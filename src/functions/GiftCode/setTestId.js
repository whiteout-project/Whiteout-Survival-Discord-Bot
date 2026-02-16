const { ButtonBuilder, ButtonStyle, ModalBuilder, SectionBuilder, TextInputBuilder, TextInputStyle, LabelBuilder, ContainerBuilder, ThumbnailBuilder, MessageFlags, TextDisplayBuilder } = require('discord.js');
const { adminQueries, testIdQueries, systemLogQueries } = require('../utility/database');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { getFurnaceReadable } = require('../Players/furnaceReadable');
const { fetchPlayerFromAPI } = require('../Players/fetchPlayerData');
const { hasPermission, sendError, getAdminLang, assertUserMatches, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getComponentEmoji, getEmojiMapForAdmin } = require('../utility/emojis');

/**
 * Creates a set test ID button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The set test ID button
 */
function createSetTestIdButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`set_test_id_${userId}`)
        .setLabel(lang.giftCode.mainPage.buttons.setTestId)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1045'));
}

/**
 * Handles set test ID button interaction - directly opens modal
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleSetTestIdButton(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[3]; // set_test_id_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        // Check if user has full access permission
        if (!hasFullAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Create and show modal directly
        const modal = new ModalBuilder()
            .setCustomId(`test_id_modal_${interaction.user.id}`)
            .setTitle(lang.giftCode.giftSetTestId.modal.title);

        const testIdInput = new TextInputBuilder()
            .setCustomId('test_id_value')
            .setPlaceholder(lang.giftCode.giftSetTestId.modal.testIdInput.placeholder)
            .setStyle(TextInputStyle.Short)
            .setMinLength(1)
            .setMaxLength(20)
            .setRequired(true);

        const testIdLabel = new LabelBuilder()
            .setLabel(lang.giftCode.giftSetTestId.modal.testIdInput.label)
            .setTextInputComponent(testIdInput);

        modal.addLabelComponents(testIdLabel);

        await interaction.showModal(modal);


    } catch (error) {
        await sendError(interaction, lang, error, 'handleSetTestIdButton');
    }
}


/**
 * Handles the test ID modal submission
 * @param {import('discord.js').ModalSubmitInteraction} interaction 
 */
async function handleTestIdModal(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[3]; // test_id_modal_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        // Check if user has full access permission
        if (!hasFullAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get the test ID value
        const testIdValue = interaction.fields.getTextInputValue('test_id_value').trim();

        // Validate it's a number
        const fid = parseInt(testIdValue);
        if (isNaN(fid) || fid <= 0) {
            return await interaction.reply({
                content: lang.giftCode.giftSetTestId.errors.invalidTestId,
                ephemeral: true
            });
        }

        const container1 = [
            new ContainerBuilder()
                .setAccentColor(0x3498db) // blue
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.giftCode.giftSetTestId.content.processingMessage}`
                    )
                )
        ];

        const content1 = updateComponentsV2AfterSeparator(interaction, container1);

        await interaction.deferUpdate({ flags: MessageFlags.IsComponentsV2 });

        await interaction.editReply({
            components: content1,
            flags: MessageFlags.IsComponentsV2
        });

        // Validate the player ID
        const playerData = await fetchPlayerFromAPI(fid);

        if (!playerData) {
            const containerError = [
                new ContainerBuilder()
                    .setAccentColor(0xe74c3c) // red
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `${lang.giftCode.giftSetTestId.errors.invalidTestId}`
                        )
                    )
            ];

            const contentError = updateComponentsV2AfterSeparator(interaction, containerError);

            return await interaction.editReply({
                components: contentError,
                flags: MessageFlags.IsComponentsV2
            });
        }

        // Valid player ID - update the database
        testIdQueries.updateUserTestId(fid, interaction.user.id);

        // Log the update
        systemLogQueries.addLog(
            'test_id_update',
            `Test ID updated to: ${fid}`,
            JSON.stringify({
                new_fid: fid,
                player_nickname: playerData.nickname,
                updated_by: interaction.user.id,
                updated_by_tag: interaction.user.tag
            })
        );

        const container2 = [
            new ContainerBuilder()
                .setAccentColor(0x2ecc71) // green
                .addSectionComponents(
                    new SectionBuilder()
                        .setThumbnailAccessory(
                            new ThumbnailBuilder()
                                .setURL(playerData.avatar_image || "https://gof-formal-avatar.akamaized.net//avatar-dev//2023//07//17//1001.png")
                        )
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent(

                                `${lang.giftCode.giftSetTestId.content.title}` +
                                `\n${lang.giftCode.giftSetTestId.content.description}` +
                                `\n${lang.giftCode.giftSetTestId.content.playerInfoField.name}` +
                                `\n${lang.giftCode.giftSetTestId.content.playerInfoField.value}`
                                    .replace('{playerId}', fid)
                                    .replace('{nickname}', playerData.nickname)
                                    .replace('{furnace}', getFurnaceReadable(playerData.stove_lv, lang))
                                    .replace('{state}', playerData.kid)
                            )
                        )
                )
        ];

        const content2 = updateComponentsV2AfterSeparator(interaction, container2);

        await interaction.editReply({
            components: content2,
            flags: MessageFlags.IsComponentsV2
        });


    } catch (error) {
        await sendError(interaction, lang, error, 'handleTestIdModal');
    }
}

/**
 * Gets the current test ID to use for validation
 * Tries user-set ID first, falls back to default
 * @returns {number} FID to use for testing
 */
function getTestIdForValidation() {
    try {
        const userTestId = testIdQueries.getUserTestId();

        // If user has set a test ID, use it
        if (userTestId && userTestId.set_by) {
            return userTestId.fid;
        }

        // Otherwise use default
        const defaultTestId = testIdQueries.getDefaultTestId();
        return defaultTestId.fid;
    } catch (error) {
        sendError(null, null, error, 'getTestIdForValidation', false);
        // Return hard-coded default as last resort
        return 40393986;
    }
}

module.exports = {
    createSetTestIdButton,
    handleSetTestIdButton,
    handleTestIdModal,
    getTestIdForValidation
};
