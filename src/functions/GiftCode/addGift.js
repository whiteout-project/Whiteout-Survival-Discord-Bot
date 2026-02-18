const { ButtonBuilder, ButtonStyle, EmbedBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
const { giftCodeQueries, allianceQueries, playerQueries, systemLogQueries } = require('../utility/database');
const { createRedeemProcess } = require('./redeemFunction');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { hasPermission, sendError, getAdminLang, assertUserMatches, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('./../utility/emojis');


/**
 * Creates an add gift code button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The add gift code button
 */
function createAddGiftButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`add_gift_${userId}`)
        .setLabel(lang.giftCode.mainPage.buttons.addGiftCode)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1000'));
}

/**
 * Handles add gift button interaction - opens modal for gift code input
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleAddGiftButton(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[2]; // add_gift_userId

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

        // Create and show modal
        const modal = new ModalBuilder()
            .setCustomId(`add_gift_modal_${interaction.user.id}`)
            .setTitle(lang.giftCode.addGiftCode.modal.title);

        const giftCodeInput = new TextInputBuilder()
            .setCustomId('gift_code_value')
            .setPlaceholder(lang.giftCode.addGiftCode.modal.giftCodeInput.placeholder)
            .setStyle(TextInputStyle.Short)
            .setMinLength(1)
            .setMaxLength(50)
            .setRequired(true);

        const giftCodeLabel = new LabelBuilder()
            .setLabel(lang.giftCode.addGiftCode.modal.giftCodeInput.label)
            .setTextInputComponent(giftCodeInput);

        modal.addLabelComponents(giftCodeLabel);

        await interaction.showModal(modal);


    } catch (error) {
        await sendError(interaction, lang, error, 'handleAddGiftButton');
    }
}

/**
 * Handles the gift code modal submission
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleGiftCodeModal(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[3]; // add_gift_modal_userId

        // Verify user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions: must be owner, have FULL_ACCESS, or have GIFT_CODE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get the gift code from the modal
        const giftCode = interaction.fields.getTextInputValue('gift_code_value').trim();

        if (!giftCode) {
            return await interaction.reply({
                content: lang.giftCode.addGiftCode.errors.invalidGiftCode,
                ephemeral: true
            });
        }

        // Check if gift code already exists
        const existingCode = await giftCodeQueries.getGiftCode(giftCode);
        if (existingCode) {
            return await interaction.reply({
                content: lang.giftCode.addGiftCode.errors.giftCodeExists,
                ephemeral: true
            });
        }

        await interaction.deferUpdate({ flags: MessageFlags.IsComponentsV2 });

        const container = [
            new ContainerBuilder()
                .setAccentColor(0xFFA500) // orange
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(lang.giftCode.addGiftCode.content.title),
                    new TextDisplayBuilder().setContent(lang.giftCode.addGiftCode.content.description.replace('{giftCode}', `\`${giftCode}\``))
                )
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        // Show processing message
        await interaction.editReply({ components: content, flags: MessageFlags.IsComponentsV2 });

        // Call the redeem function with validation status
        const validationOutcome = await createRedeemProcess([
            {
                id: null,
                giftCode,
                status: 'validation'
            }
        ], {
            adminId: interaction.user.id
        });

        if (validationOutcome?.success) {
            // Add gift code to database
            try {
                // Get VIP status from validation result
                const isVipCode = validationOutcome.results?.[0]?.is_vip || false;

                // addGiftCode(giftCode, status, addedBy, source, apiPushed, isVip)
                await giftCodeQueries.addGiftCode(giftCode, 'active', interaction.user.id, 'manual', false, isVipCode);

                // Set last_validated timestamp to prevent re-validation by validateExistingCodes
                giftCodeQueries.updateLastValidated(giftCode);

                systemLogQueries.addLog(
                    'info',
                    `Gift code added to database: ${giftCode}`,
                    JSON.stringify({
                        gift_code: giftCode,
                        added_by: interaction.user.id,
                        is_vip: isVipCode,
                        function: 'handleGiftCodeModal'
                    })
                );

                // Start auto-redeem for alliances
                setImmediate(() => {
                    startAutoRedeemForAlliances(giftCode, interaction.user.id, lang).catch(async error => {
                        await sendError(interaction, lang, error, 'startAutoRedeemForAlliances', false);
                    });
                });

                const container = [
                    new ContainerBuilder()
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent(lang.giftCode.addGiftCode.content.giftCodeAdded),
                            new TextDisplayBuilder().setContent(lang.giftCode.addGiftCode.content.giftCodeInfo.replace('{giftCode}', `\`${giftCode}\``))
                        )
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent(lang.giftCode.addGiftCode.content.footer)
                        )
                ];

                const content = updateComponentsV2AfterSeparator(interaction, container);

                await interaction.editReply({
                    components: content,
                    flags: MessageFlags.IsComponentsV2
                });

            } catch (dbError) {
                await sendError(interaction, lang, dbError, 'handleGiftCodeModal_dbError');
            }
        }
    } catch (error) {
        await sendError(interaction, lang, error, 'handleGiftCodeModal');
    }
}

/**
 * Starts auto-redeem process for all alliances with auto-redeem enabled
 * @param {string} giftCode - The gift code to redeem
 * @param {string} adminId - Admin who initiated the process
 * @param {Object} lang - Language object
 */
async function startAutoRedeemForAlliances(giftCode, adminId, lang) {
    try {
        // Get all alliances with auto-redeem enabled, ordered by priority
        const alliances = await allianceQueries.getAlliancesWithAutoRedeem();

        if (alliances.length === 0) {
            return;
        }


        // Process each alliance
        for (const alliance of alliances) {
            try {
                // Get all players for this alliance
                const players = await playerQueries.getPlayersByAlliance(alliance.id);

                if (players.length === 0) {
                    // console.log(`ℹ️ Alliance "${alliance.name}" has no players, skipping`);
                    continue;
                }

                // Create redeem data for all players
                const redeemData = players.map(player => ({
                    id: player.fid,
                    giftCode: giftCode,
                    status: 'redeem'
                }));


                const redeemOptions = {
                    adminId,
                    allianceContext: {
                        id: alliance.id,
                        name: alliance.name,
                        channelId: alliance.channel_id || null
                    }
                };

                // Call redeem function for this alliance
                const result = await createRedeemProcess(redeemData, redeemOptions);

                if (result && result.success) {
                } else {
                    await sendError(null, null, new Error(`Failed to start auto-redeem for alliance "${alliance.name}": ${result?.message || 'Unknown error'}`), 'startAutoRedeemForAlliances_redeemError', false);
                }

            } catch (allianceError) {
                allianceError.message = `${allianceError.message} | context: adminId=${adminId}, giftCode=${giftCode}, alliance=${alliance.name}(${alliance.id})`;
                await sendError(null, lang, allianceError, 'startAutoRedeemForAlliances_allianceError');
            }
        }

    } catch (error) {
        error.message = `${error.message} | context: adminId=${adminId}, giftCode=${giftCode}`;
        await sendError(null, lang, error, 'startAutoRedeemForAlliances');
    }
}

module.exports = {
    createAddGiftButton,
    handleGiftCodeModal,
    handleAddGiftButton,
};