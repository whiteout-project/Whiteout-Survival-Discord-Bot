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
    SeparatorSpacingSize,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    LabelBuilder
} = require('discord.js');
const { allianceQueries, idChannelQueries, giftCodeChannelQueries, adminLogQueries } = require('../utility/database');
const { LOG_CODES } = require('../utility/AdminLogs');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { createProcess } = require('../Processes/createProcesses');
const { queueManager } = require('../Processes/queueManager');
const { hasPermission, handleError, getUserInfo, assertUserMatches, getAlliancesForUser, updateComponentsV2AfterSeparator, createAllianceSelectionComponents } = require('../utility/commonFunctions');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { getEmojiMapForUser, getComponentEmoji, getGlobalEmojiMap } = require('../utility/emojis');

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
            const existing = global.idChannelCache.get(channel.channel_id) || [];
            existing.push({
                alliance_id: channel.alliance_id,
                guild_id: channel.guild_id,
                id: channel.id
            });
            global.idChannelCache.set(channel.channel_id, existing);
        });

    } catch (error) {
        await handleError(null, null, error, 'initializeIdChannelCache', false);
        throw error;
    }
}

/**
 * Updates the cache when an ID channel is added
 * @param {string} channelId - Discord channel ID
 * @param {Object|null} data - Channel data to add, or null to remove all entries
 */
function updateIdChannelCache(channelId, data) {
    if (data) {
        const existing = global.idChannelCache.get(channelId) || [];
        existing.push(data);
        global.idChannelCache.set(channelId, existing);

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
 * Removes a specific entry from the cache by database ID
 * @param {string} channelId - Discord channel ID
 * @param {number} dbId - Database row ID to remove
 */
function removeFromIdChannelCache(channelId, dbId) {
    const existing = global.idChannelCache.get(channelId);
    if (!existing) return;

    const filtered = existing.filter(e => e.id !== dbId);
    if (filtered.length === 0) {
        global.idChannelCache.delete(channelId);
    } else {
        global.idChannelCache.set(channelId, filtered);
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
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1014'));
}

/**
 * Handles the ID channel management button interaction
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleIdChannelButton(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
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
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1000'));

        const removeButton = new ButtonBuilder()
            .setCustomId(`id_channel_remove_${interaction.user.id}`)
            .setLabel(lang.players.idChannel.buttons.remove)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1031'));

        const autoCleanButton = new ButtonBuilder()
            .setCustomId(`id_channel_autoclean_${interaction.user.id}`)
            .setLabel(lang.players.idChannel.buttons.autoClean)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1033'));

        const row = new ActionRowBuilder().addComponents(addButton, removeButton, autoCleanButton);

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
        await handleError(interaction, lang, error, 'handleIdChannelButton');
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
            emoji: getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1031')
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
    const { adminData, lang } = getUserInfo(interaction.user.id);
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
        await handleError(interaction, lang, error, 'handleIdChannelPagination');
    }
}

/**
 * Handles ID channel remove pagination
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleIdChannelRemovePagination(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
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
        await handleError(interaction, lang, error, 'handleIdChannelRemovePagination');
    }
}

/**
 * Handles the Add Channel button
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleIdChannelAdd(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
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
        await handleError(interaction, lang, error, 'handleIdChannelAdd');
    }
}

/**
 * Handles the Remove Channel button
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleIdChannelRemove(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
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
        await handleError(interaction, lang, error, 'handleIdChannelRemove');
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
    const { adminData, lang } = getUserInfo(interaction.user.id);
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

        // Update cache - remove only this specific entry
        removeFromIdChannelCache(channelData.channel_id, selectedId);

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
        await handleError(interaction, lang, error, 'handleIdChannelRemoveSelect');
    }
}

/**
 * Handles the alliance selection for ID channel
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleIdChannelAllianceSelection(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
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
        await handleError(interaction, lang, error, 'handleIdChannelAllianceSelection');
    }
}

/**
 * Handles channel selection for ID channel
 * @param {import('discord.js').ChannelSelectMenuInteraction} interaction 
 */
async function handleIdChannelSelect(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);

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

        // Check if this specific alliance is already linked to this channel
        const existingChannels = idChannelQueries.getChannelsByChannelId(selectedChannel.id);
        if (existingChannels.some(ch => ch.alliance_id === allianceId)) {
            return await interaction.reply({
                content: lang.players.idChannel.errors.channelAlreadyLinked
                    .replace('{channel}', `<#${selectedChannel.id}>`)
                    .replace('{alliance}', alliance.name),
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
            await handleError(interaction, lang, dbError, 'handleIdChannelSelect_DBSaveError');
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
        await handleError(interaction, lang, error, 'handleIdChannelSelect');
    }
}

/**
 * Handles messages in ID channels - USES PROCESS SYSTEM
 * Supports multiple alliances linked to the same channel
 * @param {import('discord.js').Message} message 
 */
async function handleIdChannelMessage(message) {
    // Ignore bot messages
    if (message.author.bot) return;

    const { lang } = getUserInfo(message.author.id);
    const emojiMap = getEmojiMapForUser(message.author.id);

    try {
        // Check cache first (no DB query for non-ID channels)
        const channelEntries = global.idChannelCache.get(message.channel.id);
        if (!channelEntries || channelEntries.length === 0) return; // Not an ID channel

        // Sanitize and validate player IDs from message
        const sanitizedPlayerIds = sanitizePlayerIds(message.content);
        if (!sanitizedPlayerIds) return; // Invalid format - ignore silently

        // Early check: if ALL players already exist, show embed immediately (skip alliance selection)
        const playerIdsArray = sanitizedPlayerIds.split(',');
        const { playerQueries } = require('../utility/database');
        const existingPlayers = [];

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

        if (existingPlayers.length === playerIdsArray.length && existingPlayers.length > 0) {
            await message.react(emojiMap['1017'] || 'ℹ️');

            const embed = new EmbedBuilder()
                .setTitle(lang.players.idChannel.content.title.allExist)
                .setDescription(lang.players.idChannel.content.description.allExist)
                .setColor(0xffa500)
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

        // Get valid alliances from cache entries
        const alliances = channelEntries
            .map(entry => allianceQueries.getAllianceById(entry.alliance_id))
            .filter(Boolean);

        if (alliances.length === 0) return;

        if (alliances.length === 1) {
            // Single alliance - proceed directly
            await processIdChannelPlayers(message, alliances[0], sanitizedPlayerIds, lang, emojiMap);
        } else {
            // Multiple alliances - show selection
            const { embeds, components } = createMessageAllianceSelection(
                alliances, message.author.id, message.id, lang, 0
            );
            await message.reply({ embeds, components });
        }

    } catch (error) {
        await handleError(null, lang, error, 'handleIdChannelMessage', false);
        try {
            await message.reactions.cache.get('⏳')?.users.remove(message.client.user.id);
            await message.react(getComponentEmoji(getGlobalEmojiMap(), '1051'));
        } catch (reactionError) {
            await handleError(null, lang, reactionError, 'handleIdChannelMessage', false);
        }
    }
}

/**
 * Processes player IDs for a specific alliance in an ID channel
 * Shared logic for both single-alliance (direct) and multi-alliance (after selection) flows
 * @param {import('discord.js').Message} message - Original user message with player IDs
 * @param {Object} alliance - Alliance object from database
 * @param {string} sanitizedPlayerIds - Comma-separated sanitized player IDs
 * @param {Object} lang - Language object
 * @param {Object} emojiMap - Emoji map for reactions
 * @param {string|null} replyMessageId - Bot's reply message ID to edit with results (multi-alliance flow)
 */
async function processIdChannelPlayers(message, alliance, sanitizedPlayerIds, lang, emojiMap, replyMessageId = null) {
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
        await message.react(emojiMap['1017'] || 'ℹ️');

        const embed = new EmbedBuilder()
            .setTitle(lang.players.idChannel.content.title.allExist)
            .setDescription(lang.players.idChannel.content.description.allExist)
            .setColor(0xffa500)
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

        if (replyMessageId) {
            const replyMessage = await message.channel.messages.fetch(replyMessageId);
            await replyMessage.edit({ embeds: [embed] });
        } else {
            await message.reply({ embeds: [embed] });
        }
        return;
    }

    // React to message to show processing
    await message.react('⏳');

    // Create process with ALL players (including existing ones)
    const processResult = await createProcess({
        admin_id: String(message.author.id),
        alliance_id: alliance.id,
        player_ids: sanitizedPlayerIds,
        action: 'addplayer',
        id_channel_message_id: message.id,
        id_channel_channel_id: message.channel.id,
        id_channel_reply_id: replyMessageId
    });

    // Remove processing reaction
    await message.reactions.cache.get('⏳')?.users.remove(message.client.user.id);

    // Add success reaction
    await message.react(getComponentEmoji(getGlobalEmojiMap(), '1004'));

    // Manage queue to start execution
    await queueManager.manageQueue(processResult);
}

/**
 * Creates the alliance selection embed and components for the message flow
 * @param {Array} alliances - Array of alliance objects
 * @param {string} userId - User ID who can interact
 * @param {string} originalMsgId - Original message ID containing player IDs
 * @param {Object} lang - Language object
 * @param {number} page - Current page (0-indexed)
 * @returns {Object} { embeds, components }
 */
function createMessageAllianceSelection(alliances, userId, originalMsgId, lang, page = 0) {
    const itemsPerPage = 24;
    const totalPages = Math.ceil(alliances.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const currentPageAlliances = alliances.slice(startIndex, startIndex + itemsPerPage);

    const options = currentPageAlliances.map(alliance => ({
        label: alliance.name,
        value: alliance.id.toString(),
        emoji: getComponentEmoji(getEmojiMapForUser(userId), '1001')
    }));

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`id_channel_msg_select_${originalMsgId}_${page}_${userId}`)
        .setPlaceholder(lang.players.idChannel.selectMenu.selectAllianceMessage.placeholder)
        .addOptions(options);

    const selectRow = new ActionRowBuilder().addComponents(selectMenu);
    const components = [selectRow];

    if (totalPages > 1) {
        const paginationRow = createUniversalPaginationButtons({
            feature: 'id_channel_msg',
            userId: userId,
            currentPage: page,
            totalPages,
            lang,
            contextData: [originalMsgId]
        });
        if (paginationRow) components.push(paginationRow);
    }

    const embed = new EmbedBuilder()
        .setTitle(lang.players.idChannel.content.title.selectAllianceMessage)
        .setDescription(lang.players.idChannel.content.description.selectAllianceMessage)
        .setColor(0x3498db);

    return { embeds: [embed], components };
}

/**
 * Handles alliance selection from the message flow (multi-alliance channel)
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleIdChannelMessageAllianceSelect(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    const emojiMap = getEmojiMapForUser(interaction.user.id);

    try {
        // customId: id_channel_msg_select_{originalMsgId}_{page}_{userId}
        const parts = interaction.customId.split('_');
        const originalMsgId = parts[4];
        const expectedUserId = parts[6];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const selectedAllianceId = parseInt(interaction.values[0]);
        const alliance = allianceQueries.getAllianceById(selectedAllianceId);
        if (!alliance) {
            return await interaction.reply({
                content: lang.players.idChannel.errors.notFound,
                ephemeral: true
            });
        }

        // Fetch the original user message
        let originalMessage;
        try {
            originalMessage = await interaction.channel.messages.fetch(originalMsgId);
        } catch {
            return await interaction.reply({
                content: lang.players.idChannel.errors.messageNotFound,
                ephemeral: true
            });
        }

        // Re-sanitize player IDs from original message
        const sanitizedPlayerIds = sanitizePlayerIds(originalMessage.content);
        if (!sanitizedPlayerIds) {
            return await interaction.reply({
                content: lang.players.idChannel.errors.invalidSelection,
                ephemeral: true
            });
        }

        // Update the bot's reply to confirm alliance selection - remove select menu
        const playerCount = sanitizedPlayerIds.split(',').length;
        const replyMessageId = interaction.message.id;
        await interaction.update({
            embeds: [
                new EmbedBuilder()
                    .setDescription(
                        lang.players.idChannel.content.description.allianceSelected
                            .replace('{alliance}', alliance.name)
                            .replace('{count}', playerCount)
                    )
                    .setColor(0x3498db)
            ],
            components: []
        });

        // Process the players - pass replyMessageId so results edit this message
        await processIdChannelPlayers(originalMessage, alliance, sanitizedPlayerIds, lang, emojiMap, replyMessageId);

    } catch (error) {
        await handleError(interaction, lang, error, 'handleIdChannelMessageAllianceSelect');
    }
}

/**
 * Handles pagination for the message flow alliance selection
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleIdChannelMessagePagination(interaction) {
    const { lang } = getUserInfo(interaction.user.id);

    try {
        const { userId: expectedUserId, newPage, contextData } = parsePaginationCustomId(interaction.customId, 1);

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const originalMsgId = contextData[0];

        // Get alliances for this channel from cache
        const channelEntries = global.idChannelCache.get(interaction.channel.id);
        if (!channelEntries || channelEntries.length <= 1) {
            return await interaction.reply({
                content: lang.players.idChannel.errors.noAlliances,
                ephemeral: true
            });
        }

        const alliances = channelEntries
            .map(entry => allianceQueries.getAllianceById(entry.alliance_id))
            .filter(Boolean);

        const { embeds, components } = createMessageAllianceSelection(
            alliances, interaction.user.id, originalMsgId, lang, newPage
        );

        await interaction.update({ embeds, components });

    } catch (error) {
        await handleError(interaction, lang, error, 'handleIdChannelMessagePagination');
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

// ─── Auto Clean Feature ───────────────────────────────────────────────────────

/**
 * Handles the Auto Clean button - shows channel selection
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleAutoCleanButton(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[3]; // id_channel_autoclean_userId
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.PLAYER_MANAGEMENT);
        if (!hasAccess) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        const idChannels = getIdChannelsForUser(adminData);
        if (idChannels.length === 0) {
            return await interaction.reply({ content: lang.players.idChannel.autoClean.errors.noChannels, ephemeral: true });
        }

        const { components } = createAutoCleanChannelSelection(interaction, idChannels, lang, 0);

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleAutoCleanButton');
    }
}

/**
 * Creates the auto-clean channel selection container with pagination
 * @param {import('discord.js').Interaction} interaction
 * @param {Array} idChannels - Array of ID channel objects
 * @param {Object} lang - Language object
 * @param {number} page - Current page
 * @returns {Object} { components }
 */
function createAutoCleanChannelSelection(interaction, idChannels, lang, page = 0) {
    const itemsPerPage = 24;
    const totalPages = Math.ceil(idChannels.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const currentPageChannels = idChannels.slice(startIndex, startIndex + itemsPerPage);

    const options = currentPageChannels.map(channel => {
        const discordChannel = interaction.guild.channels.cache.get(channel.channel_id);
        const channelName = discordChannel ? discordChannel.name : 'Unknown Channel';
        const statusText = channel.auto_clean > 0
            ? lang.players.idChannel.autoClean.selectMenu.currentInterval.replace('{minutes}', channel.auto_clean)
            : lang.players.idChannel.autoClean.selectMenu.disabled;
        return {
            label: `${channel.alliance_name} - #${channelName}`,
            value: channel.id.toString(),
            description: statusText,
            emoji: getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1014')
        };
    });

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`id_channel_autoclean_select_${interaction.user.id}_${page}`)
        .setPlaceholder(lang.players.idChannel.autoClean.selectMenu.placeholder)
        .addOptions(options);

    const selectRow = new ActionRowBuilder().addComponents(selectMenu);

    const paginationRow = totalPages > 1
        ? createUniversalPaginationButtons({
            feature: 'id_channel_autoclean',
            userId: interaction.user.id,
            currentPage: page,
            totalPages: totalPages,
            lang: lang
        })
        : null;

    const container = new ContainerBuilder()
        .setAccentColor(0x3498db)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `${lang.players.idChannel.autoClean.content.title}\n${lang.players.idChannel.autoClean.content.description}`
            )
        )
        .addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        )
        .addActionRowComponents(selectRow);

    if (paginationRow) container.addActionRowComponents(paginationRow);

    const components = updateComponentsV2AfterSeparator(interaction, [container]);
    return { components };
}

/**
 * Handles auto-clean channel selection pagination
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleAutoCleanPagination(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const { userId: expectedUserId, newPage } = parsePaginationCustomId(interaction.customId, 0);
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const idChannels = getIdChannelsForUser(adminData);
        if (idChannels.length === 0) {
            return await interaction.reply({ content: lang.players.idChannel.autoClean.errors.noChannels, ephemeral: true });
        }

        const { components } = createAutoCleanChannelSelection(interaction, idChannels, lang, newPage);

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleAutoCleanPagination');
    }
}

/**
 * Handles auto-clean channel dropdown selection - shows Set/Disable buttons
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleAutoCleanSelect(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_'); // id_channel_autoclean_select_userId_page
        const expectedUserId = parts[4];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.PLAYER_MANAGEMENT);
        if (!hasAccess) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        const channelDbId = interaction.values[0];
        const channelData = idChannelQueries.getChannelById(parseInt(channelDbId));
        if (!channelData) {
            return await interaction.reply({ content: lang.players.idChannel.autoClean.errors.channelNotFound, ephemeral: true });
        }

        const discordChannel = interaction.guild.channels.cache.get(channelData.channel_id);
        const channelName = discordChannel ? discordChannel.name : 'Unknown Channel';
        const currentInterval = channelData.auto_clean || 0;

        const statusText = currentInterval > 0
            ? lang.players.idChannel.autoClean.content.currentInterval.replace('{minutes}', currentInterval)
            : lang.players.idChannel.autoClean.content.disabled;

        const setButton = new ButtonBuilder()
            .setCustomId(`id_channel_autoclean_set_${channelDbId}_${interaction.user.id}`)
            .setLabel(lang.players.idChannel.autoClean.buttons.set)
            .setStyle(ButtonStyle.Success)
            .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1004'));

        const disableButton = new ButtonBuilder()
            .setCustomId(`id_channel_autoclean_disable_${channelDbId}_${interaction.user.id}`)
            .setLabel(lang.players.idChannel.autoClean.buttons.disable)
            .setStyle(ButtonStyle.Danger)
            .setDisabled(currentInterval === 0)
            .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1051'));

        const row = new ActionRowBuilder().addComponents(setButton, disableButton);

        const container = [
            new ContainerBuilder()
                .setAccentColor(0x3498db)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.players.idChannel.autoClean.content.title}\n**#${channelName}**\n${statusText}`
                    )
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                )
                .addActionRowComponents(row)
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);
        await interaction.update({ components: content, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleAutoCleanSelect');
    }
}

/**
 * Handles the Set button — shows modal with interval input
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleAutoCleanSetButton(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_'); // id_channel_autoclean_set_channelDbId_userId
        const channelDbId = parts[4];
        const expectedUserId = parts[5];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const channelData = idChannelQueries.getChannelById(parseInt(channelDbId));
        const currentInterval = channelData?.auto_clean || 0;

        const modal = new ModalBuilder()
            .setCustomId(`id_channel_autoclean_modal_${channelDbId}_${interaction.user.id}`)
            .setTitle(lang.players.idChannel.autoClean.modal.title);

        const intervalInput = new TextInputBuilder()
            .setCustomId('auto_clean_interval')
            .setPlaceholder(lang.players.idChannel.autoClean.modal.placeholder)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(6);

        if (currentInterval > 0) {
            intervalInput.setValue(String(currentInterval));
        }

        const label = new LabelBuilder()
            .setLabel(lang.players.idChannel.autoClean.modal.label)
            .setTextInputComponent(intervalInput);

        modal.addLabelComponents(label);
        await interaction.showModal(modal);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleAutoCleanSetButton');
    }
}

/**
 * Handles the auto-clean modal submission
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleAutoCleanModal(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_'); // id_channel_autoclean_modal_channelDbId_userId
        const channelDbId = parseInt(parts[4]);
        const expectedUserId = parts[5];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.PLAYER_MANAGEMENT);
        if (!hasAccess) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        const rawInterval = interaction.fields.getTextInputValue('auto_clean_interval');
        const interval = parseInt(rawInterval, 10);

        if (isNaN(interval) || interval < 1) {
            return await interaction.reply({
                content: lang.players.idChannel.autoClean.errors.invalidInterval,
                ephemeral: true
            });
        }

        const channelData = idChannelQueries.getChannelById(channelDbId);
        if (!channelData) {
            return await interaction.reply({ content: lang.players.idChannel.autoClean.errors.channelNotFound, ephemeral: true });
        }

        idChannelQueries.updateAutoClean(interval, channelDbId);

        // Update the scheduler
        const { autoCleanScheduler } = require('./idChannelAutoClean');
        autoCleanScheduler.scheduleChannel(channelData.channel_id, interval);

        const container = [
            new ContainerBuilder()
                .setAccentColor(0x00ff00)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        lang.players.idChannel.autoClean.content.setSuccess
                            .replace('{minutes}', interval)
                            .replace('{channel}', channelData.channel_id)
                    )
                )
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);
        await interaction.update({ components: content, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleAutoCleanModal');
    }
}

/**
 * Handles the Disable button — sets auto_clean to 0
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleAutoCleanDisable(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_'); // id_channel_autoclean_disable_channelDbId_userId
        const channelDbId = parseInt(parts[4]);
        const expectedUserId = parts[5];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.PLAYER_MANAGEMENT);
        if (!hasAccess) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        const channelData = idChannelQueries.getChannelById(channelDbId);
        if (!channelData) {
            return await interaction.reply({ content: lang.players.idChannel.autoClean.errors.channelNotFound, ephemeral: true });
        }

        idChannelQueries.updateAutoClean(0, channelDbId);

        // Remove from scheduler
        const { autoCleanScheduler } = require('./idChannelAutoClean');
        autoCleanScheduler.cancelChannel(channelData.channel_id);

        const container = [
            new ContainerBuilder()
                .setAccentColor(0xff0000)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        lang.players.idChannel.autoClean.content.disableSuccess
                            .replace('{channel}', channelData.channel_id)
                    )
                )
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);
        await interaction.update({ components: content, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleAutoCleanDisable');
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
    handleIdChannelMessageAllianceSelect,
    handleIdChannelMessagePagination,
    initializeIdChannelCache,
    updateIdChannelCache,
    removeFromIdChannelCache,
    handleAutoCleanButton,
    handleAutoCleanPagination,
    handleAutoCleanSelect,
    handleAutoCleanSetButton,
    handleAutoCleanModal,
    handleAutoCleanDisable
};
