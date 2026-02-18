const {
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    LabelBuilder
} = require('discord.js');
const { allianceQueries, playerQueries } = require('../utility/database');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { getFurnaceReadable } = require('./furnaceReadable');
const { hasPermission, sendError, getAdminLang, assertUserMatches, updateComponentsV2AfterSeparator, createAllianceSelectionComponents } = require('../utility/commonFunctions');
const { getComponentEmoji, getEmojiMapForAdmin } = require('../utility/emojis');

/**
 * Creates the move players button for the player management panel
 * @param {string} userId - User ID who can interact with the button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} Move players button
 */
function createMovePlayersButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`move_players_${userId}`)
        .setLabel(lang.players.mainPage.buttons.movePlayers)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1033'));
}

/**
 * Handles the move players button interaction
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleMovePlayersButton(interaction) {
    // Get user's language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[2]; // move_players_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check player management permissions
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.PLAYER_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get alliances based on user permissions
        const allAlliances = getAlliancesForUser(adminData);

        if (allAlliances.length === 0) {
            return await interaction.reply({
                content: lang.players.movePlayer.errors.noAssignedAlliances,
                ephemeral: true
            });
        }

        // Filter out alliances with 0 members for source selection
        const alliancesWithMembers = allAlliances.filter(alliance => {
            const playerCount = playerQueries.getPlayersByAllianceId(alliance.id).length;
            return playerCount > 0;
        });

        if (alliancesWithMembers.length === 0) {
            return await interaction.reply({
                content: lang.players.movePlayer.errors.noAlliancesWithMembers,
                ephemeral: true
            });
        }

        if (allAlliances.length < 2) {
            return await interaction.reply({
                content: lang.players.movePlayer.errors.insufficientAlliances,
                ephemeral: true
            });
        }

        // Create source alliance selection embed and dropdown
        const { components } = createSourceAllianceSelectionEmbed(alliancesWithMembers, interaction, lang);

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });


    } catch (error) {
        await sendError(interaction, lang, error, 'handleMovePlayersButton');
    }
}

/**
 * Gets alliances available to a user based on their permissions
 * @param {Object} adminData - Admin data from database
 * @returns {Array} Array of alliance objects
 */
function getAlliancesForUser(adminData) {
    try {
        // Owner and full access can see all alliances
        if (adminData.is_owner || (adminData.permissions & PERMISSIONS.FULL_ACCESS)) {
            return allianceQueries.getAllAlliances();
        }

        // Player management users can only see their assigned alliances
        if (adminData.permissions & PERMISSIONS.PLAYER_MANAGEMENT) {
            const assignedAlliances = JSON.parse(adminData.alliances || '[]');

            if (assignedAlliances.length === 0) {
                return [];
            }

            return assignedAlliances.map(allianceId => {
                const alliance = allianceQueries.getAllianceById(allianceId);
                return alliance;
            }).filter(Boolean); // Remove null/undefined entries
        }

        return [];
    } catch (error) {
        console.error('Error getting alliances for user:', error);
        return [];
    }
}

/**
 * Generic pagination handler for move players functionality
 * @param {import('discord.js').ButtonInteraction} interaction 
 * @param {string} type - Type of pagination: 'source', 'dest', or 'player'
 */
async function handleMovePlayersPagination(interaction, type) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Parse with 0 context initially to get subtype, then extract correct amount
        const parsed = parsePaginationCustomId(interaction.customId, 0);

        const { userId: expectedUserId, newPage, subtype, contextData } = parsed;

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (subtype === 'source') {
            // move_players_source_prev/next_userId_currentPage
            const allAlliances = getAlliancesForUser(adminData);
            const alliancesWithMembers = allAlliances.filter(alliance => {
                const playerCount = playerQueries.getPlayersByAllianceId(alliance.id).length;
                return playerCount > 0;
            });

            const { components } = createSourceAllianceSelectionEmbed(alliancesWithMembers, interaction, lang, newPage);
            await interaction.update({ components: components, flags: MessageFlags.IsComponentsV2 });

        } else if (subtype === 'dest') {
            // move_players_dest_prev/next_userId_sourceId_currentPage
            const sourceAllianceId = parseInt(contextData[0]);

            const sourceAlliance = allianceQueries.getAllianceById(sourceAllianceId);
            const allAlliances = getAlliancesForUser(adminData);
            const alliances = allAlliances.filter(alliance => alliance.id !== sourceAllianceId);

            const { components } = createDestinationAllianceSelectionContainer(alliances, interaction, lang, sourceAlliance, newPage);
            await interaction.update({ components: components, flags: MessageFlags.IsComponentsV2 });

        } else if (subtype === 'player') {
            // move_players_player_(prev/next)_userId_sourceId_destId_currentPage_totalMoved
            const sourceAllianceId = parseInt(contextData[0]);
            const destAllianceId = parseInt(contextData[1]);
            const totalMovedCount = parseInt(contextData[2]) || 0;

            const sourceAlliance = allianceQueries.getAllianceById(sourceAllianceId);
            const destAlliance = allianceQueries.getAllianceById(destAllianceId);
            const players = playerQueries.getPlayersByAllianceId(sourceAllianceId);

            // Reconstruct success content from cumulative count if exists
            let additionalContent = '';
            if (totalMovedCount > 0) {
                additionalContent = `${lang.players.movePlayer.content.movedField.name}\n${lang.players.movePlayer.content.movedField.value
                    .replace('{movedCount}', totalMovedCount)
                    .replace('{sourceName}', sourceAlliance.name)
                    .replace('{destName}', destAlliance.name)}`;
            }

            const { components } = createPlayerSelectionEmbed(
                players,
                lang,
                sourceAlliance,
                destAlliance,
                interaction,
                sourceAllianceId,
                destAllianceId,
                newPage,
                additionalContent, // Reconstructed success content
                totalMovedCount // Pass cumulative count through pagination
            );
            await interaction.update({ components: components, flags: MessageFlags.IsComponentsV2 });
        }

    } catch (error) {
        await sendError(interaction, lang, error, `handleMovePlayersPagination_${type}`);
    }
}


/**
 * Creates the source alliance selection embed and dropdown with pagination
 * @param {Array} alliances - Array of alliance objects
 * @param {Object} interaction - Interaction object
 * @param {Object} lang - Language object
 * @param {number} [page=0] - Current page number (default 0)
 * @returns {Object} Embed and components
 */
/**
 * Creates source alliance selection embed using shared utility
 */
function createSourceAllianceSelectionEmbed(alliances, interaction, lang, page = 0) {
    return createAllianceSelectionComponents({
        interaction,
        alliances,
        lang,
        page,
        customIdPrefix: 'move_players_source_select',
        feature: 'move_players',
        subtype: 'source',
        placeholder: lang.players.movePlayer.selectMenu.sourceAlliance.placeholder,
        title: lang.players.movePlayer.content.title.base,
        description: lang.players.movePlayer.content.description.base,
        accentColor: 0x3498db,
        showAll: false,
        optionMapper: (alliance) => {
            const playerCount = playerQueries.getPlayersByAllianceId(alliance.id).length;
            return {
                label: alliance.name,
                value: alliance.id.toString(),
                description: lang.players.movePlayer.selectMenu.sourceAlliance.description
                    .replace('{priority}', alliance.priority)
                    .replace('{playerCount}', playerCount),
                emoji: getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1001')
            };
        }
    });
}

/**
 * Creates the destination alliance selection embed and dropdown with pagination
 * @param {Array} alliances - Array of alliance objects (excluding source)
 * @param {Object} interaction - Interaction object
 * @param {Object} lang - Language object
 * @param {Object} sourceAlliance - Source alliance object
 * @param {number} [page=0] - Current page number (default 0)
 * @returns {Object} Embed and components
 */
function createDestinationAllianceSelectionContainer(alliances, interaction, lang, sourceAlliance, page = 0) {
    const itemsPerPage = 24;
    const totalPages = Math.ceil(alliances.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const currentPageAlliances = alliances.slice(startIndex, endIndex);

    // Create dropdown options
    const options = currentPageAlliances.map(alliance => {
        const playerCount = playerQueries.getPlayersByAllianceId(alliance.id).length;
        return {
            label: alliance.name,
            value: alliance.id.toString(),
            description: (lang.players.movePlayer.selectMenu.destinationAlliance.description).replace('{priority}', alliance.priority).replace('{playerCount}', playerCount),
            emoji: getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1043')
        };
    });

    // Create dropdown menu
    const allianceSelect = new StringSelectMenuBuilder()
        .setCustomId(`move_players_dest_select_${interaction.user.id}_${sourceAlliance.id}_${page}`)
        .setPlaceholder(lang.players.movePlayer.selectMenu.destinationAlliance.placeholder)
        .addOptions(options);

    const actionRows = [];

    // Add pagination buttons if needed
    const paginationRow = createUniversalPaginationButtons({
        feature: 'move_players',
        subtype: 'dest',
        userId: interaction.user.id,
        currentPage: page,
        totalPages: totalPages,
        lang: lang,
        contextData: [sourceAlliance.id]
    });
    if (paginationRow) {
        actionRows.push(paginationRow);
    }

    // Add dropdown menu
    actionRows.push(new ActionRowBuilder().addComponents(allianceSelect));

    const newSection = [
        new ContainerBuilder()
            .setAccentColor(0xe67e22) // Orange color
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.players.movePlayer.content.title.selectDestination}` +
                    `\n${(lang.players.movePlayer.content.description.selectDestination).replace('{sourceName}', sourceAlliance.name)}` +
                    `\n${lang.pagination.text.pageInfo.replace('{current}', (page + 1)).replace('{total}', totalPages)}`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addActionRowComponents(
                actionRows
            )
    ];

    return { components: updateComponentsV2AfterSeparator(interaction, newSection) };
}

/**
 * Creates the player selection embed and dropdown with pagination
 * @param {Array} players - Array of player objects
 * @param {Object} lang - Language object
 * @param {Object} sourceAlliance - Source alliance object
 * @param {Object} destAlliance - Destination alliance object
 * @param {Object} interaction - Discord interaction object
 * @param {number} sourceId - Source alliance ID
 * @param {number} destId - Destination alliance ID
 * @param {number} [page=0] - Current page number (default 0)
 * @param {string} [additionalContent=''] - Additional content to append to the display
 * @param {number} [totalMovedCount=0] - Cumulative count of moved players in this session
 * @returns {Object} Components
 */
function createPlayerSelectionEmbed(players, lang, sourceAlliance, destAlliance, interaction, sourceId, destId, page = 0, additionalContent = '', totalMovedCount = 0) {
    const itemsPerPage = 24;
    const totalPages = Math.ceil(players.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const currentPagePlayers = players.slice(startIndex, endIndex);

    const actionRows = [];

    // Move by ID button (always present)
    const moveByIdButton = new ButtonBuilder()
        .setCustomId(`move_players_add_ids_${interaction.user.id}_${sourceId}_${destId}`)
        .setLabel(lang.players.movePlayer.buttons.inputPlayerId)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1021'))
        ;

    // Add pagination buttons only if multiple pages
    const paginationRow = createUniversalPaginationButtons({
        feature: 'move_players',
        subtype: 'player',
        userId: interaction.user.id,
        currentPage: page,
        totalPages: totalPages,
        lang: lang,
        contextData: [sourceId, destId, totalMovedCount]
    });

    if (paginationRow) {
        // Add the "Move by ID" button to the same row as pagination
        paginationRow.components.push(moveByIdButton);
        actionRows.push(paginationRow);
    } else {
        // If no pagination, add the button in its own row
        actionRows.push(new ActionRowBuilder().addComponents(moveByIdButton));
    }

    // Second row: Select menu (if there are players)
    if (currentPagePlayers.length > 0) {
        const options = currentPagePlayers.map(player => ({
            label: player.nickname || `Player ${player.fid}`,
            value: player.fid.toString(),
            description: lang.players.movePlayer.selectMenu.playerSelection.description
                .replace('{id}', player.fid)
                .replace('{furnace}', getFurnaceReadable(player.furnace_level, lang))
                .replace('{state}', player.state || 'Unknown'),
            emoji: getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1026')
        }));

        const playerSelect = new StringSelectMenuBuilder()
            .setCustomId(`move_players_player_select_${interaction.user.id}_${sourceId}_${destId}_${page}_${totalMovedCount}`)
            .setPlaceholder(lang.players.movePlayer.selectMenu.playerSelection.placeholder)
            .setMinValues(1)
            .setMaxValues(Math.min(options.length, 25))
            .addOptions(options);

        actionRows.push(new ActionRowBuilder().addComponents(playerSelect));
    }

    const newSection = [
        new ContainerBuilder()
            .setAccentColor(0xf1c40f) // Yellow color
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.players.movePlayer.content.title.selectPlayers}` +
                    `\n${(lang.players.movePlayer.content.description.selectPlayers).replace('{sourceName}', sourceAlliance.name).replace('{destName}', destAlliance.name)}` +
                    `\n${lang.players.movePlayer.content.availablePlayersField.name}\n${(lang.players.movePlayer.content.availablePlayersField.value).replace('{availableCount}', currentPagePlayers.length).replace('{sourceName}', sourceAlliance.name)}` +
                    (additionalContent ? `\n${additionalContent}` : '') +
                    `\n${lang.pagination.text.pageInfo.replace('{current}', (page + 1)).replace('{total}', totalPages)}`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addActionRowComponents(
                actionRows
            )
    ];

    return { components: updateComponentsV2AfterSeparator(interaction, newSection) };
}

/**
 * Handles source alliance selection pagination
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleMovePlayersSourcePagination(interaction) {
    await handleMovePlayersPagination(interaction, 'source');
}

/**
 * Handles destination alliance selection pagination
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleMovePlayersDestPagination(interaction) {
    await handleMovePlayersPagination(interaction, 'dest');
}

/**
 * Handles player selection pagination
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleMovePlayersPlayerPagination(interaction) {
    await handleMovePlayersPagination(interaction, 'player');
}

/**
 * Handles source alliance selection
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleMovePlayersSourceSelection(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[4]; // move_players_source_select_userId_page

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const sourceAllianceId = parseInt(interaction.values[0]);
        const sourceAlliance = allianceQueries.getAllianceById(sourceAllianceId);

        if (!sourceAlliance) {
            return await interaction.reply({
                content: lang.common.error,
                embeds: [],
                components: []
            });
        }

        // Get all alliances except the source
        const allAlliances = getAlliancesForUser(adminData);
        const alliances = allAlliances.filter(alliance => alliance.id !== sourceAllianceId);

        const { components } = createDestinationAllianceSelectionContainer(alliances, interaction, lang, sourceAlliance);

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });


    } catch (error) {
        await sendError(interaction, lang, error, 'handleMovePlayersSourceSelection');
    }
}

/**
 * Handles destination alliance selection
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleMovePlayersDestSelection(interaction) {
    const { lang } = getAdminLang(interaction.user.id);
    try {
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[4]; // move_players_dest_select_userId_sourceId_page
        const sourceAllianceId = parseInt(customIdParts[5]);

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const destAllianceId = parseInt(interaction.values[0]);
        const sourceAlliance = allianceQueries.getAllianceById(sourceAllianceId);
        const destAlliance = allianceQueries.getAllianceById(destAllianceId);

        if (!sourceAlliance || !destAlliance) {
            return await interaction.update({
                content: lang.common.error,
                embeds: [],
                components: []
            });
        }

        // Get players from source alliance
        const players = playerQueries.getPlayersByAllianceId(sourceAllianceId);

        if (players.length === 0) {
            return await interaction.update({
                content: lang.players.movePlayer.errors.noPlayersInAlliance,
                embeds: [],
                components: []
            });
        }

        const { components } = createPlayerSelectionEmbed(
            players,
            lang,
            sourceAlliance,
            destAlliance,
            interaction,
            sourceAllianceId,
            destAllianceId,
            0, // page
            '' // additionalContent
        );

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });


    } catch (error) {
        await sendError(interaction, lang, error, 'handleMovePlayersDestSelection');
    }
}

/**
 * Handles player selection from dropdown
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleMovePlayersPlayerSelection(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[4]; // move_players_player_select_userId_sourceId_destId_page_totalMoved
        const sourceAllianceId = parseInt(customIdParts[5]);
        const destAllianceId = parseInt(customIdParts[6]);
        const currentTotalMoved = parseInt(customIdParts[8]) || 0; // Get cumulative count

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const sourceAlliance = allianceQueries.getAllianceById(sourceAllianceId);
        const destAlliance = allianceQueries.getAllianceById(destAllianceId);
        const selectedPlayerIds = interaction.values.map(id => parseInt(id));

        // Move the selected players
        let movedCount = 0;
        for (const playerId of selectedPlayerIds) {
            try {
                playerQueries.updatePlayerAlliance(playerId, destAllianceId);
                movedCount++;
            } catch (error) {
                await sendError(interaction, null, error, 'handleMovePlayersPlayerSelection_movePlayer', false);
            }
        }

        // Calculate new cumulative total
        const newTotalMoved = currentTotalMoved + movedCount;

        // Update the embed to show success and refresh player list
        const updatedPlayers = playerQueries.getPlayersByAllianceId(sourceAllianceId);

        if (updatedPlayers.length === 0) {
            // All players moved - show success message using Components v2
            const successSection = [
                new ContainerBuilder()
                    .setAccentColor(0x2ecc71) // Green color
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `${lang.players.movePlayer.content.title.success}` +
                            `\n${(lang.players.movePlayer.content.description.allMoved).replace('{sourceName}', sourceAlliance.name).replace('{destName}', destAlliance.name)}`
                        )
                    )
            ];

            const successComponents = updateComponentsV2AfterSeparator(interaction, successSection);

            await interaction.update({
                components: successComponents,
                flags: MessageFlags.IsComponentsV2
            });
        } else {
            // Create success message content for Components v2 showing CUMULATIVE total
            const successContent = `${lang.players.movePlayer.content.movedField.name}\n${lang.players.movePlayer.content.movedField.value
                .replace('{movedCount}', newTotalMoved)
                .replace('{sourceName}', sourceAlliance.name)
                .replace('{destName}', destAlliance.name)}`;

            // Update the player selection with remaining players
            const { components } = createPlayerSelectionEmbed(
                updatedPlayers,
                lang,
                sourceAlliance,
                destAlliance,
                interaction,
                sourceAllianceId,
                destAllianceId,
                0, // Reset to first page
                successContent,
                newTotalMoved // Pass cumulative count
            );

            await interaction.update({
                components: components,
                flags: MessageFlags.IsComponentsV2
            });
        }


    } catch (error) {
        await sendError(interaction, lang, error, 'handleMovePlayersPlayerSelection');
    }
}

/**
 * Handles the add player IDs button
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleMovePlayersAddIds(interaction) {
    const { lang } = getAdminLang(interaction.user.id);
    try {
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[4]; // move_players_add_ids_userId_sourceId_destId
        const sourceAllianceId = parseInt(customIdParts[5]);
        const destAllianceId = parseInt(customIdParts[6]);

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const sourceAlliance = allianceQueries.getAllianceById(sourceAllianceId);
        const destAlliance = allianceQueries.getAllianceById(destAllianceId);

        // Create modal form
        const modal = new ModalBuilder()
            .setCustomId(`move_players_ids_modal_${sourceAllianceId}_${destAllianceId}_${interaction.user.id}`)
            .setTitle(lang.players.movePlayer.modals.title);

        const playerIdInput = new TextInputBuilder()
            .setCustomId('player_ids')
            .setPlaceholder(lang.players.movePlayer.modals.playerIdInput.placeholder)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(4000);

        const playerIdLabel = new LabelBuilder()
            .setLabel(lang.players.movePlayer.modals.playerIdInput.label)
            .setTextInputComponent(playerIdInput);

        modal.addLabelComponents(playerIdLabel);

        await interaction.showModal(modal);


    } catch (error) {
        await sendError(interaction, lang, error, 'handleMovePlayersAddIds');
    }
}

/**
 * Handles the move players IDs modal submission
 * @param {import('discord.js').ModalSubmitInteraction} interaction 
 */
async function handleMovePlayersIdsModal(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const customIdParts = interaction.customId.split('_');
        const sourceAllianceId = parseInt(customIdParts[4]); // move_players_ids_modal_sourceId_destId_userId
        const destAllianceId = parseInt(customIdParts[5]);
        const expectedUserId = customIdParts[6];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const sourceAlliance = allianceQueries.getAllianceById(sourceAllianceId);
        const destAlliance = allianceQueries.getAllianceById(destAllianceId);

        // Get and sanitize player IDs
        const rawPlayerIds = interaction.fields.getTextInputValue('player_ids');
        const sanitizedPlayerIds = sanitizePlayerIds(rawPlayerIds);

        if (!sanitizedPlayerIds) {
            return await interaction.reply({
                content: lang.players.movePlayer.errors.invalidPlayerIds,
                ephemeral: true
            });
        }

        const playerIds = sanitizedPlayerIds.split(',').map(id => parseInt(id));
        const foundPlayers = [];
        const notFoundPlayers = [];
        const wrongAlliancePlayers = [];

        // Check each player
        for (const playerId of playerIds) {
            const player = playerQueries.getPlayerByFid(playerId);

            if (!player) {
                notFoundPlayers.push(playerId);
                continue;
            }

            if (player.alliance_id === sourceAllianceId) {
                foundPlayers.push(player);
            } else {
                const playerAlliance = allianceQueries.getAllianceById(player.alliance_id);
                wrongAlliancePlayers.push({
                    player: player,
                    alliance: playerAlliance
                });
            }
        }

        // Move players from correct alliance
        let movedCount = 0;
        for (const player of foundPlayers) {
            try {
                playerQueries.updatePlayerAlliance(player.fid, destAllianceId);
                movedCount++;
            } catch (error) {
                await sendError(interaction, lang, error, 'handleMovePlayersIdsModal_movePlayer', false);
            }
        }

        // Create response content for Components v2
        let responseContent = `${lang.players.movePlayer.content.title.result}\n`;

        if (movedCount > 0) {
            responseContent += `\n${lang.players.movePlayer.content.movedField.name}\n${lang.players.movePlayer.content.movedField.value
                .replace('{movedCount}', movedCount)
                .replace('{sourceName}', sourceAlliance.name)
                .replace('{destName}', destAlliance.name)}`;
        }

        if (notFoundPlayers.length > 0) {
            responseContent += `\n\n${lang.players.movePlayer.content.notFoundField.name}\n${lang.players.movePlayer.content.notFoundField.value
                .replace('{notFoundCount}', notFoundPlayers.length)
                .replace('{sourceName}', sourceAlliance.name)
                .replace('{notFoundIds}', notFoundPlayers.join(', '))}`;
        }

        if (wrongAlliancePlayers.length > 0) {
            const wrongAllianceText = wrongAlliancePlayers.map(item => {
                const allianceName = item.alliance ? item.alliance.name : 'Unknown Alliance';
                return `${item.player.nickname || item.player.fid} (${allianceName})`;
            }).join(', ');

            // Truncate if too long for embed
            const truncatedText = wrongAllianceText.length > 1000 ?
                wrongAllianceText.substring(0, 997) + '...' : wrongAllianceText;

            responseContent += `\n${lang.players.movePlayer.content.wrongAllianceField.name}\n${lang.players.movePlayer.content.wrongAllianceField.value}\n${truncatedText}`;

            // Add buttons for wrong alliance players
            const actionRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`move_players_confirm_wrong_${sourceAllianceId}_${destAllianceId}_${interaction.user.id}`)
                        .setLabel(lang.players.movePlayer.buttons.confirm)
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1004')),
                    new ButtonBuilder()
                        .setCustomId(`move_players_cancel_wrong_${interaction.user.id}`)
                        .setLabel(lang.players.movePlayer.buttons.cancel)
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1051'))
                );

            const responseSection = [
                new ContainerBuilder()
                    .setAccentColor(movedCount > 0 ? 0x00ff00 : 0xffa500)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(responseContent)
                    )
                    .addActionRowComponents(actionRow)
            ];

            const responseComponents = updateComponentsV2AfterSeparator(interaction, responseSection);

            await interaction.update({
                components: responseComponents,
                flags: MessageFlags.IsComponentsV2
            });

            // Store wrong alliance players in a temporary way (now using a module-scoped Map)
            tempMoveData.set(interaction.user.id, wrongAlliancePlayers);

        } else {
            const responseSection = [
                new ContainerBuilder()
                    .setAccentColor(movedCount > 0 ? 0x00ff00 : 0xffa500)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(responseContent)
                    )
            ];

            const responseComponents = updateComponentsV2AfterSeparator(interaction, responseSection);

            await interaction.update({
                components: responseComponents,
                flags: MessageFlags.IsComponentsV2
            });
        }


    } catch (error) {
        await sendError(interaction, lang, error, 'handleMovePlayersIdsModal');
    }
}

/**
 * Handles confirming move of players from wrong alliances
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleMovePlayersConfirmWrong(interaction) {
    const { lang } = getAdminLang(interaction.user.id);
    try {
        const customIdParts = interaction.customId.split('_');
        const sourceAllianceId = parseInt(customIdParts[4]); // move_players_confirm_wrong_sourceId_destId_userId
        const destAllianceId = parseInt(customIdParts[5]);
        const expectedUserId = customIdParts[6];


        if (!assertUserMatches(interaction, expectedUserId, lang)) return;

        let movedCount = 0;
        for (const item of wrongAlliancePlayers) {
            try {
                playerQueries.updatePlayerAlliance(item.player.fid, destAllianceId);
                movedCount++;
            } catch (error) {
                await sendError(interaction, lang, error, 'handleMovePlayersConfirmWrong_movePlayer', false);
            }
        }

        // Clear temp data
        if (tempMoveData.has(interaction.user.id)) {
            tempMoveData.delete(interaction.user.id);
        }

        const successSection = [
            new ContainerBuilder()
                .setAccentColor(0x2ecc71) // Green color
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.players.movePlayer.content.title.success}` +
                        `\n${(lang.players.movePlayer.content.description.success)
                            .replace('{count}', movedCount)
                            .replace('{destName}', destAlliance.name)}`
                    )
                )
        ];

        const successComponents = updateComponentsV2AfterSeparator(interaction, successSection);

        await interaction.update({
            components: successComponents,
            flags: MessageFlags.IsComponentsV2
        });


    } catch (error) {
        await sendError(interaction, lang, error, 'handleMovePlayersConfirmWrong');
    }
}

/**
 * Handles canceling move of players from wrong alliances
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleMovePlayersCancelWrong(interaction) {
    const { lang } = getAdminLang(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[4]; // move_players_cancel_wrong_userId

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Clear temp data from module-scoped Map
        if (tempMoveData.has(interaction.user.id)) {
            tempMoveData.delete(interaction.user.id);
        }

        const cancelSection = [
            new ContainerBuilder()
                .setAccentColor(0xff0000) // Red color
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.players.movePlayer.content.title.cancel}` +
                        `\n${lang.players.movePlayer.content.description.cancel}`
                    )
                )
        ];

        const cancelComponents = updateComponentsV2AfterSeparator(interaction, cancelSection);

        await interaction.update({
            components: cancelComponents,
            flags: MessageFlags.IsComponentsV2
        });


    } catch (error) {
        await sendError(interaction, lang, error, 'handleMovePlayersCancelWrong');
    }
}

/**
/**
 * Sanitizes player IDs input.
 * Only positive integers without leading zeros are allowed (e.g., 1, 23, 456).
 * @param {string} rawInput - Raw input from user
 * @returns {string|null} Sanitized player IDs or null if invalid
 */
function sanitizePlayerIds(rawInput) {
    try {
        // Remove all spaces and split by commas
        const ids = rawInput.replace(/\s+/g, '').split(',');

        // Validate each ID
        const validIds = [];
        for (const id of ids) {
            if (id.trim() === '') continue; // Skip empty strings

            // Check if it's a valid number
            if (!/^\d+$/.test(id)) {
                return null; // Invalid format
            }

            validIds.push(id);
        }

        if (validIds.length === 0) {
            return null; // No valid IDs
        }

        return validIds.join(',');
    } catch (error) {
        console.error('Error sanitizing player IDs:', error);
        return null;
    }
}

// Module-scoped temp data store for move operations (in-memory, not persistent)
const tempMoveData = new Map();

module.exports = {
    createMovePlayersButton,
    handleMovePlayersButton,
    handleMovePlayersSourcePagination,
    handleMovePlayersDestPagination,
    handleMovePlayersPlayerPagination,
    handleMovePlayersSourceSelection,
    handleMovePlayersDestSelection,
    handleMovePlayersPlayerSelection,
    handleMovePlayersAddIds,
    handleMovePlayersIdsModal,
    handleMovePlayersConfirmWrong,
    handleMovePlayersCancelWrong,
};
