const {
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    LabelBuilder,
    SectionBuilder,
    ThumbnailBuilder,
    EmbedBuilder
} = require('discord.js');
const { adminQueries, adminLogQueries, systemLogQueries } = require('../../utility/database');
const { formatLogs } = require('../../utility/AdminLogs');
const languages = require('../../../i18n');
const { PERMISSIONS, getPermissionDescriptions } = require('./permissions');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../../Pagination/universalPagination');
const { getAdminLang, assertUserMatches, sendError, hasPermission, updateComponentsV2AfterSeparator } = require('../../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../../utility/emojis');
const { adminUsernameCache } = require('../../utility/adminUsernameCache');

/**
 * Creates a view admin button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object
 * @returns {ButtonBuilder} The view admin button
 */
function createViewAdminButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`view_admin_${userId}`)
        .setLabel(lang.settings.adminManagement.buttons.viewAdmin)
        .setStyle(ButtonStyle.Primary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1049'));
}

/**
 * Handles view admin button interaction - shows admin select menu with pagination
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleViewAdminButton(interaction) {
    // Get user's language preference
    const { lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[2]; // view_admin_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Get all admins for the dropdown (limit to 24 for initial display)
        let allAdmins;
        allAdmins = await adminQueries.getAllAdmins();

        if (allAdmins.length === 0) {
            return await interaction.reply({
                content: lang.settings.viewAdmins.error.noAdmins,
                ephemeral: true
            });
        }

        // Show first page
        await showViewAdminPage(interaction, allAdmins, 0, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleViewAdminButton');
    }
}

/**
 * Shows a page of admins for viewing with pagination
 * @param {import('discord.js').ButtonInteraction|import('discord.js').StringSelectMenuInteraction} interaction 
 * @param {Array} allAdmins - Array of all admins
 * @param {number} page - Current page (0-indexed)
 * @param {Object} lang - Language object
 * @param {string} selectedAdminId - Currently selected admin ID (optional)
 */
async function showViewAdminPage(interaction, allAdmins, page = 0, lang = {}, selectedAdminId = null) {
    const adminsPerPage = 24;
    const totalPages = Math.ceil(allAdmins.length / adminsPerPage);
    const startIndex = page * adminsPerPage;
    const endIndex = Math.min(startIndex + adminsPerPage, allAdmins.length);
    const pageAdmins = allAdmins.slice(startIndex, endIndex);

    // Create admin select menu
    const adminSelect = new StringSelectMenuBuilder()
        .setCustomId(`select_admin_view_${interaction.user.id}_${page}`)
        .setPlaceholder(lang.settings.viewAdmins.selectMenu.placeholder)
        .setMinValues(1)
        .setMaxValues(1);

    // Add admin options
    for (const admin of pageAdmins) {
        try {
            // Try to fetch user to get their tag
            const user = await interaction.client.users.fetch(admin.user_id);
            const status = admin.is_owner ? getComponentEmoji(getEmojiMapForAdmin(admin.user_id), '1023') : getComponentEmoji(getEmojiMapForAdmin(admin.user_id), '1026');

            adminSelect.addOptions(
                new StringSelectMenuOptionBuilder()
                    .setLabel(user.tag)
                    .setValue(admin.user_id)
                    .setEmoji(status)
                    .setDefault(selectedAdminId === admin.user_id)
            );
        } catch (fetchError) {
            await sendError(interaction, lang, fetchError, 'showViewAdminPage', false);

            adminSelect.addOptions(
                new StringSelectMenuOptionBuilder()
                    .setLabel(`(${admin.user_id})`)
                    .setValue(admin.user_id)
                    .setEmoji(getComponentEmoji(getEmojiMapForAdmin(admin.user_id), '1050'))
                    .setDefault(selectedAdminId === admin.user_id)
            );
        }
    }
    const actionRow = [];
    const selectRow = new ActionRowBuilder().addComponents(adminSelect);
    const actionButtonRow = new ActionRowBuilder();

    // Create pagination buttons
    const paginationRow = createUniversalPaginationButtons({
        feature: 'view_admin',
        userId: interaction.user.id,
        currentPage: page,
        totalPages: totalPages,
        lang: lang,
        contextData: [selectedAdminId || 'none']
    });

    if (paginationRow) {
        actionRow.push(paginationRow);
    }

    // Get selected admin details if one is selected
    let adminDetailsText = '';
    if (selectedAdminId) {
        const selectedAdmin = allAdmins.find(admin => admin.user_id === selectedAdminId);
        if (selectedAdmin) {
            adminDetailsText = await getSelectedAdminDetails(selectedAdmin, interaction.client, lang);

            // Add "View Full Logs" button
            actionButtonRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`view_full_logs_${interaction.user.id}_${selectedAdminId}_0`)
                    .setLabel(lang.settings.viewAdmins.buttons.viewLogs)
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji(getComponentEmoji(getEmojiMapForAdmin(selectedAdminId), '1021'))
            );
        }
    }

    // Only add actionButtonRow if it has components
    if (actionButtonRow.components.length > 0) {
        actionRow.push(actionButtonRow);
    }
    actionRow.push(selectRow);

    const containerBuilder = new ContainerBuilder()
        .setAccentColor(0x2ecc71)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `${lang.settings.viewAdmins.content.title.base}\n` +
                `${lang.settings.viewAdmins.content.description}`
            )
        );

    // Add admin details with separator if an admin is selected
    if (adminDetailsText) {
        containerBuilder
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(adminDetailsText)
            );
    }

    // Add pagination footer and action rows
    containerBuilder
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `${lang.pagination.text.pageInfo
                    .replace('{current}', (page + 1).toString())
                    .replace('{total}', totalPages.toString())}`
            )
        )
        .addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        )
        .addActionRowComponents(...actionRow);

    const components = [containerBuilder];

    const newSection = updateComponentsV2AfterSeparator(interaction, components);

    // Update the message
    await interaction.update({
        components: newSection,
        flags: MessageFlags.IsComponentsV2
    });
}

/**
 * Gets selected admin details as formatted text
 * @param {Object} adminData - Admin data from database
 * @param {import('discord.js').Client} client - Discord client
 * @param {Object} lang - Language object
 * @returns {Promise<string>} Formatted admin details text
 */
async function getSelectedAdminDetails(adminData, client, lang) {
    try {
        // Fetch user details
        let user;
        try {
            user = await client.users.fetch(adminData.user_id);
        } catch (fetchError) {
            systemLogQueries.addLog(
                'error',
                `Error fetching Discord user in admin details: ${fetchError.message}`,
                JSON.stringify({
                    user_id: adminData.user_id,
                    error: fetchError.message,
                    function: 'getSelectedAdminDetails'
                })
            );
            user = { tag: `Unknown User (${adminData.user_id})` };
        }

        // Get permission descriptions
        const permissionDescriptions = getPermissionDescriptions(lang, adminData.user_id);
        const userPermissions = [];

        Object.entries(PERMISSIONS).forEach(([key, value]) => {
            if (adminData.permissions & value) {
                const desc = permissionDescriptions[value];
                userPermissions.push(`${desc.emoji_display} ${desc.name}`);
            }
        });

        const permissionsList = userPermissions.length > 0 ?
            userPermissions.join('\n') :
            lang.settings.viewAdmins.content.noPermissions;

        // Get recent admin logs (last 5 actions)
        let recentActivity = lang.settings.viewAdmins.content.noRecentActivity;

        try {
            const formattedLogs = formatLogs(lang, adminData.user_id, { limit: 5 });
            if (formattedLogs.length > 0) {
                recentActivity = formattedLogs.map(log => {
                    return `  - ${log.message} - ${log.timestamp}`;
                }).join('\n');
            }
        } catch (logError) {
            recentActivity = lang.common.error;
        }

        return `${lang.settings.viewAdmins.content.adminInfoField.name}\n${lang.settings.viewAdmins.content.adminInfoField.value.replace('{username}', user.tag).replace('{userId}', adminData.user_id)}\n` +
            `${lang.settings.viewAdmins.content.permissionsField.name}\n${lang.settings.viewAdmins.content.permissionsField.value.replace('{permissionsList}', permissionsList)}\n` +
            `${lang.settings.viewAdmins.content.recentActivityField.name}\n${lang.settings.viewAdmins.content.recentActivityField.value.replace('{activityList}', recentActivity)}`;

    } catch (error) {
        return '';
    }
}

/**
 * Handles admin selection for viewing details
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleViewAdminSelection(interaction) {
    // Get user's language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID and page from custom ID
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[3]; // select_admin_view_userId_page
        const currentPage = parseInt(customIdParts[4]);

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasAccess = hasPermission(adminData);
        if (!hasAccess) {
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
                content: lang.settings.viewAdmins.error.userNotAdmin,
                ephemeral: true
            });
        }

        // Get all admins and show the page with selected admin
        const allAdmins = adminQueries.getAllAdmins();
        await showViewAdminPage(interaction, allAdmins, currentPage, lang, selectedAdminId);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleViewAdminSelection');
    }
}

/**
 * Handles view full logs button interaction
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleViewFullLogsButton(interaction) {
    // Get user's language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID and admin ID from custom ID: view_full_logs_userId_adminId_page
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[3]; // view_full_logs_userId_adminId_page
        const adminId = customIdParts[4];
        const page = parseInt(customIdParts[5]) || 0;

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Show full logs page
        await showFullLogsPage(interaction, adminId, page, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleViewFullLogsButton');
    }
}

/**
 * Shows paginated full logs for an admin
 * @param {import('discord.js').ButtonInteraction} interaction 
 * @param {string} adminId - ID of the admin whose logs to show
 * @param {number} page - Current page (0-indexed)
 * @param {object} lang - User's language preference
 * @param {boolean} isUpdate - Whether to update existing message (true) or reply (false)
 */
async function showFullLogsPage(interaction, adminId, page = 0, lang = {}, isUpdate = false) {
    // Get paginated logs
    const logsPerPage = 10;
    const offset = page * logsPerPage;
    const formattedLogs = formatLogs(lang, adminId, { limit: logsPerPage, offset: offset });
    const totalLogs = adminLogQueries.getAdminLogsCount(adminId);
    const totalPages = Math.ceil(totalLogs / logsPerPage);

    try {
        // Get admin data for header info
        const adminData = adminQueries.getAdmin(adminId);
        if (!adminData) {
            return await interaction.reply({
                content: lang.settings.viewAdmins.error.userNotAdmin,
                ephemeral: true
            });
        }

        // Fetch user details
        let user;
        try {
            user = await interaction.client.users.fetch(adminId);
        } catch (fetchError) {
            await sendError(interaction, lang, fetchError, 'showFullLogsPage', false);

            user = { tag: `Unknown User (${adminId})` };
        }

        // Create logs embed
        const logsEmbed = new EmbedBuilder()
            .setTitle(lang.settings.viewAdmins.content.title.fullLogs.replace('{user}', user.tag))
            .setColor(0x3498db)
            .setThumbnail(user.displayAvatarURL ? user.displayAvatarURL() : null)
            .setFooter({
                text: lang.pagination.text.pageInfo
                    .replace('{current}', (page + 1).toString())
                    .replace('{total}', totalPages.toString()),
                iconURL: interaction.user.displayAvatarURL()
            });

        // Add logs to embed
        if (formattedLogs.length > 0) {
            const logEntries = formattedLogs.map((log, index) => {
                const logNumber = offset + index + 1;
                return `${logNumber}. ${log.timestamp}\n  - ${log.message}`;
            }).join('\n');

            logsEmbed.addFields([{
                name: lang.settings.viewAdmins.content.actionLogsField.name,
                value: lang.settings.viewAdmins.content.actionLogsField.value.replace('{logsList}', logEntries.length > 1024 ? logEntries.substring(0, 1021) + '...' : logEntries)
            }]);
        } else {
            logsEmbed.addFields([{
                name: lang.settings.viewAdmins.content.actionLogsField.name,
                value: lang.settings.viewAdmins.content.noLogsFound
            }]);
        }

        const components = [];
        // Add pagination buttons if more than 1 page (always show, disabled when needed)
        const paginationRow = createUniversalPaginationButtons({
            feature: 'view_full_logs',
            userId: interaction.user.id,
            currentPage: page,
            totalPages: totalPages,
            lang: lang,
            contextData: [adminId]
        });

        if (paginationRow) {
            components.push(paginationRow);
        }

        // Use update for pagination, reply for initial display
        if (isUpdate) {
            await interaction.update({
                embeds: [logsEmbed],
                components: components
            });
        } else {
            await interaction.reply({
                embeds: [logsEmbed],
                components: components,
                ephemeral: true
            });
        }

    } catch (error) {
        await sendError(interaction, lang, error, 'showFullLogsPage');
    }
}

/**
 * Handles pagination for view admin
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleViewAdminPagination(interaction) {
    // Get user's language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Parse custom ID
        const parsed = parsePaginationCustomId(interaction.customId, 1);
        const { userId: expectedUserId, newPage, contextData } = parsed;
        const selectedAdminId = contextData[0] === 'none' ? null : contextData[0];

        // Check if the interaction user matches the expected user
        if (interaction.user.id !== expectedUserId) {
            return await interaction.reply({
                content: lang.common.notForYou,
                ephemeral: true
            });
        }

        // Check permissions
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get all admins and show the requested page
        const allAdmins = adminQueries.getAllAdmins();
        await showViewAdminPage(interaction, allAdmins, newPage, lang, selectedAdminId);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleViewAdminPagination');
    }
}

/**
 * Handles pagination for view full logs
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleViewFullLogsPagination(interaction) {
    // Get user's language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Parse custom ID
        const parsed = parsePaginationCustomId(interaction.customId, 1);
        const { userId: expectedUserId, newPage, contextData } = parsed;
        const adminId = contextData[0];

        // Check if the interaction user matches the expected user
        if (interaction.user.id !== expectedUserId) {
            return await interaction.reply({
                content: lang.common.notForYou,
                ephemeral: true
            });
        }

        // Check permissions
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Show the requested logs page
        await showFullLogsPage(interaction, adminId, newPage, lang, true);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleViewFullLogsPagination');
    }
}

module.exports = {
    createViewAdminButton,
    handleViewAdminButton,
    showViewAdminPage,
    handleViewAdminSelection,
    handleViewFullLogsButton,
    showFullLogsPage,
    handleViewAdminPagination,
    handleViewFullLogsPagination
};
