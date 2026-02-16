const { MessageFlags, ContainerBuilder, TextDisplayBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
const { getAdminLang, sendError, assertUserMatches } = require('../utility/commonFunctions');
const { createBackToPanelButton } = require('../Panel/backToPanel');
const { getComponentEmoji, getEmojiMapForAdmin } = require('../utility/emojis');

/**
 * Creates a support button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The support button
 */
function createSupportButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`support_${userId}`)
        .setLabel(lang.panel.mainPage.buttons.support)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1039'));
}


/**
 * Handles support button interaction and updates embed to show support info
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleSupportButton(interaction) {
    // Get user's language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[1];

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check if user is an admin
        if (!adminData) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const newSection = [
            new ContainerBuilder()
                .setAccentColor(0xe67e22)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.support.mainPage.content.title}\n` +
                        `${lang.support.mainPage.content.description}`
                    )
                ).addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                ).addActionRowComponents(
                    new ActionRowBuilder().addComponents(
                        createBackToPanelButton(interaction.user.id, lang)
                    )
                )
        ];

        await interaction.update({
            components: newSection,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleSupportButton');
    }
}

module.exports = {
    createSupportButton,
    handleSupportButton
};