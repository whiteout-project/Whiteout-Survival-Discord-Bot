const { ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
const { allianceQueries, playerQueries, adminQueries } = require('../utility/database');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { getAdminLang, assertUserMatches, sendError, hasPermission, updateComponentsV2AfterSeparator, formatRefreshInterval } = require('../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('./../utility/emojis');


/**
 * Creates a view alliances button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The view alliances button
 */
function createViewAlliancesButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`view_alliances_${userId}`)
        .setLabel(lang.alliance.mainPage.buttons.viewAlliances)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1049'));
}

/**
 * Handles the view alliances button interaction
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleViewAlliancesButton(interaction) {
    // Get admin data for language
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Check permissions
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        const hasAccess = hasPermission(adminData, PERMISSIONS.ALLIANCE_MANAGEMENT, PERMISSIONS.FULL_ACCESS);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get alliances based on permissions
        let alliances;
        if (hasFullAccess) {
            // Owner and full access admins can see all alliances
            alliances = allianceQueries.getAllAlliances();
        } else {
            // Regular admins can only see alliances they created
            const assignedAllianceIds = JSON.parse(adminData.alliances || '[]');
            if (assignedAllianceIds.length === 0) {
                return await interaction.reply({
                    content: lang.alliance.viewAlliances.errors.noAlliances,
                    ephemeral: true
                });
            }

            // Get only assigned alliances
            alliances = allianceQueries.getAllAlliances().filter(alliance =>
                assignedAllianceIds.includes(alliance.id)
            );
        }

        if (!alliances || alliances.length === 0) {
            await interaction.reply({
                content: lang.alliance.viewAlliances.errors.noAlliances,
                ephemeral: true
            });
            return;
        }

        // Sort by priority (ascending - lower number = higher priority)
        alliances.sort((a, b) => a.priority - b.priority);

        // Show first page with no selection
        await showAlliancesPage(interaction, alliances, 0, lang, null);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleViewAlliancesButton');
    }
}

/**
 * Handles pagination for view alliances
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleViewAlliancesPagination(interaction) {
    // Get admin data for language
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        // Extract page and selected alliance from custom ID
        const { userId: expectedUserId, newPage, contextData } = parsePaginationCustomId(interaction.customId, 1);
        const selectedAllianceId = contextData[0] === 'none' ? null : contextData[0];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        const hasAccess = hasPermission(adminData, PERMISSIONS.ALLIANCE_MANAGEMENT, PERMISSIONS.FULL_ACCESS);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get alliances based on permissions
        let alliances;
        if (hasFullAccess) {
            // Owner and full access admins can see all alliances
            alliances = allianceQueries.getAllAlliances();
        } else {
            // Regular admins can only see alliances they created
            const assignedAllianceIds = JSON.parse(adminData.alliances || '[]');
            if (assignedAllianceIds.length === 0) {
                return await interaction.reply({
                    content: lang.alliance.viewAlliances.errors.noAlliances,
                    ephemeral: true
                });
            }

            // Get only assigned alliances
            alliances = allianceQueries.getAllAlliances().filter(alliance =>
                assignedAllianceIds.includes(alliance.id)
            );
        }

        if (!alliances || alliances.length === 0) {
            await interaction.reply({
                content: lang.alliance.viewAlliances.errors.noAlliances,
                ephemeral: true
            });
            return;
        }

        // Sort by priority (ascending - lower number = higher priority)
        alliances.sort((a, b) => a.priority - b.priority);

        // Show the new page with preserved selection
        await showAlliancesPage(interaction, alliances, newPage, lang, selectedAllianceId);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleViewAlliancesPagination');
    }
}

/**
 * Shows a specific page of alliances with select menu
 * @param {import('discord.js').ButtonInteraction|import('discord.js').StringSelectMenuInteraction} interaction 
 * @param {Array} alliances - Array of all alliances
 * @param {number} page - Current page (0-based)
 * @param {Object} lang - Language object
 * @param {number|null} selectedAllianceId - ID of currently selected alliance to display details
 */
async function showAlliancesPage(interaction, alliances, page, lang, selectedAllianceId = null) {
    const itemsPerPage = 24;
    const totalPages = Math.ceil(alliances.length / itemsPerPage);

    // Ensure page is within bounds
    page = Math.max(0, Math.min(page, totalPages - 1));

    const start = page * itemsPerPage;
    const end = start + itemsPerPage;
    const currentAlliances = alliances.slice(start, end);

    // Create select menu with alliances
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`select_view_alliance_${interaction.user.id}_${page}`)
        .setPlaceholder(lang.alliance.viewAlliances.selectMenu.selectAlliance.placeholder)
        .setMinValues(1)
        .setMaxValues(1);

    // Add alliance options
    for (const alliance of currentAlliances) {
        const players = await playerQueries.getPlayersByAlliance(alliance.id);
        const playerCount = players ? players.length : 0;

        selectMenu.addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(alliance.name)
                .setValue(alliance.id.toString())
                .setDescription(lang.alliance.viewAlliances.selectMenu.selectAlliance.description
                    .replace('{priority}', alliance.priority)
                    .replace('{playerCount}', playerCount)
                )
                .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1001'))
        );
    }

    const selectRow = new ActionRowBuilder().addComponents(selectMenu);

    const paginationRow = createUniversalPaginationButtons({
        feature: 'view_alliances',
        userId: interaction.user.id,
        currentPage: page,
        totalPages: totalPages,
        lang: lang,
        contextData: [selectedAllianceId || 'none']
    });

    // Build the main selection container
    const container = [
        new ContainerBuilder()
            .setAccentColor(0x3498db)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(lang.alliance.viewAlliances.content.title),
                new TextDisplayBuilder().setContent(lang.alliance.viewAlliances.content.description)
            )
    ];

    // If an alliance is selected, add its details first (above pagination and select menu)
    if (selectedAllianceId && selectedAllianceId !== 'none') {
        const selectedAlliance = alliances.find(a => a.id === parseInt(selectedAllianceId));
        if (selectedAlliance) {
            const players = await playerQueries.getPlayersByAlliance(selectedAlliance.id);
            const playerCount = players ? players.length : 0;

            // Get creator info
            let createdByText = 'Unknown';
            if (selectedAlliance.created_by) {
                try {
                    // created_by stores Discord user_id, not admin table's internal id
                    const creatorAdminData = adminQueries.getAdmin(selectedAlliance.created_by);
                    if (creatorAdminData && creatorAdminData.user_id) {
                        createdByText = `<@${selectedAlliance.created_by}>`;
                    } else {
                        createdByText = `Unknown (User ID: ${selectedAlliance.created_by})`;
                    }
                } catch (error) {
                    createdByText = `Unknown (User ID: ${selectedAlliance.created_by})`;
                }
            }

            // Get channel info
            let channelText = lang.alliance.viewAlliances.content.channelNotFound;
            if (selectedAlliance.channel_id) {
                try {
                    const channel = await interaction.client.channels.fetch(selectedAlliance.channel_id);
                    channelText = `<#${channel.id}>`;
                } catch (error) {
                    channelText = `${lang.alliance.viewAlliances.content.channelNotFound} (${selectedAlliance.channel_id})`;
                }
            }

            // Format refresh rate
            const refreshText = formatRefreshInterval(selectedAlliance.interval, lang);

            // Add separator and alliance details
            container[0]
                .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.alliance.viewAlliances.content.allianceDetailsField.name.replace('{allianceName}', selectedAlliance.name)}\n` +
                        `${lang.alliance.viewAlliances.content.allianceDetailsField.value
                            .replace('{priority}', selectedAlliance.priority)
                            .replace('{playerCount}', playerCount)
                            .replace('{refreshRate}', refreshText)
                            .replace('{channel}', channelText)
                            .replace('{createdBy}', createdByText)}`
                    ),
                );
        }
    }

    // Add pagination info, separator, and action rows (pagination + select menu) at the bottom
    container[0]
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent((lang.pagination.text.pageInfo)
                .replace('{current}', (page + 1).toString())
                .replace('{total}', totalPages.toString()))
        )
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addActionRowComponents(selectRow);

    if (paginationRow) {
        container[0].addActionRowComponents(paginationRow);
    }

    const content = updateComponentsV2AfterSeparator(interaction, container);

    await interaction.update({
        components: content,
        flags: MessageFlags.IsComponentsV2
    });
}

/**
 * Handles alliance selection from the select menu
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleViewAllianceSelection(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID and page from custom ID
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[3]; // select_view_alliance_userId_page
        const currentPage = parseInt(customIdParts[4]);

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Get selected alliance ID
        const selectedAllianceId = interaction.values[0];

        // Check permissions and filter alliances
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

        // Get alliances based on permissions
        let alliances;
        if (hasFullAccess) {
            // Owner and full access admins can see all alliances
            alliances = allianceQueries.getAllAlliances();
        } else {
            // Regular admins can only see alliances they created
            const assignedAllianceIds = JSON.parse(adminData.alliances || '[]');
            alliances = allianceQueries.getAllAlliances().filter(alliance =>
                assignedAllianceIds.includes(alliance.id)
            );
        }

        alliances.sort((a, b) => a.priority - b.priority);

        // Show the same page with the selected alliance details
        await showAlliancesPage(interaction, alliances, currentPage, lang, selectedAllianceId);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleViewAllianceSelection');
    }
}

module.exports = {
    createViewAlliancesButton,
    handleViewAlliancesButton,
    handleViewAlliancesPagination,
    handleViewAllianceSelection
};
