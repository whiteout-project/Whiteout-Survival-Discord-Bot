/**
 * Notification Mentions Module
 * Handles all mention-related functionality (@tag configuration, user/role selection)
 */

const { ButtonBuilder, ButtonStyle, EmbedBuilder, ActionRowBuilder, UserSelectMenuBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder } = require('discord.js');
const { notificationQueries } = require('../utility/database');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { getAdminLang, assertUserMatches, sendError } = require('../utility/commonFunctions');
const { extractMentionTags, convertTagsToMentions, parseMentions } = require('./notificationUtils');
const { getEmojiMapForAdmin, getComponentEmoji, replaceEmojiPlaceholders } = require('../utility/emojis');


// Module reference for showEmbedEditor (set by createNotification.js)
let showEmbedEditorRef = null;

/**
 * Set module reference to avoid circular dependencies
 */
function setModuleReferences(showEmbedEditor) {
    showEmbedEditorRef = showEmbedEditor;
}

/**
 * Handle mention selection (user/role select menus)
 */
async function handleMentionSelection(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        // notification_mention_select_{userId}_{notificationId}_{component}|{tag}|{type}|{editorMessageId}
        const customId = interaction.customId;
        const parts = customId.split('_');

        const userId = parts[3];
        const notificationId = parts[4];

        // Everything after the 5th underscore contains: {component}|{tag}|{type}|{editorMessageId}
        const remaining = parts.slice(5).join('_'); // Rejoin in case component has underscores like field_0
        const pipeParts = remaining.split('|');

        const component = pipeParts[0]; // e.g., "field_0", "message", "description"
        const tag = pipeParts[1]; // e.g., "tag"
        const type = pipeParts[2]; // "user" or "role"
        const editorMessageId = pipeParts[3]; // message ID or "none"

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const selectedId = interaction.values[0];
        const mentionType = type === 'user' ? 'user' : 'role';

        await saveMention(interaction, notificationId, component, tag, mentionType, selectedId, lang, editorMessageId, showEmbedEditorRef);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleMentionSelection');
    }
}

/**
 * Handle tag selection from dropdown
 */
async function handleTagSelection(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        // notification_tag_select_{notificationId}_{userId}_{component}_{editorMessageId}_{page}
        const parts = interaction.customId.split('_');
        const notificationId = parts[3];
        const userId = parts[4];

        // Extract component (could be field_0, field_1, etc.)
        let component = parts[5];
        let nextIndex = 6;

        // If component is 'field', combine with next part to get 'field_0', 'field_1', etc.
        if (component === 'field' && parts[6] && !isNaN(parts[6])) {
            component = `field_${parts[6]}`;
            nextIndex = 7;
        }

        const editorMessageId = parts[nextIndex];
        const page = parseInt(parts[nextIndex + 1]);

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const selectedTag = interaction.values[0];

        // Show mention type selection for the selected tag (will update the message)
        await showMentionTypeSelection(interaction, notificationId, component, selectedTag, lang, editorMessageId);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleTagSelection');
    }
}

/**
 * Handle tag pagination buttons
 */
async function handleTagPagination(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const { userId, newPage, contextData } = parsePaginationCustomId(interaction.customId, 3);
        const notificationId = parseInt(contextData[0]);
        const component = contextData[1];
        const editorMessageId = contextData[2];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        await showTagSelectionMenu(interaction, notificationId, component, lang, editorMessageId, newPage, true);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleTagPagination');
    }
}

/**
 * Handle tag save button
 */
async function handleTagSave(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const notificationId = parts[3];
        const userId = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        // Show success and delete after 3 seconds
        await interaction.update({
            content: lang.notification.notificationEditor.content.mentionsSaved,
            embeds: [],
            components: []
        });

        setTimeout(async () => {
            try {
                await interaction.message.delete();
            } catch (err) {
                await sendError(interaction, lang, err, 'handleTagSave - delete config message');
            }
        }, 3000);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleTagSave');
    }
}

/**
 * Handle mention type button (User/Role/Everyone/Here)
 */
async function handleMentionTypeButton(interaction) {
    const { lang } = getAdminLang(interaction.user.id);

    try {
        // notification_mention_{type}_{userId}_{notificationId}_{component}|{tag}|{editorMessageId}
        const parts = interaction.customId.split('_');
        const type = parts[2]; // user, role, everyone, or here
        const userId = parts[3];
        const notificationId = parts[4];

        // Split the rest by | to get component, tag, and editorMessageId
        const remaining = parts.slice(5).join('_'); // Rejoin in case component has underscores
        const [component, tag, editorMessageId] = remaining.split('|');

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        // Handle @everyone and @here directly without showing select menu
        if (type === 'everyone' || type === 'here') {
            await saveMention(interaction, notificationId, component, tag, type, type, lang, editorMessageId, showEmbedEditorRef);
        } else {
            await showMentionSelection(interaction, notificationId, component, tag, type, lang, editorMessageId);
        }

    } catch (error) {
        await sendError(interaction, lang, error, 'handleMentionTypeButton');
    }
}

/**
 * Show tag selection menu for editing specific mentions
 */
async function showTagSelectionMenu(interaction, notificationId, component, lang, editorMessageId, page = 0, useUpdate = false) {
    const notification = notificationQueries.getNotificationById(parseInt(notificationId));

    // Extract tags based on component type
    let tags = [];
    if (component === 'message') {
        tags = extractMentionTags(notification.message_content);
    } else if (component === 'description') {
        tags = extractMentionTags(notification.description);
    } else if (component.startsWith('field_')) {
        // Extract tags from specific field value only
        try {
            const fieldIndex = parseInt(component.split('_')[1]);
            const fields = notification.fields ? JSON.parse(notification.fields) : [];
            if (fields[fieldIndex]) {
                tags = extractMentionTags(fields[fieldIndex].value);
            }
        } catch (error) {
            await sendError(interaction, lang, error, 'showTagSelectionMenu - extract field tags');
            tags = [];
        }
    }

    const mentions = parseMentions(notification.mention);
    const componentMentions = mentions[component] || {};

    // Check if there are any tags to configure
    if (tags.length === 0) {
        return;
    }

    // Build tag list with status 
    const emojiMap = getEmojiMapForAdmin(interaction.user.id);
    const hasGuild = !!(interaction && interaction.guild);
    const tagOptions = await Promise.all(tags.map(async (tag) => {
        const configured = componentMentions[tag];
        let label = `@${tag}`;
        let description = lang.notification.notificationEditor.content.notConfigured;
        if (configured) {
            const [type, id] = configured.split(':');
            if (type === 'everyone') {
                description = replaceEmojiPlaceholders('{emoji.1004} @everyone', emojiMap);
            } else if (type === 'here') {
                description = replaceEmojiPlaceholders('{emoji.1004} @here', emojiMap);
            } else {
                try {
                    if (type === 'user') {
                        if (hasGuild) {
                            const member = await interaction.guild.members.fetch(id);
                            description = lang.notification.notificationEditor.content.user.replace('{userName}', member.displayName || member.user.username);
                        } else {
                            description = lang.notification.notificationEditor.content.user.replace('{userName}', id);
                        }
                    } else if (type === 'role') {
                        if (hasGuild) {
                            const role = interaction.guild.roles.cache.get(id);
                            description = lang.notification.notificationEditor.content.role.replace('{roleName}', role ? role.name : lang.notification.notificationEditor.content.unknownRole);
                        } else {
                            description = lang.notification.notificationEditor.content.role.replace('{roleName}', id);
                        }
                    } else {
                        description = lang.notification.notificationEditor.content.noDescription.replace('{type}', type).replace('{id}', id);
                    }
                } catch (error) {
                    console.error(`Error fetching ${type} ${id}:`, error);
                    description = lang.notification.notificationEditor.content.noDescription.replace('{type}', type).replace('{id}', id);
                }
            }
        }

        return { label, description, value: tag };
    }));

    // Pagination
    const itemsPerPage = 24;
    const totalPages = Math.ceil(tagOptions.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, tagOptions.length);
    const paginatedOptions = tagOptions.slice(startIndex, endIndex);

    const embed = new EmbedBuilder()
        .setTitle(lang.notification.notificationEditor.content.title.mentionsConfigure)
        .setDescription(lang.notification.notificationEditor.content.description.mentionsConfigure.replace('{totalCount}', tags.length).replace('{configuredCount}', Object.keys(componentMentions).length).replace('{totalCount}', tags.length))
        .setColor('#5865f2')
        .setFooter({ text: lang.pagination.text.pageInfo.replace('{current}', (page + 1)).replace('{total}', totalPages) });

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`notification_tag_select_${notificationId}_${interaction.user.id}_${component}_${editorMessageId || 'none'}_${page}`)
        .setPlaceholder(lang.notification.notificationEditor.selectMenu.mentionsSelect.placeholder)
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(paginatedOptions);

    const selectRow = new ActionRowBuilder().addComponents(selectMenu);

    // Buttons: Save
    const saveButton = new ButtonBuilder()
        .setCustomId(`notification_tag_save_${notificationId}_${interaction.user.id}_${component}_${editorMessageId || 'none'}`)
        .setLabel(lang.notification.notificationEditor.buttons.save)
        .setEmoji(getComponentEmoji(emojiMap, '1037'))
        .setStyle(ButtonStyle.Success);

    const paginationRow = createUniversalPaginationButtons({
        feature: 'notification_tag',
        userId: interaction.user.id,
        currentPage: page,
        totalPages: totalPages,
        lang: lang,
        contextData: [notificationId, component, editorMessageId || 'none']
    });

    const buttonRow = new ActionRowBuilder().addComponents(saveButton);

    // Build components array and include paginationRow as a separate row when present
    const components = [selectRow, buttonRow];
    if (paginationRow) {
        components.push(paginationRow);
    }

    const payload = {
        embeds: [embed],
        components
    };

    if (useUpdate) {
        await interaction.update(payload);
    } else {
        return await interaction.followUp(payload);
    }
}

/**
 * Show mention type selection (User/Role buttons)
 */
async function showMentionTypeSelection(interaction, notificationId, component, tag, lang, editorMessageId = null) {
    // Fetch notification to get existing mentions for context
    const notification = await notificationQueries.getNotificationById(parseInt(notificationId));

    // Get the content based on component
    let content = '';
    if (component === 'message') {
        content = notification.message_content || '';
    } else if (component === 'description') {
        content = notification.description || '';
    }

    // Replace configured tags in content for preview
    let previewContent = content;
    if (notification.mention) {
        const mentions = parseMentions(notification.mention);
        if (mentions[component]) {
            Object.entries(mentions[component]).forEach(([t, val]) => {
                const [type, id] = val.split(':');
                const mentionStr = type === 'user' ? `<@${id}>` : `<@&${id}>`;
                // Replace all occurrences of @tag with mention using word boundary to avoid prefix matching
                previewContent = previewContent.replace(new RegExp(`@${t}\\b`, 'g'), mentionStr);
            });
        }
    }

    // Highlight the current tag being configured
    const currentTagRegex = new RegExp(`@${tag}\\b`, 'g');
    previewContent = previewContent.replace(currentTagRegex, `**@${tag}**`);

    const embed = new EmbedBuilder()
        .setTitle(lang.notification.notificationEditor.content.title.selectType)
        .setDescription(lang.notification.notificationEditor.content.description.selectType)
        .setColor('#5865f2');

    // Use | as separator to avoid conflicts with component names like field_0
    const userButton = new ButtonBuilder()
        .setCustomId(`notification_mention_user_${interaction.user.id}_${notificationId}_${component}|${tag}|${editorMessageId || 'none'}`)
        .setLabel(lang.notification.notificationEditor.buttons.userMentions)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1026'))
        .setStyle(ButtonStyle.Secondary);

    const roleButton = new ButtonBuilder()
        .setCustomId(`notification_mention_role_${interaction.user.id}_${notificationId}_${component}|${tag}|${editorMessageId || 'none'}`)
        .setLabel(lang.notification.notificationEditor.buttons.roleMentions)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1027'))
        .setStyle(ButtonStyle.Secondary);

    const everyoneButton = new ButtonBuilder()
        .setCustomId(`notification_mention_everyone_${interaction.user.id}_${notificationId}_${component}|${tag}|${editorMessageId || 'none'}`)
        .setLabel('@everyone')
        .setStyle(ButtonStyle.Secondary);

    const hereButton = new ButtonBuilder()
        .setCustomId(`notification_mention_here_${interaction.user.id}_${notificationId}_${component}|${tag}|${editorMessageId || 'none'}`)
        .setLabel('@here')
        .setStyle(ButtonStyle.Secondary);

    const actionRow = new ActionRowBuilder().addComponents(userButton, roleButton, everyoneButton, hereButton);

    await interaction.update({
        embeds: [embed],
        components: [actionRow]
    });
}

/**
 * Show user/role selection menu
 */
async function showMentionSelection(interaction, notificationId, component, tag, type, lang, editorMessageId = null) {
    const embed = new EmbedBuilder()
        .setTitle(lang.notification.notificationEditor.content.title.mentionTarget.replace('{tag}', tag))
        .setDescription(lang.notification.notificationEditor.content.description.chooseTarget.replace('{tag}', tag))
        .setColor('#5865f2');

    // Use | as separator to avoid conflicts with component names like field_0
    let selectMenu;
    if (type === 'user') {
        selectMenu = new UserSelectMenuBuilder()
            .setCustomId(`notification_mention_select_${interaction.user.id}_${notificationId}_${component}|${tag}|${type}|${editorMessageId || 'none'}`)
            .setPlaceholder(lang.notification.notificationEditor.selectMenu.fieldSelection.placeholder.userMention)
            .setMinValues(1)
            .setMaxValues(1);
    } else {
        selectMenu = new RoleSelectMenuBuilder()
            .setCustomId(`notification_mention_select_${interaction.user.id}_${notificationId}_${component}|${tag}|${type}|${editorMessageId || 'none'}`)
            .setPlaceholder(lang.notification.notificationEditor.selectMenu.fieldSelection.placeholder.roleMention)
            .setMinValues(1)
            .setMaxValues(1);
    }

    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.update({
        embeds: [embed],
        components: [row]
    });
}

/**
 * Process mentions after content update
 * @param {Interaction} interaction - The interaction object
 * @param {string} notificationId - The notification ID
 * @param {string} component - Component type ('message', 'description', 'field_X')
 * @param {string} content - The updated content
 * @param {object} lang - Language object
 * @param {Function} showEmbedEditorFn - Reference to showEmbedEditor function from notificationEditor.js
 */
async function processMentionsAfterContentUpdate(interaction, notificationId, component, content, lang, showEmbedEditorFn = null) {
    const tags = extractMentionTags(content);

    if (tags.length === 0) {
        // No mentions found, continue with normal flow
        if (component === 'message') {
            // Convert configured @tags to mentions for display
            const notification = notificationQueries.getNotificationById(parseInt(notificationId));
            const mentions = parseMentions(notification.mention);
            const displayContent = convertTagsToMentions(content, mentions, 'message');

            await interaction.update({
                content: displayContent,
                components: interaction.message.components
            });
        } else if (component.startsWith('field_') || component === 'description') {
            // For fields and description, refresh the embed editor if function is provided
            if (showEmbedEditorFn) {
                await showEmbedEditorFn(interaction, parseInt(notificationId), lang);
            }
        }
        return;
    }

    // Store the original editor message ID for updating later
    const editorMessageId = interaction.message.id;

    // First, update the interaction to close the modal
    if (component === 'message') {
        const notification = notificationQueries.getNotificationById(parseInt(notificationId));
        const mentions = parseMentions(notification.mention);
        const displayContent = convertTagsToMentions(content, mentions, 'message');

        await interaction.update({
            content: displayContent,
            components: interaction.message.components
        });
    } else if (component.startsWith('field_') || component === 'description') {
        // For description and fields, update the embed editor to close the modal
        if (showEmbedEditorFn) {
            await showEmbedEditorFn(interaction, parseInt(notificationId), lang);
        }
    }

    // Then send tag selection menu as a follow-up
    await showTagSelectionMenu(interaction, notificationId, component, lang, editorMessageId, 0, false);
}

/**
 * Save mention to notification
 * @param {Interaction} interaction - The interaction object
 * @param {string} notificationId - The notification ID
 * @param {string} component - Component type ('message', 'description', 'field_X')
 * @param {string} tag - The tag name
 * @param {string} mentionType - Type of mention ('user', 'role', 'everyone', 'here')
 * @param {string} mentionId - The ID of the user/role (or same as type for everyone/here)
 * @param {object} lang - Language object
 * @param {string} editorMessageId - The editor message ID to update
 * @param {Function} showEmbedEditorFn - Reference to showEmbedEditor function from notificationEditor.js
 */
async function saveMention(interaction, notificationId, component, tag, mentionType, mentionId, lang, editorMessageId = null, showEmbedEditorFn = null) {
    const notification = notificationQueries.getNotificationById(parseInt(notificationId));

    if (!notification) {
        return await interaction.reply({
            content: lang.notification.createNotification.errors.notificationNotFound,
            ephemeral: true
        });
    }

    // Parse existing mentions
    const mentions = parseMentions(notification.mention);

    // Ensure component section exists
    if (!mentions[component]) {
        mentions[component] = {};
    }

    // Save the mention
    mentions[component][tag] = `${mentionType}:${mentionId}`;

    try {
        // Update notification with new mentions
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
            JSON.stringify(mentions), // Updated mentions
            notification.repeat_status,
            notification.repeat_frequency,
            notification.embed_toggle,
            notification.is_active,
            notification.last_trigger,
            notification.next_trigger
        );

        // Update the original editor message with the configured mention
        try {
            if (editorMessageId && editorMessageId !== 'none') {
                const editorMessage = await interaction.channel.messages.fetch(editorMessageId);
                const updatedNotification = notificationQueries.getNotificationById(parseInt(notificationId));

                // Update the editor message based on component type
                if (component === 'message') {
                    // For message component, update the content directly
                    let updatedContent = updatedNotification.message_content || '';
                    if (updatedContent && updatedNotification.mention) {
                        const updatedMentions = parseMentions(updatedNotification.mention);
                        if (updatedMentions[component]) {
                            Object.entries(updatedMentions[component]).forEach(([t, val]) => {
                                const [type, id] = val.split(':');
                                let mentionStr;
                                if (type === 'everyone') {
                                    mentionStr = '@everyone';
                                } else if (type === 'here') {
                                    mentionStr = '@here';
                                } else {
                                    mentionStr = type === 'user' ? `<@${id}>` : `<@&${id}>`;
                                }
                                updatedContent = updatedContent.replace(new RegExp(`@${t}\\b`, 'g'), mentionStr);
                            });
                        }
                    }

                    await editorMessage.edit({
                        content: updatedContent,
                        components: editorMessage.components
                    });
                } else if (showEmbedEditorFn) {
                    // For fields (field_X) and description, rebuild the entire embed editor
                    const payload = await showEmbedEditorFn(null, parseInt(notificationId), lang, false, true, interaction.user.id);
                    await editorMessage.edit(payload);
                }
            }
        } catch (editorUpdateError) {
            await sendError(interaction, lang, editorUpdateError, 'saveMention - update editor message');
        }

        // Show formatted mention in success message
        let mentionDisplay = '';
        if (mentionType === 'everyone') {
            mentionDisplay = '@everyone';
        } else if (mentionType === 'here') {
            mentionDisplay = '@here';
        } else {
            mentionDisplay = `<@${mentionType === 'role' ? '&' : ''}${mentionId}>`;
        }

        // Return to tag selection menu
        const embed = new EmbedBuilder()
            .setTitle(lang.notification.notificationEditor.content.title.configuredTags)
            .setDescription(lang.notification.notificationEditor.content.description.configuredTags.replace('{tag}', tag).replace('{mentionDisplay}', mentionDisplay))
            .setColor('#57f287');

        await interaction.update({
            embeds: [embed],
            components: []
        });

        // After short delay, fetch the message and show tag selection menu
        setTimeout(async () => {
            try {
                const message = await interaction.fetchReply();

                // Build and get the tag selection menu payload
                const fakeInteraction = {
                    user: interaction.user,
                    guild: interaction.guild, // Include guild for role/user fetching
                    update: async (payload) => {
                        await message.edit(payload);
                    }
                };

                // Reuse showTagSelectionMenu to build the menu
                await showTagSelectionMenu(fakeInteraction, notificationId, component, lang, editorMessageId, 0, true);
            } catch (err) {
                await sendError(interaction, lang, err, 'saveMention - showTagSelectionMenu');
            }
        }, 1500);

    } catch (dbError) {
        await sendError(interaction, lang, dbError, 'saveMention');
    }
}

module.exports = {
    handleMentionSelection,
    handleTagSelection,
    handleTagPagination,
    handleTagSave,
    handleMentionTypeButton,
    showTagSelectionMenu,
    showMentionTypeSelection,
    showMentionSelection,
    processMentionsAfterContentUpdate,
    saveMention,
    setModuleReferences
};
