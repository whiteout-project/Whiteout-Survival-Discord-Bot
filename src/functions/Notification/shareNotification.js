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

    FileBuilder
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const { notificationQueries, adminLogQueries } = require('../utility/database');
const { LOG_CODES } = require('../utility/AdminLogs');
const { getAdminLang, assertUserMatches, sendError, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { getFilteredNotifications } = require('./editNotification');
const { parseMentions } = require('./notificationUtils');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../utility/emojis');

const ITEMS_PER_PAGE = 20;

/**
 * Handle Share Notification button - shows notification selection
 */
async function handleShareNotificationButton(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        const expectedUserId = interaction.customId.split('_')[2];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Show type selection (server or private)
        await showTypeSelection(interaction, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleShareNotificationButton');
    }
}

/**
 * Show notification type selection (server or private)
 */
async function showTypeSelection(interaction, lang) {
    const serverButton = new ButtonBuilder()
        .setCustomId(`template_share_type_server_${interaction.user.id}`)
        .setLabel(lang.notification.shareNotification.buttons.serverNotifications)
        .setStyle(ButtonStyle.Primary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1022'));

    const privateButton = new ButtonBuilder()
        .setCustomId(`template_share_type_private_${interaction.user.id}`)
        .setLabel(lang.notification.shareNotification.buttons.privateNotifications)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1029'));

    const buttonRow = new ActionRowBuilder().addComponents(serverButton, privateButton);

    const container = [
        new ContainerBuilder()
            .setAccentColor(9807270) // purple
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.notification.shareNotification.content.title.typeSelection}\n` +
                    `${lang.notification.shareNotification.content.description.typeSelection}`
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
 * Handle type selection button
 */
async function handleTypeSelection(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const type = parts[3]; // 'server' or 'private'
        const userId = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        // Get filtered notifications
        const notifications = getFilteredNotifications(type, interaction.user.id, adminData);

        if (!notifications || notifications.length === 0) {
            const noNotifMsg = type === 'server'
                ? lang.notification.shareNotification.errors.noServerNotifications
                : lang.notification.shareNotification.errors.noPrivateNotifications;

            return await interaction.update({
                components: updateComponentsV2AfterSeparator(interaction, [
                    new ContainerBuilder()
                        .setAccentColor(9807270) // purple
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent(
                                `${lang.notification.shareNotification.content.title.typeSelection}\n` +
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
        const creator = await interaction.client.users.fetch(notification.created_by).catch(() => ({ username: 'Unknown' }));
        return {
            label: notification.name.substring(0, 100),
            value: `template_export_${notification.id}`,
            description: lang.notification.shareNotification.selectMenu.description.substring(0, 100).replace('{createdBy}', creator.username || 'Unknown'),
            emoji: notification.is_active ? getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1022') : getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1052')
        };
    })
    );

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`template_export_menu_${type}_${interaction.user.id}_${page}`)
        .setPlaceholder(lang.notification.shareNotification.selectMenu.placeholder)
        .addOptions(options);

    const selectRow = new ActionRowBuilder().addComponents(selectMenu);

    // Add pagination buttons if needed
    const components = [selectRow];
    if (totalPages > 1) {
        const paginationRow = createUniversalPaginationButtons({
            feature: 'template_export',
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
            .setAccentColor(9807270) // purple
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.notification.shareNotification.content.title.notificationSelection}\n` +
                    `${lang.notification.shareNotification.content.description.notificationSelection}`
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(...components)
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    await interaction.update({
        components: content,
        flags: MessageFlags.IsComponentsV2
    });
}

/**
 * Handle pagination for export selection
 */
async function handleExportPagination(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        const { userId, newPage, subtype } = parsePaginationCustomId(interaction.customId, 0);

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const notifications = getFilteredNotifications(subtype, interaction.user.id, adminData);
        await showNotificationSelection(interaction, notifications, newPage, subtype, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleExportPagination');
    }
}

/**
 * Convert mentions back to @tag placeholders
 */
function convertMentionsToTags(text, mentions, component) {
    if (!text || !mentions || !mentions[component]) return text;

    let result = text;
    const componentMentions = mentions[component];

    // Replace Discord mentions with @tag placeholders
    Object.entries(componentMentions).forEach(([tag, value]) => {
        const [type, id] = value.split(':');
        let mentionRegex;

        if (type === 'everyone') {
            mentionRegex = /@everyone/g;
        } else if (type === 'here') {
            mentionRegex = /@here/g;
        } else if (type === 'user') {
            mentionRegex = new RegExp(`<@!?${id}>`, 'g');
        } else if (type === 'role') {
            mentionRegex = new RegExp(`<@&${id}>`, 'g');
        }

        if (mentionRegex) {
            result = result.replace(mentionRegex, `@${tag}`);
        }
    });

    return result;
}

/**
 * Export notification to JSON format
 */
function exportNotificationToJSON(notification, lang) {
    const mentions = parseMentions(notification.mention);

    // Convert message content back to @tag placeholders
    let messageContent = notification.message_content;
    if (messageContent && mentions && mentions.message) {
        messageContent = convertMentionsToTags(messageContent, mentions, 'message');
    }

    // Convert description back to @tag placeholders
    let description = notification.description;
    if (description && mentions && mentions.description) {
        description = convertMentionsToTags(description, mentions, 'description');
    }

    // Convert fields back to @tag placeholders
    let fields = null;
    if (notification.fields) {
        try {
            const parsedFields = JSON.parse(notification.fields);
            if (Array.isArray(parsedFields) && parsedFields.length > 0) {
                fields = parsedFields.map((field, index) => {
                    let value = field.value;
                    if (value && mentions && mentions[`field_${index}`]) {
                        value = convertMentionsToTags(value, mentions, `field_${index}`);
                    }
                    return {
                        name: field.name,
                        value: value,
                        inline: field.inline || false
                    };
                });
            }
        } catch (error) {
            fields = null;
        }
    }

    // Filter out default values
    const defaultMessageContent = lang.notification.notificationEditor.defaultValues.messageContent;
    const defaultTitle = lang.notification.notificationEditor.defaultValues.embedTitle;
    const defaultDescription = lang.notification.notificationEditor.defaultValues.embedDescription;

    return {
        version: '1.0',
        name: notification.name,
        message_content: (messageContent && messageContent !== defaultMessageContent) ? messageContent : null,
        embed_toggle: notification.embed_toggle || false,
        title: (notification.title && notification.title !== defaultTitle) ? notification.title : null,
        description: (description && description !== defaultDescription) ? description : null,
        color: notification.color || null,
        image_url: notification.image_url || null,
        thumbnail_url: notification.thumbnail_url || null,
        footer: notification.footer || null,
        author: notification.author || null,
        fields: fields,
        pattern: notification.pattern || 'time',
        created_by: notification.created_by
    };
}

/**
 * Handle notification export selection
 */
async function handleNotificationExportSelection(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[4];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const selectedValue = interaction.values[0];
        const notificationId = parseInt(selectedValue.split('_')[2]);

        // Get notification details
        const notification = notificationQueries.getNotificationById(notificationId);

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.shareNotification.errors.notificationNotFound,
                ephemeral: true
            });
        }

        // await interaction.deferUpdate();

        const jsonData = exportNotificationToJSON(notification, lang);
        const jsonString = JSON.stringify(jsonData, null, 2);

        // Create temp directory if it doesn't exist
        const tempDir = path.join(__dirname, '../../temp');
        await fs.promises.mkdir(tempDir, { recursive: true });

        // Create JSON file
        const fileName = `${notification.name.replace(/[^a-z0-9]/gi, '_')}_template.json`;
        const filePath = path.join(tempDir, fileName);
        await fs.promises.writeFile(filePath, jsonString);

        // Log export
        adminLogQueries.addLog(
            interaction.user.id,
            LOG_CODES.NOTIFICATION.EXPORTED,
            JSON.stringify({
                notification_id: notificationId,
                name: notification.name
            })
        );

        // Read file as buffer for FileBuilder
        const fileBuffer = await fs.promises.readFile(filePath);

        const container = [
            new ContainerBuilder()
                .setAccentColor(9807270)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.notification.shareNotification.content.title.success}\n` +
                        lang.notification.shareNotification.content.description.exportSuccess
                            .replace('{name}', notification.name)
                    )
                )
                .addSeparatorComponents(
                    new SeparatorBuilder()
                        .setSpacing(SeparatorSpacingSize.Small)
                        .setDivider(true)
                )
                .addFileComponents(
                    new FileBuilder().setURL(`attachment://${fileName}`)
                )
        ];


        const content = updateComponentsV2AfterSeparator(interaction, container);

        // Send file with Components V2
        await interaction.update({
            components: content,
            files: [
                {
                    attachment: fileBuffer,
                    name: fileName
                }
            ],
            flags: MessageFlags.IsComponentsV2
        });

        // Clean up file after sending
        setTimeout(async () => {
            try {
                await fs.promises.unlink(filePath);
            } catch (error) {
                await sendError(null, null, error, 'handleNotificationExportSelection - File Cleanup', false);
            }
        }, 5000);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleNotificationExportSelection');
    }
}

module.exports = {
    handleShareNotificationButton,
    handleTypeSelection,
    handleExportPagination,
    handleNotificationExportSelection
};
