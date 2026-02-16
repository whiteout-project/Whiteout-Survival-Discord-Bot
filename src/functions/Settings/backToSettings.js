const { ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { getAdminLang, assertUserMatches, sendError } = require('../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../utility/emojis');
/**
 * Creates a back to settings button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object
 * @returns {ButtonBuilder} The back to settings button
 */
function createBackToSettingsButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`back_to_settings_${userId}`)
        .setLabel(lang.settings.mainPage.buttons.backToSettings)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1002'));
}

/**
 * Handles back to settings button - returns to settings view
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleBackToSettingsButton(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[3]; // back_to_settings_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check if user is an admin
        if (!adminData) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Create settings components
        const { createSettingsComponents } = require('./settings');
        const settingsComponents = createSettingsComponents(interaction, adminData, lang);

        await interaction.update({
            components: settingsComponents,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleBackToSettingsButton');
    }
}

module.exports = {
    createBackToSettingsButton,
    handleBackToSettingsButton
};
