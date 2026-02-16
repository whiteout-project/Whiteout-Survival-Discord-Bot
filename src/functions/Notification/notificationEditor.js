const { ButtonBuilder, ButtonStyle, EmbedBuilder, ActionRowBuilder, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require('discord.js');
const { adminQueries, notificationQueries, adminLogQueries } = require('../utility/database');
const { LOG_CODES } = require('../utility/AdminLogs');
const { getAdminLang, assertUserMatches, sendError } = require('../utility/commonFunctions');
const { extractMentionTags, convertTagsToMentions, parseMentions, calculateEmbedSize } = require('./notificationUtils');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../utility/emojis');

// Module reference for processMentionsAfterContentUpdate (set externally)
let processMentionsAfterContentUpdateRef = null;
let showTagSelectionMenuRef = null;

/**
 * Set external function references to avoid circular dependencies
 * @param {Function} processMentionsAfterContentUpdate - Function from notificationMentions
 * @param {Function} showTagSelectionMenu - Function from notificationMentions
 */
function setModuleReferences(processMentionsAfterContentUpdate, showTagSelectionMenu) {
    processMentionsAfterContentUpdateRef = processMentionsAfterContentUpdate;
    showTagSelectionMenuRef = showTagSelectionMenu;
}

/**
 * Send the notification editor message with buttons
 */
async function sendNotificationEditorMessage(interaction, notificationId, type, lang) {
    const notification = notificationQueries.getNotificationById(notificationId);

    const messageContent = notification.message_content || lang.notification.notificationEditor.defaultValues.messageContent;

    const messageButton = new ButtonBuilder()
        .setCustomId(`notification_edit_message_${notificationId}_${interaction.user.id}`)
        .setLabel(lang.notification.notificationEditor.buttons.messageContent)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1008'));

    const toggleEmbedButton = new ButtonBuilder()
        .setCustomId(`notification_toggle_embed_${notificationId}_${interaction.user.id}`)
        .setLabel(lang.notification.notificationEditor.buttons.toggleEmbed)
        .setStyle(ButtonStyle.Primary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1041'));

    const saveButton = new ButtonBuilder()
        .setCustomId(`notification_save_${notificationId}_${interaction.user.id}`)
        .setLabel(lang.notification.notificationEditor.buttons.save)
        .setStyle(ButtonStyle.Success)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1037'));

    const row = new ActionRowBuilder().addComponents(messageButton, toggleEmbedButton, saveButton);

    await interaction.reply({
        content: messageContent,
        components: [row]
    });
}

/**
 * Handle message content edit button
 */
async function handleEditMessageButton(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const [, , , notificationId, userId] = interaction.customId.split('_');

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.notificationNotFound,
                ephemeral: true
            });
        }

        const modal = new ModalBuilder()
            .setCustomId(`notification_update_message_${notificationId}_${userId}`)
            .setTitle(lang.notification.notificationEditor.modal.messageContent.title);

        const isRequired = !notification.embed_toggle;

        const messageInput = new TextInputBuilder()
            .setCustomId('message_content')
            .setStyle(TextInputStyle.Paragraph)
            .setValue(notification.message_content || '')
            .setRequired(isRequired)
            .setMaxLength(2000); // Discord message limit

        const messageLabel = new LabelBuilder()
            .setLabel(lang.notification.notificationEditor.modal.messageContent.label)
            .setTextInputComponent(messageInput);

        modal.addLabelComponents(messageLabel);

        await interaction.showModal(modal);

    } catch (error) {
        sendError(interaction, lang, error, 'handleEditMessageButton');
    }
}

/**
 * Handle message content update modal
 */
async function handleUpdateMessageModal(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const [, , , notificationId, userId] = interaction.customId.split('_');

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        let messageContent = interaction.fields.getTextInputValue('message_content');
        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.notificationNotFound,
                ephemeral: true
            });
        }

        // Don't save default values - save as null instead
        const defaultMessageContent = lang.notification.notificationEditor.defaultValues.messageContent;
        if (messageContent === defaultMessageContent) {
            messageContent = null;
        }

        try {
            notificationQueries.updateNotification(
                parseInt(notificationId),
                notification.name,
                notification.guild_id,
                notification.channel_id,
                notification.hour,
                notification.minute,
                messageContent,
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
                LOG_CODES.NOTIFICATION.MESSAGE_UPDATED,
                JSON.stringify({
                    name: notification.name
                })
            );

            // Process mentions if any @tags were found
            if (processMentionsAfterContentUpdateRef) {
                await processMentionsAfterContentUpdateRef(interaction, parseInt(notificationId), 'message', messageContent, lang);
            }

        } catch (dbError) {
            sendError(interaction, lang, dbError, 'handleUpdateMessageModal');
        }
    } catch (error) {
        sendError(interaction, lang, error, 'handleUpdateMessageModal');
    }
}

/**
 * Handle toggle embed button
 */
async function handleToggleEmbedButton(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const [, , , notificationId, userId] = interaction.customId.split('_');

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.notificationNotFound,
                ephemeral: true
            });
        }

        const newEmbedToggle = !notification.embed_toggle;

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
                notification.repeat_status,
                notification.repeat_frequency,
                newEmbedToggle,
                notification.is_active,
                notification.last_trigger,
                notification.next_trigger
            );

            adminLogQueries.addLog(
                interaction.user.id,
                LOG_CODES.NOTIFICATION.EMBED_TOGGLED,
                JSON.stringify({
                    name: notification.name,
                    status: newEmbedToggle ? 'ON' : 'OFF'
                })
            );

            if (newEmbedToggle) {
                await showEmbedEditor(interaction, parseInt(notificationId), lang);
            } else {
                // Convert tags to mentions for display
                const mentions = parseMentions(notification.mention);
                const rawMessageContent = notification.message_content || lang.notification.notificationEditor.defaultValues.messageContent;
                const messageContent = convertTagsToMentions(rawMessageContent, mentions, 'message');

                const messageButton = new ButtonBuilder()
                    .setCustomId(`notification_edit_message_${notificationId}_${userId}`)
                    .setLabel(lang.notification.notificationEditor.modal.messageContent.label)
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1008'));

                const toggleEmbedButton = new ButtonBuilder()
                    .setCustomId(`notification_toggle_embed_${notificationId}_${userId}`)
                    .setLabel(lang.notification.notificationEditor.buttons.toggleEmbed)
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1041'));

                const saveButton = new ButtonBuilder()
                    .setCustomId(`notification_save_${notificationId}_${userId}`)
                    .setLabel(lang.notification.notificationEditor.buttons.save)
                    .setStyle(ButtonStyle.Success)
                    .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1037'));

                const row = new ActionRowBuilder().addComponents(messageButton, toggleEmbedButton, saveButton);

                await interaction.update({
                    content: messageContent,
                    embeds: [],
                    components: [row]
                });
            }
        } catch (dbError) {
            await sendError(interaction, lang, dbError, 'handleToggleEmbedButton');
        }
    } catch (error) {
        await sendError(interaction, lang, error, 'handleToggleEmbedButton');
    }
}

/**
 * Show or build the notification editor payload.
 * @param interaction - The interaction that triggered the editor (can be null when returnPayloadOnly)
 * @param notificationId - id of the notification
 * @param lang - language
 * @param useUpdate - whether to call interaction.update (default true)
 * @param returnPayloadOnly - if true, do not send update/reply; instead return payload object
 * @param userIdOverride - optional userId to use when building customIds (instead of interaction.user.id)
 * @param useDefaultValues - if false, do not inject default values for empty fields (default true)
 */
async function showEmbedEditor(interaction, notificationId, lang, useUpdate = true, returnPayloadOnly = false, userIdOverride = null, helperMode = false) {
    const notification = notificationQueries.getNotificationById(notificationId);

    const mentions = parseMentions(notification.mention);

    const rawMessageContent = notification.message_content || lang.notification.notificationEditor.defaultValues.messageContent;
    const messageContent = convertTagsToMentions(rawMessageContent, mentions, 'message');

    const editorUserId = userIdOverride || (interaction && interaction.user && interaction.user.id) || interaction?.user?.id || 'unknown';

    // If embed is toggled off, show simple editor without embed
    if (!notification.embed_toggle) {
        const messageButton = new ButtonBuilder()
            .setCustomId(`notification_edit_message_${notificationId}_${editorUserId}`)
            .setLabel(lang.notification.notificationEditor.modal.messageContent.label)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(editorUserId), '1008'));

        const toggleEmbedButton = new ButtonBuilder()
            .setCustomId(`notification_toggle_embed_${notificationId}_${editorUserId}`)
            .setLabel(lang.notification.notificationEditor.buttons.toggleEmbed)
            .setStyle(ButtonStyle.Primary)
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(editorUserId), '1041'));

        const saveButton = new ButtonBuilder()
            .setCustomId(`notification_save_${notificationId}_${editorUserId}`)
            .setLabel(lang.notification.notificationEditor.buttons.save)
            .setStyle(ButtonStyle.Success)
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(editorUserId), '1037'));

        const row = new ActionRowBuilder().addComponents(messageButton, toggleEmbedButton, saveButton);

        const payload = {
            content: messageContent,
            embeds: [],
            components: [row]
        };

        if (returnPayloadOnly) {
            return payload;
        }

        if (useUpdate) {
            await interaction.update(payload);
        } else {
            await interaction.reply(payload);
        }
        return;
    }

    const {
        hasTitle,
        hasDescription,
        hasFields,
        hasAuthor,
        hasFooter,
        hasImage,
        hasThumbnail,
        hasDescriptionValue,
        hasImageValue,
        hasThumbnailValue,
        hasFooterValue,
        hasAuthorValue,
        hasFieldsValue
    } = getEmbedComponentStates(notification, lang);

    // Build embed - only show configured components and title by default
    const embed = new EmbedBuilder();

    // Set color (use configured color, or default if helperMode is on)
    embed.setColor(notification.color || (helperMode ? lang.notification.notificationEditor.defaultValues.embedColor : '#0099ff'));

    // Title: always show (configured title, or default title if helperMode or empty embed)
    if (hasTitle) {
        embed.setTitle(notification.title);
    } else {
        embed.setTitle(lang.notification.notificationEditor.defaultValues.embedTitle);
    }

    // Description: show if has value OR helperMode is on (show default visually)
    if (hasDescriptionValue) {
        const displayDescription = convertTagsToMentions(notification.description, mentions, 'description');
        embed.setDescription(displayDescription);
    } else if (helperMode) {
        embed.setDescription(lang.notification.notificationEditor.defaultValues.embedDescription);
    }

    // Image: show if has value OR helperMode is on
    if (hasImageValue) {
        embed.setImage(notification.image_url);
    } else if (helperMode) {
        embed.setImage(lang.notification.notificationEditor.defaultValues.embedImage);
    }

    // Thumbnail: show if has value OR helperMode is on
    if (hasThumbnailValue) {
        embed.setThumbnail(notification.thumbnail_url);
    } else if (helperMode) {
        embed.setThumbnail(lang.notification.notificationEditor.defaultValues.embedThumbnail);
    }

    // Footer: show if has value OR helperMode is on
    if (hasFooterValue) {
        embed.setFooter({ text: notification.footer });
    } else if (helperMode) {
        embed.setFooter({ text: lang.notification.notificationEditor.defaultValues.embedFooter });
    }

    // Author: show if has value OR helperMode is on
    if (hasAuthorValue) {
        embed.setAuthor({ name: notification.author });
    } else if (helperMode) {
        embed.setAuthor({ name: lang.notification.notificationEditor.defaultValues.embedAuthor });
    }

    // Fields: show if has any value OR helperMode is on
    let fields = [];
    let customFieldsCount = 0;

    if (hasFieldsValue) {
        try {
            fields = JSON.parse(notification.fields);
            customFieldsCount = fields.length;
            fields = fields.map((field, index) => ({
                name: field.name,
                value: convertTagsToMentions(field.value, mentions, `field_${index}`),
                inline: field.inline
            }));
            if (fields.length > 0) {
                embed.addFields(fields);
            }
        } catch (error) {
            fields = [];
        }
    } else if (helperMode) {
        // Show default fields in helper mode
        const defaultFields = lang.notification.notificationEditor.defaultValues.embedFields;
        if (Array.isArray(defaultFields) && defaultFields.length > 0) {
            embed.addFields(defaultFields);
        }
    }

    const hasCustomFields = customFieldsCount > 0;

    const messageButton = new ButtonBuilder()
        .setCustomId(`notification_edit_message_${notificationId}_${editorUserId}`)
        .setLabel(lang.notification.notificationEditor.modal.messageContent.label)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(editorUserId), '1008'));

    const toggleEmbedButton = new ButtonBuilder()
        .setCustomId(`notification_toggle_embed_${notificationId}_${editorUserId}`)
        .setLabel(lang.notification.notificationEditor.buttons.toggleEmbed)
        .setStyle(ButtonStyle.Primary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(editorUserId), '1041'));

    const saveButton = new ButtonBuilder()
        .setCustomId(`notification_save_${notificationId}_${editorUserId}`)
        .setLabel(lang.notification.notificationEditor.buttons.save)
        .setStyle(ButtonStyle.Success)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(editorUserId), '1037'));

    const helperButton = new ButtonBuilder()
        .setCustomId(`notification_helper_${notificationId}_${editorUserId}_${helperMode ? 'on' : 'off'}`)
        .setLabel(helperMode ? lang.notification.notificationEditor.buttons.disableHelper : lang.notification.notificationEditor.buttons.enableHelper)
        .setStyle(helperMode ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setEmoji(helperMode ? getComponentEmoji(getEmojiMapForAdmin(editorUserId), '1049') : getComponentEmoji(getEmojiMapForAdmin(editorUserId), '1038'));

    const row1 = new ActionRowBuilder().addComponents(messageButton, toggleEmbedButton, saveButton, helperButton);

    const addFieldButton = new ButtonBuilder()
        .setCustomId(`notification_field_add_${notificationId}_${editorUserId}`)
        .setLabel(lang.notification.notificationEditor.buttons.addField)
        .setStyle(ButtonStyle.Success)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(editorUserId), '1000'));

    const editFieldButton = new ButtonBuilder()
        .setCustomId(`notification_field_edit_${notificationId}_${editorUserId}`)
        .setLabel(lang.notification.notificationEditor.buttons.editField)
        .setStyle(ButtonStyle.Primary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(editorUserId), '1008'))
        .setDisabled(!hasCustomFields);

    const removeFieldButton = new ButtonBuilder()
        .setCustomId(`notification_field_remove_${notificationId}_${editorUserId}`)
        .setLabel(lang.notification.notificationEditor.buttons.removeField)
        .setStyle(ButtonStyle.Danger)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(editorUserId), '1031'))
        .setDisabled(!hasCustomFields);

    const reorderFieldsButton = new ButtonBuilder()
        .setCustomId(`notification_field_reorder_${notificationId}_${editorUserId}`)
        .setLabel(lang.notification.notificationEditor.buttons.reorderFields)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(editorUserId), '1032'))
        .setDisabled(customFieldsCount < 2);

    const row2 = new ActionRowBuilder().addComponents(addFieldButton, editFieldButton, removeFieldButton, reorderFieldsButton);

    // Create select menu for embed components
    const embedComponentsMenu = new StringSelectMenuBuilder()
        .setCustomId(`notification_embed_select_${notificationId}_${editorUserId}`)
        .setPlaceholder(lang.notification.notificationEditor.editorSelectMenu.placeholder)
        .addOptions([
            {
                label: lang.notification.notificationEditor.editorSelectMenu.options.title,
                value: 'title',
                emoji: getComponentEmoji(getEmojiMapForAdmin(editorUserId), '1021')
            },
            {
                label: lang.notification.notificationEditor.editorSelectMenu.options.description,
                value: 'description',
                emoji: getComponentEmoji(getEmojiMapForAdmin(editorUserId), '1021')
            },
            {
                label: lang.notification.notificationEditor.editorSelectMenu.options.color,
                value: 'color',
                emoji: getComponentEmoji(getEmojiMapForAdmin(editorUserId), '1003')
            },
            {
                label: lang.notification.notificationEditor.editorSelectMenu.options.image,
                value: 'image',
                emoji: getComponentEmoji(getEmojiMapForAdmin(editorUserId), '1015')
            },
            {
                label: lang.notification.notificationEditor.editorSelectMenu.options.thumbnail,
                value: 'thumbnail',
                emoji: getComponentEmoji(getEmojiMapForAdmin(editorUserId), '1015')
            },
            {
                label: lang.notification.notificationEditor.editorSelectMenu.options.footer,
                value: 'footer',
                emoji: getComponentEmoji(getEmojiMapForAdmin(editorUserId), '1009')
            },
            {
                label: lang.notification.notificationEditor.editorSelectMenu.options.author,
                value: 'author',
                emoji: getComponentEmoji(getEmojiMapForAdmin(editorUserId), '1026')
            }
        ]);

    const row3 = new ActionRowBuilder().addComponents(embedComponentsMenu);

    const payload = {
        content: messageContent,
        embeds: [embed],
        components: [row1, row2, row3]
    };

    if (returnPayloadOnly) {
        return payload;
    }

    if (useUpdate) {
        await interaction.update(payload);
    } else {
        await interaction.reply(payload);
    }
}

/**
 * Handle embed component edit buttons
 */
async function handleEmbedComponentButton(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const component = parts[2];
        const notificationId = parts[3];
        const userId = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.notificationNotFound,
                ephemeral: true
            });
        }

        const componentConfig = getEmbedComponentConfig(notification, component, lang);
        if (!componentConfig) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.notificationNotFound,
                ephemeral: true
            });
        }

        const { inputStyle, currentValue, placeholder, label, title } = componentConfig;

        const modal = new ModalBuilder()
            .setCustomId(`notification_update_embed_${component}_${notificationId}_${userId}`)
            .setTitle(title);

        const {
            hasTitle,
            hasDescription,
            hasFields,
            hasAuthor,
            hasFooter,
            hasImage,
            hasThumbnail
        } = getEmbedComponentStates(notification, lang);

        // Determine if title/description should be required
        let isRequired = false;
        if (component === 'title') {
            // Title is required only if no other content exists (description, fields, author, footer, image, thumbnail)
            isRequired = !hasDescription && !hasFields && !hasAuthor && !hasFooter && !hasImage && !hasThumbnail;
        } else if (component === 'description') {
            // Description is required only if no other content exists (title, fields, author, footer, image, thumbnail)
            isRequired = !hasTitle && !hasFields && !hasAuthor && !hasFooter && !hasImage && !hasThumbnail;
        } else {
            // Other components are never required
            isRequired = false;
        }

        const input = new TextInputBuilder()
            .setCustomId('component_value')
            .setStyle(inputStyle)
            .setPlaceholder(placeholder)
            .setRequired(isRequired);

        // Apply max length limits based on component
        if (component === 'title') input.setMaxLength(256);
        else if (component === 'description') input.setMaxLength(4000); // 4096 limit, but keeping safety margin for modal limits
        else if (component === 'author') input.setMaxLength(256);
        else if (component === 'footer') input.setMaxLength(2048);
        else if (component === 'color') input.setMaxLength(7); // #FFFFFF

        const inputLabel = new LabelBuilder()
            .setLabel(label)
            .setTextInputComponent(input);

        if (currentValue) {
            input.setValue(currentValue);
        }

        modal.addLabelComponents(inputLabel);

        await interaction.showModal(modal);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleEmbedComponentButton');
    }
}

/**
 * Handle embed component update modal
 */
async function handleUpdateEmbedComponentModal(interaction) {
    const { lang } = getAdminLang(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const component = parts[3];
        const notificationId = parts[4];
        const userId = parts[5];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        let value = interaction.fields.getTextInputValue('component_value');
        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.notificationNotFound,
                ephemeral: true
            });
        }

        const defaultTitle = lang.notification.notificationEditor.defaultValues.embedTitle;
        const defaultDescription = lang.notification.notificationEditor.defaultValues.embedDescription;

        if (component === 'title' && value === defaultTitle) value = null;
        if (component === 'description' && value === defaultDescription) value = null;

        const updates = {
            title: notification.title,
            description: notification.description,
            color: notification.color,
            image_url: notification.image_url,
            thumbnail_url: notification.thumbnail_url,
            footer: notification.footer,
            author: notification.author
        };

        switch (component) {
            case 'title':
                updates.title = value;
                break;
            case 'description':
                updates.description = value;
                break;
            case 'color':
                if (value && value.startsWith('#') && value.length > 7) {
                    value = value.substring(0, 7);
                }
                updates.color = value;
                break;
            case 'image':
                updates.image_url = value;
                break;
            case 'thumbnail':
                updates.thumbnail_url = value;
                break;
            case 'footer':
                updates.footer = value;
                break;
            case 'author':
                updates.author = value;
                break;
        }

        // Validate total embed size for text components
        const potentialNotification = {
            ...notification,
            ...updates
        };
        const totalSize = calculateEmbedSize(potentialNotification);

        if (totalSize > 6000) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.embedTooLarge.replace('{totalSize}', totalSize),
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
                updates.title,
                updates.description,
                updates.color,
                updates.image_url,
                updates.thumbnail_url,
                updates.footer,
                updates.author,
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
                LOG_CODES.NOTIFICATION.EMBED_UPDATED,
                JSON.stringify({
                    name: notification.name
                })
            );

            if (component === 'description') {
                if (processMentionsAfterContentUpdateRef) {
                    await processMentionsAfterContentUpdateRef(interaction, parseInt(notificationId), 'description', value, lang, showEmbedEditor);
                }
            } else {
                await showEmbedEditor(interaction, parseInt(notificationId), lang);
            }

        } catch (dbError) {
            await sendError(interaction, lang, dbError, 'handleUpdateEmbedComponentModal');
        }
    } catch (error) {
        await sendError(interaction, lang, error, 'handleUpdateEmbedComponentModal');
    }
}

/**
 * Handle embed component select menu
 */
async function handleEmbedSelectMenu(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const notificationId = parts[3];
        const userId = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const component = interaction.values[0]; // Get selected component from select menu
        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.notificationNotFound,
                ephemeral: true
            });
        }

        const componentConfig = getEmbedComponentConfig(notification, component, lang);
        if (!componentConfig) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.notificationNotFound,
                ephemeral: true
            });
        }

        const { inputStyle, currentValue, placeholder, label, title } = componentConfig;

        const modal = new ModalBuilder()
            .setCustomId(`notification_update_embed_${component}_${notificationId}_${userId}`)
            .setTitle(title);

        const {
            hasTitle,
            hasDescription,
            hasFields,
            hasAuthor,
            hasFooter,
            hasImage,
            hasThumbnail
        } = getEmbedComponentStates(notification, lang);

        // Determine if title/description should be required
        let isRequired = false;
        if (component === 'title') {
            isRequired = !hasDescription && !hasFields && !hasAuthor && !hasFooter && !hasImage && !hasThumbnail;
        } else if (component === 'description') {
            isRequired = !hasTitle && !hasFields && !hasAuthor && !hasFooter && !hasImage && !hasThumbnail;
        }

        const input = new TextInputBuilder()
            .setCustomId('component_value')
            .setStyle(inputStyle)
            .setPlaceholder(placeholder)
            .setRequired(isRequired);

        // Apply max length limits based on component
        if (component === 'title') input.setMaxLength(256);
        else if (component === 'description') input.setMaxLength(4000);
        else if (component === 'author') input.setMaxLength(256);
        else if (component === 'footer') input.setMaxLength(2048);
        else if (component === 'description') input.setMaxLength(4000);
        else if (component === 'color') input.setMaxLength(7);

        const inputLabel = new LabelBuilder()
            .setLabel(label)
            .setTextInputComponent(input);

        if (currentValue) {
            input.setValue(currentValue);
        }

        modal.addLabelComponents(inputLabel);

        await interaction.showModal(modal);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleEmbedSelectMenu');
    }
}

/**
 * Handle helper button - fills all unconfigured components with default values
 */
async function handleHelperButton(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const notificationId = parts[2];
        const userId = parts[3];
        const currentState = parts[4]; // 'on' or 'off'

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.notificationNotFound,
                ephemeral: true
            });
        }

        // Toggle helper mode: if currently 'off', turn 'on' (show defaults), otherwise turn 'off' (hide defaults)
        const newHelperMode = currentState === 'off';

        // Refresh the editor with new helper mode (NO DATABASE CHANGES)
        await showEmbedEditor(
            interaction,
            parseInt(notificationId),
            lang,
            true,  // useUpdate
            false, // returnPayloadOnly
            null,  // userIdOverride
            newHelperMode // helperMode - controls visual display of defaults
        );

    } catch (error) {
        await sendError(interaction, lang, error, 'handleHelperButton');
    }
}

function getEmbedComponentConfig(notification, component, lang) {
    switch (component) {
        case 'title':
            return {
                inputStyle: TextInputStyle.Short,
                currentValue: notification.title || '',
                placeholder: lang.notification.notificationEditor.modal.embedEditor.title.placeholder,
                label: lang.notification.notificationEditor.modal.embedEditor.title.label,
                title: lang.notification.notificationEditor.modal.embedEditor.title.title
            };
        case 'description':
            return {
                inputStyle: TextInputStyle.Paragraph,
                currentValue: notification.description || '',
                placeholder: lang.notification.notificationEditor.modal.embedEditor.description.placeholder,
                label: lang.notification.notificationEditor.modal.embedEditor.description.label,
                title: lang.notification.notificationEditor.modal.embedEditor.description.title
            };
        case 'color':
            return {
                inputStyle: TextInputStyle.Short,
                currentValue: notification.color || '',
                placeholder: lang.notification.notificationEditor.modal.embedEditor.color.placeholder,
                label: lang.notification.notificationEditor.modal.embedEditor.color.label,
                title: lang.notification.notificationEditor.modal.embedEditor.color.title
            };
        case 'image':
            return {
                inputStyle: TextInputStyle.Short,
                currentValue: notification.image_url || '',
                placeholder: lang.notification.notificationEditor.modal.embedEditor.image.placeholder,
                label: lang.notification.notificationEditor.modal.embedEditor.image.label,
                title: lang.notification.notificationEditor.modal.embedEditor.image.title
            };
        case 'thumbnail':
            return {
                inputStyle: TextInputStyle.Short,
                currentValue: notification.thumbnail_url || '',
                placeholder: lang.notification.notificationEditor.modal.embedEditor.thumbnail.placeholder,
                label: lang.notification.notificationEditor.modal.embedEditor.thumbnail.label,
                title: lang.notification.notificationEditor.modal.embedEditor.thumbnail.title
            };
        case 'footer':
            return {
                inputStyle: TextInputStyle.Short,
                currentValue: notification.footer || '',
                placeholder: lang.notification.notificationEditor.modal.embedEditor.footer.placeholder,
                label: lang.notification.notificationEditor.modal.embedEditor.footer.label,
                title: lang.notification.notificationEditor.modal.embedEditor.footer.title
            };
        case 'author':
            return {
                inputStyle: TextInputStyle.Short,
                currentValue: notification.author || '',
                placeholder: lang.notification.notificationEditor.modal.embedEditor.author.placeholder,
                label: lang.notification.notificationEditor.modal.embedEditor.author.label,
                title: lang.notification.notificationEditor.modal.embedEditor.author.title
            };
        default:
            return null;
    }
}

function getEmbedComponentStates(notification, lang) {
    const defaultTitle = lang.notification.notificationEditor.defaultValues.embedTitle;
    const defaultDescription = lang.notification.notificationEditor.defaultValues.embedDescription;

    const hasTitle = notification.title && notification.title.trim() && notification.title !== defaultTitle;
    const hasDescription = notification.description && notification.description.trim() && notification.description !== defaultDescription;
    const hasFields = notification.fields && notification.fields !== '[]' && notification.fields !== null;
    const hasAuthor = notification.author && notification.author.trim();
    const hasFooter = notification.footer && notification.footer.trim();
    const hasImage = notification.image_url && notification.image_url.trim();
    const hasThumbnail = notification.thumbnail_url && notification.thumbnail_url.trim();

    const hasDescriptionValue = notification.description && notification.description.trim();
    const hasImageValue = notification.image_url && notification.image_url.trim();
    const hasThumbnailValue = notification.thumbnail_url && notification.thumbnail_url.trim();
    const hasFooterValue = notification.footer && notification.footer.trim();
    const hasAuthorValue = notification.author && notification.author.trim();
    const hasFieldsValue = notification.fields && notification.fields !== '[]' && notification.fields !== null;

    return {
        hasTitle,
        hasDescription,
        hasFields,
        hasAuthor,
        hasFooter,
        hasImage,
        hasThumbnail,
        hasDescriptionValue,
        hasImageValue,
        hasThumbnailValue,
        hasFooterValue,
        hasAuthorValue,
        hasFieldsValue
    };
}

module.exports = {
    sendNotificationEditorMessage,
    handleEditMessageButton,
    handleUpdateMessageModal,
    handleToggleEmbedButton,
    showEmbedEditor,
    handleEmbedComponentButton,
    handleEmbedSelectMenu,
    handleUpdateEmbedComponentModal,
    handleHelperButton,
    setModuleReferences
};
