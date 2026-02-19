const {
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    StringSelectMenuBuilder
} = require('discord.js');
const { notificationQueries, adminLogQueries } = require('../utility/database');
const { LOG_CODES } = require('../utility/AdminLogs');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { notificationScheduler } = require('./notificationScheduler');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { getAdminLang, assertUserMatches, sendError, hasPermission, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('./../utility/emojis');
const ITEMS_PER_PAGE = 20;

/**
 * Create the delete notification button
 */
function createDeleteNotificationButton(userId, lang) {
    return new ButtonBuilder()
        .setCustomId(`notification_delete_${userId}`)
        .setLabel(lang.notification.deleteNotification.buttons.deleteNotification)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1046'));
}

/**
 * Handle delete notification button click - show type selection
 */
async function handleDeleteNotificationButton(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        const expectedUserId = interaction.customId.split('_')[2];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.NOTIFICATIONS_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Show type selection
        await showTypeSelection(interaction, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleDeleteNotificationButton');
    }
}

/**
 * Show notification type selection (server or private)
 */
async function showTypeSelection(interaction, lang) {
    const serverButton = new ButtonBuilder()
        .setCustomId(`notification_delete_type_server_${interaction.user.id}`)
        .setLabel(lang.notification.deleteNotification.buttons.serverNotifications)
        .setStyle(ButtonStyle.Primary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1022'));

    const privateButton = new ButtonBuilder()
        .setCustomId(`notification_delete_type_private_${interaction.user.id}`)
        .setLabel(lang.notification.deleteNotification.buttons.privateNotifications)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1029'));

    const buttonRow = new ActionRowBuilder().addComponents(serverButton, privateButton);

    const container = [
        new ContainerBuilder()
            .setAccentColor(15548997) // red
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.notification.deleteNotification.content.title.typeSelection}\n` +
                    `${lang.notification.deleteNotification.content.description.typeSelection}`
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(buttonRow)
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    await interaction.update({
        components: content,
        flags: MessageFlags.IsComponentsV2
    });
}

/**
 * Handle type selection button (server or private)
 */
async function handleTypeSelection(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        const [, , , type, userId] = interaction.customId.split('_');
        if (!(await assertUserMatches(interaction, userId, lang))) return;

        // Get filtered notifications
        const notifications = getFilteredNotifications(type, interaction.guild?.id, interaction.user.id, adminData);

        if (!notifications || notifications.length === 0) {
            const noNotifMsg = type === 'server'
                ? lang.notification.deleteNotification.errors.noServerNotifications
                : lang.notification.deleteNotification.errors.noPrivateNotifications;

            return await interaction.update({
                components: updateComponentsV2AfterSeparator(interaction, [
                    new ContainerBuilder()
                        .setAccentColor(15548997) // red
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent(
                                `${lang.notification.deleteNotification.content.title.base}\n` +
                                noNotifMsg
                            )
                        )
                ])
            });
        }

        // Show notification selection with pagination
        await showNotificationSelection(interaction, notifications, 1, type, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleTypeSelection');
    }
}

/**
 * Show notification selection menu with pagination
 */
async function showNotificationSelection(interaction, notifications, page, type, lang) {
    const totalPages = Math.ceil(notifications.length / ITEMS_PER_PAGE);
    const startIndex = (page - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const pageNotifications = notifications.slice(startIndex, endIndex);

    // Create select menu options
    const options = await Promise.all(pageNotifications.map(async notification => {
        let channelName = 'Direct Message';
        if (notification.guild_id && notification.channel_id && interaction.guild) {
            try {
                const channel = await interaction.guild.channels.fetch(notification.channel_id);
                channelName = channel ? channel.name : 'Unknown Channel';
            } catch (error) {
                channelName = 'Unknown Channel';
            }
        }

        const creator = await interaction.client.users.fetch(notification.created_by).catch(() => ({ username: 'Unknown' }));
        const description = lang.notification.deleteNotification.selectMenu.description.replace('{channelName}', channelName).replace('{creatorName}', creator.username);

        return {
            label: notification.name.substring(0, 100),
            value: `notification_${notification.id}`,
            description: description.substring(0, 100),
            emoji: notification.is_active ? getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1022') : getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1052')
        };
    }));

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`notification_delete_${type}_select_${interaction.user.id}_${page}`)
        .setPlaceholder(lang.notification.deleteNotification.selectMenu.placeholder)
        .addOptions(options);

    const selectRow = new ActionRowBuilder().addComponents(selectMenu);

    // Add pagination buttons if needed
    const components = [selectRow];
    if (totalPages > 1) {
        const paginationRow = createUniversalPaginationButtons({
            feature: 'notification_delete',
            subtype: type,
            userId: interaction.user.id,
            currentPage: page,
            totalPages: totalPages,
            lang: lang
        });
        components.push(paginationRow);
    }

    const container = [
        new ContainerBuilder()
            .setAccentColor(15548997) // red
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.notification.deleteNotification.content.title.base}\n` +
                    `${lang.notification.deleteNotification.content.description.base.replace('{count}', notifications.length)}`
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(...components)
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    if (interaction.replied || interaction.deferred) {
        await interaction.editReply({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });
    } else {
        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });
    }
}

/**
 * Handle pagination button clicks
 */
async function handleDeleteNotificationPagination(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        const { userId, newPage, subtype } = parsePaginationCustomId(interaction.customId, 0);
        if (!(await assertUserMatches(interaction, userId, lang))) return;

        // Get filtered notifications
        const notifications = getFilteredNotifications(subtype, interaction.guild?.id, interaction.user.id, adminData);

        await showNotificationSelection(interaction, notifications, newPage, subtype, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleDeleteNotificationPagination');
    }
}

/**
 * Handle notification selection from dropdown
 */
async function handleNotificationSelection(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[4];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const selectedValue = interaction.values[0];
        const notificationId = parseInt(selectedValue.split('_')[1]);

        // Get notification details
        const notification = notificationQueries.getNotificationById(notificationId);

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.deleteNotification.errors.notificationNotFound,
                ephemeral: true
            });
        }

        // Check if user has permission to delete this notification
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.NOTIFICATIONS_MANAGEMENT);
        if (!hasFullAccess && notification.created_by !== interaction.user.id) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Show confirmation
        await showDeleteConfirmation(interaction, notification, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleNotificationSelection');
    }
}

/**
 * Show delete confirmation with notification details
 */
async function showDeleteConfirmation(interaction, notification, lang) {
    const typeDisplay = notification.guild_id
        ? lang.notification.deleteNotification.content.typeServer
        : lang.notification.deleteNotification.content.typePrivate;

    const statusDisplay = notification.is_active
        ? lang.notification.deleteNotification.content.statusActive
        : lang.notification.deleteNotification.content.statusInactive;

    const repeatDisplay = notification.repeat_status
        ? lang.notification.deleteNotification.content.enabled
        : lang.notification.deleteNotification.content.disabled;
    
    let nextTriggerStr = lang.notification.deleteNotification.content.disabled;
        if (notification.next_trigger && notification.next_trigger > 0) {
            const nextTrigger = new Date(notification.next_trigger * 1000);
            nextTriggerStr = `${nextTrigger.getUTCDate()}/${nextTrigger.getUTCMonth() + 1}/${nextTrigger.getUTCFullYear()} ${String(nextTrigger.getUTCHours()).padStart(2, '0')}:${String(nextTrigger.getUTCMinutes()).padStart(2, '0')}`;
        }

    const confirmButton = new ButtonBuilder()
        .setCustomId(`notification_delete_confirm_${notification.id}_${interaction.user.id}`)
        .setLabel(lang.notification.deleteNotification.buttons.confirm)
        .setStyle(ButtonStyle.Danger)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1004'));

    const cancelButton = new ButtonBuilder()
        .setCustomId(`notification_delete_cancel_${interaction.user.id}`)
        .setLabel(lang.notification.deleteNotification.buttons.cancel)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1051'));

    const buttonRow = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

    const container = [
        new ContainerBuilder()
            .setAccentColor(15548997) // red
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.notification.deleteNotification.content.title.confirm}\n` +
                    `${lang.notification.deleteNotification.content.description.confirm}\n\n` +
                    `${lang.notification.deleteNotification.content.notificationDetailsField.name}\n` +
                    lang.notification.deleteNotification.content.notificationDetailsField.value
                        .replace('{name}', notification.name)
                        .replace('{type}', typeDisplay)
                        .replace('{status}', statusDisplay)
                        .replace('{trigger}', nextTriggerStr)
                        .replace('{repeat}', repeatDisplay)
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(buttonRow)
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    await interaction.update({
        components: content,
        flags: MessageFlags.IsComponentsV2
    });
}

/**
 * Handle delete confirmation button
 */
async function handleDeleteConfirm(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const [, , , notificationId, userId] = interaction.customId.split('_');

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const id = parseInt(notificationId);
        const notification = notificationQueries.getNotificationById(id);

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.deleteNotification.errors.notificationNotFound,
                ephemeral: true
            });
        }

        // First, remove from scheduler
        notificationScheduler.removeNotification(id);

        // Then delete from database
        notificationQueries.deleteNotification(id);

        // Log the deletion
        adminLogQueries.addLog(
            interaction.user.id,
            LOG_CODES.NOTIFICATION.DELETED,
            JSON.stringify({
                name: notification.name,
                notification_id: id
            })
        );

        // Show success message
        const container = [
            new ContainerBuilder()
                .setAccentColor(5763719) // green
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.notification.deleteNotification.content.title.success}\n` +
                        lang.notification.deleteNotification.content.description.success.replace('{name}', notification.name)
                    )
                )
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleDeleteConfirm');
    }
}

/**
 * Handle delete cancel button
 */
async function handleDeleteCancel(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const expectedUserId = interaction.customId.split('_')[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Show cancellation message
        const container = [
            new ContainerBuilder()
                .setAccentColor(10070709) // gray
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.notification.deleteNotification.content.title.cancel}\n` +
                        `${lang.notification.deleteNotification.content.description.cancel}`
                    )
                )
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleDeleteCancel');
    }
}


/**
 * Get filtered notifications based on type, guild, user, and permissions
 * @param {string} type - 'server' or 'private'
 * @param {string} guildId - Guild ID for server notifications
 * @param {string} userId - User ID for permission checking
 * @param {Object} adminData - Admin data for permissions
 * @returns {Array} Filtered notifications
 */
function getFilteredNotifications(type, guildId, userId, adminData) {
    // Get all notifications first
    let notifications = notificationQueries.getAllNotifications();

    // Filter out incomplete notifications
    notifications = notifications.filter(n => n.completed === 1);

    // Filter by type
    if (type === 'server') {
        notifications = notifications.filter(n => n.guild_id !== null);
        // Filter by current guild only for server notifications
        if (guildId) {
            notifications = notifications.filter(n => n.guild_id === guildId);
        }
    } else if (type === 'private') {
        notifications = notifications.filter(n => n.guild_id === null);
    }

    // Apply permission filtering based on type
    if (type === 'private') {
        // Private notifications: only show user's own, regardless of permission level
        notifications = notifications.filter(n => n.created_by === userId);
    } else if (type === 'server') {
        // Server notifications: show all if user has notification permission
        const hasNotificationAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.NOTIFICATIONS_MANAGEMENT);
        if (!hasNotificationAccess) {
            notifications = notifications.filter(n => n.created_by === userId);
        }
    }

    return notifications;
}

module.exports = {
    createDeleteNotificationButton,
    handleDeleteNotificationButton,
    handleTypeSelection,
    handleDeleteNotificationPagination,
    handleNotificationSelection,
    handleDeleteConfirm,
    handleDeleteCancel
};
