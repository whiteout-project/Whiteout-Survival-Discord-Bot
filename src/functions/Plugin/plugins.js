const {
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ActionRowBuilder
} = require('discord.js');
const { getUserInfo, handleError, assertUserMatches } = require('../utility/commonFunctions');
const { getComponentEmoji, getEmojiMapForUser } = require('../utility/emojis');
const { createBackToPanelButton } = require('../Panel/backToPanel');

// ============================================================
// MAIN PAGE UI
// ============================================================

/**
 * Creates a plugins button for the settings panel
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The plugins button
 */
function createPluginsButton(userId, lang) {
    return new ButtonBuilder()
        .setCustomId(`plugins_menu_${userId}`)
        .setLabel(lang.settings.mainPage.buttons.plugins)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1039'));
}

/**
 * Creates a back-to-plugins-menu button
 * @param {string} userId - User ID for authorization
 * @param {Object} pluginLang - Plugin language object
 * @returns {ButtonBuilder}
 */
function createBackToPluginsButton(userId, pluginLang) {
    return new ButtonBuilder()
        .setCustomId(`plugins_menu_${userId}`)
        .setLabel(pluginLang.buttons.back)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1024'));
}

/**
 * Creates plugins main page components for display
 * @param {Object} interaction - Interaction object
 * @param {Object} lang - Language object for localized text
 * @returns {Array} Array of components ready for display
 */
function createPluginsComponents(interaction, lang) {
    const pluginLang = lang.plugins;
    const userId = interaction.user.id;
    const emojiMap = getEmojiMapForUser(userId);

    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`plugins_install_menu_${userId}`)
            .setLabel(pluginLang.buttons.installMenu)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(emojiMap, '1018')),
        new ButtonBuilder()
            .setCustomId(`plugins_delete_menu_${userId}`)
            .setLabel(pluginLang.buttons.deleteMenu)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(emojiMap, '1046')),
        new ButtonBuilder()
            .setCustomId(`plugins_access_menu_${userId}`)
            .setLabel(pluginLang.buttons.accessMenu)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(emojiMap, '1035')),
        createBackToPanelButton(userId, lang)
    );

    return [
        new ContainerBuilder()
            .setAccentColor(0x9b59b6)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${pluginLang.content.title}\n` +
                    `${pluginLang.content.description}\n` +

                    `${pluginLang.content.installField.name}\n` +
                    `${pluginLang.content.installField.value}\n` +

                    `${pluginLang.content.deleteField.name}\n` +
                    `${pluginLang.content.deleteField.value}\n` +

                    `${pluginLang.content.accessField.name}\n` +
                    `${pluginLang.content.accessField.value}\n`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addActionRowComponents(actionRow)
    ];
}

/**
 * Handles the plugins menu button — shows main page with Install, Delete, Access buttons
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handlePluginsMenu(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[2];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!adminData || !adminData.is_owner) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const components = createPluginsComponents(interaction, lang);

        await interaction.update({
            components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handlePluginsMenu');
    }
}

module.exports = {
    createPluginsButton,
    createBackToPluginsButton,
    createPluginsComponents,
    handlePluginsMenu
};
