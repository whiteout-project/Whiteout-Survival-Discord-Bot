const {
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    ChannelType,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize
} = require('discord.js');
const { allianceQueries, idChannelQueries, giftCodeChannelQueries, adminLogQueries } = require('../utility/database');
const { LOG_CODES } = require('../utility/AdminLogs');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { createProcess } = require('../Processes/createProcesses');
const { queueManager } = require('../Processes/queueManager');
const { hasPermission, sendError, getAdminLang, assertUserMatches, updateComponentsV2AfterSeparator, createAllianceSelectionComponents } = require('../utility/commonFunctions');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../utility/emojis');

// Global cache for ID channels
global.idChannelCache = new Map();

// Maximum cache size to prevent unbounded growth
const MAX_ID_CHANNEL_CACHE_SIZE = 1000;

/**
 * Loads all ID channels into memory cache
 * @returns {Promise<void>}
 */
async function initializeIdChannelCache() {
    try {
        const allIdChannels = idChannelQueries.getAllChannels();

        global.idChannelCache.clear();
        allIdChannels.forEach(channel => {
            global.idChannelCache.set(channel.channel_id, {
                alliance_id: channel.alliance_id,
                guild_id: channel.guild_id,
                id: channel.id
            });
        });

    } catch (error) {
        await sendError(null, null, error, 'initializeIdChannelCache', false);
        throw error;
    }
}

/**
 * Updates the cache when ID channels are added/removed
 * @param {string} channelId - Channel ID
 * @param {Object|null} data - Channel data or null to remove
 */
function updateIdChannelCache(channelId, data) {
    if (data) {
        global.idChannelCache.set(channelId, data);

        // Evict oldest entries if cache exceeds maximum size
        while (global.idChannelCache.size > MAX_ID_CHANNEL_CACHE_SIZE) {
            const oldestKey = global.idChannelCache.keys().next().value;
            global.idChannelCache.delete(oldestKey);
            console.warn(`ID Channel cache evicted oldest entry: ${oldestKey}`);
        }
    } else {
        global.idChannelCache.delete(channelId);
    }
}

/**
 * NOTE: API configuration removed - now uses process system
 * See fetchPlayerData.js for API handling with retry logic and rate limiting
 */

/**
 * Creates the ID channel management button
 * @param {string} userId - User ID who can interact with the button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} ID channel button
 */
function createIdChannelButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`id_channel_manage_${userId}`)
        .setLabel(lang.players.mainPage.buttons.idChannel)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1014'));
}

/**
 * Handles the ID channel management button interaction
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleIdChannelButton(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[3]; // id_channel_manage_userId

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

        // Create Add and Remove buttons
        const addButton = new ButtonBuilder()
            .setCustomId(`id_channel_add_${interaction.user.id}`)
            .setLabel(lang.players.idChannel.buttons.add)
            .setStyle(ButtonStyle.Success)
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1000'));

        const removeButton = new ButtonBuilder()
            .setCustomId(`id_channel_remove_${interaction.user.id}`)
            .setLabel(lang.players.idChannel.buttons.remove)
            .setStyle(ButtonStyle.Danger)
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1031'));

        const row = new ActionRowBuilder().addComponents(addButton, removeButton);

        const container = [
            new ContainerBuilder()
                .setAccentColor(0x3498db) // Blue
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.players.idChannel.content.title.base}\n` +
                        `${lang.players.idChannel.content.description.base}`
                    )
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
                )
                .addActionRowComponents(row)
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        // Send or update the message
        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });


    } catch (error) {
        await sendError(interaction, lang, error, 'handleIdChannelButton');
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
            const allianceIds = JSON.parse(adminData.alliances || '[]');
            return allianceIds
                .map(id => allianceQueries.getAllianceById(id))
                .filter(alliance => alliance !== undefined);
        }

        return [];
    } catch (error) {
        console.error('Error getting alliances for user:', error);
        return [];
    }
}

/**
 * Creates the channel removal embed and dropdown
 * @param {import('discord.js').ButtonInteraction} interaction - The interaction object
 * @param {Array} idChannels - Array of ID channel objects
 * @param {Object} lang - Language object
 * @param {number} page - Current page number (default 0)
 * @returns {Object} Embed and components
 */
function createChannelRemovalContainer(interaction, idChannels, lang, page = 0) {
    const itemsPerPage = 24;
    const totalPages = Math.ceil(idChannels.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const currentPageChannels = idChannels.slice(startIndex, endIndex);

    // Create dropdown options
    const options = currentPageChannels.map(channel => {
        const discordChannel = interaction.guild.channels.cache.get(channel.channel_id);
        const channelName = discordChannel ? discordChannel.name : 'Unknown Channel';
        return {
            label: `${channel.alliance_name}`,
            value: channel.id.toString(),
            description: lang.players.idChannel.selectMenu.selectChannel.description.replace('{channelName}', channelName),
            emoji: getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1031')
        };
    });

    // Create dropdown menu
    const channelSelect = new StringSelectMenuBuilder()
        .setCustomId(`id_channel_remove_select_${interaction.user.id}_${page}`)
        .setPlaceholder(lang.players.idChannel.selectMenu.selectChannel.placeholder)
        .addOptions(options);

    // Create action rows
    const selectMenuRow = new ActionRowBuilder().addComponents(channelSelect);
    const components = [];

    // Always add pagination buttons if the row exists (they are disabled when not needed)
    const paginationRow = createUniversalPaginationButtons({
        feature: 'id_channel_remove',
        userId: interaction.user.id,
        currentPage: page,
        totalPages: totalPages,
        lang: lang
    });
    if (paginationRow) {
        components.push(paginationRow);
    }
    components.push(selectMenuRow);

    const container = [
        new ContainerBuilder()
            .setAccentColor(0xff6b6b) // Red
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.players.idChannel.content.title.remove}` +
                    `\n${lang.players.idChannel.content.description.remove}` +
                    `\n${lang.pagination.text.pageInfo}`
                        .replace('{current}', (page + 1).toString())
                        .replace('{total}', totalPages.toString())
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
            )
            .addActionRowComponents(components)
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    return { components: content };
}

/**
 * Creates alliance selection embed using shared utility
 */
function createAllianceSelectionContainer(interaction, alliances, lang, page = 0) {
    return createAllianceSelectionComponents({
        interaction,
        alliances,
        lang,
        page,
        customIdPrefix: 'id_channel_alliance_select',
        feature: 'id_channel',
        placeholder: lang.players.idChannel.selectMenu.selectAlliance.placeholder,
        title: lang.players.idChannel.content.title.base,
        description: lang.players.idChannel.content.description.selectAlliance,
        accentColor: 0x3498db, // Blue
        showAll: false
    });
}

/**
 * Handles ID channel pagination
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleIdChannelPagination(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID and page from custom ID
        const { userId: expectedUserId, newPage } = parsePaginationCustomId(interaction.customId, 0);

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Get alliances based on user permissions
        const alliances = getAlliancesForUser(adminData);
        if (alliances.length === 0) {
            return await interaction.reply({
                content: lang.players.idChannel.errors.noAlliances,
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
        await sendError(interaction, lang, error, 'handleIdChannelPagination');
    }
}

/**
 * Handles ID channel remove pagination
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleIdChannelRemovePagination(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID and page from custom ID
        const { userId: expectedUserId, newPage } = parsePaginationCustomId(interaction.customId, 0);

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Get ID channels for user's alliances
        const idChannels = getIdChannelsForUser(adminData);
        if (idChannels.length === 0) {
            return await interaction.reply({
                content: lang.players.idChannel.errors.noChannelsToRemove,
                ephemeral: true
            });
        }

        // Create channel removal embed and dropdown for new page
        const { components } = createChannelRemovalContainer(interaction, idChannels, lang, newPage);

        // Update the message
        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleIdChannelRemovePagination');
    }
}

/**
 * Handles the Add Channel button
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleIdChannelAdd(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[3]; // id_channel_add_userId

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
        const alliances = getAlliancesForUser(adminData);

        if (alliances.length === 0) {
            return await interaction.reply({
                content: lang.players.idChannel.errors.noAlliances,
                ephemeral: true
            });
        }

        // Create alliance selection embed and dropdown with pagination (page 0)
        const { components } = createAllianceSelectionContainer(interaction, alliances, lang);

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });


    } catch (error) {
        await sendError(interaction, lang, error, 'handleIdChannelAdd');
    }
}

/**
 * Handles the Remove Channel button
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleIdChannelRemove(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[3]; // id_channel_remove_userId

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

        // Get ID channels for user's alliances
        const idChannels = getIdChannelsForUser(adminData);

        if (idChannels.length === 0) {
            return await interaction.reply({
                content: lang.players.idChannel.errors.noChannelsToRemove,
                ephemeral: true
            });
        }

        // Create channel selection embed and dropdown with pagination (page 0)
        const { components } = createChannelRemovalContainer(interaction, idChannels, lang);

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleIdChannelRemove');
    }
}

/**
 * Gets ID channels available to a user based on their permissions
 * @param {Object} adminData - Admin data from database
 * @returns {Array} Array of ID channel objects with alliance info
 */
function getIdChannelsForUser(adminData) {
    try {
        let alliances;
        // Owner and full access can see all alliances
        if (adminData.is_owner || (adminData.permissions & PERMISSIONS.FULL_ACCESS)) {
            alliances = allianceQueries.getAllAlliances();
        } else if (adminData.permissions & PERMISSIONS.PLAYER_MANAGEMENT) {
            const allianceIds = JSON.parse(adminData.alliances || '[]');
            alliances = allianceIds
                .map(id => allianceQueries.getAllianceById(id))
                .filter(alliance => alliance !== undefined);
        } else {
            return [];
        }

        // Get ID channels for these alliances
        const allianceIds = alliances.map(a => a.id);
        const idChannels = idChannelQueries.getChannelsByAllianceIds(allianceIds);

        // Enrich with alliance names and channel names (if available)
        return idChannels.map(channel => {
            const alliance = alliances.find(a => a.id === channel.alliance_id);
            return {
                ...channel,
                alliance_name: alliance?.name || 'Unknown Alliance',
                channel_name: 'Unknown' // Could fetch from Discord API if needed, but keeping simple
            };
        });
    } catch (error) {
        console.error('Error in getIdChannelsForUser:', error);
        return [];
    }
}

/**
 * Handles the channel removal selection
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleIdChannelRemoveSelect(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID: id_channel_remove_select_userId_page
        const parts = interaction.customId.split('_');
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

        // Get selected channel ID
        const selectedId = parseInt(interaction.values[0]);
        const channelData = idChannelQueries.getChannelById(selectedId);

        if (!channelData) {
            return await interaction.reply({
                content: lang.players.idChannel.errors.channelNotFound,
                ephemeral: true
            });
        }

        // Verify user has access to this alliance
        const alliances = getAlliancesForUser(adminData);
        const hasAllianceAccess = alliances.some(a => a.id === channelData.alliance_id);

        if (!hasAllianceAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Remove from database
        idChannelQueries.removeIdChannel(selectedId);

        // Update cache
        updateIdChannelCache(channelData.channel_id, null);

        // Log the action
        adminLogQueries.addLog(
            adminData.user_id,
            LOG_CODES.SETTINGS.ID_CHANNEL_UNLINKED,
            JSON.stringify({
                channelId: channelData.channel_id,
                allianceId: channelData.alliance_id
            })
        );

        const container = [
            new ContainerBuilder()
                .setAccentColor(0x00ff00) // Green
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.players.idChannel.content.title.removeSuccess}` +
                        `\n${lang.players.idChannel.content.description.removeSuccess}`
                    )
                )
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });


    } catch (error) {
        await sendError(interaction, lang, error, 'handleIdChannelRemoveSelect');
    }
}

/**
 * Handles the alliance selection for ID channel
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleIdChannelAllianceSelection(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[4]; // id_channel_alliance_select_userId_page

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

        // Get selected alliance
        const selectedAllianceId = parseInt(interaction.values[0]);
        const alliance = allianceQueries.getAllianceById(selectedAllianceId);

        if (!alliance) {
            return await interaction.reply({
                content: lang.players.idChannel.errors.notFound,
                ephemeral: true
            });
        }

        // Create channel select menu (only text channels)
        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId(`id_channel_select_${selectedAllianceId}_${interaction.user.id}`)
            .setPlaceholder(lang.players.idChannel.selectMenu.selectChannel.placeholder)
            .setChannelTypes(ChannelType.GuildText);

        const components = [new ActionRowBuilder().addComponents(channelSelect)];

        const container = [
            new ContainerBuilder()
                .setAccentColor(0x3498db) // Blue
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.players.idChannel.content.title.channelID}` +
                        `\n${lang.players.idChannel.content.description.channelID.replace('{alliance}', alliance.name)}`
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
        await sendError(interaction, lang, error, 'handleIdChannelAllianceSelection');
    }
}

/**
 * Handles channel selection for ID channel
 * @param {import('discord.js').ChannelSelectMenuInteraction} interaction 
 */
async function handleIdChannelSelect(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        // Extract alliance ID and user ID from custom ID
        const parts = interaction.customId.split('_'); // id_channel_select_allianceId_userId
        const allianceId = parseInt(parts[3]);
        const expectedUserId = parts[4];

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

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
                content: lang.players.idChannel.errors.notFound,
                embeds: [],
                components: []
            });
        }

        // Get selected channel
        const selectedChannel = interaction.channels.first();
        if (!selectedChannel) {
            return await interaction.reply({
                content: lang.players.idChannel.errors.invalidSelection,
                ephemeral: true
            });
        }

        // Check if this channel is already a gift code channel
        const isGiftCodeChannel = giftCodeChannelQueries.getChannelByChannelId(selectedChannel.id);
        if (isGiftCodeChannel) {
            return await interaction.reply({
                content: lang.players.idChannel.errors.channelIsGiftCodeChannel
                    .replace('{channel}', `<#${selectedChannel.id}>`),
                ephemeral: true
            });
        }

        // Check if this channel is already linked to ANY alliance
        const existingChannel = idChannelQueries.getChannelByChannelId(selectedChannel.id);
        if (existingChannel) {
            const existingAlliance = allianceQueries.getAllianceById(existingChannel.alliance_id);
            const existingAllianceName = existingAlliance ? existingAlliance.name : 'Unknown Alliance';

            return await interaction.reply({
                content: lang.players.idChannel.errors.channelAlreadyLinked
                    .replace('{channel}', `<#${selectedChannel.id}>`)
                    .replace('{alliance}', existingAllianceName),
                ephemeral: true
            });
        }

        // Save to database
        try {
            idChannelQueries.addIdChannel(
                interaction.guild.id,
                allianceId,
                selectedChannel.id,
                adminData.id
            );

            adminLogQueries.addLog(
                adminData.user_id,
                LOG_CODES.SETTINGS.ID_CHANNEL_LINKED,
                JSON.stringify({
                    channelName: selectedChannel.name,
                    allianceName: alliance.name,
                    allianceId: alliance.id
                })
            );

            // Update cache with new channel
            updateIdChannelCache(selectedChannel.id, {
                alliance_id: allianceId,
                guild_id: interaction.guild.id,
                id: null // Will be set by DB, but not needed for cache
            });
        } catch (dbError) {
            await sendError(interaction, lang, dbError, 'handleIdChannelSelect_DBSaveError');
        }

        const container = [
            new ContainerBuilder()
                .setAccentColor(0x00ff00) // Green
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.players.idChannel.content.title.success}` +
                        `\n${lang.players.idChannel.content.description.success
                            .replace('{channel}', `<#${selectedChannel.id}>`)
                            .replace('{alliance}', alliance.name)}` +
                        `\n${lang.players.idChannel.content.formatField.name}` +
                        `\n${lang.players.idChannel.content.formatField.value}`
                    )
                )
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleIdChannelSelect');
    }
}

/**
 * Handles messages in ID channels - USES PROCESS SYSTEM
 * @param {import('discord.js').Message} message 
 */
async function handleIdChannelMessage(message) {
    // Ignore bot messages
    if (message.author.bot) return;

    const { lang } = getAdminLang(message.author.id);

    try {
        // Check cache first (no DB query for non-ID channels)
        const channelData = global.idChannelCache.get(message.channel.id);
        if (!channelData) return; // Not an ID channel

        // Get alliance from cache (avoid DB query)
        const alliance = allianceQueries.getAllianceById(channelData.alliance_id);
        if (!alliance) {
            console.error(`Alliance not found for cached ID channel: ${channelData.alliance_id}`);
            return;
        }

        // Sanitize and validate player IDs from message
        const sanitizedPlayerIds = sanitizePlayerIds(message.content);

        if (!sanitizedPlayerIds) {
            // Invalid format - ignore silently
            return;
        }

        // Check if ALL players already exist (for early exit embed only)
        const playerIdsArray = sanitizedPlayerIds.split(',');
        const existingPlayers = [];
        const { playerQueries } = require('../utility/database');

        for (const playerId of playerIdsArray) {
            const existingPlayer = playerQueries.getPlayer(playerId);
            if (existingPlayer) {
                existingPlayers.push({
                    id: playerId,
                    nickname: existingPlayer.nickname,
                    alliance: allianceQueries.getAllianceById(existingPlayer.alliance_id)?.name || 'Unknown'
                });
            }
        }

        // If ALL players already exist, show embed and return (no process needed)
        if (existingPlayers.length === playerIdsArray.length && existingPlayers.length > 0) {
            // React with info emoji to indicate all exist
            await message.react('ℹ️');

            // Send brief response
            const embed = new EmbedBuilder()
                .setTitle(lang.players.idChannel.content.title.allExist)
                .setDescription(lang.players.idChannel.content.description.allExist)
                .setColor(0xffa500) // Orange
                .addFields([
                    {
                        name: lang.players.idChannel.content.existingPlayersField.name,
                        value: existingPlayers.map(p => lang.players.idChannel.content.existingPlayersField.value
                            .replace('{nickname}', p.nickname)
                            .replace('{id}', p.id)
                            .replace('{alliance}', p.alliance)
                        ).join('\n').slice(0, 1024),

                    }
                ])
                .setFooter({ text: message.author.tag, iconURL: message.author.displayAvatarURL() })
                .setTimestamp();

            await message.reply({ embeds: [embed] });

            return;
        }

        // React to message to show processing
        await message.react('⏳');

        // Create process with ALL players (including existing ones)
        // fetchPlayerData.js will handle filtering and moving existing players to 'existing' status
        const processResult = await createProcess({
            admin_id: String(message.author.id),
            alliance_id: alliance.id,
            player_ids: sanitizedPlayerIds, // Use ALL player IDs
            action: 'addplayer',
            // Store ID channel message for result embed
            id_channel_message_id: message.id,
            id_channel_channel_id: message.channel.id
        });

        // Remove processing reaction
        await message.reactions.cache.get('⏳')?.users.remove(message.client.user.id);

        // Add success reaction only (no status embed in ID channel)
        await message.react(getComponentEmoji(getGlobalEmojiMap(), '1004'));

        // CRITICAL: Manage queue to start execution (same as addPlayer.js)
        // This call actually triggers the process to execute
        await queueManager.manageQueue(processResult);

    } catch (error) {
        await sendError(null, lang, error, 'handleIdChannelMessage', false);
        // Try to add error reaction
        try {
            await message.reactions.cache.get('⏳')?.users.remove(message.client.user.id);
            await message.react(getComponentEmoji(getGlobalEmojiMap(), '1051'));
        } catch (reactionError) {
            await sendError(null, lang, reactionError, 'handleIdChannelMessage', false);
        }
    }
}

/**
 * Sanitizes player IDs input (same logic as addPlayer.js)
 * @param {string} rawInput - Raw input from user
 * @returns {string|null} Sanitized player IDs or null if invalid
 */
function sanitizePlayerIds(rawInput) {
    try {
        // Split by commas, spaces, or newlines, then trim whitespace from each ID
        const ids = rawInput.split(/[\s,\n]+/).map(id => id.trim()).filter(id => id.length > 0);

        // Validate each ID
        const validIds = [];
        for (const id of ids) {
            // Check if ID is numeric and has reasonable length (6-15 digits)
            if (/^\d{6,15}$/.test(id)) {
                validIds.push(id);
            } else {
                // If any ID is invalid, return null (invalid format)
                return null;
            }
        }

        // Must have at least one valid ID
        if (validIds.length === 0) {
            return null;
        }

        // Return comma-separated string
        return validIds.join(',');

    } catch (error) {
        console.error('Error in sanitizePlayerIds:', error);
        return null;
    }
}

module.exports = {
    createIdChannelButton,
    handleIdChannelButton,
    handleIdChannelAdd,
    handleIdChannelRemove,
    handleIdChannelRemoveSelect,
    handleIdChannelPagination,
    handleIdChannelRemovePagination,
    handleIdChannelAllianceSelection,
    handleIdChannelSelect,
    handleIdChannelMessage,
    initializeIdChannelCache,
    updateIdChannelCache
};
