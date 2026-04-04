const {
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js');
const { settingsQueries } = require('../utility/database');
const { getUserInfo, handleError, assertUserMatches } = require('../utility/commonFunctions');
const { getComponentEmoji, getEmojiMapForUser } = require('../utility/emojis');

/**
 * Creates an auto-delete toggle button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @param {boolean} isEnabled - Current state of auto-delete
 * @returns {ButtonBuilder} The auto-delete toggle button
 */
function createAutoDeleteButton(userId, lang, isEnabled) {
    return new ButtonBuilder()
        .setCustomId(`toggle_auto_delete_${userId}`)
        .setLabel(lang.settings.mainPage.buttons.autoDelete)
        .setStyle(isEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setEmoji(isEnabled ? getComponentEmoji(getEmojiMapForUser(userId), '1004') : getComponentEmoji(getEmojiMapForUser(userId), '1051'));
}

/**
 * Handles auto-delete toggle button interaction
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleToggleAutoDelete(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        // Verify user
        const expectedUserId = interaction.customId.split('_')[3]; // toggle_auto_delete_userId
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Only owner can toggle auto-delete
        if (!adminData.is_owner) {
            await interaction.reply({
                content: lang.common.noPermission,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // Toggle auto_delete setting
        const currentSettings = settingsQueries.getSettings.get();
        const newAutoDelete = currentSettings.auto_delete ? 0 : 1;
        settingsQueries.updateAutoDelete.run(newAutoDelete);

        // Refresh features category display (stay on same category page)
        const { createFeaturesCategory } = require('./settings');
        const featuresComponents = createFeaturesCategory(interaction.user.id, adminData, lang);
        await interaction.update({
            components: featuresComponents,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handleToggleAutoDelete');
    }
}

module.exports = {
    createAutoDeleteButton,
    handleToggleAutoDelete
};
