const { ButtonBuilder, ButtonStyle, MessageFlags, } = require('discord.js');
const { getAdminLang, assertUserMatches, sendError } = require('../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../utility/emojis');

/**
 * Creates a back to panel button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The back to panel button
 */
function createBackToPanelButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`back_to_panel_${userId}`)
        .setLabel(lang.panel.mainPage.buttons.backToPanel)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1024'));
}

/**
 * Handles back to panel button interaction and updates container to show main panel
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleBackToPanelButton(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[3]; // back_to_panel_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!adminData) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Use centralized panel creation from panel.js
        const panel = require('../../commands/panel');
        const { components } = panel.createPanelContainer(interaction, adminData, lang);

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleBackToPanelButton');
    }
}

module.exports = {
    createBackToPanelButton,
    handleBackToPanelButton
};
