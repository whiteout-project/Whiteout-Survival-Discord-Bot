const { ButtonBuilder, ButtonStyle, EmbedBuilder, ActionRowBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { createBackToPanelButton } = require('../Panel/backToPanel');
const { createAddPlayerButton } = require('./addPlayer');
const { createMovePlayersButton } = require('./movePlayers');
const { createRemovePlayersButton } = require('./removePlayers');
const { createViewPlayersButton } = require('./viewPlayers');
const { createIdChannelButton } = require('./idChannel');
const { createExportButton } = require('./export');
const { getUserInfo, assertUserMatches, handleError, hasPermission } = require('../utility/commonFunctions');
const { getComponentEmoji, getEmojiMapForUser } = require('../utility/emojis');
const { getPlayerSyncIntegration } = require('./playerSyncIntegration');


/**
 * Creates a player management button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The player management button
 */
function createPlayerManagementButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`player_management_${userId}`)
        .setLabel(lang.panel.mainPage.buttons.players)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1027'));
}

/**
 * Handles player management button interaction and updates embed to show player management
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handlePlayerManagementButton(interaction) {
    // Get user's language preference
    const { lang, adminData } = getUserInfo(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[2]; // player_management_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check if admin has player management permissions
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.PLAYER_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Create action row with player management buttons
        const actionRow1 = new ActionRowBuilder()
            .addComponents(
                createAddPlayerButton(interaction.user.id, lang),
                createMovePlayersButton(interaction.user.id, lang),
                createViewPlayersButton(interaction.user.id, lang),
                createRemovePlayersButton(interaction.user.id, lang)
            );

        // Create second row with ID channel button
        const actionRow2 = new ActionRowBuilder()
            .addComponents(
                createIdChannelButton(interaction.user.id, lang),
                createExportButton(interaction.user.id, lang),
                createBackToPanelButton(interaction.user.id, lang)
            );

        if (getPlayerSyncIntegration()) {
            actionRow2.addComponents(new ButtonBuilder()
                .setCustomId(`ps_open_${interaction.user.id}`)
                .setLabel(lang.plugins?.['player-sync']?.title || 'Player Sync')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1033')));
        }

        const newSection = [
            new ContainerBuilder()
                .setAccentColor(2417109) // blue
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.players.mainPage.content.title}\n` +

                        `${lang.players.mainPage.content.addPlayersField.name}\n` +
                        `${lang.players.mainPage.content.addPlayersField.value}\n` +

                        `${lang.players.mainPage.content.movePlayersField.name}\n` +
                        `${lang.players.mainPage.content.movePlayersField.value}\n` +

                        `${lang.players.mainPage.content.viewPlayersField.name}\n` +
                        `${lang.players.mainPage.content.viewPlayersField.value}\n` +

                        `${lang.players.mainPage.content.removePlayersField.name}\n` +
                        `${lang.players.mainPage.content.removePlayersField.value}\n` +

                        `${lang.players.mainPage.content.idChannelField.name}\n` +
                        `${lang.players.mainPage.content.idChannelField.value}\n` +

                        `${lang.players.mainPage.content.exportPlayersField.name}\n` +
                        `${lang.players.mainPage.content.exportPlayersField.value}\n`
                    )
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
                )
                .addActionRowComponents(actionRow1, actionRow2)
        ];

        await interaction.update({
            components: newSection,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handlePlayerManagementButton');
    }
}

module.exports = {
    createPlayerManagementButton,
    handlePlayerManagementButton
};
