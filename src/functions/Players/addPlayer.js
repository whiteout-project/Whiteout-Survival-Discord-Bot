const {
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
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
const { allianceQueries } = require('../utility/database');
const { createProcess, updateProcessProgress, getProcessById } = require('../Processes/createProcesses');
const { queueManager } = require('../Processes/queueManager');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { getAdminLang, assertUserMatches, sendError, hasPermission, updateComponentsV2AfterSeparator, createAllianceSelectionComponents } = require('../utility/commonFunctions');
const { parsePaginationCustomId } = require('../Pagination/universalPagination');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../utility/emojis');

/**
 * Creates the add player button for the player management panel
 * @param {string} userId - User ID who can interact with the button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} Add player button
 */
function createAddPlayerButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`add_player_${userId}`)
        .setLabel(lang.players.mainPage.buttons.addPlayer)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1000'));
}

/**
 * Handles the add player button interaction
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleAddPlayerButton(interaction) {
    // Get user's language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[2]; // add_player_userId

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
        const alliances = await getAlliancesForUser(adminData);

        if (alliances.length === 0) {
            return await interaction.reply({
                content: lang.players.addPlayer.error.noAssignedAlliances,
                ephemeral: true
            });
        }

        // Create alliance selection container
        const { components } = createAllianceSelectionContainer(interaction, alliances, lang);

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });


    } catch (error) {
        await sendError(interaction, lang, error, 'handleAddPlayerButton');
    }
}

/**
 * Gets alliances available to a user based on their permissions
 * @param {Object} adminData - Admin data from database
 * @returns {Array} Array of alliance objects
 */
async function getAlliancesForUser(adminData) {
    try {

        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        const hasAccess = hasPermission(adminData, PERMISSIONS.PLAYER_MANAGEMENT);
        // Owner and full access can see all alliances
        if (hasFullAccess) {
            return allianceQueries.getAllAlliances();
        }

        // Player management users can only see their assigned alliances
        if (hasAccess) {
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
        await sendError(null, null, error, 'getAlliancesForUser', false);
        return [];
    }
}

/**
 * Creates the alliance selection embed and dropdown
 * @param {Array} alliances - Array of alliance objects
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {Object} lang - Language object
 * @param {number} page - Current page number (default 0)
 * @returns {Object} Embed and components
*/

/**
 * Creates alliance selection container using shared utility
 */
function createAllianceSelectionContainer(interaction, alliances, lang, page = 0) {
    return createAllianceSelectionComponents({
        interaction,
        alliances,
        lang,
        page,
        customIdPrefix: 'alliance_select_add_player',
        feature: 'add_player',
        placeholder: lang.players.addPlayer.selectMenu.selectAlliance.placeholder,
        title: lang.players.addPlayer.content.title.base,
        description: lang.players.addPlayer.content.description.base,
        accentColor: 0x3498db, // Blue
        showAll: false
    });
}

/**
 * Handles alliance selection pagination for add player
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleAddPlayerPagination(interaction) {
    // Get user's language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID and page from custom ID
        const { userId: expectedUserId, newPage } = parsePaginationCustomId(interaction.customId, 0);

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Get alliances based on user permissions
        const alliances = await getAlliancesForUser(adminData);
        if (alliances.length === 0) {
            return await interaction.reply({
                content: lang.players.addPlayer.error.noAssignedAlliances,
                ephemeral: true
            });
        }

        // Create alliance selection embed and dropdown for new page
        const { components } = createAllianceSelectionContainer(interaction, alliances, lang, newPage);

        // Update the message
        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleAddPlayerPagination');
    }
}

/**
 * Handles alliance selection for add player
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleAllianceSelection(interaction) {
    // Get user's language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[4]; // alliance_select_add_player_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.PLAYER_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get selected alliance
        const selectedAllianceId = parseInt(interaction.values[0]);
        const alliance = allianceQueries.getAllianceById(selectedAllianceId);

        if (!alliance) {
            return await interaction.reply({
                content: lang.common.error,
                ephemeral: true
            });
        }

        // Create form button
        const formButton = new ButtonBuilder()
            .setCustomId(`open_player_form_${alliance.id}_${interaction.user.id}`)
            .setLabel(lang.players.addPlayer.buttons.inputPlayerId)
            .setStyle(ButtonStyle.Primary)
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1021'));

        const components = [
            new ActionRowBuilder().addComponents(formButton),
        ];

        // Create confirmation container with form button
        const container = [
            new ContainerBuilder()
                .setAccentColor(0x00ff00) // Green
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.players.addPlayer.content.title.addPlayerAlliance.replace('{Alliance}', alliance.name)}\n` +
                        `${lang.players.addPlayer.content.description.enterID}\n` +
                        `${lang.players.addPlayer.content.instructionField.name}\n` +
                        `${lang.players.addPlayer.content.instructionField.value}`
                    )
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
                )
                .addActionRowComponents(components)
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleAllianceSelection');
    }
}

/**
 * Handles opening the player ID input form
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handlePlayerFormButton(interaction) {
    // Get user's language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract alliance ID and user ID from custom ID
        const parts = interaction.customId.split('_'); // open_player_form_allianceId_userId
        const allianceId = parseInt(parts[3]);
        const expectedUserId = parts[4];

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.PLAYER_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get alliance
        const alliance = allianceQueries.getAllianceById(allianceId);
        if (!alliance) {
            return await interaction.reply({
                content: lang.common.error,
                ephemeral: true
            });
        }

        // Create modal form
        const modal = new ModalBuilder()
            .setCustomId(`player_id_modal_${allianceId}_${interaction.user.id}`)
            .setTitle(lang.players.addPlayer.modal.title);

        const playerIdInput = new TextInputBuilder()
            .setCustomId('player_ids')
            .setPlaceholder(lang.players.addPlayer.modal.playerIdInput.placeholder)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(4000);

        const playerIdLabel = new LabelBuilder()
            .setLabel(lang.players.addPlayer.modal.playerIdInput.label)
            .setTextInputComponent(playerIdInput);

        modal.addLabelComponents(playerIdLabel);

        await interaction.showModal(modal);


    } catch (error) {
        await sendError(interaction, lang, error, 'handlePlayerFormButton');
    }
}

/**
 * Handles the player ID modal submission
 * @param {import('discord.js').ModalSubmitInteraction} interaction 
 */
async function handlePlayerIdModal(interaction) {
    // Get user's language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract alliance ID and user ID from custom ID
        const parts = interaction.customId.split('_'); // player_id_modal_allianceId_userId
        const allianceId = parseInt(parts[3]);

        // Check permissions
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.PLAYER_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get alliance
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
                content: lang.players.addPlayer.error.invalidPlayerIds,
                ephemeral: true
            });
        }

        // Defer the reply since process creation might take time
        await interaction.deferReply({ ephemeral: true });

        // Create process with ALL players (including existing ones)
        // fetchPlayerData.js will handle filtering and moving existing players to 'existing' status
        const processResult = await createProcess({
            admin_id: String(interaction.user.id),
            alliance_id: allianceId,
            player_ids: sanitizedPlayerIds, // Use ALL player IDs
            action: 'addplayer'
        });

        // Create response embed with progress tracking (no existing players to show yet)
        const responseEmbed = createProcessResponseEmbed(processResult, { status: 'queued' }, alliance, lang, interaction.user.id, []);

        // Get the alliance's configured channel from database
        // If no channel is configured, fall back to interaction channel
        let targetChannel = null;

        if (alliance.channel_id) {
            try {
                targetChannel = await interaction.client.channels.fetch(alliance.channel_id);
            } catch (error) {
                await sendError(null, lang, error, 'fetchAllianceChannel', false);
                targetChannel = interaction.channel;
            }
        } else {
            targetChannel = interaction.channel;
        }

        // Send a non-ephemeral message in the target channel for progress updates
        // Can't use editReply because ephemeral messages get deleted
        const responseMessage = await targetChannel.send({
            embeds: [responseEmbed]
        });

        // Send ephemeral confirmation to user
        const channelMention = targetChannel.id === interaction.channel.id
            ? lang.players.addPlayer.content.currentChannel
            : `<#${targetChannel.id}>`;

        await interaction.editReply({
            content: lang.players.addPlayer.content.processStarted.replace('{channelMention}', channelMention),
            ephemeral: true
        });

        // CRITICAL: Store message details in process BEFORE managing queue
        // This ensures fetchPlayerData will find the message_id when the process starts
        const currentProcess = await getProcessById(processResult.process_id);

        if (currentProcess) {
            const updatedProgress = {
                ...currentProcess.progress,
                message_id: responseMessage.id,
                channel_id: targetChannel.id,
                guild_id: interaction.guild.id
            };
            await updateProcessProgress(processResult.process_id, updatedProgress);
        }

        // Manage queue AFTER storing message details
        // This prevents race condition where process starts before message_id is stored
        await queueManager.manageQueue(processResult);

    } catch (error) {
        await sendError(interaction, lang, error, 'handlePlayerIdModal');
    }
}

/**
 * Sanitizes player IDs input
 * @param {string} rawInput - Raw input from user
 * @returns {string|null} Sanitized player IDs or null if invalid
 */
function sanitizePlayerIds(rawInput) {
    try {
        // Split by commas, then trim whitespace from each ID
        const ids = rawInput.split(',').map(id => id.trim());

        // Validate each ID
        const validIds = [];
        for (const id of ids) {
            if (id === '') continue; // Skip empty strings

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
        return null;
    }
}

/**
 * Creates the process response embed
 * @param {Object} processResult - Process creation result
 * @param {Object} queueResult - Queue management result
 * @param {Object} alliance - Alliance object
 * @param {Object} lang - Language object
 * @param {Array} existingPlayers - Array of existing players (optional)
 * @returns {EmbedBuilder} Response embed
 */
function createProcessResponseEmbed(processResult, queueResult, alliance, lang, userId, existingPlayers = []) {
    const playerCount = processResult.player_ids ? processResult.player_ids.split(',').length : 0;

    let color = "#3498db"; // Default blue
    let statusEmoji = getComponentEmoji(getEmojiMapForAdmin(userId), '1021');
    let statusMessage = lang.players.addPlayer.content.status.queued;

    if (queueResult.status === 'active') {
        color = "#00ff00"; // Green
        statusEmoji = getComponentEmoji(getEmojiMapForAdmin(userId), '1035');
        statusMessage = lang.players.addPlayer.content.status.active;
    } else if (queueResult.status === 'queue') {
        color = "#ffa500"; // Orange
        statusEmoji = getComponentEmoji(getEmojiMapForAdmin(userId), '1021');
        statusMessage = lang.players.addPlayer.content.status.queued;
    }

    const embed = new EmbedBuilder()
        .setTitle(`${statusEmoji} ${lang.players.addPlayer.content.title.addPlayerProcess}`)
        .setDescription(statusMessage)
        .setColor(color)
        .addFields([
            {
                name: lang.players.addPlayer.content.processDetailsField.name,
                value: lang.players.addPlayer.content.processDetailsField.value
                    .replace('{processId}', processResult.process_id)
                    .replace('{alliance}', alliance.name)
                    .replace('{playerCount}', playerCount)
                    .replace('{priority}', processResult.priority)
                    .replace('{status}', queueResult.status),
            }
        ])
        .setTimestamp();

    // Add existing players info if any were filtered out
    if (existingPlayers.length > 0) {
        embed.addFields([
            {
                name: lang.players.addPlayer.content.skippedExistingField.name.replace('{count}', existingPlayers.length),
                value: existingPlayers.slice(0, 5).map(p => lang.players.addPlayer.content.skippedExistingField.value
                    .replace('{nickname}', p.nickname)
                    .replace('{id}', p.id)
                    .replace('{alliance}', p.alliance)
                ).join('\n') +
                    (existingPlayers.length > 5 ? lang.players.addPlayer.content.moreThanTen.replace('{count}', existingPlayers.length - 5) : ''),

            }
        ]);
    }

    return embed;
}

module.exports = {
    createAddPlayerButton,
    handleAddPlayerButton,
    handleAllianceSelection,
    handlePlayerFormButton,
    handlePlayerIdModal,
    handleAddPlayerPagination
};