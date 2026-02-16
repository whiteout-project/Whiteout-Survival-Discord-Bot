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
const { adminQueries, adminLogQueries, systemLogQueries } = require('../../utility/database');
const { LOG_CODES } = require('../../utility/AdminLogs');
const { PERMISSIONS, getPermissionDescriptions } = require('./permissions');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../../Pagination/universalPagination');
const { getAdminLang, assertUserMatches, sendError, updateComponentsV2AfterSeparator } = require('../../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../../utility/emojis');
const { adminUsernameCache } = require('../../utility/adminUsernameCache');

/**
 * Creates an edit admin button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object
 * @returns {ButtonBuilder} The edit admin button
 */
function createEditAdminButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`edit_admin_${userId}`)
        .setLabel(lang.settings.adminManagement.buttons.assignPermissions)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1008'));
}

/**
 * Handles edit admin permissions button interaction - shows admin select menu with pagination
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleEditAdminButton(interaction) {
    // Get user's language preference for error message
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[2]; // edit_admin_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!adminData || !adminData.is_owner) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get all admins (excluding the owner)
        const allAdmins = adminQueries.getAllAdmins().filter(admin =>
            admin.user_id !== interaction.user.id && !admin.is_owner
        );

        if (allAdmins.length === 0) {
            return await interaction.reply({
                content: lang.settings.assignAdmin.error.noAdmins,
                ephemeral: true
            });
        }

        // Show first page
        await showEditAdminPage(interaction, allAdmins, 0, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleEditAdminButton');
    }
}

/**
 * Shows a page of admins for permission editing with pagination
 * @param {import('discord.js').ButtonInteraction|import('discord.js').StringSelectMenuInteraction} interaction 
 * @param {Array} allAdmins - Array of all editable admins
 * @param {number} page - Current page (0-indexed)
 * @param {Object} lang - Language object
 */
async function showEditAdminPage(interaction, allAdmins, page = 0, lang) {
    const adminsPerPage = 20;
    const totalPages = Math.ceil(allAdmins.length / adminsPerPage);
    const startIndex = page * adminsPerPage;
    const endIndex = Math.min(startIndex + adminsPerPage, allAdmins.length);
    const pageAdmins = allAdmins.slice(startIndex, endIndex);

    // Create admin select menu
    const adminSelect = new StringSelectMenuBuilder()
        .setCustomId(`select_admin_edit_${interaction.user.id}_${page}`)
        .setPlaceholder(lang.settings.assignAdmin.selectMenu.adminSelect.placeholder)
        .setMinValues(1)
        .setMaxValues(1);

    // Add admin options
    for (const admin of pageAdmins) {
        // Get user tag from cache
        const userTag = adminUsernameCache.getTag(admin.user_id);

        // Get current permissions (should be integer)
        const currentPermissions = admin.permissions || 0;

        // Get current permission names using localized descriptions
        const permissionDescriptions = getPermissionDescriptions(lang, interaction.user.id);
        const permissionNames = [];
        Object.values(PERMISSIONS).forEach((value) => {
            if (currentPermissions & value) {
                permissionNames.push(permissionDescriptions[value].name);
            }
        });

        const permissionText = permissionNames.length > 0 ? permissionNames.join(', ') : lang.settings.assignAdmin.content.noPermissions;

        adminSelect.addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(userTag)
                .setValue(admin.user_id)
                .setDescription(permissionText.length > 100 ? permissionText.substring(0, 97) + '...' : permissionText)
                .setEmoji(getComponentEmoji(getEmojiMapForAdmin(admin.user_id), '1026'))
        );
    }

    const actionRow = [new ActionRowBuilder().addComponents(adminSelect)];
    const paginationRow = createUniversalPaginationButtons({
        feature: 'edit_admin',
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
            .setAccentColor(0x3498db)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.settings.assignAdmin.content.title.base}\n` +
                    `${lang.settings.assignAdmin.content.description.base}\n` +
                    `${lang.pagination.text.pageInfo
                        .replace('{current}', (page + 1).toString())
                        .replace('{total}', totalPages.toString())}`
                )
            ).addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            ).addActionRowComponents(
                ...actionRow
            )
    ];

    const newSection = updateComponentsV2AfterSeparator(interaction, components);

    // Send or update the message
    await interaction.update({
        components: newSection,
        flags: MessageFlags.IsComponentsV2,
    });
}

/**
 * Handles admin selection for editing permissions - shows permission select menu
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleEditAdminSelection(interaction) {
    // Get user's language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID and page from custom ID
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[3]; // select_admin_edit_userId_page

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!adminData || !adminData.is_owner) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get selected admin ID
        const selectedAdminId = interaction.values[0];

        // Verify selected user is an admin
        const selectedAdminData = adminQueries.getAdmin(selectedAdminId);
        if (!selectedAdminData) {
            return await interaction.reply({
                content: lang.settings.assignAdmin.error.userNotAdmin
            });
        }

        // Try to fetch the selected user
        let selectedUser;
        try {
            selectedUser = await interaction.client.users.fetch(selectedAdminId);
        } catch (fetchError) {
            selectedUser = { tag: `Unknown User (${selectedAdminId})` };
        }

        // Get current permissions (should be integer)
        const currentPermissions = selectedAdminData.permissions || 0;

        // Get localized permission descriptions
        const permissionDescriptions = getPermissionDescriptions(lang, interaction.user.id);

        const permissionFields = Object.values(permissionDescriptions).map(desc =>
            `- ${desc.emoji_display} **${desc.name}**\n  - ${desc.description}`
        ).join('\n');

        // Create permission select menu (multi-select)
        const permissionSelect = new StringSelectMenuBuilder()
            .setCustomId(`select_permissions_${interaction.user.id}_${selectedAdminId}`)
            .setPlaceholder(lang.settings.assignAdmin.selectMenu.permissionSelect.placeholder)
            .setMinValues(0)
            .setMaxValues(Object.keys(permissionDescriptions).length);

        // Add permission options
        Object.entries(permissionDescriptions).forEach(([bit, desc]) => {
            const bitValue = parseInt(bit);
            const isCurrentlySelected = (currentPermissions & bitValue) !== 0;

            permissionSelect.addOptions(
                new StringSelectMenuOptionBuilder()
                    .setLabel(desc.name)
                    .setValue(bit)
                    .setDescription(desc.description)
                    .setEmoji(desc.emoji)
                    .setDefault(isCurrentlySelected)
            );
        });

        const permissionActionRow = new ActionRowBuilder().addComponents(permissionSelect);

        const components = [
            new ContainerBuilder()
                .setAccentColor(0x9b59b6)
                .addSectionComponents(
                    new SectionBuilder()
                        .setThumbnailAccessory(
                            new ThumbnailBuilder()
                                .setURL(selectedUser.displayAvatarURL ? selectedUser.displayAvatarURL() : null)
                        )
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent(
                                `${lang.settings.assignAdmin.content.title.edit}\n` +
                                `${lang.settings.assignAdmin.content.description.selectPermissions.replace('{admin}', selectedUser.tag)}\n` +
                                `${lang.settings.assignAdmin.content.availablePermissionsField.name}\n` +
                                lang.settings.assignAdmin.content.availablePermissionsField.value.replace('{permissionsList}', permissionFields)
                            )
                        )
                ).addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                ).addActionRowComponents(
                    permissionActionRow
                )
        ];

        const newSection = updateComponentsV2AfterSeparator(interaction, components);

        // Update the message with permission selection
        await interaction.update({
            components: newSection,
            flags: MessageFlags.IsComponentsV2,
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleEditAdminSelection');
    }
}

/**
 * Handles permission selection for admin
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handlePermissionSelection(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID and admin ID from custom ID
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[2]; // select_permissions_userId_adminId
        const adminToEditId = customIdParts[3];

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!adminData || !adminData.is_owner) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Calculate new permissions from selection
        let newPermissions = 0;
        interaction.values.forEach(bitValue => {
            newPermissions |= parseInt(bitValue);
        });

        // Try to fetch the admin to edit
        let adminToEdit;
        try {
            adminToEdit = await interaction.client.users.fetch(adminToEditId);
        } catch (fetchError) {
            adminToEdit = { tag: `Unknown User (${adminToEditId})` };
        }

        // Update admin permissions in database (store as integer only)
        try {
            // Get old permissions for logging
            const oldAdminData = adminQueries.getAdmin(adminToEditId);
            const oldPermissions = oldAdminData?.permissions || 0;

            adminQueries.updateAdminPermissions(newPermissions, adminToEditId);

            // Get selected permission names using localized descriptions
            const permissionDescriptions = getPermissionDescriptions(lang, interaction.user.id);
            const selectedPermissions = [];
            Object.values(PERMISSIONS).forEach((value) => {
                if (newPermissions & value) {
                    selectedPermissions.push(permissionDescriptions[value].name);
                }
            });

            // Log admin permission update
            adminLogQueries.addLog(
                interaction.user.id,
                LOG_CODES.SETTINGS.PERMISSIONS_UPDATED,
                JSON.stringify({
                    username: adminToEdit.tag,
                    userId: adminToEditId,
                    oldPermissions: oldPermissions,
                    newPermissions: newPermissions,
                    permissionsGranted: selectedPermissions.join(', ')
                })
            );

            const components = [
                new ContainerBuilder()
                    .setAccentColor(0x57F287)
                    .addSectionComponents(
                        new SectionBuilder()
                            .setThumbnailAccessory(
                                new ThumbnailBuilder()
                                    .setURL(adminToEdit.displayAvatarURL())
                            )
                            .addTextDisplayComponents(
                                new TextDisplayBuilder().setContent(
                                    `${lang.settings.assignAdmin.content.title.success}\n` +
                                    `${lang.settings.assignAdmin.content.description.success.replace('{admin}', adminToEdit.tag)}\n` +
                                    `${lang.settings.assignAdmin.content.updatedPermissionsField.name}\n` +
                                    (selectedPermissions.length > 0 ?
                                        lang.settings.assignAdmin.content.updatedPermissionsField.value
                                            .replace('{permissionsList}', selectedPermissions.map(perm => `  - ${perm}`).join('\n'))
                                        : lang.settings.assignAdmin.content.noPermissions)
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
            await sendError(interaction, lang, dbError, 'handlePermissionSelection_dbError');
        }

    } catch (error) {
        await sendError(interaction, lang, error, 'handlePermissionSelection');
    }
}

/**
 * Handles pagination for edit admin
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleEditAdminPagination(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Parse pagination data
        const { userId: expectedUserId, newPage } = parsePaginationCustomId(interaction.customId, 0);

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!adminData || !adminData.is_owner) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get all admins (excluding the owner)
        const allAdmins = adminQueries.getAllAdmins().filter(admin =>
            admin.user_id !== interaction.user.id && !admin.is_owner
        );

        // Show the requested page
        await showEditAdminPage(interaction, allAdmins, newPage, adminData.language || 'en');

    } catch (error) {
        await sendError(interaction, lang, error, 'handleEditAdminPagination');
    }
}


module.exports = {
    createEditAdminButton,
    handleEditAdminButton,
    showEditAdminPage,
    handleEditAdminSelection,
    handlePermissionSelection,
    handleEditAdminPagination
};
