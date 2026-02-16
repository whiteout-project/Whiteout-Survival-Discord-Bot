const {
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize
} = require('discord.js');
const { adminQueries, allianceQueries } = require('../utility/database');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');;
const { getAdminLang, assertUserMatches, sendError, hasPermission, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('./../utility/emojis');
const { adminUsernameCache } = require('../utility/adminUsernameCache');


/**
 * Creates an assign alliance button
 * @param {string} userId - User ID for permission check
 * @param {Object} lang - Language object
 * @returns {ButtonBuilder} The assign alliance button
 */
function createAssignAllianceButton(userId, lang) {
    return new ButtonBuilder()
        .setCustomId(`assign_alliance_${userId}`)
        .setLabel(lang.alliance.mainPage.buttons.assignAlliance)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1020'));
}

/**
 * Handles the assign alliance button click
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleAssignAllianceButton(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[2]; // assign_alliance_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check if user has owner or full access permissions
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get all admins that are not owners and don't have full access
        const allAdmins = adminQueries.getAllAdmins();
        const eligibleAdmins = allAdmins.filter(admin =>
            !admin.is_owner && !(admin.permissions & PERMISSIONS.FULL_ACCESS)
        );

        if (eligibleAdmins.length === 0) {
            return await interaction.reply({
                content: lang.alliance.assignAlliance.errors.noEligible,
                ephemeral: true
            });
        }

        // Defer the interaction to prevent timeout during user fetches
        await interaction.deferUpdate();

        // Show admin selection with pagination (page 0)
        await showAdminSelection(interaction, 0, lang, eligibleAdmins);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleAssignAllianceButton');
    }
}

/**
 * Shows admin selection with pagination
 * @param {import('discord.js').ButtonInteraction|import('discord.js').StringSelectMenuInteraction} interaction 
 * @param {number} page - Current page number
 * @param {Object} lang - Language object
 * @param {Array} eligibleAdmins - Array of eligible admins to display
 */
async function showAdminSelection(interaction, page = 0, lang = {}, eligibleAdmins = null) {
    // If eligibleAdmins not provided, get them
    if (!eligibleAdmins) {
        const allAdmins = adminQueries.getAllAdmins();
        eligibleAdmins = allAdmins.filter(admin =>
            !admin.is_owner && !(admin.permissions & PERMISSIONS.FULL_ACCESS)
        );
    }

    const itemsPerPage = 24;
    const totalPages = Math.ceil(eligibleAdmins.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const currentPageAdmins = eligibleAdmins.slice(startIndex, endIndex);

    // Create select menu options for admins
    const options = currentPageAdmins.map((admin) => {
        const assignedAlliances = JSON.parse(admin.alliances || '[]');
        const allianceCount = assignedAlliances.length;

        // Get username from cache
        const username = adminUsernameCache.getUsername(admin.user_id);

        return {
            label: username,
            description: lang.alliance.assignAlliance.selectMenu.selectAdmin.description.replace('{count}', allianceCount),
            value: `admin_${admin.user_id}`
        };
    });

    // Create dropdown menu
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`select_assign_admin_${interaction.user.id}_${page}`)
        .setPlaceholder(lang.alliance.assignAlliance.selectMenu.selectAdmin.placeholder)
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(options);

    // Create action rows
    const actionRow = [];
    const selectRow = new ActionRowBuilder().addComponents(selectMenu);

    // Add pagination buttons if more than 1 page (always show, disabled when needed)
    const paginationRow = createUniversalPaginationButtons({
        feature: 'assign_admin',
        userId: interaction.user.id,
        currentPage: page,
        totalPages: totalPages,
        lang: lang
    });

    if (paginationRow) {
        actionRow.push(paginationRow);
    }

    actionRow.push(selectRow);

    const container = [
        new ContainerBuilder()
            .setAccentColor(0x3498db)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.alliance.assignAlliance.content.title.base}\n` +
                    `${lang.alliance.assignAlliance.content.description.base}\n` +
                    `${lang.pagination.text.pageInfo
                        .replace('{current}', (page + 1).toString())
                        .replace('{total}', totalPages.toString())
                    }`
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(
                actionRow
            )
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    // Send or update the message (use editReply if deferred)
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });
    } else {
        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });
    }
}

/**
 * Handles the admin selection for alliance assignment
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleAssignAdminSelection(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[3]; // select_assign_admin_userId_page

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

        // Parse selected admin user ID
        const selectedAdminUserId = interaction.values[0].replace('admin_', '');
        const targetAdmin = adminQueries.getAdmin(selectedAdminUserId);

        if (!targetAdmin) {
            return await interaction.reply({
                content: lang.alliance.assignAlliance.errors.adminNotFound,
                ephemeral: true
            });
        }

        // Get all alliances
        const allAlliances = allianceQueries.getAllAlliances();

        if (allAlliances.length === 0) {
            return await interaction.reply({
                content: lang.alliance.assignAlliance.errors.noAlliances,
                ephemeral: true
            });
        }

        // Show alliance selection with pagination (page 0)
        await showAllianceSelection(interaction, 0, lang, selectedAdminUserId, allAlliances);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleAssignAdminSelection');
    }
}

/**
 * Shows alliance selection with pagination
 * @param {import('discord.js').ButtonInteraction|import('discord.js').StringSelectMenuInteraction} interaction 
 * @param {number} page - Current page number
 * @param {Object} lang - Language object
 * @param {string} selectedAdminUserId - The admin user ID to assign alliances to
 * @param {Array} allAlliances - Array of all alliances
 */
async function showAllianceSelection(interaction, page = 0, lang = {}, selectedAdminUserId, allAlliances = null) {
    const emojiMap = getEmojiMapForAdmin(interaction.user.id);
    // If allAlliances not provided, get them
    if (!allAlliances) {
        allAlliances = allianceQueries.getAllAlliances();
    }

    // Get target admin
    const targetAdmin = adminQueries.getAdmin(selectedAdminUserId);
    if (!targetAdmin) {
        return;
    }

    // Get currently assigned alliances for this admin
    const assignedAllianceIds = JSON.parse(targetAdmin.alliances || '[]');

    const itemsPerPage = 24;
    const totalPages = Math.ceil(allAlliances.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const currentPageAlliances = allAlliances.slice(startIndex, endIndex);

    // Create select menu options for alliances
    const options = currentPageAlliances.map(alliance => {
        const isAssigned = assignedAllianceIds.includes(alliance.id);

        return {
            label: `${alliance.name}`,
            description: isAssigned
                ? lang.alliance.assignAlliance.selectMenu.selectAlliances.description.add.replace('{alliancePriority}', alliance.priority)
                : lang.alliance.assignAlliance.selectMenu.selectAlliances.description.remove.replace('{alliancePriority}', alliance.priority),
            value: `alliance_${alliance.id}`,
            emoji: isAssigned ? getComponentEmoji(emojiMap, '1004') : getComponentEmoji(emojiMap, '1051')
        };
    });

    // Create dropdown menu
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`select_assign_alliances_${interaction.user.id}_${selectedAdminUserId}_${page}`)
        .setPlaceholder(lang.alliance.assignAlliance.selectMenu.selectAlliances.placeholder)
        .setMinValues(1)
        .setMaxValues(Math.min(options.length, 25))
        .addOptions(options);

    // Create action rows
    const actionRow = [];
    const selectRow = new ActionRowBuilder().addComponents(selectMenu);

    // Add pagination buttons if more than 1 page (always show, disabled when needed)
    if (totalPages > 1) {
        const paginationRow = createUniversalPaginationButtons({
            feature: 'assign_alliances',
            userId: interaction.user.id,
            currentPage: page,
            totalPages: totalPages,
            lang: lang,
            contextData: [selectedAdminUserId]
        });

        actionRow.push(paginationRow);
    }
    actionRow.push(selectRow);

    const container = [
        new ContainerBuilder()
            .setAccentColor(0x3498db)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.alliance.assignAlliance.content.title.allianceSelection}\n` +
                    `${lang.alliance.assignAlliance.content.description.allianceSelection.replace('{admin}', `<@${selectedAdminUserId}>`)}\n` +
                    `${lang.alliance.assignAlliance.content.currentlyAssignedField.name}\n` +
                    (assignedAllianceIds.length > 0
                        ? assignedAllianceIds.map(id => {
                            const alliance = allAlliances.find(a => a.id == id);
                            return alliance ? `  - ${alliance.name}` : `  - ${id}`;
                        }).join('\n')
                        : lang.alliance.assignAlliance.content.currentlyAssignedField.value) +
                    `\n` +
                    `${lang.pagination.text.pageInfo
                        .replace('{current}', (page + 1).toString())
                        .replace('{total}', totalPages.toString())}`
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(
                actionRow
            )
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    await interaction.update({
        components: content,
        flags: MessageFlags.IsComponentsV2
    });
}

/**
 * Handles the alliance selection for assignment/removal
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleAssignAlliancesSelection(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID, target admin user ID, and page from custom ID
        const customIdParts = interaction.customId.split('_');
        const customIdUserId = customIdParts[3];
        const targetAdminUserId = customIdParts[4];

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, customIdUserId, lang))) return;

        // Check permissions
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get target admin
        const targetAdmin = adminQueries.getAdmin(targetAdminUserId);
        if (!targetAdmin) {
            return await interaction.reply({
                content: lang.alliance.assignAlliance.errors.adminNotFound,
                ephemeral: true
            });
        }

        // Parse selected alliance IDs
        const selectedAllianceIds = interaction.values
            .filter(value => value.startsWith('alliance_'))
            .map(value => parseInt(value.split('_')[1], 10))
            .filter(id => !isNaN(id));

        if (selectedAllianceIds.length === 0) {
            return await interaction.reply({
                content: lang.alliance.assignAlliance.errors.noValidAlliances,
                ephemeral: true
            });
        }

        // Get currently assigned alliances
        const currentAssignedIds = JSON.parse(targetAdmin.alliances || '[]');

        // Determine which alliances to add and which to remove
        const toAdd = [];
        const toRemove = [];

        for (const allianceId of selectedAllianceIds) {
            if (currentAssignedIds.includes(allianceId)) {
                // Already assigned, so remove it
                toRemove.push(allianceId);
            } else {
                // Not assigned, so add it
                toAdd.push(allianceId);
            }
        }

        // Calculate new assigned alliances
        let newAssignedIds = [...currentAssignedIds];

        // Remove alliances
        newAssignedIds = newAssignedIds.filter(id => !toRemove.includes(id));

        // Add new alliances
        newAssignedIds = [...newAssignedIds, ...toAdd];

        // Update the admin's assigned alliances
        adminQueries.updateAdminAlliances(JSON.stringify(newAssignedIds), targetAdminUserId);

        // Get alliance names for reporting
        const allAlliances = allianceQueries.getAllAlliances();
        const addedNames = toAdd.map(id => {
            const alliance = allAlliances.find(a => a.id === id);
            return alliance ? alliance.name : `ID ${id}`;
        });
        const removedNames = toRemove.map(id => {
            const alliance = allAlliances.find(a => a.id === id);
            return alliance ? alliance.name : `ID ${id}`;
        });

        const container = [
            new ContainerBuilder()
                .setAccentColor(0x2ecc71)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.alliance.assignAlliance.content.title.assigned}\n` +
                        `${lang.alliance.assignAlliance.content.description.assigned.replace('{admin}', `<@${targetAdminUserId}>`)}`
                    )
                )
                .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        ];

        if (addedNames.length > 0) {
            container[0].addTextDisplayComponents(
                new TextDisplayBuilder()
                    .setContent(
                        `${lang.alliance.assignAlliance.content.addedField.name}\n` +
                        `${addedNames.map(name => lang.alliance.assignAlliance.content.addedField.value.replace('{name}', name)).join('\n')}`)
            );
        }

        if (removedNames.length > 0 && addedNames.length > 0) {
            container[0].addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
        }

        if (removedNames.length > 0) {
            container[0].addTextDisplayComponents(
                new TextDisplayBuilder()
                    .setContent(`${lang.alliance.assignAlliance.content.removedField.name}\n` +
                        `${removedNames.map(name => lang.alliance.assignAlliance.content.removedField.value.replace('{name}', name)).join('\n')}`
                    )
            );
        }

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleAssignAlliancesSelection');
    }
}

/**
 * Handles pagination for admin list
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleAssignAdminPagination(interaction) {
    const { lang } = getAdminLang(interaction.user.id);
    try {
        const { userId, newPage } = parsePaginationCustomId(interaction.customId, 0);

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, userId, lang))) return;

        // Defer the interaction to prevent timeout during user fetches
        await interaction.deferUpdate();

        // Show new page
        await showAdminSelection(interaction, newPage, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleAssignAdminPagination');
    }
}

/**
 * Handles pagination for alliance list
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleAssignAlliancesPagination(interaction) {
    const { lang } = getAdminLang(interaction.user.id);
    try {
        const { userId, newPage, contextData } = parsePaginationCustomId(interaction.customId, 1);
        const selectedAdminUserId = contextData[0];

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, userId, lang))) return;

        // Show new page
        await showAllianceSelection(interaction, newPage, lang, selectedAdminUserId);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleAssignAlliancesPagination');
    }
}

module.exports = {
    createAssignAllianceButton,
    handleAssignAllianceButton,
    handleAssignAdminSelection,
    handleAssignAlliancesSelection,
    handleAssignAdminPagination,
    handleAssignAlliancesPagination
};
