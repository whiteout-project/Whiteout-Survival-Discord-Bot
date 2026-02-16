const {
    ButtonBuilder,
    ButtonStyle,
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
const { giftCodeChannelQueries, giftCodeQueries, allianceQueries, playerQueries, systemLogQueries, idChannelQueries } = require('../utility/database');
const { createRedeemProcess } = require('./redeemFunction');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { hasPermission, sendError, getAdminLang, assertUserMatches, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../utility/emojis');

// Global cache for gift code channels
global.giftCodeChannelCache = new Map();

// Maximum cache size to prevent unbounded growth
const MAX_GIFT_CODE_CHANNEL_CACHE_SIZE = 1000;

/**
 * Loads all gift code channels into memory cache
 * @returns {Promise<void>}
 */
async function initializeGiftCodeChannelCache() {
    try {
        const allChannels = giftCodeChannelQueries.getAllChannels();

        global.giftCodeChannelCache.clear();
        allChannels.forEach(channel => {
            global.giftCodeChannelCache.set(channel.channel_id, {
                id: channel.id,
                channelId: channel.channel_id,
                linkedBy: channel.linked_by,
                createdAt: channel.created_at
            });
        });

    } catch (error) {
        await sendError(null, null, error, 'initializeGiftCodeChannelCache', false);
        throw error;
    }
}

/**
 * Updates the cache when gift code channels are added/removed
 * @param {string} channelId - Channel ID
 * @param {Object|null} data - Channel data or null to remove
 */
function updateGiftCodeChannelCache(channelId, data) {
    if (data) {
        global.giftCodeChannelCache.set(channelId, data);

        // Evict oldest entries if cache exceeds maximum size
        while (global.giftCodeChannelCache.size > MAX_GIFT_CODE_CHANNEL_CACHE_SIZE) {
            const oldestKey = global.giftCodeChannelCache.keys().next().value;
            global.giftCodeChannelCache.delete(oldestKey);
            console.warn(`Gift Code Channel cache evicted oldest entry: ${oldestKey}`);
        }
    } else {
        global.giftCodeChannelCache.delete(channelId);
    }
}

/**
 * Creates the gift code channel management button
 * @param {string} userId - User ID who can interact with the button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} Gift code channel button
 */
function createGiftCodeChannelButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`gift_code_channel_manage_${userId}`)
        .setLabel(lang.giftCode.giftCodeChannel.buttons.manageChannel)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1014'));
}

/**
 * Handles the gift code channel management button interaction
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleGiftCodeChannelButton(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[4]; // gift_code_channel_manage_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions: must be owner, have FULL_ACCESS, or have GIFT_CODE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Create Add and Remove buttons
        const addButton = new ButtonBuilder()
            .setCustomId(`gift_code_channel_add_${interaction.user.id}`)
            .setLabel(lang.giftCode.giftCodeChannel.buttons.add)
            .setStyle(ButtonStyle.Success)
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1000')); // plus emoji

        const removeButton = new ButtonBuilder()
            .setCustomId(`gift_code_channel_remove_${interaction.user.id}`)
            .setLabel(lang.giftCode.giftCodeChannel.buttons.remove)
            .setStyle(ButtonStyle.Danger)
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1031')); // minus emoji

        const row = new ActionRowBuilder().addComponents(addButton, removeButton);

        const container = [
            new ContainerBuilder()
                .setAccentColor(0x3498db) // blue
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.giftCode.giftCodeChannel.content.title.base}\n` +
                        `${lang.giftCode.giftCodeChannel.content.description.base}`
                    )
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                )
                .addActionRowComponents(row)
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleGiftCodeChannelButton');
    }
}

/**
 * Handles the Add Channel button
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleGiftCodeChannelAdd(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[4]; // gift_code_channel_add_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Create channel select menu
        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId(`gift_code_channel_select_${interaction.user.id}`)
            .setPlaceholder(lang.giftCode.giftCodeChannel.selectMenu.selectChannel.placeholder)
            .setChannelTypes([ChannelType.GuildText]);

        const selectRow = new ActionRowBuilder().addComponents(channelSelect);

        const container = [
            new ContainerBuilder()
                .setAccentColor(0x2ecc71) // green
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.giftCode.giftCodeChannel.content.title.add}\n` +
                        `${lang.giftCode.giftCodeChannel.content.description.add}`
                    )
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                )
                .addActionRowComponents(selectRow)
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleGiftCodeChannelAdd');
    }
}

/**
 * Handles the Remove Channel button
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleGiftCodeChannelRemove(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[4]; // gift_code_channel_remove_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get all gift code channels
        const giftCodeChannels = giftCodeChannelQueries.getAllChannels();

        if (!giftCodeChannels || giftCodeChannels.length === 0) {
            return await interaction.reply({
                content: lang.giftCode.giftCodeChannel.errors.noChannels,
                ephemeral: true
            });
        }

        // Create channel removal dropdown
        const { components } = createChannelRemovalContainer(interaction, giftCodeChannels, lang);

        await interaction.update({
            components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleGiftCodeChannelRemove');
    }
}

/**
 * Creates the channel removal container and dropdown
 * @param {import('discord.js').ButtonInteraction} interaction - The interaction object
 * @param {Array} giftCodeChannels - Array of gift code channel objects
 * @param {Object} lang - Language object
 * @returns {Object} Components
 */
function createChannelRemovalContainer(interaction, giftCodeChannels, lang) {
    // Create dropdown options with channel names
    const options = giftCodeChannels.map(channel => {
        // Try to get channel name from cache or Discord API
        let channelName = 'Unknown Channel';
        try {
            const discordChannel = interaction.guild.channels.cache.get(channel.channel_id);
            if (discordChannel) {
                channelName = discordChannel.name;
            } else {
                // Fallback to ID if channel not found
                channelName = `Channel ID: ${channel.channel_id}`;
            }
        } catch (error) {
            // Fallback to ID if error
            channelName = `Channel ID: ${channel.channel_id}`;
        }

        return {
            label: channelName,
            value: channel.id.toString(),
            emoji: getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1014')
        };
    });

    // Create dropdown menu
    const channelSelect = new StringSelectMenuBuilder()
        .setCustomId(`gift_code_channel_remove_select_${interaction.user.id}`)
        .setPlaceholder(lang.giftCode.giftCodeChannel.selectMenu.removeChannel.placeholder)
        .addOptions(options);

    const selectMenuRow = new ActionRowBuilder().addComponents(channelSelect);

    const container = [
        new ContainerBuilder()
            .setAccentColor(0xff6b6b) // red
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.giftCode.giftCodeChannel.content.title.remove}\n` +
                    `${lang.giftCode.giftCodeChannel.content.description.remove}`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addActionRowComponents(selectMenuRow)
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    return { components: content };
}

/**
 * Handles channel selection for gift code channel
 * @param {import('discord.js').ChannelSelectMenuInteraction} interaction 
 */
async function handleGiftCodeChannelSelect(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[4]; // gift_code_channel_select_userId

        // Security check
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const selectedChannelId = interaction.values[0];
        const selectedChannel = await interaction.guild.channels.fetch(selectedChannelId);

        if (!selectedChannel) {
            return await interaction.reply({
                content: lang.giftCode.giftCodeChannel.errors.channelNotFound,
                ephemeral: true
            });
        }

        // Check if channel is already an ID channel
        const isIdChannel = idChannelQueries.getChannelByChannelId(selectedChannelId);
        if (isIdChannel) {
            const alliance = allianceQueries.getAllianceById(isIdChannel.alliance_id);
            return await interaction.reply({
                content: lang.giftCode.giftCodeChannel.errors.channelIsIdChannel
                    .replace('{channel}', `<#${selectedChannelId}>`)
                    .replace('{alliance}', alliance?.name || 'Unknown Alliance'),
                ephemeral: true
            });
        }

        // Check if channel is already registered
        const existingChannel = giftCodeChannelQueries.getChannelByChannelId(selectedChannelId);
        if (existingChannel) {
            return await interaction.reply({
                content: lang.giftCode.giftCodeChannel.errors.channelAlreadyExists,
                ephemeral: true
            });
        }

        // Add channel to database
        giftCodeChannelQueries.addChannel(selectedChannelId, interaction.user.id);

        // Update cache
        const newChannelData = giftCodeChannelQueries.getChannelByChannelId(selectedChannelId);
        updateGiftCodeChannelCache(selectedChannelId, {
            id: newChannelData.id,
            channelId: newChannelData.channel_id,
            linkedBy: newChannelData.linked_by,
            createdAt: newChannelData.created_at
        });

        systemLogQueries.addLog(
            'info',
            `Gift code channel added: ${selectedChannel.name}`,
            JSON.stringify({
                channel_id: selectedChannelId,
                channel_name: selectedChannel.name,
                linked_by: interaction.user.id,
                function: 'handleGiftCodeChannelSelect'
            })
        );

        const container = [
            new ContainerBuilder()
                .setAccentColor(0x2ecc71) // green
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        lang.giftCode.giftCodeChannel.content.channelAdded
                            .replace('{channelID}', selectedChannel.id)
                    )
                )
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleGiftCodeChannelSelect');
    }
}

/**
 * Handles the channel removal selection
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleGiftCodeChannelRemoveSelect(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[5]; // gift_code_channel_remove_select_userId

        // Security check
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const selectedChannelId = parseInt(interaction.values[0]);
        const channelData = giftCodeChannelQueries.getChannelById(selectedChannelId);

        if (!channelData) {
            return await interaction.reply({
                content: lang.giftCode.giftCodeChannel.errors.channelNotFound,
                ephemeral: true
            });
        }

        // Remove from database
        giftCodeChannelQueries.deleteChannel(selectedChannelId);

        // Remove from cache
        updateGiftCodeChannelCache(channelData.channel_id, null);

        systemLogQueries.addLog(
            'info',
            `Gift code channel removed: ${channelData.channel_id}`,
            JSON.stringify({
                channel_id: channelData.channel_id,
                removed_by: interaction.user.id,
                function: 'handleGiftCodeChannelRemoveSelect'
            })
        );

        const container = [
            new ContainerBuilder()
                .setAccentColor(0xff6b6b) // red
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        lang.giftCode.giftCodeChannel.content.channelRemoved
                    )
                )
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleGiftCodeChannelRemoveSelect');
    }
}

/**
 * Handles messages in gift code channels
 * @param {import('discord.js').Message} message 
 */
async function handleGiftCodeChannelMessage(message) {
    // Ignore bot messages
    if (message.author.bot) return;

    const { lang } = getAdminLang(message.author.id);
    const emojiMap = getEmojiMapForAdmin(message.author.id);
    const receivedEmoji = emojiMap['1017'] || 'ℹ️';

    try {
        // Check if this channel is in the cache
        const channelData = global.giftCodeChannelCache.get(message.channel.id);
        if (!channelData) return;

        // Extract gift code from message
        const giftCode = extractGiftCode(message.content);

        if (!giftCode) {
            // Invalid format - silently ignore
            return;
        }

        // React with received emoji
        await message.react(receivedEmoji);

        // Check if gift code already exists
        const existingCode = giftCodeQueries.getGiftCode(giftCode);
        if (existingCode) {
            await message.reactions.cache.filter(r => r.me).first()?.remove();
            await message.react(emojiMap['1051'] || '❌');
            await message.reply(lang.giftCode.giftCodeChannel.messages.alreadyExists.replace('{giftCode}', `\`${giftCode}\``));
            return;
        }

        // Validate the gift code
        const validationOutcome = await createRedeemProcess([
            {
                id: null,
                giftCode,
                status: 'validation'
            }
        ], {
            adminId: message.author.id
        });

        if (!validationOutcome?.success) {
            await message.reactions.cache.filter(r => r.me).first()?.remove();
            await message.react(emojiMap['1051'] || '❌');
            await message.reply(lang.giftCode.giftCodeChannel.messages.invalid.replace('{giftCode}', `\`${giftCode}\``));
            return;
        }

        // Get VIP status from validation result
        const isVipCode = validationOutcome.results?.[0]?.is_vip || false;

        // Add gift code to database
        giftCodeQueries.addGiftCode(giftCode, 'active', message.author.id, 'manual', false, isVipCode);

        // Set last_validated timestamp
        giftCodeQueries.updateLastValidated(giftCode);

        systemLogQueries.addLog(
            'info',
            `Gift code added via channel: ${giftCode}`,
            JSON.stringify({
                gift_code: giftCode,
                added_by: message.author.id,
                channel_id: message.channel.id,
                is_vip: isVipCode,
                function: 'handleGiftCodeChannelMessage'
            })
        );

        // Reply with success
        await message.reactions.cache.filter(r => r.me).first()?.remove();
        await message.react(emojiMap['1004'] || '✅');
        await message.reply(lang.giftCode.giftCodeChannel.messages.added.replace('{giftCode}', `\`${giftCode}\``));

        // Start auto-redeem for alliances
        try {
            await startAutoRedeemForAlliances(giftCode, message.author.id, lang);
        } catch (error) {
            await sendError(null, lang, error, 'startAutoRedeemForAlliances', false);
            // Change reaction to failed
            await message.reactions.cache.filter(r => r.me).first()?.remove();
            await message.react(emojiMap['1051'] || '❌');
            await message.reply(lang.giftCode.giftCodeChannel.messages.redeemFailed);
        }

    } catch (error) {
        await sendError(null, lang, error, 'handleGiftCodeChannelMessage', false);
        try {
            await message.reply(lang.common.error);
        } catch (replyError) {
            // Failed to reply, ignore
        }
    }
}

/**
 * Extracts gift code from message content
 * Supports two formats:
 * 1. Plain text: "Giftcode"
 * 2. Webhook/announcement format: "Code: HappyFriday"
 * @param {string} content - Message content
 * @returns {string|null} Extracted gift code or null if invalid
 */
function extractGiftCode(content) {
    if (!content || typeof content !== 'string') return null;

    const trimmedContent = content.trim();

    // Check for "Code:" format (case-insensitive)
    const codeMatch = trimmedContent.match(/code:\s*(\S+)/i);
    if (codeMatch) {
        return codeMatch[1].trim();
    }

    // Check for plain text (single word/code, 1-50 characters, alphanumeric)
    const plainTextMatch = trimmedContent.match(/^([a-zA-Z0-9]{1,50})$/);
    if (plainTextMatch) {
        return plainTextMatch[1].trim();
    }

    return null;
}

/**
 * Starts auto-redeem process for all alliances with auto-redeem enabled
 * @param {string} giftCode - The gift code to redeem
 * @param {string} adminId - Admin who initiated the process
 * @param {Object} lang - Language object
 */
async function startAutoRedeemForAlliances(giftCode, adminId, lang) {
    // Get all alliances with auto-redeem enabled, ordered by priority
    const alliances = allianceQueries.getAlliancesWithAutoRedeem();

    if (alliances.length === 0) {
        return;
    }

    // Process each alliance
    for (const alliance of alliances) {
        // Get all players for this alliance
        const players = playerQueries.getPlayersByAlliance(alliance.id);

        if (players.length === 0) {
            continue;
        }

        // Create redeem data for all players
        const redeemData = players.map(player => ({
            id: player.fid,
            giftCode: giftCode,
            status: 'redeem'
        }));

        const redeemOptions = {
            adminId,
            allianceContext: {
                id: alliance.id,
                name: alliance.name,
                channelId: alliance.channel_id || null
            }
        };

        // Call redeem function for this alliance
        await createRedeemProcess(redeemData, redeemOptions);
    }
}

module.exports = {
    createGiftCodeChannelButton,
    handleGiftCodeChannelButton,
    handleGiftCodeChannelAdd,
    handleGiftCodeChannelRemove,
    handleGiftCodeChannelSelect,
    handleGiftCodeChannelRemoveSelect,
    handleGiftCodeChannelMessage,
    initializeGiftCodeChannelCache,
    updateGiftCodeChannelCache
};
