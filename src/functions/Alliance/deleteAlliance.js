const { ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ActionRowBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
const { adminQueries, allianceQueries, playerQueries, idChannelQueries, systemLogQueries, adminLogQueries } = require('../utility/database');
const { LOG_CODES } = require('../utility/AdminLogs');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { stopAutoRefresh } = require('./refreshAlliance');
const { updateIdChannelCache } = require('../Players/idChannel');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { getAdminLang, assertUserMatches, sendError, hasPermission, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('./../utility/emojis');

/**
 * Creates a delete alliance button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The delete alliance button
 */
function createDeleteAllianceButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`delete_alliance_${userId}`)
        .setLabel(lang.alliance.mainPage.buttons.deleteAlliance)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1046'));
}

/**
 * Handles delete alliance button interaction and shows alliance selection
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleDeleteAllianceButton(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[2]; // delete_alliance_userId

        // Check if the interaction user matches the expected user
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
        } else if (hasAccess) {
            // Regular admins with alliance management can only see assigned alliances
            const assignedAllianceIds = JSON.parse(adminData.alliances || '[]');
            if (assignedAllianceIds.length === 0) {
                return await interaction.reply({
                    content: lang.alliance.deleteAlliance.errors.noAssignedAlliances,
                    ephemeral: true
                });
            }

            // Get only assigned alliances
            alliances = allianceQueries.getAllAlliances().filter(alliance =>
                assignedAllianceIds.includes(alliance.id)
            );
        }

        if (alliances.length === 0) {
            return await interaction.reply({
                content: lang.alliance.deleteAlliance.errors.noAlliancesFound,
                ephemeral: true
            });
        }

        // Show alliance selection with pagination (page 0)
        await showDeleteAllianceSelection(interaction, 0, lang, alliances);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleDeleteAllianceButton');
    }
}

/**
 * Shows delete alliance selection with pagination
 * @param {import('discord.js').ButtonInteraction|import('discord.js').StringSelectMenuInteraction} interaction 
 * @param {number} page - Current page number
 * @param {Object} lang - Language object
 * @param {Array} alliances - Array of alliances to display (filtered based on permissions)
 */
async function showDeleteAllianceSelection(interaction, page = 0, lang = {}, alliances = null) {
    // If alliances not provided, get them based on user permissions
    if (!alliances) {
        const adminData = adminQueries.getAdmin(interaction.user.id);
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.ALLIANCE_MANAGEMENT);

        if (hasFullAccess) {
            alliances = allianceQueries.getAllAlliances();
        } else if (hasAccess) {
            const assignedAllianceIds = JSON.parse(adminData.alliances || '[]');
            alliances = allianceQueries.getAllAlliances().filter(alliance =>
                assignedAllianceIds.includes(alliance.id)
            );
        } else {
            alliances = [];
        }
    }

    const itemsPerPage = 24;
    const totalPages = Math.ceil(alliances.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const currentPageAlliances = alliances.slice(startIndex, endIndex);

    // Create dropdown menu with alliances
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`select_alliance_delete_${interaction.user.id}_${page}`)
        .setPlaceholder(lang.alliance.deleteAlliance.selectMenu.selectAlliance.placeholder)
        .setMinValues(1)
        .setMaxValues(1);

    // Add alliance options
    currentPageAlliances.forEach(alliance => {
        // Get player count for this alliance
        const playersInAlliance = playerQueries.getPlayersByAlliance(alliance.id);
        const playerCount = playersInAlliance.length;

        selectMenu.addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(alliance.name)
                .setDescription((lang.alliance.deleteAlliance.selectMenu.selectAlliance.description)
                    .replace('{alliancePriority}', alliance.priority)
                    .replace('{playerCount}', playerCount.toString())
                )
                .setValue(alliance.id.toString())
                .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1001'))
        );
    });

    // Create action rows
    const components = [];
    const selectRow = new ActionRowBuilder().addComponents(selectMenu);

    const paginationRow = createUniversalPaginationButtons({
        feature: 'delete_alliance',
        userId: interaction.user.id,
        currentPage: page,
        totalPages: totalPages,
        lang: lang
    });
    components.push(selectRow);
    if (paginationRow) {
        components.push(paginationRow)
    }

    const container = [
        new ContainerBuilder()
            .setAccentColor(16711680) // red
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.alliance.deleteAlliance.content.title.base}\n` +
                    `${lang.alliance.deleteAlliance.content.warningField.name}\n` +
                    `${lang.alliance.deleteAlliance.content.warningField.value}\n` +
                    `${lang.pagination.text.pageInfo
                        .replace('{current}', (page + 1).toString())
                        .replace('{total}', totalPages.toString())}`
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(
                components
            )
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    await interaction.update({
        components: content,
        flags: MessageFlags.IsComponentsV2
    });
}

/**
 * Handles delete alliance selection pagination
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleDeleteAlliancePagination(interaction) {
    // Get admin language preference
    const { lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID and page from custom ID
        const { userId: expectedUserId, newPage } = parsePaginationCustomId(interaction.customId, 0);

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Show new page
        await showDeleteAllianceSelection(interaction, newPage, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleDeleteAlliancePagination');
    }
}

/**
 * Handles alliance selection for deletion
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleDeleteAllianceSelection(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[3]; // select_alliance_delete_userId_page

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Get selected alliance ID
        const allianceId = parseInt(interaction.values[0]);
        const alliance = allianceQueries.getAllianceById(allianceId);

        if (!alliance) {
            return await interaction.reply({
                content: lang.common.error,
                ephemeral: true
            });
        }

        // Check if admin has permission to delete this specific alliance
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.ALLIANCE_MANAGEMENT);

        // Check permissions for this specific alliance
        if (!hasFullAccess) {
            if (!hasAccess) {
                return await interaction.reply({
                    content: lang.common.noPermission,
                    ephemeral: true
                });
            }

            const assignedAllianceIds = JSON.parse(adminData.alliances || '[]');
            if (!assignedAllianceIds.includes(allianceId)) {
                return await interaction.reply({
                    content: lang.common.noPermission,
                    ephemeral: true
                });
            }
        }

        // Get player count for this alliance
        const playersInAlliance = playerQueries.getPlayersByAlliance(allianceId);
        const playerCount = playersInAlliance.length;

        // If owner or full access, delete immediately
        if (hasFullAccess) {
            await showDeleteConfirmation(interaction, alliance, playerCount, lang);
        } else {
            // For regular admins, require owner/full-access confirmation
            await requestDeletionApproval(interaction, alliance, playerCount, adminData);
        }
    } catch (error) {
        await sendError(interaction, lang, error, 'handleDeleteAllianceSelection');
    }
}

/**
 * Shows delete confirmation for immediate deletion (owner/full-access)
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 * @param {Object} alliance - Alliance object
 * @param {number} playerCount - Number of players in alliance
 * @param {Object} lang - Language object
 * @param {boolean} immediate - Whether this is immediate deletion
 */
async function showDeleteConfirmation(interaction, alliance, playerCount, lang) {
    const actionRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`confirm_delete_alliance_${alliance.id}_${interaction.user.id}`)
                .setLabel(lang.alliance.deleteAlliance.buttons.confirmDelete)
                .setStyle(ButtonStyle.Danger)
                .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1004')),
            new ButtonBuilder()
                .setCustomId(`cancel_delete_alliance_${alliance.id}_${interaction.user.id}`)
                .setLabel(lang.alliance.deleteAlliance.buttons.cancelDelete)
                .setStyle(ButtonStyle.Secondary)
                .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1051'))
        );

    const container = [
        new ContainerBuilder()
            .setAccentColor(16711680) // red
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.alliance.deleteAlliance.content.title.confirm}\n` +
                    `${lang.alliance.deleteAlliance.content.allianceToDeleteField.name}\n` +
                    `${lang.alliance.deleteAlliance.content.allianceToDeleteField.value.confirming
                        .replace('{allianceName}', alliance.name)
                        .replace('{priority}', alliance.priority)
                        .replace('{players}', playerCount.toString())}\n`
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(actionRow)
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    await interaction.update({
        components: content,
        flags: MessageFlags.IsComponentsV2
    });
}

/**
 * Requests deletion approval from owner/full-access admins
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 * @param {Object} alliance - Alliance object
 * @param {number} playerCount - Number of players in alliance
 * @param {Object} requesterAdminData - Admin data of the requester
 */
async function requestDeletionApproval(interaction, alliance, playerCount, requesterAdminData) {
    // Get all owner and full-access admins
    const allAdmins = adminQueries.getAllAdmins();

    const approvers = allAdmins.filter(admin =>
        admin.is_owner || (admin.permissions & PERMISSIONS.FULL_ACCESS)
    );

    if (approvers.length === 0) {
        return await interaction.update({
            content: lang.common.error,
            embeds: [],
            components: []
        });
    }

    const { lang } = getAdminLang(interaction.user.id);

    const newSection = [
        new ContainerBuilder()
            .setAccentColor(16753920) // orange
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.alliance.deleteAlliance.content.title.request}\n` +
                    `${lang.alliance.deleteAlliance.content.description.request}\n` +
                    `${lang.alliance.deleteAlliance.content.requestedByField.name}\n` +
                    `${lang.alliance.deleteAlliance.content.requestedByField.value.replace('{requester}', `<@${interaction.user.id}>`)}\n` +
                    `${lang.alliance.deleteAlliance.content.allianceToDeleteField.name}\n` +
                    `${lang.alliance.deleteAlliance.content.allianceToDeleteField.value.confirming
                        .replace('{allianceName}', alliance.name)
                        .replace('{priority}', alliance.priority)
                        .replace('{players}', playerCount.toString())}`
                )
            )
    ];

    const content = updateComponentsV2AfterSeparator(interaction, newSection);

    await interaction.update({
        components: content,
        flags: MessageFlags.IsComponentsV2
    });

    // Send DM to all approvers
    for (const approver of approvers) {
        const { lang: approverLang } = getAdminLang(approver.user_id);
        try {
            const approverUser = await interaction.client.users.fetch(approver.user_id);
            const dmActionRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`approve_delete_alliance_${alliance.id}_${requesterAdminData.user_id}_${interaction.user.id}`)
                        .setLabel(approverLang.alliance.deleteAlliance.buttons.approveRequest)
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(approver.user_id), '1004')),
                    new ButtonBuilder()
                        .setCustomId(`deny_delete_alliance_${alliance.id}_${requesterAdminData.user_id}_${interaction.user.id}`)
                        .setLabel(approverLang.alliance.deleteAlliance.buttons.denyRequest)
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(approver.user_id), '1051'))
                );

            const container = [
                new ContainerBuilder()
                    .setAccentColor(16711680) // red
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `${approverLang.alliance.deleteAlliance.content.title.approvalNeeded}\n` +
                            `${approverLang.alliance.deleteAlliance.content.requestedByField.name}\n` +
                            `${approverLang.alliance.deleteAlliance.content.requestedByField.value.replace('{requester}', `<@${interaction.user.id}>`)}\n` +
                            `${approverLang.alliance.deleteAlliance.content.allianceToDeleteField.name}\n` +
                            `${approverLang.alliance.deleteAlliance.content.allianceToDeleteField.value.confirming
                                .replace('{allianceName}', alliance.name)
                                .replace('{priority}', alliance.priority)
                                .replace('{players}', playerCount.toString())
                            }`

                        )
                    )
                    .addSeparatorComponents(
                        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                    )
                    .addActionRowComponents(
                        dmActionRow
                    )
            ];

            await approverUser.send({
                components: container,
                flags: MessageFlags.IsComponentsV2
            });

        } catch (dmError) {
            await sendError(interaction, lang, dmError, 'requestDeletionApproval');
        }
    }

    // Log the approval request
    adminLogQueries.addLog(
        requesterAdminData.user_id,
        LOG_CODES.ALLIANCE.DELETE_REQUESTED,
        JSON.stringify({
            allianceName: alliance.name,
            allianceId: alliance.id
        })
    );
}

/**
 * Handles confirmation of alliance deletion
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleConfirmDeleteAlliance(interaction) {
    // Get admin language preference
    const { lang, adminData } = getAdminLang(interaction.user.id);
    try {
        const customIdParts = interaction.customId.split('_');
        const allianceId = parseInt(customIdParts[3]); // confirm_delete_alliance_allianceId_userId
        const expectedUserId = customIdParts[4];

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        if (!hasFullAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        await performAllianceDeletion(interaction, allianceId);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleConfirmDeleteAlliance');
    }
}

/**
 * Handles approval of alliance deletion request
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleApproveDeleteAlliance(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        const customIdParts = interaction.customId.split('_');
        const allianceId = parseInt(customIdParts[3]); // approve_delete_alliance_allianceId_requesterId_originalInteractionUserId
        const requesterId = customIdParts[4];

        // Verify approver has permission
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        if (!hasFullAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        await performAllianceDeletion(interaction, allianceId, requesterId, true);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleApproveDeleteAlliance');
    }
}

/**
 * Performs the actual alliance deletion
 * @param {import('discord.js').ButtonInteraction} interaction 
 * @param {number} allianceId - Alliance ID to delete
 * @param {string} requesterId - ID of the user who requested deletion (for approvals)
 * @param {boolean} isApproval - Whether this is an approval action
 */
async function performAllianceDeletion(interaction, allianceId, requesterId = null, isApproval = false) {
    // Get admin language preference
    const { lang } = getAdminLang(interaction.user.id);
    try {
        // Get alliance data before deletion
        const alliance = allianceQueries.getAllianceById(allianceId);
        if (!alliance) {
            return await interaction.reply({
                content: lang.alliance.deleteAlliance.errors.allianceNotFound,
                ephemeral: true
            });
        }

        // Get all players assigned to this alliance
        const playersInAlliance = playerQueries.getPlayersByAlliance(allianceId);
        const playerCount = playersInAlliance.length;

        try {
            // Get the priority of the alliance being deleted
            const deletedAlliancePriority = alliance.priority;

            // Delete all players assigned to this alliance
            for (const player of playersInAlliance) {
                playerQueries.deletePlayer(player.fid);
            }

            // Delete alliance ID channels
            const idChannels = idChannelQueries.getChannelsByAlliance(allianceId);
            for (const channel of idChannels) {
                idChannelQueries.deleteChannel(channel.id);
                // Update cache to remove the channel
                updateIdChannelCache(channel.channel_id, null);
            }

            // Stop auto-refresh for this alliance before deletion
            try {
                await stopAutoRefresh(allianceId);
            } catch (autoRefreshError) {
                await sendError(interaction, lang, autoRefreshError, 'performAllianceDeletion_stopAutoRefresh', false);
            }

            // Delete the alliance
            allianceQueries.deleteAlliance(allianceId);

            // Remove alliance assignment from all admins who had it assigned
            const allAdmins = adminQueries.getAllAdmins();
            let adminsUpdated = 0;
            for (const admin of allAdmins) {
                if (admin.alliances) {
                    try {
                        const assignedAllianceIds = JSON.parse(admin.alliances);
                        const updatedAllianceIds = assignedAllianceIds.filter(id => id !== allianceId);

                        // Only update if the alliance was actually assigned
                        if (updatedAllianceIds.length !== assignedAllianceIds.length) {
                            adminQueries.updateAdmin(
                                admin.user_id,
                                admin.permissions,
                                admin.is_owner,
                                admin.language,
                                JSON.stringify(updatedAllianceIds)
                            );
                            adminsUpdated++;
                        }
                    } catch (parseError) {
                        // Skip this admin if JSON parsing fails
                    }
                }
            }


            // Update priorities of remaining alliances to fill the gap
            const allRemainingAlliances = allianceQueries.getAllAlliances();
            const alliancesToUpdate = allRemainingAlliances.filter(a => a.priority > deletedAlliancePriority);

            // Sort by current priority to ensure correct order
            alliancesToUpdate.sort((a, b) => a.priority - b.priority);

            // Update each alliance's priority (decrease by 1)
            for (const allianceToUpdate of alliancesToUpdate) {
                const newPriority = allianceToUpdate.priority - 1;
                allianceQueries.updateAlliance(
                    newPriority,
                    allianceToUpdate.name,
                    allianceToUpdate.guide_id,
                    allianceToUpdate.channel_id,
                    allianceToUpdate.interval,
                    allianceToUpdate.auto_redeem,
                    allianceToUpdate.id
                );
            }


            const approvedBy = isApproval ? `<@${interaction.user.id}>` : lang.alliance.deleteAlliance.content.noApproval;

            // Create success section using Components v2
            const container = [
                new ContainerBuilder()
                    .setAccentColor(3381657) // Green color for success
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `${lang.alliance.deleteAlliance.content.title.success}\n` +
                            `${lang.alliance.deleteAlliance.content.allianceToDeleteField.name}\n` +
                            `${lang.alliance.deleteAlliance.content.allianceToDeleteField.value.approved
                                .replace('{allianceName}', alliance.name)
                                .replace('{priority}', alliance.priority)
                                .replace('{players}', playerCount.toString())
                                .replace('{deletedBy}', `<@${interaction.user.id}>`)
                                .replace('{approvedBy}', approvedBy)}`
                        )
                    )
            ];

            const content = updateComponentsV2AfterSeparator(interaction, container);

            // Update the message
            await interaction.update({
                components: content,
                flags: MessageFlags.IsComponentsV2
            });

            // Log the deletion
            adminLogQueries.addLog(
                interaction.user.id,
                LOG_CODES.ALLIANCE.DELETED,
                JSON.stringify({
                    allianceName: alliance.name,
                    allianceId: allianceId,
                    playerCount: playerCount,
                    isApproval: isApproval,
                    requesterId: isApproval ? requesterId : null
                })
            );

            // Log to system for priority updates
            if (alliancesToUpdate.length > 0) {
                systemLogQueries.addLog(
                    'alliance',
                    `Priority updates after alliance deletion: ${alliancesToUpdate.length} alliances updated, ${adminsUpdated} admins updated`,
                    JSON.stringify({
                        deleted_alliance_id: allianceId,
                        deleted_alliance_name: alliance.name,
                        deleted_priority: deletedAlliancePriority,
                        updated_alliances: alliancesToUpdate.map(a => ({
                            id: a.id,
                            name: a.name,
                            old_priority: a.priority,
                            new_priority: a.priority - 1
                        })),
                        admins_updated: adminsUpdated,
                        function: 'performAllianceDeletion'
                    })
                );
            }


            // If this was an approval, notify the requester
            if (isApproval && requesterId) {
                try {
                    // Get the requester language preference
                    const { lang: reqLang } = getAdminLang(requesterId);

                    const requesterUser = await interaction.client.users.fetch(requesterId);

                    const content = [
                        new ContainerBuilder()
                            .setAccentColor(3381657) // Green color for success
                            .addTextDisplayComponents(
                                new TextDisplayBuilder().setContent(
                                    `${reqLang.alliance.deleteAlliance.content.title.approval}\n` +
                                    `${reqLang.alliance.deleteAlliance.content.allianceToDeleteField.name}\n` +
                                    `${reqLang.alliance.deleteAlliance.content.allianceToDeleteField.value.approved
                                        .replace('{allianceName}', alliance.name)
                                        .replace('{priority}', alliance.priority)
                                        .replace('{players}', playerCount.toString())
                                        .replace('{deletedBy}', `<@${interaction.user.id}>`)
                                        .replace('{approvedBy}', approvedBy)}`
                                )
                            )
                    ];
                    await requesterUser.send({ components: content, flags: MessageFlags.IsComponentsV2 });
                } catch (notifyError) {
                    await sendError(interaction, null, notifyError, 'performAllianceDeletion_notifyRequester', false);
                }
            }

        } catch (dbError) {
            await sendError(interaction, lang, dbError, 'performAllianceDeletion_databaseError');
        }
    } catch (error) {
        await sendError(interaction, lang, error, 'performAllianceDeletion');
    }
}

/**
 * Handles cancellation of alliance deletion
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleCancelDeleteAlliance(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[4]; // cancel_delete_alliance_allianceId_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // check if admin has permission to cancel
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.ALLIANCE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const container = [
            new ContainerBuilder()
                .setAccentColor(16711680) // red
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(lang.alliance.deleteAlliance.content.title.cancel)
                )
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(lang.alliance.deleteAlliance.content.description.cancel)
                )
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleCancelDeleteAlliance');
    }
}

/**
 * Handles denial of alliance deletion request
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleDenyDeleteAlliance(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        const customIdParts = interaction.customId.split('_');
        const allianceId = parseInt(customIdParts[3]); // deny_delete_alliance_allianceId_requesterId_originalInteractionUserId
        const requesterId = customIdParts[4];

        // Verify denier has permission
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);


        if (!hasFullAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get alliance data
        const alliance = allianceQueries.getAllianceById(allianceId);
        const playerCount = playerQueries.getPlayersByAlliance(allianceId).length;

        const content = [
            new ContainerBuilder()
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(lang.alliance.deleteAlliance.content.title.denial)
                )
                .setAccentColor(16711680) // red
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(lang.alliance.deleteAlliance.content.description.denial)
                )
        ];

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

        // Notify the requester
        try {
            // Get the requester language preference
            const { lang: reqLang } = getAdminLang(requesterId);

            const requesterUser = await interaction.client.users.fetch(requesterId);

            const content = [
                new ContainerBuilder()
                    .setAccentColor(16711680) // red
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `${reqLang.alliance.deleteAlliance.content.title.denial}\n` +
                            `${reqLang.alliance.deleteAlliance.content.description.denial}\n` +
                            `${reqLang.alliance.deleteAlliance.content.allianceToDeleteField.name}\n` +
                            `${reqLang.alliance.deleteAlliance.content.allianceToDeleteField.value.denied
                                .replace('{allianceName}', alliance.name)
                                .replace('{priority}', alliance.priority)
                                .replace('{players}', playerCount.toString())
                                .replace('{deniedBy}', `<@${interaction.user.id}>`)}`
                        )
                    )
            ];

            await requesterUser.send({ components: content, flags: MessageFlags.IsComponentsV2 });
        } catch (notifyError) {
            await sendError(interaction, null, notifyError, 'handleDenyDeleteAlliance_notifyRequester', false);
        }

        // Log the denial
        adminLogQueries.addLog(
            interaction.user.id,
            LOG_CODES.ALLIANCE.DELETE_DENIED,
            JSON.stringify({
                allianceName: alliance?.name || 'Unknown',
                allianceId: allianceId,
                requester: requesterId
            })
        );

    } catch (error) {
        await sendError(interaction, lang, error, 'handleDenyDeleteAlliance');
    }
}

module.exports = {
    createDeleteAllianceButton,
    handleDeleteAllianceButton,
    handleDeleteAlliancePagination,
    handleDeleteAllianceSelection,
    handleConfirmDeleteAlliance,
    handleApproveDeleteAlliance,
    handleCancelDeleteAlliance,
    handleDenyDeleteAlliance
};
