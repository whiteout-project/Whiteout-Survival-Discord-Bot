/**
 * Notification Fields Module
 * Handles all field management functionality (add, edit, remove, reorder)
 */
const { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, LabelBuilder } = require('discord.js');
const { notificationQueries } = require('../utility/database');
const { getAdminLang, assertUserMatches, sendError } = require('../utility/commonFunctions');
const { extractMentionTags, parseMentions, calculateEmbedSize } = require('./notificationUtils');

// Import reference to showTagSelectionMenu from mentions module (will be set by createNotification)
let showTagSelectionMenuRef = null;
let showEmbedEditorRef = null;

/**
 * Set references to functions from other modules to avoid circular dependencies
 * This should be called from createNotification.js after all modules are loaded
 */
function setModuleReferences(showTagSelectionMenu, showEmbedEditor) {
    showTagSelectionMenuRef = showTagSelectionMenu;
    showEmbedEditorRef = showEmbedEditor;
}

/**
 * Handle add field button
 */
async function handleAddFieldButton(interaction) {
    const { lang } = getAdminLang(interaction.user.id);
    try {
        const parts = interaction.customId.split('_'); // notification_field_add_{notificationId}_{userId}
        const notificationId = parts[3];
        const userId = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) {
            return;
        }

        const notification = notificationQueries.getNotificationById(parseInt(notificationId));
        if (!notification) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.notificationNotFound,
                ephemeral: true
            });
        }

        // Check field limit (max 25)
        let existingFields = [];
        try {
            if (notification.fields) {
                existingFields = JSON.parse(notification.fields);
            }
        } catch (error) {
            existingFields = [];
        }

        if (existingFields.length >= 25) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.tooManyFields,
                ephemeral: true
            });
        }

        const modal = new ModalBuilder()
            .setCustomId(`notification_field_add_modal_${notificationId}_${userId}`)
            .setTitle(lang.notification.notificationEditor.modal.embedEditor.addField.title);

        const nameInput = new TextInputBuilder()
            .setCustomId('field_name')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(lang.notification.notificationEditor.modal.embedEditor.addField.fieldName.placeholder)
            .setRequired(true)
            .setMaxLength(256);

        const nameLabel = new LabelBuilder()
            .setLabel(lang.notification.notificationEditor.modal.embedEditor.addField.fieldName.label)
            .setTextInputComponent(nameInput);

        const valueInput = new TextInputBuilder()
            .setCustomId('field_value')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder(lang.notification.notificationEditor.modal.embedEditor.addField.fieldValue.placeholder)
            .setRequired(true)
            .setMaxLength(1024);

        const valueLabel = new LabelBuilder()
            .setLabel(lang.notification.notificationEditor.modal.embedEditor.addField.fieldValue.label)
            .setTextInputComponent(valueInput);

        const inlineInput = new TextInputBuilder()
            .setCustomId('field_inline')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(lang.notification.notificationEditor.modal.embedEditor.addField.fieldInline.placeholder)
            .setRequired(false)
            .setMaxLength(5)
            .setValue('false');

        const inlineLabel = new LabelBuilder()
            .setLabel(lang.notification.notificationEditor.modal.embedEditor.addField.fieldInline.label)
            .setTextInputComponent(inlineInput);

        modal.addLabelComponents(nameLabel, valueLabel, inlineLabel);

        await interaction.showModal(modal);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleAddFieldButton');
    }
}

/**
 * Handle add field modal submission
 */
async function handleAddFieldModal(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_'); // notification_field_add_modal_{notificationId}_{userId}
        const notificationId = parts[4];
        const userId = parts[5];

        if (!(await assertUserMatches(interaction, userId, lang))) {
            return;
        }

        const fieldName = interaction.fields.getTextInputValue('field_name');
        const fieldValue = interaction.fields.getTextInputValue('field_value');
        const fieldInlineInput = interaction.fields.getTextInputValue('field_inline') || 'false';
        const fieldInline = fieldInlineInput.toLowerCase().trim() === 'true';

        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.notificationNotFound,
                ephemeral: true
            });
        }

        // Parse existing fields
        let fields = [];
        try {
            if (notification.fields) {
                fields = JSON.parse(notification.fields);
            }
        } catch (error) {
            fields = [];
        }

        // Add new field
        const newField = {
            name: fieldName,
            value: fieldValue,
            inline: fieldInline
        };
        fields.push(newField);

        // Validate total embed size
        const potentialNotification = { ...notification, fields: fields };
        const totalSize = calculateEmbedSize(potentialNotification);

        if (totalSize > 6000) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.embedTooLarge.replace('{totalSize}', totalSize),
                ephemeral: true
            });
        }

        try {
            // Update notification with new fields
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
                JSON.stringify(fields), // Updated fields array
                notification.pattern,
                notification.mention,
                notification.repeat_status,
                notification.repeat_frequency,
                notification.embed_toggle,
                notification.is_active,
                notification.last_trigger,
                notification.next_trigger
            );

            // Check for @tags in field value only (field names don't support Discord mentions)
            const tagsInValue = extractMentionTags(fieldValue);

            if (tagsInValue.length > 0 && showTagSelectionMenuRef && showEmbedEditorRef) {
                // Store the editor message ID and show tag configuration
                const editorMessageId = interaction.message.id;
                const fieldIndex = fields.length - 1; // Index of the newly added field

                // First refresh the embed editor
                await showEmbedEditorRef(interaction, parseInt(notificationId), lang);

                // Then show tag selection menu for this specific field
                await showTagSelectionMenuRef(interaction, parseInt(notificationId), `field_${fieldIndex}`, lang, editorMessageId, 0, false);
            } else {
                // No tags found, just refresh the embed editor
                await showEmbedEditorRef(interaction, parseInt(notificationId), lang);
            }

        } catch (dbError) {
            await sendError(interaction, lang, dbError, 'handleAddFieldModal');
        }
    } catch (error) {
        await sendError(interaction, lang, error, 'handleAddFieldModal');
    }
}

/**
 * Handle remove field button - Show select menu
 */
async function handleRemoveFieldButton(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
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

        let fields = [];
        try {
            if (notification.fields) {
                fields = JSON.parse(notification.fields);
            }
        } catch (error) {
            fields = [];
        }

        if (fields.length === 0) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.noFieldsToRemove,
                ephemeral: true
            });
        }

        // Create select menu options
        const options = fields.map((field, index) => ({
            label: `${index + 1}. ${field.name.substring(0, 50)}`,
            description: field.value.substring(0, 100) || 'No content',
            value: String(index)
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`notification_field_remove_select_${notificationId}_${userId}_${interaction.message.id}`)
            .setPlaceholder(lang.notification.notificationEditor.selectMenu.fieldSelection.placeholder.remove)
            .setMinValues(1)
            .setMaxValues(options.length)
            .addOptions(options);

        const row = new ActionRowBuilder().addComponents(selectMenu);

        await interaction.reply({
            content: lang.notification.notificationEditor.content.removeField,
            components: [row],
            ephemeral: true
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleRemoveFieldButton');
    }
}

/**
 * Handle remove field select menu - remove the selected fields
 */
async function handleRemoveFieldSelect(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const notificationId = parts[4];
        const userId = parts[5];
        const editorMessageId = parts[6];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const selectedIndices = interaction.values.map(v => parseInt(v));
        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.update({
                content: lang.notification.notificationEditor.errors.notificationNotFound,
                components: []
            });
        }

        // Parse existing fields
        let fields = [];
        try {
            if (notification.fields) {
                fields = JSON.parse(notification.fields);
            }
        } catch (error) {
            await sendError(interaction, lang, error, 'handleRemoveFieldSelect - parsing fields', false);
            fields = [];
        }

        if (selectedIndices.some(idx => idx < 0 || idx >= fields.length)) {
            return await interaction.update({
                content: lang.notification.notificationEditor.errors.invalidFieldIndex,
                components: []
            });
        }

        // Parse existing mentions to update field keys
        const mentions = parseMentions(notification.mention);
        const originalFieldCount = fields.length;

        // New fields array (filtering out selected indices)
        const newFields = fields.filter((_, index) => !selectedIndices.includes(index));

        // Rebuild mention keys to match new field indices
        const newMentions = { ...mentions };

        // Clear all old field_X keys first
        Object.keys(newMentions).forEach(key => {
            if (key.startsWith('field_')) {
                delete newMentions[key];
            }
        });

        // Remap keep fields to new indices
        let newIndex = 0;
        for (let oldIndex = 0; oldIndex < originalFieldCount; oldIndex++) {
            if (!selectedIndices.includes(oldIndex)) {
                // This field is kept, map from oldIndex to newIndex
                const oldKey = `field_${oldIndex}`;
                const newKey = `field_${newIndex}`;

                // If the old field had mentions configured, copy them to the new key
                if (mentions[oldKey]) {
                    newMentions[newKey] = mentions[oldKey];
                }
                newIndex++;
            }
        }

        try {
            // Update notification with updated fields and remapped mentions
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
                JSON.stringify(newFields), // Updated fields array
                notification.pattern,
                JSON.stringify(newMentions), // Updated mentions with remapped field keys
                notification.repeat_status,
                notification.repeat_frequency,
                notification.embed_toggle,
                notification.is_active,
                notification.last_trigger,
                notification.next_trigger
            );

            // Refresh the embed editor
            const payload = await showEmbedEditorRef(interaction, parseInt(notificationId), lang, false, true, userId);

            // Update original editor message
            try {
                if (editorMessageId) {
                    const editorMessage = await interaction.channel.messages.fetch(editorMessageId);
                    await editorMessage.edit(payload);
                }
            } catch (msgError) {
                await sendError(interaction, lang, msgError, 'handleRemoveFieldSelect - updating editor message', false);
            }

            // Dismiss ephemeral message
            await interaction.update({
                content: lang.notification.notificationEditor.content.fieldRemoved,
                components: [],
                embeds: []
            });

        } catch (dbError) {
            await sendError(interaction, lang, dbError, 'handleRemoveFieldSelect', false);
        }

    } catch (error) {
        await sendError(interaction, lang, error, 'handleRemoveFieldSelect');
    }
}

/**
 * Handle reorder fields button
 */
async function handleReorderFieldsButton(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
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

        let fields = [];
        try {
            if (notification.fields) {
                fields = JSON.parse(notification.fields);
            }
        } catch (error) {
            await sendError(interaction, lang, error, 'handleReorderFieldsFromSelect - parsing fields');
            fields = [];
        }

        if (fields.length < 2) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.notEnoughFieldsToReorder,
                ephemeral: true
            });
        }

        // Create select menu with fields to choose which one to move
        const options = fields.map((field, index) => ({
            label: `${index + 1}. ${field.name.substring(0, 50)}`,
            description: field.value.substring(0, 100),
            value: String(index)
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`notification_field_reorder_from_${notificationId}_${userId}_${interaction.message.id}`)
            .setPlaceholder(lang.notification.notificationEditor.selectMenu.fieldSelection.placeholder.move)
            .addOptions(options);

        const row = new ActionRowBuilder().addComponents(selectMenu);

        await interaction.reply({
            content: lang.notification.notificationEditor.content.fieldReordered,
            components: [row],
            ephemeral: true
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleReorderFieldsButton');
    }
}

/**
 * Handle reorder fields "from" select menu - show "to" select menu
 */
async function handleReorderFieldsFromSelect(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const notificationId = parts[4];
        const userId = parts[5];
        const editorMessageId = parts[6];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const fromIndex = parseInt(interaction.values[0]);
        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.update({
                content: lang.notification.notificationEditor.errors.notificationNotFound,
                components: []
            });
        }

        let fields = [];
        try {
            if (notification.fields) {
                fields = JSON.parse(notification.fields);
            }
        } catch (error) {
            await sendError(interaction, lang, error, 'handleReorderFieldsFromSelect - parsing fields');
            fields = [];
        }

        if (fromIndex < 0 || fromIndex >= fields.length) {
            return await interaction.update({
                content: lang.notification.notificationEditor.errors.invalidFieldIndex,
                components: []
            });
        }

        const selectedField = fields[fromIndex];

        // Create select menu with remaining fields (excluding the selected one) to choose where to move
        // Options will represent "move above this field"
        const options = fields
            .map((field, index) => ({
                label: `${index + 1}. ${field.name.substring(0, 50)}`,
                description: lang.notification.notificationEditor.selectMenu.fieldSelection.description.move.replace('{name}', field.name.substring(0, 50)),
                value: String(index)
            }))
            .filter((_, index) => index !== fromIndex); // Exclude the field being moved

        // Add "Move to Bottom" option
        options.push({
            label: lang.notification.notificationEditor.selectMenu.fieldSelection.label.move,
            description: lang.notification.notificationEditor.selectMenu.fieldSelection.description.moveBottom,
            value: String(fields.length)
        });

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`notification_field_reorder_to_${notificationId}_${userId}_${fromIndex}_${editorMessageId}`)
            .setPlaceholder(lang.notification.notificationEditor.selectMenu.fieldSelection.placeholder.whereToMove)
            .addOptions(options);

        const row = new ActionRowBuilder().addComponents(selectMenu);

        await interaction.update({
            content: lang.notification.notificationEditor.content.whereToMove.replace('{selectedField}', selectedField.name),
            components: [row]
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleReorderFieldsFromSelect');
    }
}

/**
 * Handle reorder fields "to" select menu - perform the reorder
 */
async function handleReorderFieldsToSelect(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const notificationId = parts[4];
        const userId = parts[5];
        const fromIndex = parseInt(parts[6]);
        const editorMessageId = parts[7];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const toIndex = parseInt(interaction.values[0]);
        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.update({
                content: lang.notification.notificationEditor.errors.notificationNotFound,
                components: []
            });
        }

        let fields = [];
        try {
            if (notification.fields) {
                fields = JSON.parse(notification.fields);
            }
        } catch (error) {
            await sendError(interaction, lang, error, 'handleReorderFieldsToSelect - parsing fields');
            fields = [];
        }

        // Validate indices
        // Allow toIndex to be equal to fields.length (which represents "end of list")
        if (fromIndex < 0 || fromIndex >= fields.length || toIndex < 0 || toIndex > fields.length) {
            return await interaction.update({
                content: lang.notification.notificationEditor.errors.invalidFieldPosition,
                components: []
            });
        }

        // Parse existing mentions to reorder field keys
        const mentions = parseMentions(notification.mention);

        // Build array of which mention config belongs to which field (by original index)
        const fieldMentionConfigs = [];
        for (let i = 0; i < fields.length; i++) {
            const key = `field_${i}`;
            fieldMentionConfigs.push(mentions[key] || null);
        }

        // Move field from fromIndex to before toIndex
        const [movedField] = fields.splice(fromIndex, 1);
        const [movedMentionConfig] = fieldMentionConfigs.splice(fromIndex, 1);

        // Adjust toIndex if moving down (after removal, indices shift)
        const insertIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;

        fields.splice(insertIndex, 0, movedField);
        fieldMentionConfigs.splice(insertIndex, 0, movedMentionConfig);

        // Rebuild mentions object with reordered field keys
        const newMentions = { ...mentions };

        // Clear all old field_X keys
        Object.keys(newMentions).forEach(key => {
            if (key.startsWith('field_')) {
                delete newMentions[key];
            }
        });

        // Set new field keys based on reordered configs
        fieldMentionConfigs.forEach((config, index) => {
            if (config) {
                newMentions[`field_${index}`] = config;
            }
        });

        try {
            // Update notification with reordered fields and mentions
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
                JSON.stringify(fields), // Reordered fields array
                notification.pattern,
                JSON.stringify(newMentions), // Reordered mentions
                notification.repeat_status,
                notification.repeat_frequency,
                notification.embed_toggle,
                notification.is_active,
                notification.last_trigger,
                notification.next_trigger
            );

            // Refresh the embed editor
            // Get payload for editor update
            const payload = await showEmbedEditorRef(interaction, parseInt(notificationId), lang, false, true, userId);

            // Update original editor message
            try {
                if (editorMessageId) {
                    const editorMessage = await interaction.channel.messages.fetch(editorMessageId);
                    await editorMessage.edit(payload);
                }
            } catch (msgError) {
                await sendError(interaction, lang, msgError, 'handleReorderFieldsToSelect - updating editor message');
            }

            // Dismiss ephemeral message
            await interaction.update({
                content: lang.notification.notificationEditor.content.fieldsReordered,
                components: [],
                embeds: []
            });

        } catch (dbError) {
            await sendError(interaction, lang, dbError, 'handleReorderFieldsModal');
        }

    } catch (error) {
        await sendError(interaction, lang, error, 'handleReorderFieldsModal');
    }
}

/**
 * Show edit field modal
 */
async function showEditFieldModal(interaction, notificationId, fieldIndex, field, lang, editorMessageId = '', selectMenuMessageId = '') {
    try {
        const customIdParts = [
            'notification_field_edit_modal',
            notificationId,
            fieldIndex
        ];

        // Add optional message IDs if provided
        if (editorMessageId) customIdParts.push(editorMessageId);
        if (selectMenuMessageId) customIdParts.push(selectMenuMessageId);

        const modal = new ModalBuilder()
            .setCustomId(customIdParts.join('_'))
            .setTitle(lang.notification.notificationEditor.modal.embedEditor.editField.title);

        const nameInput = new TextInputBuilder()
            .setCustomId('field_name')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(lang.notification.notificationEditor.modal.embedEditor.editField.fieldName.placeholder || 'Enter field name')
            .setRequired(true)
            .setMaxLength(256)
            .setValue(field.name);

        const nameLabel = new LabelBuilder()
            .setLabel(lang.notification.notificationEditor.modal.embedEditor.editField.fieldName.label)
            .setTextInputComponent(nameInput);

        const valueInput = new TextInputBuilder()
            .setCustomId('field_value')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder(lang.notification.notificationEditor.modal.embedEditor.editField.fieldValue.placeholder)
            .setRequired(true)
            .setMaxLength(1024)
            .setValue(field.value);

        const valueLabel = new LabelBuilder()
            .setLabel(lang.notification.notificationEditor.modal.embedEditor.editField.fieldValue.label)
            .setTextInputComponent(valueInput);

        const inlineInput = new TextInputBuilder()
            .setCustomId('field_inline')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(lang.notification.notificationEditor.modal.embedEditor.editField.fieldInline.placeholder)
            .setRequired(false)
            .setMaxLength(5)
            .setValue(field.inline ? 'true' : 'false');

        const inlineLabel = new LabelBuilder()
            .setLabel(lang.notification.notificationEditor.modal.embedEditor.editField.fieldInline.label)
            .setTextInputComponent(inlineInput);

        modal.addLabelComponents(nameLabel, valueLabel, inlineLabel);

        await interaction.showModal(modal);
    } catch (error) {
        await sendError(interaction, lang, error, 'showEditFieldModal');
    }
}

/**
 * Handle edit field button
 */
async function handleEditFieldButton(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_'); // notification_field_edit_{notificationId}_{userId}
        const notificationId = parts[3];
        const userId = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            const notFoundMessage = lang.notification.notificationEditor.errors.notificationNotFound;
            return await interaction.reply({
                content: notFoundMessage,
                ephemeral: true
            });
        }

        let fields = [];
        try {
            if (notification.fields) {
                fields = JSON.parse(notification.fields);
            }
        } catch (error) {
            await sendError(interaction, lang, error, 'handleEditFieldButton - parsing fields');
            fields = [];
        }

        if (fields.length === 0) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.noFieldsToEdit,
                ephemeral: true
            });
        }

        // If only 1 field, skip selection and go directly to edit
        if (fields.length === 1) {
            return await showEditFieldModal(interaction, notificationId, 0, fields[0], lang, interaction.message.id);
        }

        // Multiple fields - show select menu for field selection
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`notification_field_edit_select_${notificationId}_${userId}_${interaction.message.id}`)
            .setPlaceholder(lang.notification.notificationEditor.selectMenu.fieldSelection.placeholder.edit)
            .setMinValues(1)
            .setMaxValues(1);

        // Add options for each field
        fields.forEach((field, index) => {
            selectMenu.addOptions({
                label: `${index + 1}. ${field.name}`,
                description: field.value.substring(0, 100), // First 100 chars of value
                value: index.toString()
            });
        });

        const row = new ActionRowBuilder().addComponents(selectMenu);

        // Send as a reply so we can delete the menu later and still update the original message
        await interaction.reply({
            content: lang.notification.notificationEditor.content.editField,
            components: [row],
            ephemeral: true
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleEditFieldButton');
    }
}

/**
 * Handle edit field selection from select menu
 */
async function handleEditFieldSelectMenu(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_'); // notification_field_edit_select_{notificationId}_{userId}_{editorMessageId}
        const notificationId = parts[4];
        const userId = parts[5];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const fieldNumber = parseInt(interaction.values[0]); // Already 0-based from select menu value
        const editorMessageId = parts[6];

        const notification = notificationQueries.getNotificationById(parseInt(notificationId));
        let fields = [];
        try {
            if (notification.fields) {
                fields = JSON.parse(notification.fields);
            }
        } catch (error) {
            await sendError(interaction, lang, error, 'handleEditFieldSelectMenu - parsing fields');
            fields = [];
        }

        if (fieldNumber < 0 || fieldNumber >= fields.length) {
            return await interaction.update({
                content: lang.notification.notificationEditor.errors.invalidFieldIndex,
                components: [],
                embeds: [],
                ephemeral: true
            });
        }

        // Show modal for editing the selected field
        const field = fields[fieldNumber];
        const selectMenuMessageId = interaction.message.id;

        await showEditFieldModal(interaction, notificationId, fieldNumber, field, lang, editorMessageId, selectMenuMessageId);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleEditFieldSelectMenu');
    }
}

/**
 * Handle edit field modal submission
 */
async function handleEditFieldModal(interaction) {
    const { lang } = getAdminLang(interaction.user.id);
    try {
        const parts = interaction.customId.split('_'); // notification_field_edit_modal_{notificationId}_{fieldIndex}_{editorMessageId}_{selectMenuMessageId}
        const notificationId = parts[4];
        const fieldIndex = parseInt(parts[5]);
        const editorMessageId = parts[6];
        const userId = interaction.user.id;

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const fieldName = interaction.fields.getTextInputValue('field_name');
        const fieldValue = interaction.fields.getTextInputValue('field_value');
        const fieldInlineInput = interaction.fields.getTextInputValue('field_inline') || 'false';
        const fieldInline = fieldInlineInput.toLowerCase().trim() === 'true';

        const notification = notificationQueries.getNotificationById(parseInt(notificationId));

        if (!notification) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.notificationNotFound,
                ephemeral: true
            });
        }

        // Parse existing fields
        let fields = [];
        try {
            if (notification.fields) {
                fields = JSON.parse(notification.fields);
            }
        } catch (error) {
            await sendError(interaction, lang, error, 'handleEditFieldModal - parsing fields');
            fields = [];
        }

        if (fieldIndex < 0 || fieldIndex >= fields.length) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.invalidFieldIndex,
                ephemeral: true
            });
        }

        // Update field
        fields[fieldIndex] = {
            name: fieldName,
            value: fieldValue,
            inline: fieldInline
        };

        // Validate total embed size
        const potentialNotification = { ...notification, fields: fields };
        const totalSize = calculateEmbedSize(potentialNotification);

        if (totalSize > 6000) {
            return await interaction.reply({
                content: lang.notification.notificationEditor.errors.embedTooLarge.replace('{totalSize}', totalSize),
                ephemeral: true
            });
        }

        try {
            // Update notification with updated fields
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
                JSON.stringify(fields), // Updated fields array
                notification.pattern,
                notification.mention,
                notification.repeat_status,
                notification.repeat_frequency,
                notification.embed_toggle,
                notification.is_active,
                notification.last_trigger,
                notification.next_trigger
            );

            // Check for @tags in field value only (field names don't support Discord mentions)
            const tagsInValue = extractMentionTags(fieldValue);

            // Reply to modal immediately to dismiss it
            await interaction.update({
                content: lang.notification.notificationEditor.content.fieldEdited,
                components: [],
                ephemeral: true
            });


            // Update the original editor message with new embed
            try {
                const payload = await showEmbedEditorRef(interaction, parseInt(notificationId), lang, true, true, userId);
                if (editorMessageId) {
                    const editorMsg = await interaction.channel.messages.fetch(editorMessageId);
                    await editorMsg.edit(payload);

                    // If tags found, show tag configuration
                    if (tagsInValue.length > 0 && showTagSelectionMenuRef) {
                        const syntheticInteraction = {
                            user: interaction.user,
                            guild: interaction.guild,
                            channel: interaction.channel,
                            followUp: async (payload) => {
                                return await interaction.channel.send(payload);
                            }
                        };
                        await showTagSelectionMenuRef(syntheticInteraction, parseInt(notificationId), `field_${fieldIndex}`, lang, editorMessageId, 0, false);
                    }
                }
            } catch (err) {
                await sendError(interaction, lang, err, 'handleEditFieldModal - updating editor message');
            }

        } catch (dbError) {
            await sendError(interaction, lang, dbError, 'handleEditFieldModal');
        }

    } catch (error) {
        await sendError(interaction, lang, error, 'handleEditFieldModal');
    }
}

module.exports = {
    setModuleReferences,
    handleAddFieldButton,
    handleAddFieldModal,
    handleEditFieldButton,
    handleEditFieldSelectMenu,
    handleEditFieldModal,
    handleRemoveFieldButton,
    handleRemoveFieldSelect,
    handleReorderFieldsButton,
    handleReorderFieldsFromSelect,
    handleReorderFieldsToSelect
};
