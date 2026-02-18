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
const { allianceQueries, playerQueries, adminLogQueries } = require('../utility/database');
const { LOG_CODES } = require('../utility/AdminLogs');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { getFurnaceReadable } = require('./furnaceReadable');
const { getAdminLang, assertUserMatches, sendError, hasPermission, updateComponentsV2AfterSeparator, createAllianceSelectionComponents } = require('../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../utility/emojis');

/**
 * Creates the remove players button for the player management panel
 * @param {string} userId - User ID who can interact with the button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} Remove players button
 */
function createRemovePlayersButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`remove_players_${userId}`)
        .setLabel(lang.players.mainPage.buttons.removePlayers)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1046'));
}

/**
 * Handles the remove players button interaction
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleRemovePlayersButton(interaction) {
    // Get user's language preference
    const { lang, adminData } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[2]; // remove_players_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check if user is an admin with proper permissions
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
                content: lang.players.removePlayer.errors.noAssignedAlliances,
                ephemeral: true
            });
        }

        // Get player counts for all alliances in a single query
        const allianceIds = allAlliances.map(a => a.id);
        const playerCounts = playerQueries.getPlayerCountsByAllianceIds(allianceIds);
        const playerCountMap = {};
        playerCounts.forEach(row => {
            playerCountMap[row.alliance_id] = row.player_count;
        });

        // Filter out alliances with 0 members
        const alliancesWithMembers = allAlliances.filter(alliance => {
            return (playerCountMap[alliance.id] || 0) > 0;
        });

        if (alliancesWithMembers.length === 0) {
            return await interaction.reply({
                content: lang.players.removePlayer.errors.noAvailableAlliances,
                ephemeral: true
            });
        }

        // Create alliance selection embed and dropdown
        const { components } = createAllianceSelectionContainer(interaction, alliancesWithMembers, lang);

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });


    } catch (error) {
        await sendError(interaction, lang, error, 'handleRemovePlayersButton');
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
 * Creates the alliance selection embed and dropdown with pagination
 * @param {import('discord.js').ButtonInteraction} interaction - The button interaction
 * @param {Array} alliances - Array of alliance objects
 * @param {Object} lang - Language object
 * @param {number} page - Current page number (default 0)
 * @returns {Object} Embed and components
 */
/**
 * Creates alliance selection embed using shared utility with player count info
 */
function createAllianceSelectionContainer(interaction, alliances, lang, page = 0) {
    return createAllianceSelectionComponents({
        interaction,
        alliances,
        lang,
        page,
        customIdPrefix: 'remove_players_alliance_select',
        feature: 'remove_players',
        subtype: 'alliance',
        placeholder: lang.players.removePlayer.selectMenu.allianceSelect.placeholder,
        title: lang.players.removePlayer.content.title.base,
        description: lang.players.removePlayer.content.description.base,
        accentColor: 16711937, // Red
        showAll: false,
        optionMapper: (alliance) => {
            const playerCount = playerQueries.getPlayersByAllianceId(alliance.id).length;
            return {
                label: alliance.name,
                value: alliance.id.toString(),
                description: lang.players.removePlayer.selectMenu.allianceSelect.description
                    .replace('{alliancePriority}', alliance.priority)
                    .replace('{playerCount}', playerCount),
                emoji: getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1001')
            };
        }
    });
}

/**
 * Creates the player selection embed and dropdown with pagination
 * @param {import('discord.js').ButtonInteraction} interaction - The button interaction
 * @param {Array} players - Array of player objects 
 * @param {Object} lang - Language object
 * @param {Object} alliance - Alliance object
 * @param {number} page - Current page number (default 0)
 * @param {string} additionalContent - Additional content to show
 * @param {number} [totalRemovedCount=0] - Cumulative count of removed players in this session
 * @returns {Object} Embed and components
 */
function createPlayerSelectionEmbed(interaction, players, lang, alliance, page = 0, additionalContent = '', totalRemovedCount = 0) {
    const itemsPerPage = 24;
    const totalPages = Math.ceil(players.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const currentPagePlayers = players.slice(startIndex, endIndex);

    const components = [];

    // Create "Remove by ID" button
    const removeByIdButton = new ButtonBuilder()
        .setCustomId(`remove_players_add_ids_${interaction.user.id}_${alliance.id}`)
        .setLabel(lang.players.removePlayer.buttons.inputPlayerId)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1021'));

    // Add pagination buttons if more than 1 page (always show, disabled when needed)
    const paginationRow = createUniversalPaginationButtons({
        feature: 'remove_players',
        subtype: 'player',
        userId: interaction.user.id,
        currentPage: page,
        totalPages: totalPages,
        lang: lang,
        contextData: [alliance.id, totalRemovedCount]
    });

    if (paginationRow) {
        // Add the "Remove by ID" button to the same row as pagination
        paginationRow.components.push(removeByIdButton);
        components.push(paginationRow);
    } else {
        // If no pagination, add the button in its own row
        components.push(new ActionRowBuilder().addComponents(removeByIdButton));
    }

    // Third row: Select menu (if there are players)
    if (currentPagePlayers.length > 0) {
        const options = currentPagePlayers.map(player => ({
            label: player.nickname || `Player ${player.fid}`,
            value: player.fid.toString(),
            description: (lang.players.removePlayer.selectMenu.playerSelect.description)
                .replace('{id}', player.fid)
                .replace('{furnace}', getFurnaceReadable(player.furnace_level, lang) || "Unknown")
                .replace('{state}', player.state || "Unknown"),
            emoji: getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1026')
        }));

        const playerSelect = new StringSelectMenuBuilder()
            .setCustomId(`remove_players_player_select_${interaction.user.id}_${alliance.id}_${page}_${totalRemovedCount}`)
            .setPlaceholder(lang.players.removePlayer.selectMenu.playerSelect.placeholder)
            .setMinValues(1)
            .setMaxValues(Math.min(options.length, 25))
            .addOptions(options);

        components.push(new ActionRowBuilder().addComponents(playerSelect));
    }

    const newSection = [
        new ContainerBuilder()
            .setAccentColor(16711937) // Red color
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.players.removePlayer.content.title.selectPlayers}\n` +
                    `${lang.players.removePlayer.content.description.selectPlayers.replace('{allianceName}', alliance.name)}\n` +
                    (additionalContent ? `${additionalContent}` : '') +
                    `${lang.pagination.text.pageInfo.replace('{current}', page + 1).replace('{total}', totalPages)}`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
            )
            .addActionRowComponents(components)
    ];

    return { components: updateComponentsV2AfterSeparator(interaction, newSection) };
}

/**
 * Creates the confirmation embed for player removal
 * @param {Array} players - Array of player objects to remove
 * @param {Object} alliance - Alliance object
 * @param {import('discord.js').Interaction} interaction - Interaction object
 * @param {Object} lang - Language object
 * @returns {Object} Embed and components
 */
function createRemovalConfirmationEmbed(players, alliance, interaction, lang) {
    const playerList = players.map(player => lang.players.removePlayer.content.playersToRemoveField.value
        .replace('{nickname}', player.nickname || `Player ${player.fid}`)
        .replace('{id}', player.fid)
        .replace('{furnace}', getFurnaceReadable(player.furnace_level, lang) || "Unknown")
        .replace('{state}', player.state || "Unknown")
    ).join('\n');

    // Truncate if too long for embed
    const truncatedPlayerList = playerList.length > 1000 ?
        playerList.substring(0, 997) + '...' : playerList;

    // Encode player IDs in custom ID (comma-separated, limit to avoid exceeding 100 char limit)
    const playerIds = players.map(p => p.fid).join(',');
    const encodedIds = Buffer.from(playerIds).toString('base64').replace(/=/g, '');

    const actionRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`remove_players_confirm_${interaction.user.id}_${alliance.id}_${encodedIds}`)
                .setLabel(lang.players.removePlayer.buttons.accept)
                .setStyle(ButtonStyle.Danger)
                .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1004')),
            new ButtonBuilder()
                .setCustomId(`remove_players_cancel_${interaction.user.id}_${alliance.id}`)
                .setLabel(lang.players.removePlayer.buttons.cancel)
                .setStyle(ButtonStyle.Secondary)
                .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1051'))
        );

    const newSection = [
        new ContainerBuilder()
            .setAccentColor(16711937) // Red color
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.players.removePlayer.content.title.confirmRemoval}\n` +
                    `${lang.players.removePlayer.content.description.confirmRemoval.replace('{count}', players.length).replace('{allianceName}', alliance.name)}\n` +
                    `${lang.players.removePlayer.content.playersToRemoveField.name}\n${truncatedPlayerList}`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
            )
            .addActionRowComponents(actionRow)
    ];

    return { components: updateComponentsV2AfterSeparator(interaction, newSection) };
}

/**
 * Handles alliance selection pagination
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleRemovePlayersAlliancePagination(interaction) {
    const { lang, adminData } = getAdminLang(interaction.user.id);

    try {
        const { userId: expectedUserId, newPage } = parsePaginationCustomId(interaction.customId, 0);

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const allAlliances = getAlliancesForUser(adminData);

        // Get player counts for all alliances in a single query
        const allianceIds = allAlliances.map(a => a.id);
        const playerCounts = playerQueries.getPlayerCountsByAllianceIds(allianceIds);
        const playerCountMap = {};
        playerCounts.forEach(row => {
            playerCountMap[row.alliance_id] = row.player_count;
        });

        const alliancesWithMembers = allAlliances.filter(alliance => {
            return (playerCountMap[alliance.id] || 0) > 0;
        });

        const { components } = createAllianceSelectionContainer(interaction, alliancesWithMembers, lang, newPage);

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleRemovePlayersAlliancePagination');
    }
}

/**
 * Handles player selection pagination
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleRemovePlayersPlayerPagination(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const { userId: expectedUserId, newPage, contextData } = parsePaginationCustomId(interaction.customId, 2);

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // contextData[0] = allianceId, contextData[1] = totalRemovedCount
        const alliance = allianceQueries.getAllianceById(contextData[0]);
        const players = playerQueries.getPlayersByAllianceId(contextData[0]);
        const totalRemovedCount = parseInt(contextData[1]) || 0;

        // Reconstruct success content if there are removed players
        let additionalContent = '';
        if (totalRemovedCount > 0) {
            additionalContent = `${lang.players.removePlayer.content.playersRemovedField.name}\n${lang.players.removePlayer.content.playersRemovedField.value
                .replace('{removedCount}', totalRemovedCount)
                .replace('{allianceName}', alliance.name)}\n`;
        }

        const { components } = createPlayerSelectionEmbed(interaction, players, lang, alliance, newPage, additionalContent, totalRemovedCount);

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleRemovePlayersPlayerPagination');
    }
}

/**
 * Handles alliance selection
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleRemovePlayersAllianceSelection(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[4]; // remove_players_alliance_select_userId_page

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const allianceId = parseInt(interaction.values[0]);
        const alliance = allianceQueries.getAllianceById(allianceId);

        if (!alliance) {
            return await interaction.reply({
                content: lang.common.error,
                ephemeral: true,
            });
        }

        // Get players from alliance
        const players = playerQueries.getPlayersByAllianceId(allianceId);

        if (players.length === 0) {
            return await interaction.reply({
                content: lang.players.removePlayer.errors.noPlayersInAlliance,
                ephemeral: true
            });
        }

        const { components } = createPlayerSelectionEmbed(interaction, players, lang, alliance, 0, '', 0);
        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });


    } catch (error) {
        await sendError(interaction, lang, error, 'handleRemovePlayersAllianceSelection');
    }
}

/**
 * Handles player selection from dropdown
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleRemovePlayersPlayerSelection(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[4]; // remove_players_player_select_userId_allianceId_page_totalRemoved
        const allianceId = parseInt(customIdParts[5]);
        const currentTotalRemoved = parseInt(customIdParts[7]) || 0; // Get cumulative count

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const alliance = allianceQueries.getAllianceById(allianceId);
        const selectedPlayerIds = interaction.values.map(id => parseInt(id));

        // Get player objects
        const selectedPlayers = selectedPlayerIds.map(playerId => {
            return playerQueries.getPlayerByFid(playerId);
        }).filter(Boolean);

        // Store selected players and current total temporarily
        interaction.client.tempRemoveData = interaction.client.tempRemoveData || {};
        interaction.client.tempRemoveData[interaction.user.id] = {
            players: selectedPlayers,
            currentTotal: currentTotalRemoved
        };

        // Show confirmation embed
        const { components } = createRemovalConfirmationEmbed(selectedPlayers, alliance, interaction, lang);

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });


    } catch (error) {
        await sendError(interaction, lang, error, 'handleRemovePlayersPlayerSelection');
    }
}

/**
 * Handles confirmation of player removal
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleRemovePlayersConfirm(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[3]; // remove_players_confirm_userId_allianceId_encodedIds
        const allianceId = parseInt(customIdParts[4]);
        const encodedIds = customIdParts[5];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const alliance = allianceQueries.getAllianceById(allianceId);

        // Decode player IDs from custom ID (persistent across restarts)
        let playerIds = [];
        try {
            const decodedIds = Buffer.from(encodedIds, 'base64').toString('utf-8');
            playerIds = decodedIds.split(',').map(id => parseInt(id));
        } catch (decodeError) {
            await sendError(interaction, lang, decodeError, 'handleRemovePlayersConfirm - decoding IDs');
            return;
        }

        // Fetch fresh player data from database in batch
        const playersToRemove = playerQueries.getPlayersByFids(playerIds);

        // Get current total from temp data if available (for cumulative count), otherwise start at 0
        const tempData = interaction.client.tempRemoveData?.[interaction.user.id] || {};
        const currentTotal = tempData.currentTotal || 0;

        if (playersToRemove.length === 0) {
            return await interaction.reply({
                content: lang.common.error,
                ephemeral: true
            });
        }

        // Remove the players in batch
        let removedCount = 0;
        try {
            const fidsToDelete = playersToRemove.map(p => p.fid);
            playerQueries.deletePlayers(fidsToDelete);
            removedCount = playersToRemove.length;
        } catch (error) {
            await sendError(interaction, lang, error, 'handleRemovePlayersConfirm - batch delete failed', false);
            // Fall back to individual deletion if batch fails
            for (const player of playersToRemove) {
                try {
                    playerQueries.deletePlayer(player.fid);
                    removedCount++;
                } catch (individualError) {
                    await sendError(interaction, lang, individualError, `handleRemovePlayersConfirm - individual delete failed for player ${player.fid}`, false);
                }
            }
        }

        // Calculate new cumulative total
        const newTotalRemoved = currentTotal + removedCount;

        // Clear temp data
        if (interaction.client.tempRemoveData?.[interaction.user.id]) {
            delete interaction.client.tempRemoveData[interaction.user.id];
        }

        adminLogQueries.addLog(
            interaction.user.id,
            LOG_CODES.PLAYERS.REMOVED,
            JSON.stringify({
                count: removedCount,
                allianceName: alliance.name,
                allianceId: alliance.id
            })
        );

        // Show success message and return to player selection
        const remainingPlayers = playerQueries.getPlayersByAllianceId(allianceId);

        if (remainingPlayers.length === 0) {
            const newSection = [
                new ContainerBuilder()
                    .setAccentColor(65280) // green color
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `### ${lang.players.removePlayer.content.title.removalSuccess}\n` +
                            `${lang.players.removePlayer.content.description.allRemoved.replace('{allianceName}', alliance.name)}\n\n`
                        )
                    )
            ];

            await interaction.update({
                components: updateComponentsV2AfterSeparator(interaction, newSection),
                flags: MessageFlags.IsComponentsV2
            });

        } else {
            // Update the player selection with remaining players showing CUMULATIVE total
            const successContent = `${lang.players.removePlayer.content.playersRemovedField.name}\n${lang.players.removePlayer.content.playersRemovedField.value
                .replace('{removedCount}', newTotalRemoved)
                .replace('{allianceName}', alliance.name)}\n`;
            const { components } = createPlayerSelectionEmbed(interaction, remainingPlayers, lang, alliance, 0, successContent, newTotalRemoved);

            await interaction.update({
                components: components,
                flags: MessageFlags.IsComponentsV2
            });
        }


    } catch (error) {
        await sendError(interaction, lang, error, 'handleRemovePlayersConfirm');
    }
}

/**
 * Handles the add player IDs button for manual removal
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleRemovePlayersAddIds(interaction) {
    const { lang } = getAdminLang(interaction.user.id);
    try {
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[4]; // remove_players_add_ids_userId_allianceId
        const allianceId = parseInt(customIdParts[5]);

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const alliance = allianceQueries.getAllianceById(allianceId);

        if (!alliance) {
            return await interaction.reply({
                content: lang.common.error,
                ephemeral: true
            });
        }

        // Create modal form
        const modal = new ModalBuilder()
            .setCustomId(`remove_players_ids_modal_${allianceId}_${interaction.user.id}`)
            .setTitle(lang.players.removePlayer.modals.title);

        const playerIdInput = new TextInputBuilder()
            .setCustomId('player_ids')
            .setPlaceholder(lang.players.removePlayer.modals.playerIdInput.placeholder)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(4000);

        const playerIdLabel = new LabelBuilder()
            .setLabel(lang.players.removePlayer.modals.playerIdInput.label)
            .setTextInputComponent(playerIdInput);

        modal.addLabelComponents(playerIdLabel);

        await interaction.showModal(modal);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleRemovePlayersAddIds');
    }
}

/**
 * Handles the remove players IDs modal submission
 * @param {import('discord.js').ModalSubmitInteraction} interaction 
 */
async function handleRemovePlayersIdsModal(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const customIdParts = interaction.customId.split('_');
        const allianceId = parseInt(customIdParts[4]); // remove_players_ids_modal_allianceId_userId
        const expectedUserId = customIdParts[5];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const alliance = allianceQueries.getAllianceById(allianceId);

        if (!alliance) {
            return await interaction.reply({
                content: lang.common.error,
                ephemeral: true
            });
        }

        // Get and sanitize player IDs
        const rawPlayerIds = interaction.fields.getTextInputValue('player_ids');
        const sanitizedPlayerIds = sanitizePlayerIds(rawPlayerIds);

        if (!sanitizedPlayerIds) {
            return await interaction.reply({
                content: lang.players.removePlayer.errors.invalidPlayerIds,
                ephemeral: true
            });
        }

        const playerIds = sanitizedPlayerIds.split(',').map(id => parseInt(id));

        // Fetch all players in batch
        const allPlayers = playerQueries.getPlayersByFids(playerIds);
        const foundPlayers = [];
        const notFoundPlayers = [];

        // Create a set of found player IDs for efficient lookup
        const foundPlayerIds = new Set(allPlayers.map(p => p.fid));

        // Check each requested player
        for (const playerId of playerIds) {
            const player = allPlayers.find(p => p.fid === playerId);

            if (!player) {
                notFoundPlayers.push(playerId);
            } else if (player.alliance_id !== allianceId) {
                // Player exists but not in this alliance
                notFoundPlayers.push(playerId);
            } else {
                foundPlayers.push(player);
            }
        }

        if (foundPlayers.length === 0) {
            return await interaction.reply({
                content: lang.players.removePlayer.errors.playersNotFound,
                ephemeral: true
            });
        }

        // Store selected players temporarily with consistent structure
        interaction.client.tempRemoveData = interaction.client.tempRemoveData || {};
        interaction.client.tempRemoveData[interaction.user.id] = {
            players: foundPlayers,
            currentTotal: 0
        };

        // Show confirmation embed
        const { components } = createRemovalConfirmationEmbed(foundPlayers, alliance, interaction, lang);

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleRemovePlayersIdsModal');
    }
}

/**
 * Sanitizes player IDs from user input
 * @param {string} input - Raw input string
 * @returns {string|null} Sanitized comma-separated IDs or null if invalid
 */
function sanitizePlayerIds(input) {
    if (!input || typeof input !== 'string') return null;

    // Remove all non-digit and non-comma characters, then clean up commas
    const cleaned = input
        .replace(/[^0-9,]/g, '') // Keep only digits and commas
        .replace(/,+/g, ',')      // Replace multiple commas with single comma
        .replace(/^,|,$/g, '');   // Remove leading/trailing commas

    // Validate: must contain at least one digit
    if (!/\d/.test(cleaned)) return null;

    return cleaned;
}

/**
 * Handles cancellation of player removal
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleRemovePlayersCancel(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[3]; // remove_players_cancel_userId_allianceId
        const allianceId = parseInt(customIdParts[4]);

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Clear temp data
        if (interaction.client.tempRemoveData?.[interaction.user.id]) {
            delete interaction.client.tempRemoveData[interaction.user.id];
        }

        const alliance = allianceQueries.getAllianceById(allianceId);
        const players = playerQueries.getPlayersByAllianceId(allianceId);

        // Return to player selection
        const { components } = createPlayerSelectionEmbed(interaction, players, lang, alliance, 0, '');

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });


    } catch (error) {
        await sendError(interaction, lang, error, 'handleRemovePlayersCancel');
    }
}

module.exports = {
    createRemovePlayersButton,
    handleRemovePlayersButton,
    handleRemovePlayersAlliancePagination,
    handleRemovePlayersPlayerPagination,
    handleRemovePlayersAllianceSelection,
    handleRemovePlayersPlayerSelection,
    handleRemovePlayersConfirm,
    handleRemovePlayersCancel,
    handleRemovePlayersAddIds,
    handleRemovePlayersIdsModal
};
