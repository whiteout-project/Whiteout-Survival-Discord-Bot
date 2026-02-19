const { ButtonBuilder, ButtonStyle, ActionRowBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
const { createBackToPanelButton } = require('../Panel/backToPanel');
const { createAddGiftButton } = require('./addGift');
const { createSetTestIdButton } = require('./setTestId');
const { createManualRedeemButton } = require('./redeemGift');
const { createRemoveGiftButton } = require('./removeGift');
const { createViewGiftButton } = require('./viewGift');
const { createToggleAutoRedeemButton } = require('./autoRedeem');
const { createGiftCodeChannelButton } = require('./giftCodeChannel');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { getAdminLang, assertUserMatches, sendError, hasPermission } = require('../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('./../utility/emojis');

/**
 * Creates a gift code management button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The gift code management button
 */
function createGiftCodeManagementButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`gift_code_management_${userId}`)
        .setLabel(lang.panel.mainPage.buttons.giftCode)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1013'));
}

/**
 * Handles gift code management button interaction and updates embed to show gift code management
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleGiftCodeManagementButton(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[3]; // gift_code_management_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions: must be owner, have FULL_ACCESS, or have GIFT_CODE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Create back to panel button
        const backToPanelButton = createBackToPanelButton(interaction.user.id, lang);
        const addGiftCodeButton = createAddGiftButton(interaction.user.id, lang);
        const setTestIdButton = createSetTestIdButton(interaction.user.id, lang);
        const manualRedeemButton = createManualRedeemButton(interaction.user.id, lang);
        const removeGiftButton = createRemoveGiftButton(interaction.user.id, lang);
        const viewGiftButton = createViewGiftButton(interaction.user.id, lang);
        const toggleAutoRedeemButton = createToggleAutoRedeemButton(interaction.user.id, lang);
        const giftCodeChannelButton = createGiftCodeChannelButton(interaction.user.id, lang);

        // Only owner or full access admins can set test ID and toggle auto-redeem
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        if (!hasFullAccess) {
            setTestIdButton.setDisabled(true);
            toggleAutoRedeemButton.setDisabled(true);
        }

        const row1 = new ActionRowBuilder()
            .addComponents(addGiftCodeButton, manualRedeemButton, toggleAutoRedeemButton, setTestIdButton);

        const row2 = new ActionRowBuilder()
            .addComponents(viewGiftButton, removeGiftButton, giftCodeChannelButton, backToPanelButton);


        const components = [
            new ContainerBuilder()
                .setAccentColor(2417109) // blue
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(        // Title with header formatting
                        `${lang.giftCode.mainPage.content.title}\n` +

                        `${lang.giftCode.mainPage.content.addGiftCodeField.name}\n` +
                        `${lang.giftCode.mainPage.content.addGiftCodeField.value}\n` +

                        `${lang.giftCode.mainPage.content.useGiftCodeField.name}\n` +
                        `${lang.giftCode.mainPage.content.useGiftCodeField.value}\n` +

                        `${lang.giftCode.mainPage.content.toggleGiftCodeField.name}\n` +
                        `${lang.giftCode.mainPage.content.toggleGiftCodeField.value}\n` +

                        `${lang.giftCode.mainPage.content.setTestIdField.name}\n` +
                        `${lang.giftCode.mainPage.content.setTestIdField.value}\n` +

                        `${lang.giftCode.mainPage.content.listGiftCodesField.name}\n` +
                        `${lang.giftCode.mainPage.content.listGiftCodesField.value}\n` +

                        `${lang.giftCode.mainPage.content.deleteGiftCodeField.name}\n` +
                        `${lang.giftCode.mainPage.content.deleteGiftCodeField.value}\n` +

                        `${lang.giftCode.mainPage.content.giftCodeChannel.name}\n` +
                        `${lang.giftCode.mainPage.content.giftCodeChannel.value}\n`
                    )
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
                )
                .addActionRowComponents(row1, row2)
        ];

        // Update the message with gift code management embed and buttons
        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleGiftCodeManagementButton');
    }
}

module.exports = {
    createGiftCodeManagementButton,
    handleGiftCodeManagementButton
};
