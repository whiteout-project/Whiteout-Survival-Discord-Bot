const {
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    SectionBuilder,
    ThumbnailBuilder
} = require('discord.js');
const { adminQueries, adminLogQueries } = require('../../utility/database');
const { LOG_CODES } = require('../../utility/AdminLogs');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../../Pagination/universalPagination');
const { getAdminLang, assertUserMatches, sendError, updateComponentsV2AfterSeparator } = require('../../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../../utility/emojis');
const { adminUsernameCache } = require('../../utility/adminUsernameCache');

/**
 * Creates a remove admin button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object
 * @returns {ButtonBuilder} The remove admin button
 */
function createRemoveAdminButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`remove_admin_${userId}`)
        .setLabel(lang.settings.adminManagement.buttons.removeAdmin)
        .setStyle(ButtonStyle.Danger)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1031'));
}

/**
 * Handles remove admin button interaction - shows admin select menu with pagination
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleRemoveAdminButton(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[2]; // remove_admin_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Get all admins (excluding the owner)
        const allAdmins = adminQueries.getAllAdmins().filter(admin =>
            admin.user_id !== interaction.user.id && !admin.is_owner
        );

        if (!adminData || !adminData.is_owner) {
            return await interaction.reply({
                content: lang.common.noPermissions,
                ephemeral: true
            });
        }

        if (allAdmins.length === 0) {
            return await interaction.reply({
                content: lang.settings.removeAdmin.error.noAdmins,
                ephemeral: true
            });
        }

        // Show first page
        await showRemoveAdminPage(interaction, allAdmins, 0, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleRemoveAdminButton');
    }
}

/**
 * Shows a page of admins for removal with pagination
 * @param {import('discord.js').ButtonInteraction|import('discord.js').StringSelectMenuInteraction} interaction 
 * @param {Array} allAdmins - Array of all removable admins
 * @param {number} page - Current page (0-indexed)
 * @param {Object} lang - Language object
 */
async function showRemoveAdminPage(interaction, allAdmins, page = 0, lang) {
    const adminsPerPage = 20;
    const totalPages = Math.ceil(allAdmins.length / adminsPerPage);
    const startIndex = page * adminsPerPage;
    const endIndex = Math.min(startIndex + adminsPerPage, allAdmins.length);
    const pageAdmins = allAdmins.slice(startIndex, endIndex);

    // Create admin select menu
    const adminSelect = new StringSelectMenuBuilder()
        .setCustomId(`select_admin_remove_${interaction.user.id}_${page}`)
        .setPlaceholder(lang.settings.removeAdmin.selectMenu.adminSelect.placeholder)
        .setMinValues(1)
        .setMaxValues(1);

    // Add admin options
    for (const admin of pageAdmins) {
        // Get user tag from cache
        const userTag = adminUsernameCache.getTag(admin.user_id);

        adminSelect.addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(userTag)
                .setValue(admin.user_id)
                .setEmoji(getComponentEmoji(getEmojiMapForAdmin(admin.user_id), '1026'))
        );
    }

    const actionRow = [new ActionRowBuilder().addComponents(adminSelect)];

    const paginationRow = createUniversalPaginationButtons({
        feature: 'remove_admin',
        userId: interaction.user.id,
        currentPage: page,
        totalPages: totalPages,
        lang: lang
    });

    if (paginationRow) {
        actionRow.push(paginationRow);
    }

    const components = [
        new ContainerBuilder()
            .setAccentColor(0xe74c3c) // Red accent
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.settings.removeAdmin.content.title.base}\n` +
                    `${lang.settings.removeAdmin.content.description.base}\n` +
                    `${lang.pagination.text.pageInfo
                        .replace('{current}', (page + 1).toString())
                        .replace('{total}', totalPages.toString())}`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addActionRowComponents(
                ...actionRow
            )
    ];

    const newSection = updateComponentsV2AfterSeparator(interaction, components);

    // Send or update the message
    await interaction.update({
        components: newSection,
        flags: MessageFlags.IsComponentsV2
    });
}

/**
 * Handles admin selection for removal - shows confirmation
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleRemoveAdminSelection(interaction) {
    // Get admin language preference
    const { lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID and page from custom ID
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[3]; // select_admin_remove_userId_page

        // Check if the interaction user matches the expected user
        if (interaction.user.id !== expectedUserId) {
            return await interaction.reply({
                content: lang.common.notForYou,
                ephemeral: true
            });
        }

        // Get selected admin ID
        const selectedAdminId = interaction.values[0];

        // Verify selected user is an admin
        const selectedAdminData = adminQueries.getAdmin(selectedAdminId);
        if (!selectedAdminData) {
            return await interaction.update({
                content: lang.settings.removeAdmin.error.userNotAdmin,
                embeds: [],
                components: []
            });
        }

        // Try to fetch the selected user
        let selectedUser;
        try {
            selectedUser = await interaction.client.users.fetch(selectedAdminId);
        } catch (fetchError) {
            selectedUser = { tag: `Unknown User (${selectedAdminId})` };
        }

        // Create confirmation buttons with admin ID in custom ID
        const confirmationRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`confirm_remove_admin_${interaction.user.id}_${selectedAdminId}`)
                    .setLabel(lang.settings.removeAdmin.buttons.confirm)
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji(getComponentEmoji(getEmojiMapForAdmin(selectedAdminId), '1004')),

                new ButtonBuilder()
                    .setCustomId(`cancel_remove_admin_${interaction.user.id}`)
                    .setLabel(lang.settings.removeAdmin.buttons.cancel)
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji(getComponentEmoji(getEmojiMapForAdmin(selectedAdminId), '1051'))
            );

        const components = [
            new ContainerBuilder()
                .setAccentColor(0xf39c12) // Orange accent
                .addSectionComponents(
                    new SectionBuilder()
                        .setThumbnailAccessory(
                            new ThumbnailBuilder()
                                .setURL(selectedUser.displayAvatarURL())
                        )
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent(
                                `${lang.settings.removeAdmin.content.title.confirm}\n` +
                                `${lang.settings.removeAdmin.content.description.confirm.replace('{admin}', selectedUser.tag)}`
                            )
                        )
                ).addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                )
                .addActionRowComponents(
                    confirmationRow
                )
        ];

        const newSection = updateComponentsV2AfterSeparator(interaction, components);

        // Update the message with confirmation
        await interaction.update({
            components: newSection,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleRemoveAdminSelection');
    }
}

/**
 * Handles confirm remove admin button
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleConfirmRemoveAdmin(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID and admin ID from custom ID
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[3]; // confirm_remove_admin_userId_adminId
        const adminToRemoveId = customIdParts[4];

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check if the user has permission to remove the admin
        if (!adminData || !adminData.is_owner) {
            return await interaction.reply({
                content: lang.common.notForYou,
                ephemeral: true
            });
        }

        // Try to fetch the admin to remove
        let adminToRemove;
        try {
            adminToRemove = await interaction.client.users.fetch(adminToRemoveId);
        } catch (fetchError) {
            adminToRemove = { tag: `Unknown User (${adminToRemoveId})` };
        }

        // Remove admin from database
        try {
            adminQueries.deleteAdmin(adminToRemoveId);

            // Remove from username cache
            adminUsernameCache.remove(adminToRemoveId);

            // Log admin removal
            adminLogQueries.addLog(
                interaction.user.id,
                LOG_CODES.SETTINGS.ADMIN_REMOVED,
                JSON.stringify({
                    username: adminToRemove.tag,
                    userId: adminToRemoveId
                })
            );

            const components = [
                new ContainerBuilder()
                    .setAccentColor(0xe74c3c) // Red accent
                    .addSectionComponents(
                        new SectionBuilder()
                            .setThumbnailAccessory(
                                new ThumbnailBuilder()
                                    .setURL(adminToRemove.displayAvatarURL())
                            )
                            .addTextDisplayComponents(
                                new TextDisplayBuilder().setContent(
                                    `${lang.settings.removeAdmin.content.title.success}\n` +
                                    `${lang.settings.removeAdmin.content.description.success.replace('{admin}', adminToRemove.tag)}`
                                )
                            )
                    )
            ];

            const newSection = updateComponentsV2AfterSeparator(interaction, components);

            // Update the message with success
            await interaction.update({
                components: newSection,
                flags: MessageFlags.IsComponentsV2
            });

        } catch (dbError) {
            await sendError(interaction, lang, dbError, 'handleConfirmRemoveAdmin');
        }

    } catch (error) {
        await sendError(interaction, lang, error, 'handleConfirmRemoveAdmin');
    }
}

/**
 * Handles cancel remove admin button
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleCancelRemoveAdmin(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[3]; // cancel_remove_admin_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // check if user has permission
        if (!adminData.is_owner) {
            return await interaction.reply({
                content: lang.common.notForYou,
                ephemeral: true
            });
        }

        const components = [
            new ContainerBuilder()
                .setAccentColor(0xf39c12) // Orange accent
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.settings.removeAdmin.content.title.cancel}\n`
                    )
                )
        ];

        const newSection = updateComponentsV2AfterSeparator(interaction, components);

        // Update the message to show cancellation
        await interaction.update({
            components: newSection,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleCancelRemoveAdmin');
    }
}

/**
 * Handles pagination for remove admin
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleRemoveAdminPagination(interaction) {
    // Get admin language preference
    const { lang } = getAdminLang(interaction.user.id);
    try {
        // Parse pagination data
        const { userId: expectedUserId, newPage } = parsePaginationCustomId(interaction.customId, 0);

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Get all admins (excluding the owner)
        const allAdmins = adminQueries.getAllAdmins().filter(admin =>
            admin.user_id !== interaction.user.id && !admin.is_owner
        );

        // Show the requested page
        await showRemoveAdminPage(interaction, allAdmins, newPage, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleRemoveAdminPagination');
    }
}

module.exports = {
    createRemoveAdminButton,
    handleRemoveAdminButton,
    showRemoveAdminPage,
    handleRemoveAdminSelection,
    handleConfirmRemoveAdmin,
    handleCancelRemoveAdmin,
    handleRemoveAdminPagination
};
