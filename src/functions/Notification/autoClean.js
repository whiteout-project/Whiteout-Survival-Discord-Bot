const {
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    LabelBuilder
} = require('discord.js');
const { settingsQueries, notificationQueries, notifAutoCleanQueries, notifMessageQueries } = require('../utility/database');
const { getUserInfo, handleError, assertUserMatches, hasPermission, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getComponentEmoji, getEmojiMapForUser } = require('../utility/emojis');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');

const PAGE_SIZE = 25; // Max options per select menu
const MAX_FREQUENCY_SECONDS = 7 * 24 * 60 * 60; // 7 days in seconds

/**
 * Creates the auto clean button for the notification panel
 * @param {string} userId - Discord user ID
 * @param {Object} lang - Localization object
 * @returns {ButtonBuilder}
 */
function createAutoCleanButton(userId, lang) {
    return new ButtonBuilder()
        .setCustomId(`notif_auto_clean_${userId}`)
        .setLabel(lang.notification.mainPage.buttons.autoClean)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1033'));
}

/**
 * Parse a human-readable duration string into seconds
 * @param {string} input - Duration string (e.g. "30m", "2h", "1d")
 * @returns {number|null} Seconds, or null if invalid
 */
function parseDuration(input) {
    if (!input) return null;
    const trimmed = input.trim().toLowerCase();
    const match = trimmed.match(/^(\d+)\s*(m|h|d)$/);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2];

    if (value <= 0) return null;

    switch (unit) {
        case 'm': return value * 60;
        case 'h': return value * 3600;
        case 'd': return value * 86400;
        default: return null;
    }
}

/**
 * Format seconds into a human-readable duration
 * @param {number} seconds - Duration in seconds
 * @returns {string}
 */
function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    return parts.join(' ') || '0m';
}

/**
 * Build the auto clean panel container
 * @param {import('discord.js').Interaction} interaction
 * @returns {ContainerBuilder[]}
 */
function buildAutoCleanPanel(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    const ac = lang.notification.autoClean;

    const settings = settingsQueries.getSettings.get();
    const isEnabled = !!settings.notif_auto_clean;
    const frequency = settings.notif_auto_clean_freq || 0;

    const hasServerPermission = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.NOTIFICATIONS_MANAGEMENT);
    const userId = interaction.user.id;

    // Status text
    let statusText = `${ac.content.title}\n${ac.content.description}\n`;
    statusText += isEnabled ? `${ac.content.statusEnabled}\n` : `${ac.content.statusDisabled}\n`;
    statusText += frequency > 0
        ? `${ac.content.frequency.replace('{frequency}', formatDuration(frequency))}\n`
        : `${ac.content.frequencyNotSet}\n`;

    // Channels button
    const channelsButton = new ButtonBuilder()
        .setCustomId(`notif_ac_channels_${userId}`)
        .setLabel(ac.buttons.channels)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1022'))
        .setDisabled(!hasServerPermission);

    // Enable/Disable toggle
    const toggleButton = new ButtonBuilder()
        .setCustomId(`notif_ac_toggle_${userId}`)
        .setLabel(isEnabled ? ac.buttons.toggleDisable : ac.buttons.toggle)
        .setStyle(isEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setEmoji(isEnabled
            ? getComponentEmoji(getEmojiMapForUser(userId), '1004')
            : getComponentEmoji(getEmojiMapForUser(userId), '1051'))
        .setDisabled(!hasServerPermission);

    // Frequency button
    const frequencyButton = new ButtonBuilder()
        .setCustomId(`notif_ac_freq_${userId}`)
        .setLabel(ac.buttons.frequency)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1033'))
        .setDisabled(!hasServerPermission);

    const row = new ActionRowBuilder().addComponents(channelsButton, toggleButton, frequencyButton);

    const container = new ContainerBuilder()
        .setAccentColor(2417109)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(statusText))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addActionRowComponents(row);

    return [container];
}

/**
 * Handle the auto clean button from notification panel
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleAutoCleanButton(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_').pop();
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const section = buildAutoCleanPanel(interaction);
        const components = updateComponentsV2AfterSeparator(interaction, section);
        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleAutoCleanButton');
    }
}

/**
 * Handle the enable/disable toggle
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleAutoCleanToggle(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_').pop();
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.NOTIFICATIONS_MANAGEMENT)) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        const settings = settingsQueries.getSettings.get();
        const newVal = settings.notif_auto_clean ? 0 : 1;
        settingsQueries.updateNotifAutoClean.run(newVal);

        const section = buildAutoCleanPanel(interaction);
        const components = updateComponentsV2AfterSeparator(interaction, section);
        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleAutoCleanToggle');
    }
}

/**
 * Handle the frequency button — show modal
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleAutoCleanFreqButton(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_').pop();
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.NOTIFICATIONS_MANAGEMENT)) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        const ac = lang.notification.autoClean;
        const settings = settingsQueries.getSettings.get();

        const modal = new ModalBuilder()
            .setCustomId(`notif_ac_freq_modal_${interaction.user.id}`)
            .setTitle(ac.modal.title);

        const freqInput = new TextInputBuilder()
            .setCustomId('frequency')
            .setPlaceholder(ac.modal.frequencyPlaceholder)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(10);

        if (settings.notif_auto_clean_freq > 0) {
            freqInput.setValue(formatDuration(settings.notif_auto_clean_freq));
        }

        const freqLabel = new LabelBuilder()
            .setLabel(ac.modal.frequencyLabel)
            .setTextInputComponent(freqInput);

        modal.addLabelComponents(freqLabel);
        await interaction.showModal(modal);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleAutoCleanFreqButton');
    }
}

/**
 * Handle the frequency modal submission
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleAutoCleanFreqModal(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_').pop();
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.NOTIFICATIONS_MANAGEMENT)) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        const ac = lang.notification.autoClean;
        const input = interaction.fields.getTextInputValue('frequency');
        const seconds = parseDuration(input);

        if (seconds === null) {
            return await interaction.reply({ content: ac.errors.invalidFrequency, ephemeral: true });
        }
        if (seconds > MAX_FREQUENCY_SECONDS) {
            return await interaction.reply({ content: ac.errors.frequencyTooLong, ephemeral: true });
        }

        settingsQueries.updateNotifAutoCleanFreq.run(seconds);

        await interaction.deferUpdate();
        const section = buildAutoCleanPanel(interaction);
        const components = updateComponentsV2AfterSeparator(interaction, section);
        await interaction.editReply({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleAutoCleanFreqModal');
    }
}

/**
 * Handle the channels button — show channel select
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleAutoCleanChannelsButton(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_').pop();
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.NOTIFICATIONS_MANAGEMENT)) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        await showChannelSelect(interaction, 0);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleAutoCleanChannelsButton');
    }
}

/**
 * Build and show the channel select menu for a given page
 * @param {import('discord.js').Interaction} interaction
 * @param {number} page - 0-indexed page number
 */
async function showChannelSelect(interaction, page) {
    const { lang } = getUserInfo(interaction.user.id);
    const ac = lang.notification.autoClean;
    const userId = interaction.user.id;

    // Get all unique channel IDs from server notifications
    const allNotifications = notificationQueries.getNotificationsByGuild(interaction.guildId);
    const channelSet = new Set();
    for (const n of allNotifications) {
        if (n.channel_id) channelSet.add(n.channel_id);
    }
    const channelIds = [...channelSet];

    if (channelIds.length === 0) {
        const container = new ContainerBuilder()
            .setAccentColor(2417109)
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                `${ac.content.channelsTitle}\n${ac.content.noChannels}`
            ));

        const components = updateComponentsV2AfterSeparator(interaction, [container]);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ components, flags: MessageFlags.IsComponentsV2 });
        } else {
            await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
        }
        return;
    }

    // Get currently selected channels
    const selectedChannels = notifAutoCleanQueries.getAllChannels();
    const selectedSet = new Set(selectedChannels.map(c => c.channel_id));

    // Paginate
    const totalPages = Math.ceil(channelIds.length / PAGE_SIZE);
    const currentPage = Math.min(page, totalPages - 1);
    const pageChannels = channelIds.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

    // Build select menu options with channel names
    const options = pageChannels.map(chId => {
        const isSelected = selectedSet.has(chId);
        let channelName = chId;
        try {
            const discordChannel = interaction.guild.channels.cache.get(chId);
            if (discordChannel) channelName = discordChannel.name;
        } catch { /* fallback to ID */ }

        const option = new StringSelectMenuOptionBuilder()
            .setLabel(`#${channelName}`)
            .setValue(chId)
            .setDefault(isSelected);

        if (isSelected) {
            option.setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1004'));
        } else {
            option.setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1051'));
        }

        return option;
    });

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`notif_ac_ch_select_${currentPage}_${userId}`)
        .setPlaceholder(totalPages > 1
            ? ac.selectMenu.placeholder + ' ' + ac.selectMenu.page.replace('{current}', currentPage + 1).replace('{total}', totalPages)
            : ac.selectMenu.placeholder)
        .addOptions(options)
        .setMinValues(0)
        .setMaxValues(pageChannels.length);

    const container = new ContainerBuilder()
        .setAccentColor(2417109)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `${ac.content.channelsTitle}\n${ac.content.channelsDescription}`
        ))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addActionRowComponents(new ActionRowBuilder().addComponents(selectMenu));

    // Add universal pagination if needed
    const paginationRow = createUniversalPaginationButtons({
        feature: 'notif_ac_ch',
        userId,
        currentPage,
        totalPages,
        lang
    });

    if (paginationRow) {
        container.addActionRowComponents(paginationRow);
    }

    const components = updateComponentsV2AfterSeparator(interaction, [container]);
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ components, flags: MessageFlags.IsComponentsV2 });
    } else {
        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    }
}

/**
 * Handle channel select menu submission
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleChannelSelectMenu(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const userId = parts.pop();
        const page = parseInt(parts[parts.length - 1], 10);

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        if (!hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.NOTIFICATIONS_MANAGEMENT)) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        // Get all notification channels for this page
        const allNotifications = notificationQueries.getNotificationsByGuild(interaction.guildId);
        const channelSet = new Set();
        for (const n of allNotifications) {
            if (n.channel_id) channelSet.add(n.channel_id);
        }
        const channelIds = [...channelSet];
        const pageChannels = channelIds.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

        // Selected values from the interaction
        const selectedValues = new Set(interaction.values);

        // Update database: add/remove only channels on this page
        for (const chId of pageChannels) {
            if (selectedValues.has(chId)) {
                notifAutoCleanQueries.addChannel(chId);
            } else {
                notifAutoCleanQueries.removeChannel(chId);
            }
        }

        await interaction.deferUpdate();
        await showChannelSelect(interaction, page);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleChannelSelectMenu');
    }
}

/**
 * Handle channel pagination buttons
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleChannelPagination(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const { userId, newPage } = parsePaginationCustomId(interaction.customId);

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        await showChannelSelect(interaction, newPage);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleChannelPagination');
    }
}

// ============================================================
// AUTO-CLEAN SCHEDULER
// ============================================================

let cleanupInterval = null;
let isProcessing = false;

const BATCH_SIZE = 10; // Max messages to process per cycle
const DELETE_DELAY_MS = 1500; // Delay between Discord deletions to avoid rate limits

/**
 * Start the auto-clean scheduler that periodically deletes old notification messages
 * @param {import('discord.js').Client} client - Discord client
 */
function startAutoCleanScheduler(client) {
    // Clear existing interval if any
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
    }

    // Check every 60 seconds
    cleanupInterval = setInterval(() => processAutoClean(client), 60_000);
}

/**
 * Stop the auto-clean scheduler
 */
function stopAutoCleanScheduler() {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
    }
}

/**
 * Process auto-clean: delete messages whose trigger_time + frequency has passed
 * @param {import('discord.js').Client} client
 */
async function processAutoClean(client) {
    if (isProcessing) return; // Skip if previous cycle is still running
    isProcessing = true;

    try {
        const settings = settingsQueries.getSettings.get();
        if (!settings.notif_auto_clean || !settings.notif_auto_clean_freq) return;

        const frequency = settings.notif_auto_clean_freq;
        const cutoffTime = Math.floor(Date.now() / 1000) - frequency;

        // Get messages whose trigger_time is old enough and are in auto-clean channels
        const messages = notifMessageQueries.getMessagesByTriggerTime(cutoffTime);
        if (!messages || messages.length === 0) return;

        // Process in batches to avoid memory spikes and rate limits
        const batch = messages.slice(0, BATCH_SIZE);

        for (const msg of batch) {
            try {
                const channel = await client.channels.fetch(msg.channel_id).catch(() => null);
                if (!channel) {
                    notifMessageQueries.deleteMessage(msg.id);
                    continue;
                }

                // Try fetch-then-delete first (validates message exists)
                const discordMsg = await channel.messages.fetch(msg.message_id).catch(() => null);
                if (discordMsg) {
                    await discordMsg.delete();
                    notifMessageQueries.deleteMessage(msg.id);
                } else {
                    // Fallback: direct REST DELETE (works without Read Message History)
                    await client.rest.delete(`/channels/${msg.channel_id}/messages/${msg.message_id}`);
                    notifMessageQueries.deleteMessage(msg.id);
                }

                // Delay between deletions to avoid Discord rate limits
                if (batch.indexOf(msg) < batch.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, DELETE_DELAY_MS));
                }
            } catch (err) {
                // 10008 = Unknown Message (already deleted), 10003 = Unknown Channel
                if (err.code === 10008 || err.code === 10003) {
                    notifMessageQueries.deleteMessage(msg.id);
                }
                // For permission errors or transient failures, keep tracking row for retry
            }
        }

        // Clean up very old entries (older than 14 days) to prevent table bloat
        const oldCutoff = Math.floor(Date.now() / 1000) - (14 * 86400);
        notifMessageQueries.deleteOlderThan(oldCutoff);
    } catch (err) {
        handleError(null, null, err, 'processAutoClean');
    } finally {
        isProcessing = false;
    }
}

/**
 * Track a sent notification message for auto-clean
 * @param {number} notificationId - The notification ID
 * @param {string} channelId - Channel the message was sent to
 * @param {string} messageId - The Discord message ID
 * @param {number} triggerTime - The notification's trigger time (Unix timestamp)
 */
function trackSentMessage(notificationId, channelId, messageId, triggerTime) {
    try {
        // Only track if auto-clean is enabled and this channel is configured
        const settings = settingsQueries.getSettings.get();
        if (!settings.notif_auto_clean) return;

        const isTracked = notifAutoCleanQueries.getChannel(channelId);
        if (!isTracked) return;

        const sentAt = Math.floor(Date.now() / 1000);
        notifMessageQueries.addMessage(notificationId, channelId, messageId, triggerTime, sentAt);
    } catch (err) {
        handleError(null, null, err, 'trackSentMessage');
    }
}

module.exports = {
    createAutoCleanButton,
    handleAutoCleanButton,
    handleAutoCleanToggle,
    handleAutoCleanFreqButton,
    handleAutoCleanFreqModal,
    handleAutoCleanChannelsButton,
    handleChannelSelectMenu,
    handleChannelPagination,
    startAutoCleanScheduler,
    stopAutoCleanScheduler,
    trackSentMessage,
    formatDuration,
    parseDuration
};
