const { ButtonBuilder, ButtonStyle, ActionRowBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
const { createBackToPanelButton } = require('../Panel/backToPanel');
const { createCreateAllianceButton } = require('./createAlliance');
const { createEditAllianceButton } = require('./editAlliance');
const { createDeleteAllianceButton } = require('./deleteAlliance');
const { createViewAlliancesButton } = require('./viewAlliances');
const { createEditPriorityButton } = require('./editPriority');
const { createTriggerRefreshButton } = require('./triggerRefresh');
const { createAssignAllianceButton } = require('./assignAlliance');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { getAdminLang, assertUserMatches, sendError, hasPermission } = require('../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('./../utility/emojis');

/**
 * Creates an alliance management button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The alliance management button
 */
function createAllianceManagementButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`alliance_management_${userId}`)
        .setLabel(lang.panel.mainPage.buttons.alliance)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1001'));
}

/**
 * Handles alliance management button interaction and updates embed to show alliance management
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleAllianceManagementButton(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[2]; // alliance_management_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.ALLIANCE_MANAGEMENT);
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const editPriorityButton = createEditPriorityButton(interaction.user.id, lang);
        const assignAllianceButton = createAssignAllianceButton(interaction.user.id, lang);
        if (!hasFullAccess) {
            editPriorityButton.setDisabled(true);
            assignAllianceButton.setDisabled(true);
        }

        // Create back to panel button and alliance management buttons
        const actionRow1 = new ActionRowBuilder()
            .addComponents(
                createCreateAllianceButton(interaction.user.id, lang),
                createEditAllianceButton(interaction.user.id, lang),
                createDeleteAllianceButton(interaction.user.id, lang),
                editPriorityButton
            );

        const actionRow2 = new ActionRowBuilder()
            .addComponents(
                createTriggerRefreshButton(interaction.user.id, lang),
                createViewAlliancesButton(interaction.user.id, lang),
                assignAllianceButton,
                createBackToPanelButton(interaction.user.id, lang)
            );

        const components = [
            new ContainerBuilder()
                .setAccentColor(2417109) // blue
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.alliance.mainPage.content.title}\n` +

                        `${lang.alliance.mainPage.content.createAllianceField.name}\n` +
                        `${lang.alliance.mainPage.content.createAllianceField.value}\n` +

                        `${lang.alliance.mainPage.content.editAllianceField.name}\n` +
                        `${lang.alliance.mainPage.content.editAllianceField.value}\n` +

                        `${lang.alliance.mainPage.content.deleteAllianceField.name}\n` +
                        `${lang.alliance.mainPage.content.deleteAllianceField.value}\n` +

                        `${lang.alliance.mainPage.content.editPriorityField.name}\n` +
                        `${lang.alliance.mainPage.content.editPriorityField.value}\n` +

                        `${lang.alliance.mainPage.content.manualRefreshField.name}\n` +
                        `${lang.alliance.mainPage.content.manualRefreshField.value}\n` +

                        `${lang.alliance.mainPage.content.viewAlliancesField.name}\n` +
                        `${lang.alliance.mainPage.content.viewAlliancesField.value}\n` +

                        `${lang.alliance.mainPage.content.assignAllianceField.name}\n` +
                        `${lang.alliance.mainPage.content.assignAllianceField.value}\n`

                    )
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
                )
                .addActionRowComponents(
                    actionRow1,
                )
                .addActionRowComponents(
                    actionRow2,
                ),
        ];

        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleAllianceManagementButton');
    }
}

module.exports = {
    createAllianceManagementButton,
    handleAllianceManagementButton
};
