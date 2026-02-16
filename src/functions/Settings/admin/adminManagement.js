const {
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    LabelBuilder
} = require('discord.js');
const { createAddAdminButton } = require('./addAdmin');
const { createRemoveAdminButton } = require('./removeAdmin');
const { createEditAdminButton } = require('./assignPermission');
const { createViewAdminButton } = require('./viewAdmin');
const { createBackToSettingsButton } = require('../backToSettings');
const { getAdminLang, assertUserMatches, sendError, hasPermission } = require('../../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../../utility/emojis');


/**
 * Creates a manage admins button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object
 * @returns {ButtonBuilder} The manage admins button
 */
function createManageAdminsButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`manage_admins_${userId}`)
        .setLabel(lang.settings.adminManagement.buttons.manageAdmins)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1027'));
}

/**
 * Handles manage admins button interaction and updates embed to show admin management
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleManageAdminsButton(interaction) {
    // Get admin language preference
    const { lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[2];

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Create action row with admin management buttons
        const actionRow = new ActionRowBuilder()
            .addComponents(
                createAddAdminButton(interaction.user.id, lang),
                createRemoveAdminButton(interaction.user.id, lang),
                createEditAdminButton(interaction.user.id, lang),
                createViewAdminButton(interaction.user.id, lang)
            );

        // Create second row with back button
        const actionRow2 = new ActionRowBuilder()
            .addComponents(
                createBackToSettingsButton(interaction.user.id, lang)
            );

        const components = [
            new ContainerBuilder()
                .setAccentColor(0x9b59b6) // Purple color
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.settings.adminManagement.content.title}\n` +
                        `${lang.settings.adminManagement.content.description}\n` +

                        `${lang.settings.adminManagement.content.addAdminField.name}\n` +
                        `${lang.settings.adminManagement.content.addAdminField.value}\n` +

                        `${lang.settings.adminManagement.content.removeAdminField.name}\n` +
                        `${lang.settings.adminManagement.content.removeAdminField.value}\n` +

                        `${lang.settings.adminManagement.content.assignPermissionsField.name}\n` +
                        `${lang.settings.adminManagement.content.assignPermissionsField.value}\n` +

                        `${lang.settings.adminManagement.content.viewAdminsField.name}\n` +
                        `${lang.settings.adminManagement.content.viewAdminsField.value}`
                    )
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                )
                .addActionRowComponents(
                    actionRow,
                    actionRow2
                )
        ]

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleManageAdminsButton');
    }
}

module.exports = {
    createManageAdminsButton,
    handleManageAdminsButton
};
