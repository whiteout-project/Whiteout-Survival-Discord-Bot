const {
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize
} = require('discord.js');
const { allianceQueries, giftCodeQueries, playerQueries, systemLogQueries } = require('../utility/database');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { createRedeemProcess } = require('./redeemFunction');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { hasPermission, sendError, getAdminLang, assertUserMatches, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('./../utility/emojis');

/**
 * Creates a manual redeem gift code button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The manual redeem button
 */
function createManualRedeemButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`manual_redeem_gift_${userId}`)
        .setLabel(lang.giftCode.mainPage.buttons.useGiftCode)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1043'));
}

/**
 * Handles manual redeem button - shows alliance selection
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleManualRedeemButton(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        // Extract and verify user ID
        const expectedUserId = interaction.customId.split('_')[3];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions: must be owner, have FULL_ACCESS, or have GIFT_CODE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const playerCount = playerQueries.getAllPlayers();
        if (playerCount.length === 0) {
            return await interaction.reply({
                content: lang.giftCode.redeemGiftCode.errors.noPlayers,
                ephemeral: true
            });
        }

        // check if there is any giftcode available, if not, return error
        const allGiftCodes = giftCodeQueries.getAllGiftCodes();
        if (!allGiftCodes || allGiftCodes.length === 0) {
            return await interaction.reply({
                content: lang.giftCode.redeemGiftCode.errors.noGiftCodes,
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

            // Get only assigned alliances
            alliances = allianceQueries.getAllAlliances().filter(alliance =>
                assignedAllianceIds.includes(alliance.id)
            );
        }

        // Filter to only alliances that have players
        const allianceIds = alliances.map(a => a.id);
        const playerCountResults = allianceIds.length > 0
            ? playerQueries.getPlayerCountsByAllianceIds(allianceIds)
            : [];

        const alliancesWithPlayers = new Set(playerCountResults.map(row => row.alliance_id));
        alliances = alliances.filter(alliance => alliancesWithPlayers.has(alliance.id));

        if (alliances.length === 0) {
            return await interaction.reply({
                content: lang.giftCode.redeemGiftCode.errors.noAlliances,
                ephemeral: true
            });
        }

        const { components } = createAllianceSelectionContainer(
            alliances,
            interaction.user.id,
            lang,
            0,
            hasFullAccess,
            interaction
        );

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleManualRedeemButton');
    }
}

/**
 * Creates alliance selection embed with pagination
 * @param {Array} alliances - Array of alliance objects
 * @param {string} userId - User ID
 * @param {Object} lang - Language object
 * @param {number} page - Current page number
 * @param {boolean} isOwnerOrFullAccess - Whether user is owner or has full access
 * @returns {Object} Embed and components
 */
function createAllianceSelectionContainer(alliances, userId, lang, page = 0, isOwnerOrFullAccess = false, interaction) {
    const itemsPerPage = 24;
    const totalPages = Math.ceil(alliances.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const currentPageAlliances = alliances.slice(startIndex, endIndex);

    // Pre-fetch player counts for all alliances on this page (and overall for totals)
    const allianceIds = alliances.map(a => a.id);
    const playerCountResults = allianceIds.length > 0
        ? playerQueries.getPlayerCountsByAllianceIds(allianceIds)
        : [];

    const playerCounts = new Map();
    playerCountResults.forEach(row => {
        playerCounts.set(row.alliance_id, row.player_count);
    });

    const totalPlayers = playerCountResults.reduce((sum, row) => sum + row.player_count, 0);

    // Create dropdown options
    const options = [];

    // Add "All Alliances" option for owner/full access users on first page
    if (isOwnerOrFullAccess && page === 0) {
        options.push(
            new StringSelectMenuOptionBuilder()
                .setLabel(lang.giftCode.redeemGiftCode.selectMenu.selectAlliance.allAlliances)
                .setValue('ALL_ALLIANCES')
                .setDescription(`Select all ${alliances.length} alliances (${totalPlayers} total players)`)
                .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1039'))
        );
    }

    // Add individual alliance options
    const allianceOptions = currentPageAlliances.map(alliance => {
        const playerCount = playerCounts.get(alliance.id) || 0;
        return new StringSelectMenuOptionBuilder()
            .setLabel(alliance.name)
            .setValue(alliance.id.toString())
            .setDescription(lang.giftCode.redeemGiftCode.selectMenu.selectAlliance.description
                .replace('{priority}', alliance.priority)
                .replace('{playerCount}', playerCount))
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1001'));
    });

    options.push(...allianceOptions);

    // Create dropdown menu (multi-select)
    const allianceSelect = new StringSelectMenuBuilder()
        .setCustomId(`manual_redeem_alliance_select_${userId}_${page}`)
        .setPlaceholder(lang.giftCode.redeemGiftCode.selectMenu.selectAlliance.placeholder)
        .setMinValues(1)
        .setMaxValues(Math.min(options.length, 25)) // Discord max is 25
        .addOptions(options);

    const actionRows = [];

    // Add dropdown menu first
    actionRows.push(new ActionRowBuilder().addComponents(allianceSelect));

    // Add pagination buttons if needed
    const paginationRow = createUniversalPaginationButtons({
        feature: 'manual_redeem_alliance',
        userId: userId,
        currentPage: page,
        totalPages: totalPages,
        lang: lang
    });
    if (paginationRow) {
        actionRows.push(paginationRow);
    }

    const container = [
        new ContainerBuilder()
            .setAccentColor(2417109) // blue color
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.giftCode.redeemGiftCode.content.title.base}\n` +
                    `${lang.giftCode.redeemGiftCode.content.description.base}\n` +
                    `${lang.pagination.text.pageInfo
                        .replace('{current}', (page + 1))
                        .replace('{total}', totalPages)}`
                )
            ).addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
            )
            .addActionRowComponents(
                actionRows
            ),
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);


    return { components: content };
}

/**
 * Handles alliance selection pagination
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleAllianceSelectionPagination(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        const { userId, newPage } = parsePaginationCustomId(interaction.customId, 0);

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        // Check permissions: must be owner, have FULL_ACCESS, or have GIFT_CODE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

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

            // Get only assigned alliances
            alliances = allianceQueries.getAllAlliances().filter(alliance =>
                assignedAllianceIds.includes(alliance.id)
            );
        }

        // Filter to only alliances that have players
        const allianceIds = alliances.map(a => a.id);
        const playerCountResults = allianceIds.length > 0
            ? playerQueries.getPlayerCountsByAllianceIds(allianceIds)
            : [];

        const alliancesWithPlayers = new Set(playerCountResults.map(row => row.alliance_id));
        alliances = alliances.filter(alliance => alliancesWithPlayers.has(alliance.id));

        const { components } = createAllianceSelectionContainer(
            alliances,
            userId,
            lang,
            newPage,
            hasFullAccess,
            interaction
        );

        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleAllianceSelectionPagination');
    }
}

/**
 * Handles alliance selection from dropdown
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleAllianceSelection(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        // Extract user ID from custom ID
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[4]; // manual_redeem_alliance_select_userId_page

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions: must be owner, have FULL_ACCESS, or have GIFT_CODE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get selected alliance IDs
        const selectedAllianceIds = interaction.values;

        // Handle "All Alliances" selection
        let finalAllianceIds = selectedAllianceIds;
        if (selectedAllianceIds.includes('ALL_ALLIANCES')) {
            // Get all alliances based on permissions
            let allAlliances;
            if (hasFullAccess) {
                allAlliances = allianceQueries.getAllAlliances();
            } else if (hasAccess) {
                const assignedAllianceIds = JSON.parse(adminData.alliances || '[]');
                allAlliances = allianceQueries.getAllAlliances().filter(alliance =>
                    assignedAllianceIds.includes(alliance.id)
                );
            }

            finalAllianceIds = allAlliances.map(alliance => alliance.id.toString());
        }

        // Get active gift codes
        const allGiftCodes = giftCodeQueries.getAllGiftCodes();
        const activeGiftCodes = allGiftCodes.filter(code => code.status === 'active');

        if (activeGiftCodes.length === 0) {
            return await interaction.reply({
                content: lang.giftCode.redeemGiftCode.errors.noActiveGiftCodes,
                ephemeral: true,
            });
        }

        const { components } = createGiftCodeSelectionContainer(
            activeGiftCodes,
            finalAllianceIds,
            interaction.user.id,
            lang,
            0,
            interaction
        );

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleAllianceSelection');
    }
}

/**
 * Creates gift code selection embed with pagination
 * @param {Array} giftCodes - Array of active gift code objects
 * @param {Array} allianceIds - Selected alliance IDs
 * @param {string} userId - User ID
 * @param {Object} lang - Language object
 * @param {number} page - Current page number
 * @returns {Object} container and components
 */
function createGiftCodeSelectionContainer(giftCodes, allianceIds, userId, lang, page = 0, interaction) {
    const itemsPerPage = 24;
    const totalPages = Math.ceil(giftCodes.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const currentPageCodes = giftCodes.slice(startIndex, endIndex);

    // Get alliance names with a single batch query
    const allianceIdsNumeric = allianceIds.map(id => Number(id));
    const allianceRows = allianceIdsNumeric.length > 0
        ? allianceQueries.getAlliancesByIds(allianceIdsNumeric)
        : [];
    const allianceNameMap = new Map(allianceRows.map(a => [a.id, a.name]));

    const allianceNames = allianceIdsNumeric
        .map(id => allianceNameMap.get(id) || `ID:${id}`)
        .join(', ');

    // Create dropdown options
    const options = [];
    const emojiMap = getEmojiMapForAdmin(userId);

    // Add "All Gift Codes" option on first page
    if (page === 0) {
        options.push(
            new StringSelectMenuOptionBuilder()
                .setLabel(lang.giftCode.redeemGiftCode.selectMenu.selectGiftCode.allGiftCodes)
                .setValue('ALL_GIFT_CODES')
                .setDescription(`Select all ${giftCodes.length} active gift codes`)
                .setEmoji(getComponentEmoji(emojiMap, '1039'))
        );
    }

    // Add individual gift code options
    const giftCodeOptions = currentPageCodes.map(code => {
        const vipLabel = code.is_vip ? lang.giftCode.redeemGiftCode.content.vip : '';
        const sourceLabel = code.source === 'api' ? ` ${lang.giftCode.redeemGiftCode.content.api}` : ` ${lang.giftCode.redeemGiftCode.content.manual}`;
        return new StringSelectMenuOptionBuilder()
            .setLabel(`${vipLabel} ${code.gift_code}`)
            .setValue(code.gift_code)
            .setDescription(lang.giftCode.redeemGiftCode.selectMenu.selectGiftCode.description
                .replace('{source}', sourceLabel)
                .replace('{date}', new Date(code.date).toLocaleDateString()))
            .setEmoji(getComponentEmoji(emojiMap, '1013'));
    });

    options.push(...giftCodeOptions);

    // Create dropdown menu
    const giftCodeSelect = new StringSelectMenuBuilder()
        .setCustomId(`manual_redeem_code_select_${userId}_${allianceIds.join('-')}_${page}`)
        .setPlaceholder(lang.giftCode.redeemGiftCode.selectMenu.selectGiftCode.placeholder)
        .addOptions(options);

    const actionRows = [];

    // Add dropdown menu first
    actionRows.push(new ActionRowBuilder().addComponents(giftCodeSelect));

    // Add pagination buttons if needed
    const paginationRow = createUniversalPaginationButtons({
        feature: 'manual_redeem_code',
        userId: userId,
        currentPage: page,
        totalPages: totalPages,
        lang: lang,
        contextData: allianceIds
    });
    if (paginationRow) {
        actionRows.push(paginationRow);
    }

    const container = [
        new ContainerBuilder()
            .setAccentColor(0x2ecc71) // Green color
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.giftCode.redeemGiftCode.content.title.selectGiftCode}\n` +
                    `${lang.giftCode.redeemGiftCode.content.description.selectGiftCode.replace('{alliances}', allianceNames)}\n` +
                    `${lang.pagination.text.pageInfo
                        .replace('{current}', (page + 1))
                        .replace('{total}', totalPages)}`
                )
            ).addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addActionRowComponents(
                actionRows
            )
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    return { components: content };
}

/**
 * Handles gift code selection pagination
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleGiftCodeSelectionPagination(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        // Parse pagination with alliance IDs as context
        const { userId, newPage, contextData } = parsePaginationCustomId(interaction.customId, 1);

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        // Check permissions: must be owner, have FULL_ACCESS, or have GIFT_CODE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Context data contains alliance IDs joined with '-'
        const allianceIds = contextData[0].split('-');

        const allGiftCodes = giftCodeQueries.getAllGiftCodes();
        const activeGiftCodes = allGiftCodes.filter(code => code.status === 'active');

        const { components } = createGiftCodeSelectionContainer(
            activeGiftCodes,
            allianceIds,
            userId,
            lang,
            newPage,
            interaction
        );

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleGiftCodeSelectionPagination');
    }
}

/**
 * Handles gift code selection and starts redemption
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleGiftCodeSelection(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        // Extract data from custom ID
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[4]; // manual_redeem_code_select_userId_allianceIds_page
        const allianceIdsStr = customIdParts[5];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        // Check permissions: must be owner, have FULL_ACCESS, or have GIFT_CODE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const selectedGiftCode = interaction.values[0];
        const allianceIds = allianceIdsStr.split('-').map(id => parseInt(id));

        // Handle "All Gift Codes" selection
        let giftCodesToRedeem = [];
        if (selectedGiftCode === 'ALL_GIFT_CODES') {
            if (hasFullAccess) {
                // Get all active gift codes
                const allGiftCodes = giftCodeQueries.getAllGiftCodes();
                giftCodesToRedeem = allGiftCodes.filter(code => code.status === 'active');
            } else {
                // Unauthorized attempt to use ALL_GIFT_CODES without full access
                return await interaction.reply({
                    content: lang.common.noPermission,
                    ephemeral: true
                });
            }
        } else {
            // Single gift code selection
            const giftCodeData = giftCodeQueries.getGiftCode(selectedGiftCode);
            if (giftCodeData && giftCodeData.status === 'active') {
                giftCodesToRedeem = [giftCodeData];
            } else {
                return await interaction.reply({
                    content: lang.giftCode.redeemGiftCode.errors.invalidGiftCode,
                    ephemeral: true,
                });
            }
        }

        // Start redemption processes for each alliance and gift code combination
        const processResults = [];

        for (const allianceId of allianceIds) {
            const alliance = allianceQueries.getAllianceById(allianceId);
            if (!alliance) continue;

            const players = playerQueries.getPlayersByAllianceId(allianceId);
            if (players.length === 0) continue;

            // Create redeem processes for each gift code
            for (const giftCode of giftCodesToRedeem) {
                // Create redeem data
                const redeemData = players.map(player => ({
                    id: player.fid,
                    giftCode: giftCode.gift_code,
                    status: 'redeem'
                }));

                // Create alliance context for progress tracking
                const allianceContext = {
                    id: alliance.id,
                    name: alliance.name,
                    channelId: alliance.channel_id,
                    guildId: interaction.guildId
                };

                // Create redeem process
                const result = await createRedeemProcess(redeemData, {
                    adminId: interaction.user.id,
                    allianceContext: allianceContext
                });

                processResults.push({
                    alliance: alliance.name,
                    giftCode: giftCode.gift_code,
                    success: result.success,
                    processId: result.processId,
                    message: result.message
                });
            }
        }

        // Create summary embed
        const totalProcesses = processResults.length;
        const successfulProcesses = processResults.filter(r => r.success).length;
        const displayCode = selectedGiftCode === 'ALL_GIFT_CODES' ?
            `${giftCodesToRedeem.length} gift codes` : selectedGiftCode;

        const container = [
            new ContainerBuilder()
                .setAccentColor(successfulProcesses === totalProcesses ? 0x2ecc71 : 0xf39c12) // Green or Orange color
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.giftCode.redeemGiftCode.content.title.success}\n` +
                        `${lang.giftCode.redeemGiftCode.content.description.success
                            .replace('{code}', displayCode)
                            .replace('{count}', allianceIds.length.toString())}\n` +

                        `${lang.giftCode.redeemGiftCode.content.summeryField.name}\n` +
                        `${lang.giftCode.redeemGiftCode.content.summeryField.value
                            .replace('{total}', totalProcesses.toString())
                            .replace('{success}', successfulProcesses.toString())}`
                    )
                )
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

        // Log the manual redeem action
        systemLogQueries.addLog(
            'manual_redeem',
            `Manual redeem started by ${interaction.user.tag}`,
            JSON.stringify({
                user_id: interaction.user.id,
                username: interaction.user.tag,
                gift_codes: selectedGiftCode === 'ALL_GIFT_CODES' ?
                    giftCodesToRedeem.map(gc => gc.gift_code) : [selectedGiftCode],
                alliances: allianceIds,
                process_ids: processResults.map(r => r.processId).filter(Boolean),
                total_processes: totalProcesses,
                function: 'handleGiftCodeSelection'
            })
        );

    } catch (error) {
        await sendError(interaction, lang, error, 'handleGiftCodeSelection');
    }
}

module.exports = {
    createManualRedeemButton,
    handleManualRedeemButton,
    handleAllianceSelectionPagination,
    handleAllianceSelection,
    handleGiftCodeSelectionPagination,
    handleGiftCodeSelection
};
