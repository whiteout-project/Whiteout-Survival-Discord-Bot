const {
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    SectionBuilder,
    UserSelectMenuBuilder,
    ThumbnailBuilder
} = require('discord.js');
const { adminQueries, adminLogQueries } = require('../../utility/database');
const { LOG_CODES } = require('../../utility/AdminLogs');
const { getAdminLang, assertUserMatches, sendError, updateComponentsV2AfterSeparator } = require('../../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../../utility/emojis'); const { adminUsernameCache } = require('../../utility/adminUsernameCache');
/**
 * Creates a manage admins button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object
 * @returns {ButtonBuilder} The add admin button
 */
function createAddAdminButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`add_admin_${userId}`)
        .setLabel(lang.settings.adminManagement.buttons.addAdmin)
        .setStyle(ButtonStyle.Success)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1000'));
}

/**
 * Handles add admin button interaction - shows user select menu
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleAddAdminButton(interaction) {
    // Get user's language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[2]; // add_admin_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!adminData || !adminData.is_owner) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Create user select menu
        const userSelect = new UserSelectMenuBuilder()
            .setCustomId(`select_user_add_admin_${interaction.user.id}`)
            .setPlaceholder(lang.settings.addAdmin.selectMenu.selectUser.placeholder)
            .setMinValues(1)
            .setMaxValues(1);

        const actionRow = new ActionRowBuilder().addComponents(userSelect);

        const container = [
            new ContainerBuilder()
                .setAccentColor(0x3498db)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.settings.addAdmin.content.title.base}\n` +
                        `${lang.settings.addAdmin.content.description.base}`
                    )
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                )
                .addActionRowComponents(
                    actionRow
                )
        ];

        const newSection = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: newSection,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleAddAdminButton');
    }
}

/**
 * Handles user selection for adding admin
 * @param {import('discord.js').UserSelectMenuInteraction} interaction 
 */
async function handleAddAdminUserSelection(interaction) {
    // Get user's language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[4]; // select_user_add_admin_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;


        if (!adminData || !adminData.is_owner) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get selected user
        const selectedUserId = interaction.values[0];
        const selectedUser = await interaction.client.users.fetch(selectedUserId);

        // Check if user is already an admin
        const existingAdmin = adminQueries.getAdmin(selectedUserId);
        if (existingAdmin) {
            return await interaction.reply({
                content: lang.settings.addAdmin.errors.userAlreadyAdmin.replace('{selectedUser}', `<@${selectedUserId}>`),
                ephemeral: true
            });
        }

        // Add user to admin table
        try {
            adminQueries.addAdmin(
                selectedUserId,          // user_id
                interaction.user.id,     // added_by
                0,                       // permissions (no permissions = 0)
                '[]',                    // alliances (empty array)
                0,                       // is_owner (false)
                'NA'                     // language set to "NA" for new admins
            );

            // Add to username cache
            await adminUsernameCache.add(selectedUserId);

            // Log admin promotion
            adminLogQueries.addLog(
                interaction.user.id,
                LOG_CODES.SETTINGS.ADMIN_ADDED,
                JSON.stringify({
                    username: selectedUser.tag,
                    userId: selectedUser.id
                })
            );

            const container = [
                new ContainerBuilder()
                    .setAccentColor(0x57F287)
                    .addSectionComponents(
                        new SectionBuilder()
                            .setThumbnailAccessory(
                                new ThumbnailBuilder()
                                    .setURL(selectedUser.displayAvatarURL())
                            )
                            .addTextDisplayComponents(
                                new TextDisplayBuilder().setContent(
                                    `${lang.settings.addAdmin.content.title.success}\n` +
                                    `${lang.settings.addAdmin.content.description.success.replace('{admin}', `<@${selectedUserId}>`)}`
                                )
                            )
                    )
            ];

            const newSection = updateComponentsV2AfterSeparator(interaction, container);

            // Update the message with success
            await interaction.update({
                components: newSection,
                flags: MessageFlags.IsComponentsV2
            });

        } catch (dbError) {
            await sendError(interaction, lang, dbError, 'handleAddAdminUserSelection_dbError');
        }
    } catch (error) {
        await sendError(interaction, lang, error, 'handleAddAdminUserSelection');
    }
}

module.exports = {
    createAddAdminButton,
    handleAddAdminButton,
    handleAddAdminUserSelection
};
