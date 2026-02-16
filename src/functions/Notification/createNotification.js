const { ButtonBuilder,
    ButtonStyle,

    ActionRowBuilder,
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
const { notificationQueries, adminLogQueries } = require('../utility/database');
const { LOG_CODES } = require('../utility/AdminLogs');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { getAdminLang, assertUserMatches, sendError, hasPermission, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const notificationMentions = require('./notificationMentions');
const { processMentionsAfterContentUpdate, showTagSelectionMenu } = notificationMentions;
const notificationFields = require('./notificationFields');
const notificationSettings = require('./notificationSettings');
const { showPatternSelection } = notificationSettings;
const notificationEditor = require('./notificationEditor');
const { sendNotificationEditorMessage } = notificationEditor;
const { getEmojiMapForAdmin, getComponentEmoji } = require('./../utility/emojis');


/**
 * Create the main notification management button
 */
function createNotificationButton(userId, lang) {
    return new ButtonBuilder()
        .setCustomId(`notification_create_${userId}`)
        .setLabel(lang.notification.mainPage.buttons.createNotification)
        .setStyle(ButtonStyle.Primary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1022'));
}

/**
 * Handle the main notification management button click
 * @param {import('discord.js').Interaction} interaction - Discord interaction
 */
async function handleNotificationCreateButton(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        const expectedUserId = interaction.customId.split('_')[2]; // notification_create_userId

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permission for server notifications only
        const hasServerPermission = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.NOTIFICATIONS_MANAGEMENT);

        // Show server/private notification choice buttons
        const serverButton = new ButtonBuilder()
            .setCustomId(`notification_type_server_${expectedUserId}`)
            .setLabel(lang.notification.createNotification.buttons.serverNotification)
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!hasServerPermission)
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(expectedUserId), '1022'));

        const privateButton = new ButtonBuilder()
            .setCustomId(`notification_type_private_${expectedUserId}`)
            .setLabel(lang.notification.createNotification.buttons.privateNotification)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(expectedUserId), '1029'));

        const row = new ActionRowBuilder().addComponents(serverButton, privateButton);

        const container = [
            new ContainerBuilder()
                .setAccentColor(2417109) // blue
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.notification.createNotification.content.title.base}\n` +
                        `${lang.notification.createNotification.content.serverNotificationField.name}\n` +
                        `${lang.notification.createNotification.content.serverNotificationField.value}\n` +

                        `${lang.notification.createNotification.content.privateNotificationField.name}\n` +
                        `${lang.notification.createNotification.content.privateNotificationField.value}\n`
                    )
                )
                .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
                .addActionRowComponents(
                    row
                )
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleNotificationCreateButton');
    }
}

/**
 * Handle notification type selection (server or private)
 */
async function handleNotificationTypeButton(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        const expectedUserId = interaction.customId.split('_')[3]; // notification_type_type_userId
        const type = interaction.customId.split('_')[2]; // server or private

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions for server notifications
        if (type === 'server') {
            const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.NOTIFICATIONS_MANAGEMENT);

            if (!hasAccess) {
                return await interaction.reply({
                    content: lang.common.noPermission,
                    ephemeral: true
                });
            }
        }

        // Show modal with name, date, and time fields
        await showCreateNotificationModal(interaction, type);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleNotificationTypeButton');
    }
}

/**
 * Show the create notification modal
 */
async function showCreateNotificationModal(interaction, type) {
    // Get admin language preference
    const { lang } = getAdminLang(interaction.user.id);

    // Get current date and time in UTC
    const now = new Date();
    const day = String(now.getUTCDate()).padStart(2, '0');
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const year = now.getUTCFullYear();
    const hours = String(now.getUTCHours()).padStart(2, '0');
    const minutes = String(now.getUTCMinutes()).padStart(2, '0');
    const seconds = String(now.getUTCSeconds()).padStart(2, '0');

    const modal = new ModalBuilder()
        .setCustomId(`notification_create_${type}_${interaction.user.id}`)
        .setTitle(lang.notification.createNotification.modal.title.notificationDetails);

    const nameInput = new TextInputBuilder()
        .setCustomId('notification_name')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(lang.notification.createNotification.modal.nameInput.placeholder)
        .setRequired(true)
        .setMaxLength(100);

    const nameLabel = new LabelBuilder()
        .setLabel(lang.notification.createNotification.modal.nameInput.label)
        .setTextInputComponent(nameInput);

    const dateInput = new TextInputBuilder()
        .setCustomId('notification_date')
        .setStyle(TextInputStyle.Short)
        .setValue(`${day}/${month}/${year}`)
        .setPlaceholder(lang.notification.createNotification.modal.dateInput.placeholder)
        .setRequired(true);

    const dateLabel = new LabelBuilder()
        .setLabel(lang.notification.createNotification.modal.dateInput.label)
        .setTextInputComponent(dateInput);

    const timeInput = new TextInputBuilder()
        .setCustomId('notification_time')
        .setStyle(TextInputStyle.Short)
        .setValue(`${hours}:${minutes}:${seconds}`)
        .setPlaceholder(lang.notification.createNotification.modal.timeInput.placeholder)
        .setRequired(true);

    const timeLabel = new LabelBuilder()
        .setLabel(lang.notification.createNotification.modal.timeInput.label)
        .setTextInputComponent(timeInput);

    modal.addLabelComponents(nameLabel, dateLabel, timeLabel);

    await interaction.showModal(modal);
}

/**
 * Handle notification creation modal submission
 */
async function handleCreateNotificationModal(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        const [, , type, userId] = interaction.customId.split('_');

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        // Check admin permission only for server notifications
        if (type === 'server' && !adminData) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Parse form data
        const name = interaction.fields.getTextInputValue('notification_name');
        const dateStr = interaction.fields.getTextInputValue('notification_date');
        const timeStr = interaction.fields.getTextInputValue('notification_time');

        // Parse date (DD/MM/YYYY) and time (HH:MM:SS) with range validation
        const parsedDate = parseDateParts(dateStr);
        if (!parsedDate) {
            return await interaction.reply({
                content: lang.notification.createNotification.errors.invalidDateFormat,
                ephemeral: true
            });
        }

        const parsedTime = parseTimeParts(timeStr);
        if (!parsedTime) {
            return await interaction.reply({
                content: lang.notification.createNotification.errors.invalidTimeFormat,
                ephemeral: true
            });
        }

        const { day, month, year } = parsedDate;
        const { hour, minute, second } = parsedTime;

        // Create next_trigger timestamp from user's date/time input as UTC
        const nextTriggerDate = new Date(Date.UTC(year, month, day, hour, minute, second));
        const nextTriggerTimestamp = Math.floor(nextTriggerDate.getTime() / 1000); // Convert to Unix timestamp

        // Create notification in database
        const guildId = type === 'server' ? interaction.guild.id : null;
        const channelId = null; // Will be set later for server notifications

        try {
            const result = notificationQueries.addNotification(
                name,                    // name
                type,                    // type (server or private)
                false,                   // completed (false initially)
                guildId,                 // guild_id
                channelId,               // channel_id
                hour,                    // hour
                minute,                  // minute
                null,                    // message_content (null initially)
                null,                    // title
                null,                    // description
                null,                    // color
                null,                    // image_url
                null,                    // thumbnail_url
                null,                    // footer
                null,                    // author
                null,                    // fields (null initially)
                null,                    // pattern
                null,                    // mention
                0,                       // repeat_status
                0,                       // repeat_frequency
                false,                   // embed_toggle (false initially)
                false,                   // is_active (false initially)
                null,                    // last_trigger
                nextTriggerTimestamp,    // next_trigger (set from user's date/time)
                interaction.user.id      // created_by (Discord user ID)
            );

            const notificationId = result.lastInsertRowid;

            // Log notification creation
            adminLogQueries.addLog(
                interaction.user.id,
                LOG_CODES.NOTIFICATION.CREATED,
                JSON.stringify({
                    name: name,
                    type: type
                })
            );


            // Send message with editor message
            await sendNotificationEditorMessage(interaction, notificationId, type, lang);

        } catch (dbError) {
            await sendError(interaction, lang, dbError, 'handleCreateNotificationModal');
        }
    } catch (error) {
        await sendError(interaction, lang, error, 'handleCreateNotificationModal');
    }
}

// Initialize module references for notificationEditor
const { showEmbedEditor } = notificationEditor;
try {
    notificationMentions.setModuleReferences(showEmbedEditor);

    notificationFields.setModuleReferences(showTagSelectionMenu, showEmbedEditor);

    notificationEditor.setModuleReferences(processMentionsAfterContentUpdate, showTagSelectionMenu);
} catch (error) {
    console.error('createNotification: Error initializing module references:', error);
}

/**
 * Handle save button
 */
async function handleSaveButton(interaction) {
    // Get admin language preference
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const [, , notificationId, userId] = interaction.customId.split('_');

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.createNotification.errors.notificationNotFound,
                ephemeral: true
            });
        }

        // Validation: Check content requirements based on embed_toggle
        const defaultMessageContent = lang.notification.notificationEditor.defaultValues.messageContent;
        const defaultTitle = lang.notification.notificationEditor.defaultValues.embedTitle;
        const defaultDescription = lang.notification.notificationEditor.defaultValues.embedDescription;

        if (notification.embed_toggle) {
            // Embed is ON: At least one embed component must have non-default value
            const hasTitle = notification.title && notification.title.trim() && notification.title !== defaultTitle;
            const hasDescription = notification.description && notification.description.trim() && notification.description !== defaultDescription;
            const hasFields = notification.fields && notification.fields !== '[]' && notification.fields !== null;
            const hasAuthor = notification.author && notification.author.trim();
            const hasFooter = notification.footer && notification.footer.trim();
            const hasImage = notification.image_url && notification.image_url.trim();
            const hasThumbnail = notification.thumbnail_url && notification.thumbnail_url.trim();

            const hasAnyEmbedContent = hasTitle || hasDescription || hasFields || hasAuthor || hasFooter || hasImage || hasThumbnail;

            if (!hasAnyEmbedContent) {
                return await interaction.reply({
                    content: lang.notification.createNotification.errors.embedRequiresContent,
                    ephemeral: true
                });
            }
        } else {
            // Embed is OFF: Message content is required and must not be default
            const hasMessageContent = notification.message_content &&
                notification.message_content.trim() &&
                notification.message_content !== defaultMessageContent;

            if (!hasMessageContent) {
                return await interaction.reply({
                    content: lang.notification.createNotification.errors.messageContentRequired,
                    ephemeral: true
                });
            }
        }

        try {
            // Check if notification is in edit mode (completed or active) or in creation flow
            const wasActive = notification.is_active === 1;
            const isCompleted = notification.completed === 1;

            if (wasActive || isCompleted) {
                // Edit mode: Update scheduler if active and return to edit panel
                if (wasActive) {
                    const { notificationScheduler } = require('./notificationScheduler');
                    await notificationScheduler.removeNotification(parseInt(notificationId));
                    await notificationScheduler.addNotification(parseInt(notificationId));
                }

                // Get updated notification and show edit panel
                const updatedNotification = notificationQueries.getNotificationById(parseInt(notificationId));
                const editNotification = require('./editNotification');

                await interaction.reply({
                    content: lang.notification.editNotification.content.infoUpdated.replace('info', 'content'),
                    ephemeral: true
                });

                await editNotification.showNotificationEditPanel(interaction, updatedNotification, lang, true);
            } else {
                // Creation mode: Continue to pattern selection
                await showPatternSelection(interaction, parseInt(notificationId), lang);
            }

        } catch (dbError) {
            await sendError(interaction, lang, dbError, 'handleSaveButton');
        }
    } catch (error) {
        await sendError(interaction, lang, error, 'handleSaveButton');
    }
}


// Simple date/time validators to reject malformed input early
function parseDateParts(dateStr) {
    const dateParts = dateStr.split('/');
    if (dateParts.length !== 3) return null;

    const day = Number(dateParts[0]);
    const month = Number(dateParts[1]);
    const year = Number(dateParts[2]);

    if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return null;
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;

    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) {
        return null;
    }

    return { day, month: month - 1, year };
}

function parseTimeParts(timeStr) {
    const timeParts = timeStr.split(':');
    if (timeParts.length !== 3) return null;

    const hour = Number(timeParts[0]);
    const minute = Number(timeParts[1]);
    const second = Number(timeParts[2]);

    if (!Number.isInteger(hour) || !Number.isInteger(minute) || !Number.isInteger(second)) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;

    return { hour, minute, second };
}

module.exports = {
    createNotificationButton,
    handleNotificationCreateButton,
    handleNotificationTypeButton,
    handleCreateNotificationModal,
    handleSaveButton
};
