const {
    ButtonBuilder,
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
    LabelBuilder,
    FileUploadBuilder
} = require('discord.js');
const https = require('https');
const { notificationQueries, adminLogQueries } = require('../utility/database');
const { LOG_CODES } = require('../utility/AdminLogs');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { getAdminLang, assertUserMatches, sendError, hasPermission, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { showEmbedEditor } = require('./notificationEditor');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../utility/emojis');

/**
 * Handle Upload Notification button - shows modal with file upload
 */
async function handleUploadNotificationButton(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const expectedUserId = interaction.customId.split('_')[2];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Create modal with file upload component
        const modal = new ModalBuilder()
            .setCustomId(`template_upload_file_modal_${interaction.user.id}_${Date.now()}`)
            .setTitle(lang.notification.uploadNotification.modal.title);

        const fileUpload = new FileUploadBuilder()
            .setCustomId('notification_template_file')
            .setRequired(true)
            .setMinValues(1)
            .setMaxValues(1);

        const fileLabel = new LabelBuilder()
            .setLabel(lang.notification.uploadNotification.modal.fileInput.label)
            .setFileUploadComponent(fileUpload);

        modal.addLabelComponents(fileLabel);

        await interaction.showModal(modal);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleUploadNotificationButton');
    }
}

/**
 * Validate notification JSON structure
 */
function validateNotificationJSON(jsonData) {
    const errors = [];

    // Check version
    if (!jsonData.version || jsonData.version !== '1.0') {
        errors.push('Invalid or missing version');
    }

    // Check required fields
    if (!jsonData.name || typeof jsonData.name !== 'string') {
        errors.push('Missing or invalid name');
    }

    // Must have either message_content OR embed content
    const hasMessageContent = jsonData.message_content && typeof jsonData.message_content === 'string';
    const hasEmbedContent = jsonData.embed_toggle && (
        jsonData.title || jsonData.description || jsonData.fields ||
        jsonData.author || jsonData.footer || jsonData.image_url || jsonData.thumbnail_url
    );

    if (!hasMessageContent && !hasEmbedContent) {
        errors.push('Must have either message_content or embed content');
    }

    // Validate fields structure if present
    if (jsonData.fields) {
        if (!Array.isArray(jsonData.fields)) {
            errors.push('fields must be an array');
        } else {
            jsonData.fields.forEach((field, index) => {
                if (!field.name || !field.value) {
                    errors.push(`Field ${index} missing name or value`);
                }
            });
        }
    }

    return {
        valid: errors.length === 0,
        errors: errors
    };
}

/**
 * Download file from URL
 * - Only allows Discord CDN URLs (cdn.discordapp.com, media.discordapp.net)
 * - Enforces a maximum file size to prevent memory exhaustion
 */
function downloadFile(url) {
    return new Promise((resolve, reject) => {
        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch (e) {
            return reject(new Error('Invalid URL'));
        }

        // Allow only HTTPS and specific Discord CDN hosts to mitigate SSRF
        const allowedHosts = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
        if (parsedUrl.protocol !== 'https:' || !allowedHosts.has(parsedUrl.hostname)) {
            return reject(new Error('URL is not an allowed Discord CDN URL'));
        }

        const MAX_BYTES = 5 * 1024 * 1024; // 5 MB limit

        https.get(parsedUrl, (response) => {
            const { statusCode, headers } = response;

            if (statusCode !== 200) {
                // Drain data to free up memory/sockets
                response.resume();
                return reject(new Error(`Failed to download file, status code: ${statusCode}`));
            }

            const contentLengthHeader = headers['content-length'];
            if (contentLengthHeader) {
                const contentLength = parseInt(contentLengthHeader, 10);
                if (!Number.isNaN(contentLength) && contentLength > MAX_BYTES) {
                    response.resume();
                    return reject(new Error('File too large'));
                }
            }

            const chunks = [];
            let totalBytes = 0;
            let aborted = false;

            response.on('data', (chunk) => {
                if (aborted) return;

                totalBytes += chunk.length;
                if (totalBytes > MAX_BYTES) {
                    aborted = true;
                    response.destroy(new Error('File too large'));
                    return;
                }
                chunks.push(chunk);
            });

            response.on('end', () => {
                if (aborted || totalBytes > MAX_BYTES) return; // error event already fired

                const data = Buffer.concat(chunks).toString('utf8');
                try {
                    const jsonData = JSON.parse(data);
                    resolve(jsonData);
                } catch (error) {
                    reject(new Error('Invalid JSON format'));
                }
            });

            response.on('error', (err) => {
                if (!aborted) {
                    reject(err);
                } else {
                    reject(new Error('File too large'));
                }
            });
        }).on('error', (error) => {
            reject(error);
        });
    });
}

/**
 * Handle file upload modal submission - validates and shows type selection
 */
async function handleFileUploadModalSubmit(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const userId = parts[4];
        const timestamp = parts[5];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        // Get uploaded files (returns Collection)
        const uploadedFiles = interaction.fields.getUploadedFiles('notification_template_file');

        if (!uploadedFiles || uploadedFiles.size === 0) {
            return await interaction.reply({
                content: lang.notification.uploadNotification.errors.invalidFileType,
                ephemeral: true
            });
        }

        // Get first uploaded file from Collection
        const fileData = uploadedFiles.first();

        // Check if file is JSON
        if (!fileData.name || !fileData.name.endsWith('.json')) {
            return await interaction.reply({
                content: lang.notification.uploadNotification.errors.invalidFileType,
                ephemeral: true
            });
        }

        // Download and parse JSON from the attachment URL
        let jsonData;
        try {
            jsonData = await downloadFile(fileData.url);
        } catch (error) {
            const content = error.message === 'File too large'
                ? lang.notification.uploadNotification.errors.fileTooLarge
                : lang.notification.uploadNotification.errors.processingError;

            return await interaction.reply({
                content,
                ephemeral: true
            });
        }

        // Validate JSON
        const validation = validateNotificationJSON(jsonData);
        if (!validation.valid) {
            return await interaction.reply({
                content: lang.notification.uploadNotification.errors.invalidJSON + '\n' + validation.errors.join('\n'),
                ephemeral: true
            });
        }

        // Show type selection (server or private)
        const serverButton = new ButtonBuilder()
            .setCustomId(`template_import_type_server_${interaction.user.id}_${timestamp}`)
            .setLabel(lang.notification.uploadNotification.buttons.serverNotification)
            .setStyle(ButtonStyle.Primary)
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1022'));

        const privateButton = new ButtonBuilder()
            .setCustomId(`template_import_type_private_${interaction.user.id}_${timestamp}`)
            .setLabel(lang.notification.uploadNotification.buttons.privateNotification)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1029'));

        const buttonRow = new ActionRowBuilder().addComponents(serverButton, privateButton);

        const container = [
            new ContainerBuilder()
                .setAccentColor(9807270) // purple
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.notification.uploadNotification.content.title.typeSelection}\n` +
                        `${lang.notification.uploadNotification.content.validationSuccess.replace('{name}', jsonData.name)}\n\n` +
                        `${lang.notification.uploadNotification.content.typePrompt}`
                    )
                )
                .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
                .addActionRowComponents(buttonRow)
        ];

        // Store JSON data temporarily
        if (!global.pendingImports) global.pendingImports = new Map();
        global.pendingImports.set(`${interaction.user.id}_${timestamp}`, jsonData);

        // Clean up old imports (older than 5 minutes)
        const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
        for (const [key] of global.pendingImports) {
            const keyTimestamp = parseInt(key.split('_')[1]);
            if (keyTimestamp < fiveMinutesAgo) {
                global.pendingImports.delete(key);
            }
        }

        await interaction.reply({
            components: container,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleFileUploadModalSubmit');
    }
}

/**
 * Handle import type selection (server or private)
 */
async function handleImportTypeSelection(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const type = parts[3]; // 'server' or 'private'
        const userId = parts[4];
        const timestamp = parts[5];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

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

        // Retrieve stored JSON data
        if (!global.pendingImports) global.pendingImports = new Map();
        const jsonData = global.pendingImports.get(`${userId}_${timestamp}`);

        if (!jsonData) {
            return await interaction.reply({
                content: lang.notification.uploadNotification.errors.dataExpired,
                ephemeral: true
            });
        }

        // Show modal with name, date, and time
        await showImportModal(interaction, type, jsonData, timestamp);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleImportTypeSelection');
    }
}

/**
 * Show import modal with name, date, and time
 */
async function showImportModal(interaction, type, jsonData, timestamp) {
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
        .setCustomId(`template_import_modal_${type}_${interaction.user.id}_${timestamp}`)
        .setTitle(lang.notification.uploadNotification.modal.title);

    const nameInput = new TextInputBuilder()
        .setCustomId('notification_name')
        .setStyle(TextInputStyle.Short)
        .setValue(jsonData.name)
        .setPlaceholder(lang.notification.uploadNotification.modal.nameInput.placeholder)
        .setRequired(true)
        .setMaxLength(100);

    const nameLabel = new LabelBuilder()
        .setLabel(lang.notification.uploadNotification.modal.nameInput.label)
        .setTextInputComponent(nameInput);

    const dateInput = new TextInputBuilder()
        .setCustomId('notification_date')
        .setStyle(TextInputStyle.Short)
        .setValue(`${day}/${month}/${year}`)
        .setPlaceholder(lang.notification.uploadNotification.modal.dateInput.placeholder)
        .setRequired(true);

    const dateLabel = new LabelBuilder()
        .setLabel(lang.notification.uploadNotification.modal.dateInput.label)
        .setTextInputComponent(dateInput);

    const timeInput = new TextInputBuilder()
        .setCustomId('notification_time')
        .setStyle(TextInputStyle.Short)
        .setValue(`${hours}:${minutes}:${seconds}`)
        .setPlaceholder(lang.notification.uploadNotification.modal.timeInput.placeholder)
        .setRequired(true);

    const timeLabel = new LabelBuilder()
        .setLabel(lang.notification.uploadNotification.modal.timeInput.label)
        .setTextInputComponent(timeInput);

    modal.addLabelComponents(nameLabel, dateLabel, timeLabel);

    await interaction.showModal(modal);
}

/**
 * Handle import modal submission - creates notification and opens editor
 */
async function handleImportModalSubmit(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const type = parts[3]; // 'server' or 'private'
        const userId = parts[4];
        const timestamp = parts[5];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        // Check permissions
        if (type === 'server' && !adminData) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Retrieve stored JSON data
        if (!global.pendingImports) global.pendingImports = new Map();
        const jsonData = global.pendingImports.get(`${userId}_${timestamp}`);

        if (!jsonData) {
            return await interaction.reply({
                content: lang.notification.uploadNotification.errors.dataExpired,
                ephemeral: true
            });
        }

        // Parse form data
        const name = interaction.fields.getTextInputValue('notification_name');
        const dateStr = interaction.fields.getTextInputValue('notification_date');
        const timeStr = interaction.fields.getTextInputValue('notification_time');

        // Parse date (DD/MM/YYYY)
        const dateParts = dateStr.split('/');
        if (dateParts.length !== 3) {
            return await interaction.reply({
                content: lang.notification.uploadNotification.errors.invalidDateFormat,
                ephemeral: true
            });
        }

        // Parse time (HH:MM:SS)
        const timeParts = timeStr.split(':');
        if (timeParts.length !== 3) {
            return await interaction.reply({
                content: lang.notification.uploadNotification.errors.invalidTimeFormat,
                ephemeral: true
            });
        }

        const day = parseInt(dateParts[0]);
        const month = parseInt(dateParts[1]) - 1;
        const year = parseInt(dateParts[2]);
        const hour = parseInt(timeParts[0]);
        const minute = parseInt(timeParts[1]);
        const second = parseInt(timeParts[2]);

        // Validate date/time
        if (isNaN(day) || isNaN(month) || isNaN(year) || isNaN(hour) || isNaN(minute) || isNaN(second)) {
            return await interaction.reply({
                content: lang.notification.uploadNotification.errors.invalidDateTime,
                ephemeral: true
            });
        }

        // Create next_trigger timestamp
        const nextTriggerDate = new Date(Date.UTC(year, month, day, hour, minute, second));
        const nextTriggerTimestamp = Math.floor(nextTriggerDate.getTime() / 1000);

        // Create notification in database with imported data
        const guildId = type === 'server' ? interaction.guild.id : null;
        const channelId = type === 'server' ? null : null;

        try {
            const result = notificationQueries.addNotification(
                name,
                type,
                false, // completed (will be set after editing)
                guildId,
                channelId,
                hour,
                minute,
                jsonData.message_content || '',
                jsonData.title || '',
                jsonData.description || '',
                jsonData.color,
                jsonData.image_url,
                jsonData.thumbnail_url,
                jsonData.footer,
                jsonData.author,
                jsonData.fields ? JSON.stringify(jsonData.fields) : null,
                jsonData.pattern || 'time',
                null, // mention (will be configured by user)
                0, // repeat_status
                0, // repeat_frequency
                jsonData.embed_toggle || false,
                false, // is_active
                null,
                nextTriggerTimestamp,
                interaction.user.id
            );

            const notificationId = result.lastInsertRowid;

            // Clean up stored data
            global.pendingImports.delete(`${userId}_${timestamp}`);

            // Log import
            adminLogQueries.addLog(
                interaction.user.id,
                LOG_CODES.NOTIFICATION.IMPORTED,
                JSON.stringify({
                    notification_id: notificationId,
                    name: name,
                    template_name: jsonData.name
                })
            );

            //delete selecting the notification type message
            await interaction.message.delete();

            // Show editor with imported content - helperMode=false means no default values shown
            const editorPayload = await showEmbedEditor(interaction, notificationId, lang, false, true, interaction.user.id, false);

            await interaction.reply({
                ...editorPayload,
                flags: 0 // Not ephemeral
            });

        } catch (dbError) {
            await sendError(interaction, lang, dbError, 'handleImportModalSubmit_createNotification');
        }

    } catch (error) {
        await sendError(interaction, lang, error, 'handleImportModalSubmit');
    }
}

module.exports = {
    handleUploadNotificationButton,
    handleFileUploadModalSubmit,
    handleImportTypeSelection,
    handleImportModalSubmit,
    validateNotificationJSON
};
