const { ButtonBuilder, ButtonStyle, EmbedBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelSelectMenuBuilder, ChannelType, LabelBuilder } = require('discord.js');
const { adminQueries, notificationQueries, systemLogQueries, adminLogQueries } = require('../utility/database');
const { LOG_CODES } = require('../utility/AdminLogs');
const { notificationScheduler } = require('./notificationScheduler');
const { getAdminLang, assertUserMatches, sendError } = require('../utility/commonFunctions');
const { parseMentions, convertTagsToMentions } = require('./notificationUtils');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../utility/emojis');

/**
 * Show pattern selection for notification timing
 */
async function showPatternSelection(interaction, notificationId, lang) {
    const embed = new EmbedBuilder()
        .setTitle(lang.notification.notificationSettings.content.title.pattern)
        .setDescription(lang.notification.notificationSettings.content.description.pattern)
        .setColor('#FFA500');

    const fiveMinButton = new ButtonBuilder()
        .setCustomId(`notification_pattern_5m_${notificationId}_${interaction.user.id}`)
        .setLabel(lang.notification.notificationSettings.buttons.fiveMinutes)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1025'));

    const fiveAndFifteenButton = new ButtonBuilder()
        .setCustomId(`notification_pattern_5m15m_${notificationId}_${interaction.user.id}`)
        .setLabel(lang.notification.notificationSettings.buttons.fiveAndFifteenMinutes)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1025'));

    const onTimeButton = new ButtonBuilder()
        .setCustomId(`notification_pattern_ontime_${notificationId}_${interaction.user.id}`)
        .setLabel(lang.notification.notificationSettings.buttons.onTime)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1043'));

    const customButton = new ButtonBuilder()
        .setCustomId(`notification_pattern_custom_${notificationId}_${interaction.user.id}`)
        .setLabel(lang.notification.notificationSettings.buttons.custom)
        .setStyle(ButtonStyle.Primary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1038'));

    const row = new ActionRowBuilder().addComponents(fiveMinButton, fiveAndFifteenButton, onTimeButton, customButton);

    await interaction.update({
        content: null,
        embeds: [embed],
        components: [row]
    });
}

/**
 * Handle pattern selection buttons
 */
async function handlePatternButton(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const patternType = parts[2]; // 5m, 5m15m, ontime, custom
        const notificationId = parts[3];
        const userId = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        if (patternType === 'custom') {
            await showCustomPatternModal(interaction, notificationId);
        } else {
            let pattern;
            switch (patternType) {
                case '5m':
                    pattern = '5';
                    break;
                case '5m15m':
                    pattern = '5,15';
                    break;
                case 'ontime':
                    pattern = 'time';
                    break;
            }

            const notification = notificationQueries.getNotificationById(parseInt(notificationId));
            if (!notification) {
                return await interaction.reply({
                    content: lang.notification.notificationEditor.errors.notificationNotFound,
                    ephemeral: true
                });
            }

            try {
                notificationQueries.updateNotification(
                    parseInt(notificationId),
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
                    pattern,
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
                    LOG_CODES.NOTIFICATION.PATTERN_SET,
                    JSON.stringify({
                        name: notification.name,
                        patternType: patternType
                    })
                );

                // Check if notification is in edit mode (completed or active) or in creation flow
                const wasActive = notification.is_active === 1;
                const isCompleted = notification.completed === 1;

                if (wasActive || isCompleted) {
                    // Edit mode: Update scheduler if active and return to edit panel
                    if (wasActive) {
                        await notificationScheduler.removeNotification(parseInt(notificationId));
                        await notificationScheduler.addNotification(parseInt(notificationId));
                    }

                    // Get updated notification and show edit panel
                    const updatedNotification = notificationQueries.getNotificationById(parseInt(notificationId));
                    const editNotification = require('./editNotification');

                    await interaction.reply({
                        content: lang.notification.editNotification.content.infoUpdated.replace('info', 'pattern'),
                        ephemeral: true
                    });

                    await editNotification.showNotificationEditPanel(interaction, updatedNotification, lang, true);
                } else {
                    // Creation mode: Continue to repeat selection
                    await showRepeatSelection(interaction, parseInt(notificationId), lang);
                }

            } catch (dbError) {
                await sendError(interaction, lang, dbError, 'handlePatternButton');
            }
        }
    } catch (error) {
        await sendError(interaction, lang, error, 'handlePatternButton');
    }
}

/**
 * Show custom pattern modal
 */
async function showCustomPatternModal(interaction, notificationId) {
    const { lang } = getAdminLang(interaction.user.id);

    const modal = new ModalBuilder()
        .setCustomId(`notification_pattern_custom_modal_${notificationId}_${interaction.user.id}`)
        .setTitle(lang.notification.notificationSettings.modal.customPattern.title);

    const patternInput = new TextInputBuilder()
        .setCustomId('pattern_value')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(lang.notification.notificationSettings.modal.customPattern.placeholder)
        .setRequired(true)
        .setMaxLength(100);

    const patternLabel = new LabelBuilder()
        .setLabel(lang.notification.notificationSettings.modal.customPattern.label)
        .setDescription(lang.notification.notificationSettings.modal.customPattern.description)
        .setTextInputComponent(patternInput);

    modal.addLabelComponents(patternLabel);

    await interaction.showModal(modal);
}

/**
 * Handle custom pattern modal submission
 */
async function handleCustomPatternModal(interaction) {
    const { lang } = getAdminLang(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const notificationId = parts[4];
        const userId = parts[5];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const pattern = interaction.fields.getTextInputValue('pattern_value').trim();

        // Validate pattern format: X or X,X,time or just time
        const patternRegex = /^((\d+)(,\d+)*(,time)?|(time)(,\d+)*|((\d+,)*time(,\d+)*))$/;
        if (!patternRegex.test(pattern)) {
            return await interaction.reply({
                content: lang.notification.notificationSettings.errors.invalidPattern,
                ephemeral: true
            });
        }

        const notification = notificationQueries.getNotificationById(parseInt(notificationId));
        if (!notification) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.notificationNotFound,
                ephemeral: true
            });
        }

        try {
            notificationQueries.updateNotification(
                parseInt(notificationId),
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
                pattern,
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
                LOG_CODES.NOTIFICATION.PATTERN_CUSTOM,
                JSON.stringify({
                    name: notification.name
                })
            );

            // Check if notification is in edit mode (completed or active) or in creation flow
            const wasActive = notification.is_active === 1;
            const isCompleted = notification.completed === 1;

            if (wasActive || isCompleted) {
                // Edit mode: Update scheduler if active and return to edit panel
                if (wasActive) {
                    await notificationScheduler.removeNotification(parseInt(notificationId));
                    await notificationScheduler.addNotification(parseInt(notificationId));
                }

                // Get updated notification and show edit panel
                const updatedNotification = notificationQueries.getNotificationById(parseInt(notificationId));
                const editNotification = require('./editNotification');

                await interaction.reply({
                    content: lang.notification.editNotification.content.infoUpdated.replace('info', 'pattern'),
                    ephemeral: true
                });

                await editNotification.showNotificationEditPanel(interaction, updatedNotification, lang, true);
            } else {
                // Creation mode: Continue to repeat selection
                await showRepeatSelection(interaction, parseInt(notificationId), lang);
            }

        } catch (dbError) {
            await sendError(interaction, lang, dbError, 'handleCustomPatternModal');
        }
    } catch (error) {
        await sendError(interaction, lang, error, 'handleCustomPatternModal');
    }
}

/**
 * Show repeat frequency selection
 */
async function showRepeatSelection(interaction, notificationId, lang) {

    const embed = new EmbedBuilder()
        .setTitle(lang.notification.notificationSettings.content.title.repeat)
        .setDescription(lang.notification.notificationSettings.content.description.repeat)
        .setColor(0x5865f2);

    const everyDayButton = new ButtonBuilder()
        .setCustomId(`notification_repeat_daily_${notificationId}_${interaction.user.id}`)
        .setLabel(lang.notification.notificationSettings.buttons.everyDay)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1005'));

    const every2DaysButton = new ButtonBuilder()
        .setCustomId(`notification_repeat_2days_${notificationId}_${interaction.user.id}`)
        .setLabel(lang.notification.notificationSettings.buttons.every2Days)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1005'));

    const every2WeeksButton = new ButtonBuilder()
        .setCustomId(`notification_repeat_2weeks_${notificationId}_${interaction.user.id}`)
        .setLabel(lang.notification.notificationSettings.buttons.every2Weeks)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1005'));

    const noRepeatButton = new ButtonBuilder()
        .setCustomId(`notification_repeat_none_${notificationId}_${interaction.user.id}`)
        .setLabel(lang.notification.notificationSettings.buttons.noRepeat)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1043'));

    const customButton = new ButtonBuilder()
        .setCustomId(`notification_repeat_custom_${notificationId}_${interaction.user.id}`)
        .setLabel(lang.notification.notificationSettings.buttons.custom)
        .setStyle(ButtonStyle.Primary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1038'));

    const row = new ActionRowBuilder().addComponents(everyDayButton, every2DaysButton, every2WeeksButton, noRepeatButton, customButton);

    if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
            embeds: [embed],
            components: [row],
            content: null,
            ephemeral: true
        });
    } else {
        await interaction.update({
            embeds: [embed],
            content: null,
            components: [row]
        });
    }
}

/**
 * Handle repeat frequency buttons
 */
async function handleRepeatButton(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const repeatType = parts[2]; // daily, 2days, 2weeks, none, custom
        const notificationId = parts[3];
        const userId = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        if (repeatType === 'custom') {
            await showCustomRepeatModal(interaction, notificationId);
        } else {
            let repeatStatus;
            let repeatFrequency;

            switch (repeatType) {
                case 'daily':
                    repeatStatus = 1;
                    repeatFrequency = 86400; // 1 day in seconds
                    break;
                case '2days':
                    repeatStatus = 1;
                    repeatFrequency = 172800; // 2 days in seconds
                    break;
                case '2weeks':
                    repeatStatus = 1;
                    repeatFrequency = 1209600; // 14 days in seconds
                    break;
                case 'none':
                    repeatStatus = 0;
                    repeatFrequency = null;
                    break;
            }

            const notification = notificationQueries.getNotificationById(parseInt(notificationId));

            if (!notification) {
                return await interaction.reply({
                    content: lang.notification.notificationEditor.errors.notificationNotFound,
                    ephemeral: true
                });
            }

            try {
                notificationQueries.updateNotification(
                    parseInt(notificationId),
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
                    repeatStatus,
                    repeatFrequency,
                    notification.embed_toggle,
                    notification.is_active,
                    notification.last_trigger,
                    notification.next_trigger
                );

                adminLogQueries.addLog(
                    interaction.user.id,
                    LOG_CODES.NOTIFICATION.REPEAT_SET,
                    JSON.stringify({
                        name: notification.name,
                        repeatType: repeatType
                    })
                );

                // Check if notification is in edit mode (completed or active) or in creation flow
                const wasActive = notification.is_active === 1;
                const isCompleted = notification.completed === 1;

                if (wasActive || isCompleted) {
                    // Edit mode: Update scheduler if active and return to edit panel
                    if (wasActive) {
                        await notificationScheduler.removeNotification(parseInt(notificationId));
                        await notificationScheduler.addNotification(parseInt(notificationId));
                    }

                    // Get updated notification and show edit panel
                    const updatedNotification = notificationQueries.getNotificationById(parseInt(notificationId));
                    const editNotification = require('./editNotification');

                    await interaction.reply({
                        content: lang.notification.editNotification.content.infoUpdated.replace('info', 'repeat'),
                        ephemeral: true
                    });

                    await editNotification.showNotificationEditPanel(interaction, updatedNotification, lang, true);
                } else {
                    // Creation mode: Continue to channel selection
                    await showChannelSelection(interaction, parseInt(notificationId), lang);
                }

            } catch (dbError) {
                await sendError(interaction, lang, dbError, 'handleRepeatButton');
            }
        }
    } catch (error) {
        await sendError(interaction, lang, error, 'handleRepeatButton');
    }
}

/**
 * Show custom repeat modal
 */
async function showCustomRepeatModal(interaction, notificationId) {
    const { lang } = getAdminLang(interaction.user.id);
    const modal = new ModalBuilder()
        .setCustomId(`notification_repeat_custom_modal_${notificationId}_${interaction.user.id}`)
        .setTitle(lang.notification.notificationSettings.modal.customRepeat.title);

    const secondsInput = new TextInputBuilder()
        .setCustomId('repeat_seconds')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('0')
        .setValue('0')
        .setRequired(true);

    const secondsLabel = new LabelBuilder()
        .setLabel(lang.notification.notificationSettings.modal.customRepeat.seconds)
        .setTextInputComponent(secondsInput);

    const minutesInput = new TextInputBuilder()
        .setCustomId('repeat_minutes')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('0')
        .setValue('0')
        .setRequired(true);

    const minutesLabel = new LabelBuilder()
        .setLabel(lang.notification.notificationSettings.modal.customRepeat.minutes)
        .setTextInputComponent(minutesInput);

    const hoursInput = new TextInputBuilder()
        .setCustomId('repeat_hours')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('0')
        .setValue('0')
        .setRequired(true);

    const hoursLabel = new LabelBuilder()
        .setLabel(lang.notification.notificationSettings.modal.customRepeat.hours)
        .setTextInputComponent(hoursInput);

    const daysInput = new TextInputBuilder()
        .setCustomId('repeat_days')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('0')
        .setValue('0')
        .setRequired(true);

    const daysLabel = new LabelBuilder()
        .setLabel(lang.notification.notificationSettings.modal.customRepeat.days)
        .setTextInputComponent(daysInput);

    const monthsInput = new TextInputBuilder()
        .setCustomId('repeat_months')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('0')
        .setValue('0')
        .setRequired(true);

    const monthsLabel = new LabelBuilder()
        .setLabel(lang.notification.notificationSettings.modal.customRepeat.months)
        .setTextInputComponent(monthsInput);

    modal.addLabelComponents(secondsLabel, minutesLabel, hoursLabel, daysLabel, monthsLabel);

    await interaction.showModal(modal);
}

/**
 * Handle custom repeat modal submission
 */
async function handleCustomRepeatModal(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const notificationId = parts[4];
        const userId = parts[5];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const seconds = parseInt(interaction.fields.getTextInputValue('repeat_seconds')) || 0;
        const minutes = parseInt(interaction.fields.getTextInputValue('repeat_minutes')) || 0;
        const hours = parseInt(interaction.fields.getTextInputValue('repeat_hours')) || 0;
        const days = parseInt(interaction.fields.getTextInputValue('repeat_days')) || 0;
        const months = parseInt(interaction.fields.getTextInputValue('repeat_months')) || 0;

        const totalSeconds = seconds + (minutes * 60) + (hours * 3600) + (days * 86400) + (months * 2592000);

        if (totalSeconds === 0) {
            return await interaction.reply({
                content: lang.notification.notificationSettings.errors.invalidRepeat,
                ephemeral: true
            });
        }

        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.notificationNotFound,
                ephemeral: true
            });
        }

        try {
            notificationQueries.updateNotification(
                parseInt(notificationId),
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
                1,
                totalSeconds,
                notification.embed_toggle,
                notification.is_active,
                notification.last_trigger,
                notification.next_trigger
            );

            adminLogQueries.addLog(
                interaction.user.id,
                LOG_CODES.NOTIFICATION.REPEAT_SET,
                JSON.stringify({
                    name: notification.name,
                    repeatType: 'custom'
                })
            );

            // Check if notification is in edit mode (completed or active) or in creation flow
            const wasActive = notification.is_active === 1;
            const isCompleted = notification.completed === 1;

            if (wasActive || isCompleted) {
                // Edit mode: Update scheduler if active and return to edit panel
                if (wasActive) {
                    await notificationScheduler.removeNotification(parseInt(notificationId));
                    await notificationScheduler.addNotification(parseInt(notificationId));
                }

                // Get updated notification and show edit panel
                const updatedNotification = notificationQueries.getNotificationById(parseInt(notificationId));
                const editNotification = require('./editNotification');

                await interaction.reply({
                    content: lang.notification.editNotification.content.infoUpdated.replace('info', 'repeat'),
                    ephemeral: true
                });

                await editNotification.showNotificationEditPanel(interaction, updatedNotification, lang, true);
            } else {
                // Creation mode: Continue to channel selection
                await showChannelSelection(interaction, parseInt(notificationId), lang);
            }

        } catch (dbError) {
            await sendError(interaction, lang, dbError, 'handleCustomRepeatModal');
        }

    } catch (error) {
        await sendError(interaction, lang, error, 'handleCustomRepeatModal');
    }
}

/**
 * Show channel selection dropdown
 */
async function showChannelSelection(interaction, notificationId, lang) {

    const notification = notificationQueries.getNotificationById(notificationId);

    if (!notification) {
        return await interaction.reply({
            content: lang.notification.notificationEditor.errors.notificationNotFound,
            ephemeral: true
        });
    }

    // Check if it's a private notification
    if (!notification.guild_id) {
        try {
            const currentTime = Math.floor(Date.now() / 1000);
            if (notification.next_trigger && notification.next_trigger < currentTime) {

                const updateTimeButton = new ButtonBuilder()
                    .setCustomId(`notification_update_time_${notificationId}_${interaction.user.id}`)
                    .setLabel(lang.notification.notificationSettings.buttons.updateTime)
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('⏰');

                const row = new ActionRowBuilder().addComponents(updateTimeButton);

                return await interaction.update({
                    content: lang.notification.notificationSettings.errors.triggerTimePassed,
                    components: [row],
                    embeds: []
                });
            }

            notificationQueries.updateNotificationActiveStatus(notificationId, true);
            await notificationScheduler.removeNotification(notificationId);
            await notificationScheduler.addNotification(notificationId);

            adminLogQueries.addLog(
                interaction.user.id,
                LOG_CODES.NOTIFICATION.SETUP_COMPLETED,
                JSON.stringify({
                    name: notification.name,
                    channelName: 'Direct Message'
                })
            );

            await showFinalConfirmation(interaction, notificationId, null, lang);

        } catch (dbError) {
            await sendError(interaction, lang, dbError, 'showChannelSelection_privateActivation');
        }
        return;
    }

    // Server notification - show channel selection
    const embed = new EmbedBuilder()
        .setTitle(lang.notification.notificationSettings.content.title.selectChannel)
        .setDescription(lang.notification.notificationSettings.content.description.selectChannel)
        .setColor(0x5865f2);

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId(`notification_channel_select_${notificationId}_${interaction.user.id}`)
        .setPlaceholder(lang.notification.notificationSettings.selectMenu.channelPlaceholder)
        .setChannelTypes([ChannelType.GuildText])
        .setMinValues(1)
        .setMaxValues(1);

    const row = new ActionRowBuilder().addComponents(channelSelect);

    if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
            embeds: [embed],
            components: [row],
            ephemeral: true
        });
    } else {
        await interaction.update({
            embeds: [embed],
            components: [row]
        });
    }
}

/**
 * Handle channel selection
 */
async function handleChannelSelection(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const notificationId = parts[3];
        const userId = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const selectedChannelId = interaction.values[0];
        const selectedChannel = interaction.guild.channels.cache.get(selectedChannelId);

        if (!selectedChannel) {
            return await interaction.reply({
                content: lang.notification.notificationSettings.errors.invalidChannel,
                ephemeral: true
            });
        }

        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.notificationNotFound,
                ephemeral: true
            });
        }

        try {
            // Save channel (keep inactive until validation passes)
            notificationQueries.updateNotification(
                parseInt(notificationId),
                notification.name,
                notification.guild_id,
                selectedChannelId,
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
                notification.next_trigger
            );

            // Check if trigger time is still in the future
            const currentTime = Math.floor(Date.now() / 1000);
            if (notification.next_trigger && notification.next_trigger < currentTime) {

                const updateTimeButton = new ButtonBuilder()
                    .setCustomId(`notification_update_time_${notificationId}_${interaction.user.id}`)
                    .setLabel(lang.notification.notificationSettings.buttons.updateTime)
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('⏰');

                const row = new ActionRowBuilder().addComponents(updateTimeButton);

                return await interaction.update({
                    content: lang.notification.notificationSettings.errors.triggerTimePassed,
                    components: [row],
                    embeds: []
                });
            }

            // Time is valid - activate notification
            notificationQueries.updateNotificationActiveStatus(parseInt(notificationId), true);
            await notificationScheduler.removeNotification(parseInt(notificationId));
            await notificationScheduler.addNotification(parseInt(notificationId));

            adminLogQueries.addLog(
                interaction.user.id,
                LOG_CODES.NOTIFICATION.SETUP_COMPLETED,
                JSON.stringify({
                    name: notification.name,
                    channelName: selectedChannel.name
                })
            );

            await showFinalConfirmation(interaction, parseInt(notificationId), selectedChannel, lang);

        } catch (dbError) {
            await sendError(interaction, lang, dbError, 'handleChannelSelection_updateChannel');
        }

    } catch (error) {
        await sendError(interaction, lang, error, 'handleChannelSelection');
    }
}

/**
 * Handle update time button - redirect to notification creation modal to update time
 */
async function handleUpdateTimeButton(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const notificationId = parts[3];
        const userId = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.notificationSettings.errors.notificationNotFound,
                ephemeral: true
            });
        }

        // Get current date and time in UTC
        const now = new Date();
        const day = String(now.getUTCDate()).padStart(2, '0');
        const month = String(now.getUTCMonth() + 1).padStart(2, '0');
        const year = now.getUTCFullYear();
        const hours = String(now.getUTCHours()).padStart(2, '0');
        const minutes = String(now.getUTCMinutes()).padStart(2, '0');
        const seconds = String(now.getUTCSeconds()).padStart(2, '0');

        const modal = new ModalBuilder()
            .setCustomId(`notification_update_time_modal_${notificationId}_${userId}`)
            .setTitle(lang.notification.notificationSettings.modal.updateTime.title);

        const nameInput = new TextInputBuilder()
            .setCustomId('name')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(lang.notification.notificationSettings.modal.updateTime.nameField.placeholder)
            .setValue(notification.name)
            .setRequired(true);

        const nameLabel = new LabelBuilder()
            .setLabel(lang.notification.notificationSettings.modal.updateTime.nameField.label)
            .setTextInputComponent(nameInput);

        const dateInput = new TextInputBuilder()
            .setCustomId('date')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(lang.notification.notificationSettings.modal.updateTime.dateField.placeholder)
            .setValue(`${day}/${month}/${year}`)
            .setRequired(true);

        const dateLabel = new LabelBuilder()
            .setLabel(lang.notification.notificationSettings.modal.updateTime.dateField.label)
            .setTextInputComponent(dateInput);

        const timeInput = new TextInputBuilder()
            .setCustomId('time')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(lang.notification.notificationSettings.modal.updateTime.timeField.placeholder)
            .setValue(`${hours}:${minutes}:${seconds}`)
            .setRequired(true);

        const timeLabel = new LabelBuilder()
            .setLabel(lang.notification.notificationSettings.modal.updateTime.timeField.label)
            .setTextInputComponent(timeInput);

        modal.addLabelComponents(nameLabel, dateLabel, timeLabel);

        await interaction.showModal(modal);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleUpdateTimeButton');
    }
}

/**
 * Handle update time modal submission
 */
async function handleUpdateTimeModal(interaction) {
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
                content: lang.notification.notificationSettings.errors.invalidDateFormat,
                ephemeral: true
            });
        }

        const timeParts = timeStr.split(':');
        if (timeParts.length !== 3) {
            return await interaction.reply({
                content: lang.notification.notificationSettings.errors.invalidTimeFormat,
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
                content: lang.notification.notificationSettings.errors.invalidDateTime,
                ephemeral: true
            });
        }

        const nextTriggerDate = new Date(Date.UTC(year, month, day, hour, minute, second));
        const nextTriggerTimestamp = Math.floor(nextTriggerDate.getTime() / 1000);

        // Validate time is in future
        const currentTime = Math.floor(Date.now() / 1000);
        if (nextTriggerTimestamp < currentTime) {
            return await interaction.reply({
                content: lang.notification.notificationSettings.errors.timeStillInPast,
                ephemeral: true
            });
        }

        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.notificationSettings.errors.notificationNotFound,
                ephemeral: true
            });
        }

        try {
            // Update notification (keep inactive until channel selection)
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
                0,
                notification.last_trigger,
                nextTriggerTimestamp
            );

            adminLogQueries.addLog(
                interaction.user.id,
                LOG_CODES.NOTIFICATION.TIME_UPDATED,
                JSON.stringify({
                    name: name,
                    newTime: nextTriggerTimestamp
                })
            );

            const updatedNotification = notificationQueries.getNotificationById(parseInt(notificationId));

            // Reactivate notification
            notificationQueries.updateNotificationActiveStatus(parseInt(notificationId), true);
            await notificationScheduler.removeNotification(parseInt(notificationId));
            await notificationScheduler.addNotification(parseInt(notificationId));

            const channel = updatedNotification.guild_id && updatedNotification.channel_id
                ? interaction.guild.channels.cache.get(updatedNotification.channel_id)
                : null;

            await showFinalConfirmation(interaction, parseInt(notificationId), channel, lang);

        } catch (dbError) {
            await sendError(interaction, lang, dbError, 'handleUpdateTimeModal_updateNotification');
        }

    } catch (error) {
        await sendError(interaction, lang, error, 'handleUpdateTimeModal');
    }
}

/**
 * Show final confirmation with notification preview
 */
async function showFinalConfirmation(interaction, notificationId, channel, lang) {

    // Mark notification as completed since this is the final confirmation step
    notificationQueries.updateNotificationCompletedStatus(notificationId, true);

    const notification = notificationQueries.getNotificationById(notificationId);

    if (!notification) {
        return await interaction.reply({
            content: lang.notification.notificationEditor.errors.notificationNotFound,
            ephemeral: true
        });
    }

    // Format next trigger time in UTC
    const nextTrigger = new Date(notification.next_trigger * 1000);
    const nextTriggerStr = `${nextTrigger.getUTCDate()}/${nextTrigger.getUTCMonth() + 1}/${nextTrigger.getUTCFullYear()} ${String(nextTrigger.getUTCHours()).padStart(2, '0')}:${String(nextTrigger.getUTCMinutes()).padStart(2, '0')}`;

    // Format repeat frequency
    let repeatStr = 'No Repeat';
    if (notification.repeat_status === 1 && notification.repeat_frequency) {
        const freq = notification.repeat_frequency;
        const days = Math.floor(freq / 86400);
        const hours = Math.floor((freq % 86400) / 3600);
        const minutes = Math.floor((freq % 3600) / 60);
        const seconds = freq % 60;

        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        if (seconds > 0) parts.push(`${seconds}s`);

        repeatStr = `Every ${parts.join(' ')}`;
    }

    // Create preview embed
    const previewEmbed = new EmbedBuilder()
        .setTitle(lang.notification.notificationSettings.content.title.notificationPreview)
        .setDescription(lang.notification.notificationSettings.content.description.notificationPreview)
        .setColor('#33ff00');

    // Parse mentions for preview
    const mentions = parseMentions(notification.mention);

    const rawMessageContent = notification.message_content || null;
    const messageContent = convertTagsToMentions(rawMessageContent, mentions, 'message');

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
                await sendError(interaction, lang, error, 'showFinalConfirmation_parseFields');
            }
        }
    }


    const channelDisplay = channel ? channel.name : lang.notification.notificationSettings.content.channelField.directMessage;

    const infoEmbed = new EmbedBuilder()
        .setTitle(lang.notification.notificationSettings.content.title.notificationInformation)
        .addFields([
            { name: lang.notification.notificationSettings.content.nameField.name, value: lang.notification.notificationSettings.content.nameField.value.replace('{notificationName}', notification.name), inline: true },
            { name: lang.notification.notificationSettings.content.channelField.name, value: lang.notification.notificationSettings.content.channelField.value.replace('{channelMention}', channelDisplay), inline: true },
            { name: lang.notification.notificationSettings.content.TriggerField.name, value: lang.notification.notificationSettings.content.TriggerField.value.replace('{TriggerTime}', nextTriggerStr), inline: true },
            { name: lang.notification.notificationSettings.content.repeatField.name, value: lang.notification.notificationSettings.content.repeatField.value.replace('{repeat}', repeatStr), inline: true },
            { name: lang.notification.notificationSettings.content.patternField.name, value: lang.notification.notificationSettings.content.patternField.value.replace('{pattern}', notification.pattern || lang.notification.notificationSettings.content.patternField.time), inline: true },
        ])
        .setColor(0x57f287) // Green
        .setTimestamp();

    // previewEmbed - looks better without it.
    const embeds = [];
    if (notificationEmbed) {
        embeds.push(notificationEmbed);
    }
    embeds.push(infoEmbed);

    // Use update if possible (works for MessageComponent and ModalSubmit from MessageComponent)
    if (interaction.isMessageComponent() || (interaction.isModalSubmit() && interaction.message)) {
        await interaction.update({
            content: messageContent,
            embeds: embeds,
            components: []
        });
    } else {
        await interaction.reply({
            content: messageContent,
            embeds: embeds,
            components: [],
            ephemeral: true
        });
    }
}

module.exports = {
    showPatternSelection,
    handlePatternButton,
    showCustomPatternModal,
    handleCustomPatternModal,
    showRepeatSelection,
    handleRepeatButton,
    showCustomRepeatModal,
    handleCustomRepeatModal,
    showChannelSelection,
    handleChannelSelection,
    handleUpdateTimeButton,
    handleUpdateTimeModal,
    showFinalConfirmation
};
