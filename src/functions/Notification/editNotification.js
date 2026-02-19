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
    EmbedBuilder
} = require('discord.js');
const { notificationQueries, adminLogQueries } = require('../utility/database');
const { LOG_CODES } = require('../utility/AdminLogs');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { notificationScheduler } = require('./notificationScheduler');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { getAdminLang, assertUserMatches, sendError, hasPermission, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { parseMentions, convertTagsToMentions } = require('./notificationUtils');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../utility/emojis');

const ITEMS_PER_PAGE = 20;

/**
 * Create the edit notification button
 */
function createEditNotificationButton(userId, lang) {
    return new ButtonBuilder()
        .setCustomId(`notification_edit_main_${userId}`)
        .setLabel(lang.notification.editNotification.buttons.editNotification)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1008'));
}

/**
 * Handle edit notification button click - show type selection
 */
async function handleEditNotificationButton(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        const expectedUserId = interaction.customId.split('_')[3];
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
        await sendError(interaction, lang, error, 'handleEditNotificationButton');
    }
}

/**
 * Show notification type selection (server or private)
 */
async function showTypeSelection(interaction, lang) {
    const serverButton = new ButtonBuilder()
        .setCustomId(`notification_edit_type_server_${interaction.user.id}`)
        .setLabel(lang.notification.editNotification.buttons.serverNotifications)
        .setStyle(ButtonStyle.Primary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1022'));

    const privateButton = new ButtonBuilder()
        .setCustomId(`notification_edit_type_private_${interaction.user.id}`)
        .setLabel(lang.notification.editNotification.buttons.privateNotifications)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1029'));

    const buttonRow = new ActionRowBuilder().addComponents(serverButton, privateButton);

    const container = [
        new ContainerBuilder()
            .setAccentColor(3447003) // blue
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.notification.editNotification.content.title.typeSelection}\n` +
                    `${lang.notification.editNotification.content.description.typeSelection}`
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

        // Get filtered notifications using helper function
        const notifications = getFilteredNotifications(type, interaction.user.id, adminData, interaction.guild?.id);

        if (!notifications || notifications.length === 0) {
            const noNotifMsg = type === 'server'
                ? lang.notification.editNotification.errors.noServerNotifications
                : lang.notification.editNotification.errors.noPrivateNotifications;

            return await interaction.update({
                components: updateComponentsV2AfterSeparator(interaction, [
                    new ContainerBuilder()
                        .setAccentColor(3447003) // blue
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent(
                                `${lang.notification.editNotification.content.title.base}\n` +
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
        if (notification.guild_id && notification.channel_id) {
            try {
                const channel = await interaction.guild.channels.fetch(notification.channel_id);
                channelName = channel ? channel.name : 'Unknown Channel';
            } catch (error) {
                channelName = 'Unknown Channel';
            }
        }

        const creator = await interaction.client.users.fetch(notification.created_by).catch(() => ({ username: 'Unknown' }));
        const description = lang.notification.editNotification.selectMenu.description.replace('{channelName}', channelName).replace('{creatorName}', creator.username);

        return {
            label: notification.name.substring(0, 100),
            value: `notification_${notification.id}`,
            description: description.substring(0, 100),
            emoji: notification.is_active ? getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1022') : getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1052')
        };
    }));

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`notification_edit_select_${type}_${interaction.user.id}_${page}`)
        .setPlaceholder(lang.notification.editNotification.selectMenu.placeholder)
        .addOptions(options);

    const selectRow = new ActionRowBuilder().addComponents(selectMenu);

    // Add pagination buttons if needed
    const components = [selectRow];
    if (totalPages > 1) {
        const paginationRow = createUniversalPaginationButtons({
            feature: 'notification_edit',
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
            .setAccentColor(3447003) // blue
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.notification.editNotification.content.title.base}\n` +
                    `${lang.notification.editNotification.content.description.base.replace('{count}', notifications.length)}`
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
async function handleEditNotificationPagination(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        const { userId, newPage, subtype } = parsePaginationCustomId(interaction.customId, 0);
        const type = subtype; // 'server' or 'private'

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        // Get filtered notifications using helper function
        const notifications = getFilteredNotifications(type, interaction.user.id, adminData, interaction.guild?.id);

        await showNotificationSelection(interaction, notifications, newPage, type, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleEditNotificationPagination');
    }
}

/**
 * Handle notification selection from dropdown - sends NEW message with edit panel
 */
async function handleNotificationSelection(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        const customIdParts = interaction.customId.split('_');
        const type = customIdParts[3]; // 'server' or 'private'
        const expectedUserId = customIdParts[4];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const selectedValue = interaction.values[0];
        const notificationId = parseInt(selectedValue.split('_')[1]);

        // Get notification details
        const notification = notificationQueries.getNotificationById(notificationId);

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.editNotification.errors.notificationNotFound,
                ephemeral: true
            });
        }

        // Check if user has permission to edit this notification
        const hasFullAccess = adminData.is_owner || (adminData.permissions & PERMISSIONS.FULL_ACCESS);
        const hasNotificationAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.NOTIFICATIONS_MANAGEMENT);

        // For server notifications: need notification permission
        // For private notifications: must be creator
        const canEdit = notification.guild_id
            ? hasNotificationAccess
            : (notification.created_by === interaction.user.id);

        if (!canEdit || !hasFullAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Acknowledge the selection
        await interaction.deferUpdate();

        // Show edit panel as NEW message
        await showNotificationEditPanel(interaction, notification, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleNotificationSelection');
    }
}

/**
 * Show notification edit panel with 5 buttons (Info/Content/Repeat/Pattern/Save)
 * Sends as NEW message with notification preview or updates existing message
 * @param {Object} interaction - Discord interaction
 * @param {Object} notification - Notification data
 * @param {Object} lang - Language object
 * @param {boolean} updateExisting - If true, updates interaction.message instead of sending new followUp
 */
async function showNotificationEditPanel(interaction, notification, lang, updateExisting = false) {
    try {
        // Format next trigger time
        let nextTriggerStr = lang.notification.editNotification.content.triggerField.disabled;
        if (notification.next_trigger && notification.next_trigger > 0) {
            const nextTrigger = new Date(notification.next_trigger * 1000);
            nextTriggerStr = `${nextTrigger.getUTCDate()}/${nextTrigger.getUTCMonth() + 1}/${nextTrigger.getUTCFullYear()} ${String(nextTrigger.getUTCHours()).padStart(2, '0')}:${String(nextTrigger.getUTCMinutes()).padStart(2, '0')}`;
        }

        // Format repeat frequency
        let repeatStr = lang.notification.editNotification.content.repeatField.disabled;
        if (notification.repeat_status === 1 && notification.repeat_frequency) {
            const freq = notification.repeat_frequency;
            const days = Math.floor(freq / 86400);
            const hours = Math.floor((freq % 86400) / 3600);
            const minutes = Math.floor((freq % 3600) / 60);
            const seconds = freq % 60;

            const parts = [];
            if (days > 0) parts.push(lang.notification.editNotification.content.repeatField.days.replace('{count}', days));
            if (hours > 0) parts.push(lang.notification.editNotification.content.repeatField.hours.replace('{count}', hours));
            if (minutes > 0) parts.push(lang.notification.editNotification.content.repeatField.minutes.replace('{count}', minutes));
            if (seconds > 0) parts.push(lang.notification.editNotification.content.repeatField.seconds.replace('{count}', seconds));

            repeatStr = lang.notification.editNotification.content.repeatField.enabled.replace('{parts}', parts.join(' '));
        }

        // Parse mentions for preview
        const mentions = parseMentions(notification.mention);

        // Get raw message content
        const rawMessageContent = notification.message_content || null;

        // Build notification embed
        let notificationEmbed = null;
        if (notification.embed_toggle) {
            notificationEmbed = new EmbedBuilder()
                .setColor(notification.color || '#0099ff');

            if (notification.title) notificationEmbed.setTitle(notification.title);
            if (notification.description) {
                const displayDescription = convertTagsToMentions(notification.description, mentions, 'description');
                notificationEmbed.setDescription(displayDescription);
            }
            if (notification.image_url) notificationEmbed.setImage(notification.image_url);
            if (notification.thumbnail_url) notificationEmbed.setThumbnail(notification.thumbnail_url);
            if (notification.footer) notificationEmbed.setFooter({ text: notification.footer });
            if (notification.author) notificationEmbed.setAuthor({ name: notification.author });

            if (notification.fields) {
                try {
                    const fields = JSON.parse(notification.fields);
                    if (Array.isArray(fields) && fields.length > 0) {
                        fields.forEach((field, index) => {
                            if (field.name && field.value) {
                                const displayValue = convertTagsToMentions(field.value, mentions, `field_${index}`);
                                notificationEmbed.addFields({ name: field.name, value: displayValue, inline: field.inline || false });
                            }
                        });
                    }
                } catch (error) {
                    // Silently fail field parsing
                }
            }
        }

        // Build info embed
        let channelDisplay = lang.notification.editNotification.content.channelField.directMessage;
        if (notification.guild_id && notification.channel_id) {
            try {
                const channel = await interaction.guild.channels.fetch(notification.channel_id);
                channelDisplay = channel ? `<#${notification.channel_id}>` : lang.notification.editNotification.content.channelField.directMessage;
            } catch (error) {
                channelDisplay = lang.notification.editNotification.content.channelField.directMessage;
            }
        }

        const typeDisplay = notification.guild_id
            ? lang.notification.editNotification.content.typeServer
            : lang.notification.editNotification.content.typePrivate;

        const statusDisplay = notification.is_active
            ? lang.notification.editNotification.content.statusActive
            : lang.notification.editNotification.content.statusInactive;

        const infoEmbed = new EmbedBuilder()
            .setTitle(lang.notification.editNotification.content.title.editPanel)
            .setDescription(lang.notification.editNotification.content.description.editPanel)
            .addFields([
                { name: lang.notification.editNotification.content.nameField.name, value: notification.name, inline: true },
                { name: lang.notification.editNotification.content.typeField.name, value: typeDisplay, inline: true },
                { name: lang.notification.editNotification.content.statusField.name, value: statusDisplay, inline: true },
                { name: lang.notification.editNotification.content.channelField.name, value: channelDisplay, inline: true },
                { name: lang.notification.editNotification.content.triggerField.name, value: nextTriggerStr, inline: true },
                { name: lang.notification.editNotification.content.repeatField.name, value: repeatStr, inline: true },
                { name: lang.notification.editNotification.content.patternField.name, value: notification.pattern || 'time', inline: true },
            ])
            .setColor(0x3498db) // Blue
            .setTimestamp();

        // Create 5 buttons: Info, Content, Repeat, Pattern, Save
        const infoButton = new ButtonBuilder()
            .setCustomId(`notification_edit_info_${notification.id}_${interaction.user.id}`)
            .setLabel(lang.notification.editNotification.buttons.info)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1038'));

        const contentButton = new ButtonBuilder()
            .setCustomId(`notification_edit_content_${notification.id}_${interaction.user.id}`)
            .setLabel(lang.notification.editNotification.buttons.content)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1008'));

        const repeatButton = new ButtonBuilder()
            .setCustomId(`notification_edit_repeat_${notification.id}_${interaction.user.id}`)
            .setLabel(lang.notification.editNotification.buttons.repeat)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1033'));

        const patternButton = new ButtonBuilder()
            .setCustomId(`notification_edit_pattern_${notification.id}_${interaction.user.id}`)
            .setLabel(lang.notification.editNotification.buttons.pattern)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1025'));

        const saveButton = new ButtonBuilder()
            .setCustomId(`notification_edit_save_${notification.id}_${interaction.user.id}`)
            .setLabel(lang.notification.editNotification.buttons.save)
            .setStyle(ButtonStyle.Success)
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1037'));

        const disableButton = new ButtonBuilder()
            .setCustomId(`notification_edit_disable_${notification.id}_${interaction.user.id}`)
            .setLabel(lang.notification.editNotification.buttons.disable)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1051'))
            .setDisabled(!notification.is_active);

        const buttonRow = new ActionRowBuilder().addComponents(infoButton, contentButton, repeatButton, patternButton, disableButton);
        const secondRow = new ActionRowBuilder().addComponents(saveButton);
        const embeds = [infoEmbed];
        if (notificationEmbed && notification.embed_toggle) {
            embeds.push(notificationEmbed);
        }

        const cleanMessageContent = rawMessageContent ? convertTagsToMentions(rawMessageContent, mentions, 'message') : null;

        // Update existing message or send new one
        if (updateExisting && interaction.message) {
            await interaction.message.edit({
                content: cleanMessageContent,
                embeds: embeds,
                components: [buttonRow, secondRow]
            });
        } else {
            // Send NEW message (NOT ephemeral for editor compatibility)
            const sentMessage = await interaction.followUp({
                content: rawMessageContent,
                embeds: embeds,
                components: [buttonRow, secondRow]
            });

            // Update message immediately to show mentions
            try {
                await sentMessage.edit({
                    content: cleanMessageContent,
                    embeds: embeds,
                    components: [buttonRow, secondRow]
                });
            } catch (error) {
                // Silently fail if message was deleted or interaction expired
            }
        }

    } catch (error) {
        await sendError(interaction, lang, error, 'showNotificationEditPanel');
    }
}

/**
 * Handle Info button - opens modal to edit name and trigger time
 */
async function handleInfoButton(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const notificationId = parts[3];
        const userId = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.editNotification.errors.notificationNotFound,
                ephemeral: true
            });
        }

        // Get notification's trigger time for default values (use last_trigger if next_trigger is not set)
        const triggerTimestamp = (notification.next_trigger && notification.next_trigger > 0)
            ? notification.next_trigger
            : notification.last_trigger || 0;
        const triggerDate = new Date(triggerTimestamp * 1000);
        const day = String(triggerDate.getUTCDate()).padStart(2, '0');
        const month = String(triggerDate.getUTCMonth() + 1).padStart(2, '0');
        const year = triggerDate.getUTCFullYear();
        const hours = String(triggerDate.getUTCHours()).padStart(2, '0');
        const minutes = String(triggerDate.getUTCMinutes()).padStart(2, '0');
        const seconds = String(triggerDate.getUTCSeconds()).padStart(2, '0');

        const { ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder } = require('discord.js');

        const modal = new ModalBuilder()
            .setCustomId(`notification_edit_info_modal_${notificationId}_${userId}`)
            .setTitle(lang.notification.editNotification.modal.info.title);

        const nameInput = new TextInputBuilder()
            .setCustomId('name')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(lang.notification.editNotification.modal.info.nameField.placeholder)
            .setValue(notification.name)
            .setRequired(true);

        const nameLabel = new LabelBuilder()
            .setLabel(lang.notification.editNotification.modal.info.nameField.label)
            .setTextInputComponent(nameInput);

        const dateInput = new TextInputBuilder()
            .setCustomId('date')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(lang.notification.editNotification.modal.info.dateField.placeholder)
            .setValue(`${day}/${month}/${year}`)
            .setRequired(true);

        const dateLabel = new LabelBuilder()
            .setLabel(lang.notification.editNotification.modal.info.dateField.label)
            .setTextInputComponent(dateInput);

        const timeInput = new TextInputBuilder()
            .setCustomId('time')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(lang.notification.editNotification.modal.info.timeField.placeholder)
            .setValue(`${hours}:${minutes}:${seconds}`)
            .setRequired(true);

        const timeLabel = new LabelBuilder()
            .setLabel(lang.notification.editNotification.modal.info.timeField.label)
            .setTextInputComponent(timeInput);

        modal.addLabelComponents(nameLabel, dateLabel, timeLabel);

        await interaction.showModal(modal);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleInfoButton');
    }
}

/**
 * Handle Info modal submission - validates and updates notification info
 */
async function handleInfoModal(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const notificationId = parts[4];
        const userId = parts[5];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const name = interaction.fields.getTextInputValue('name');
        const dateStr = interaction.fields.getTextInputValue('date');
        const timeStr = interaction.fields.getTextInputValue('time');

        // Validate and parse date/time
        const dateParts = dateStr.split('/');
        if (dateParts.length !== 3) {
            return await interaction.reply({
                content: lang.notification.editNotification.errors.invalidDateFormat,
                ephemeral: true
            });
        }

        const timeParts = timeStr.split(':');
        if (timeParts.length !== 3) {
            return await interaction.reply({
                content: lang.notification.editNotification.errors.invalidTimeFormat,
                ephemeral: true
            });
        }

        const day = parseInt(dateParts[0]);
        const month = parseInt(dateParts[1]) - 1;
        const year = parseInt(dateParts[2]);
        const hour = parseInt(timeParts[0]);
        const minute = parseInt(timeParts[1]);
        const second = parseInt(timeParts[2]);

        if (isNaN(day) || isNaN(month) || isNaN(year) || isNaN(hour) || isNaN(minute) || isNaN(second)) {
            return await interaction.reply({
                content: lang.notification.editNotification.errors.invalidDateTime,
                ephemeral: true
            });
        }

        const nextTriggerDate = new Date(Date.UTC(year, month, day, hour, minute, second));
        const nextTriggerTimestamp = Math.floor(nextTriggerDate.getTime() / 1000);

        // Get current notification
        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.editNotification.errors.notificationNotFound,
                ephemeral: true
            });
        }

        // Check if time is in future
        const currentTime = Math.floor(Date.now() / 1000);
        if (nextTriggerTimestamp < currentTime) {
            // Time is in past - only update name
            try {
                notificationQueries.updateNotification(
                    parseInt(notificationId),
                    name,
                    notification.guild_id,
                    notification.channel_id,
                    notification.hour,
                    notification.minute,
                    notification.message_content,
                    notification.title,
                    notification.description,
                    notification.color,
                    notification.image_url,
                    notification.thumbnail_url,
                    notification.footer,
                    notification.author,
                    notification.fields,
                    notification.pattern,
                    notification.mention,
                    notification.repeat_status,
                    notification.repeat_frequency,
                    notification.embed_toggle,
                    notification.is_active,
                    notification.last_trigger,
                    notification.next_trigger
                );

                adminLogQueries.addLog(
                    interaction.user.id,
                    LOG_CODES.NOTIFICATION.EDITED,
                    JSON.stringify({
                        notification_id: notificationId,
                        name: name,
                        field: 'name'
                    })
                );

                return await interaction.reply({
                    content: lang.notification.editNotification.errors.timeInPast,
                    ephemeral: true
                });

            } catch (dbError) {
                await sendError(interaction, lang, dbError, 'handleInfoModal_updateNameOnly');
            }
        } else {
            // Time is in future - update everything and set to active
            try {
                notificationQueries.updateNotification(
                    parseInt(notificationId),
                    name,
                    notification.guild_id,
                    notification.channel_id,
                    hour,
                    minute,
                    notification.message_content,
                    notification.title,
                    notification.description,
                    notification.color,
                    notification.image_url,
                    notification.thumbnail_url,
                    notification.footer,
                    notification.author,
                    notification.fields,
                    notification.pattern,
                    notification.mention,
                    notification.repeat_status,
                    notification.repeat_frequency,
                    notification.embed_toggle,
                    1,
                    notification.last_trigger,
                    nextTriggerTimestamp
                );

                adminLogQueries.addLog(
                    interaction.user.id,
                    LOG_CODES.NOTIFICATION.EDITED,
                    JSON.stringify({
                        notification_id: notificationId,
                        name: name,
                        next_trigger: nextTriggerTimestamp
                    })
                );

                // Mark notification as completed since it's now fully configured and active
                notificationQueries.updateNotificationCompletedStatus(parseInt(notificationId), true);

                // Always update scheduler since we set notification to active
                await notificationScheduler.removeNotification(parseInt(notificationId));
                await notificationScheduler.addNotification(parseInt(notificationId));

                // Reply ephemeral with success message
                await interaction.reply({
                    content: lang.notification.editNotification.content.infoUpdated,
                    ephemeral: true
                });

                // Update the edit panel message with latest notification data
                const updatedNotification = notificationQueries.getNotificationById(parseInt(notificationId));
                await showNotificationEditPanel(interaction, updatedNotification, lang, true);

            } catch (dbError) {
                await sendError(interaction, lang, dbError, 'handleInfoModal_updateAll');
            }
        }

    } catch (error) {
        await sendError(interaction, lang, error, 'handleInfoModal');
    }
}

/**
 * Handle Content button - opens notification editor
 */
async function handleContentButton(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const notificationId = parts[3];
        const userId = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.editNotification.errors.notificationNotFound,
                ephemeral: true
            });
        }

        // Import notificationEditor dynamically
        const notificationEditor = require('./notificationEditor');

        // Get the editor payload
        const editorPayload = await notificationEditor.showEmbedEditor(interaction, parseInt(notificationId), lang, false, true);

        // Update current message with editor
        await interaction.update(editorPayload);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleContentButton');
    }
}

/**
 * Handle Repeat or Pattern button - shows selection UI
 * @param {Object} interaction - Discord interaction
 * @param {string} type - 'repeat' or 'pattern'
 */
async function handleSettingsButtonFromEdit(interaction, type = 'repeat') {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const notificationId = parts[3];
        const userId = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.editNotification.errors.notificationNotFound,
                ephemeral: true
            });
        }

        // Import notificationSettings dynamically
        const notificationSettings = require('./notificationSettings');

        // Show selection UI based on type
        if (type === 'repeat') {
            await notificationSettings.showRepeatSelection(interaction, parseInt(notificationId), lang);
        } else if (type === 'pattern') {
            await notificationSettings.showPatternSelection(interaction, parseInt(notificationId), lang);
        }

    } catch (error) {
        await sendError(interaction, lang, error, `handleSettingsButtonFromEdit_${type}`);
    }
}

/**
 * Handle Repeat button - wrapper for handleSettingsButtonFromEdit
 */
async function handleRepeatButtonFromEdit(interaction) {
    return await handleSettingsButtonFromEdit(interaction, 'repeat');
}

/**
 * Handle Pattern button - wrapper for handleSettingsButtonFromEdit
 */
async function handlePatternButtonFromEdit(interaction) {
    return await handleSettingsButtonFromEdit(interaction, 'pattern');
}

/**
 * Handle Save button - updates message, deletes after 3 seconds
 */
async function handleSaveButton(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const notificationId = parts[3];
        const userId = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.editNotification.errors.notificationNotFound,
                ephemeral: true
            });
        }

        // Update scheduler if notification is active
        if (notification.is_active) {
            await notificationScheduler.removeNotification(parseInt(notificationId));
            await notificationScheduler.addNotification(parseInt(notificationId));
        }

        adminLogQueries.addLog(
            interaction.user.id,
            LOG_CODES.NOTIFICATION.EDITED,
            JSON.stringify({
                notification_id: notificationId,
                name: notification.name,
                action: 'saved_changes'
            })
        );

        // Update message to show success
        await interaction.update({
            content: lang.notification.editNotification.content.saved,
            embeds: [],
            components: []
        });

        // Delete message after 3 seconds
        setTimeout(async () => {
            try {
                await interaction.deleteReply();
            } catch (error) {
                // Silently fail if message was already deleted
            }
        }, 3000);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleSaveButton');
    }
}

/**
 * Handle Disable button - clears next_trigger and removes from scheduler
 */
async function handleDisableButton(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const notificationId = parseInt(parts[3]);
        const userId = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const notification = notificationQueries.getNotificationById(notificationId);

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.editNotification.errors.notificationNotFound,
                ephemeral: true
            });
        }

        if (!notification.is_active) {
            return await interaction.reply({
                content: lang.notification.editNotification.errors.alreadyDisabled,
                ephemeral: true
            });
        }

        // Update notification next_trigger to 0 (no next trigger) and mark inactive
        notificationQueries.updateNotification(
            notificationId,
            notification.name,
            notification.guild_id,
            notification.channel_id,
            notification.hour,
            notification.minute,
            notification.message_content,
            notification.title,
            notification.description,
            notification.color,
            notification.image_url,
            notification.thumbnail_url,
            notification.footer,
            notification.author,
            notification.fields,
            notification.pattern,
            notification.mention,
            notification.repeat_status,
            notification.repeat_frequency,
            notification.embed_toggle,
            0,
            notification.last_trigger,
            0
        );

        // Remove from scheduler
        await notificationScheduler.removeNotification(notificationId);

        adminLogQueries.addLog(
            interaction.user.id,
            LOG_CODES.NOTIFICATION.EDITED,
            JSON.stringify({ notification_id: notificationId, action: 'disabled' })
        );

        // Acknowledge and update panel
        await interaction.deferUpdate();
        const updatedNotification = notificationQueries.getNotificationById(notificationId);
        await showNotificationEditPanel(interaction, updatedNotification, lang, true);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleDisableButton');
    }
}

/**
 * Get filtered notifications by type and permissions
 * @param {string} type - 'server' or 'private'
 * @param {string} userId - User ID for permission filtering
 * @param {Object} adminData - Admin data with permissions
 * @param {string} guildId - Guild ID for server notification filtering
 * @returns {Array} Filtered notifications
 */
function getFilteredNotifications(type, userId, adminData, guildId = null) {
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
    createEditNotificationButton,
    handleEditNotificationButton,
    handleTypeSelection,
    handleEditNotificationPagination,
    handleNotificationSelection,
    showNotificationEditPanel,
    handleInfoButton,
    handleInfoModal,
    handleContentButton,
    handleRepeatButtonFromEdit,
    handlePatternButtonFromEdit,
    handleSaveButton,
    handleDisableButton,
    getFilteredNotifications 
};
