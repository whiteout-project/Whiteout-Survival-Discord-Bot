const { ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, TextDisplayBuilder, StringSelectMenuBuilder, ActionRowBuilder, SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
const { allianceQueries } = require('../utility/database');
const { parsePaginationCustomId, createUniversalPaginationButtons } = require('../Pagination/universalPagination');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { hasPermission, sendError, getAdminLang, assertUserMatches, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../utility/emojis');

/**
 * Creates a toggle auto-redeem button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The toggle auto-redeem button
 */
function createToggleAutoRedeemButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`toggle_auto_redeem_${userId}`)
        .setLabel(lang.giftCode.autoRedeem.buttons.toggleAutoRedeem)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1033')); // refresh/shuffle emoji
}

/**
 * Handle toggle auto-redeem button - Shows list of alliances to select
 * @param {Object} interaction - Discord interaction
 * @returns {Promise<void>}
 */
async function handleToggleAutoRedeemButton(interaction) {
    // Get language preference first (needed for all messages including errors)
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        // Extract user ID from custom ID for security check
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[3]; // toggle_auto_redeem_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions: must be owner, have FULL_ACCESS, or have ALLIANCE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.ALLIANCE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get all alliances from database
        const allAlliances = allianceQueries.getAllAlliances();

        if (!allAlliances || allAlliances.length === 0) {
            return await interaction.reply({
                content: lang.alliance.errors.noAlliances,
                ephemeral: true
            });
        }

        // Display the alliance selection
        await displayToggleAutoRedeemPage(interaction, allAlliances, 0, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleToggleAutoRedeemButton');
    }
}

/**
 * Display alliance selection for toggle auto-redeem
 * @param {Object} interaction - Discord interaction
 * @param {Array} allAlliances - All alliances from database
 * @param {number} page - Current page number (0-indexed)
 * @param {Object} lang - Language object
 * @returns {Promise<void>}
 */
async function displayToggleAutoRedeemPage(interaction, allAlliances, page, lang) {
    // Filter alliances based on showAll parameter (show only assigned alliances)
    const { adminQueries } = require('../utility/database');
    let filteredAlliances = allAlliances;
    const adminData = adminQueries.getAdmin(interaction.user.id);
    const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

    if (!hasFullAccess) {
        // Filter to only assigned alliances
        const assignedAllianceIds = JSON.parse(adminData?.alliances || '[]');
        filteredAlliances = allAlliances.filter(alliance =>
            assignedAllianceIds.includes(alliance.id)
        );
    }

    const itemsPerPage = 24;
    const totalPages = Math.ceil(filteredAlliances.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const currentPageAlliances = filteredAlliances.slice(startIndex, endIndex);

    // Custom option mapper to show auto-redeem status
    const optionMapper = (alliance) => ({
        label: alliance.name,
        description: lang.giftCode.autoRedeem.selectMenu.selectAlliances.description.replace('{priority}', alliance.priority).replace('{autoRedeemStatus}', alliance.auto_redeem ? lang.giftCode.autoRedeem.selectMenu.selectAlliances.enabled : lang.giftCode.autoRedeem.selectMenu.selectAlliances.disabled),
        value: alliance.id.toString(),
        emoji: getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1001') // shield emoji
    });

    const selectOptions = currentPageAlliances.map(optionMapper);

    // Create dropdown menu
    const allianceSelect = new StringSelectMenuBuilder()
        .setCustomId(`toggle_auto_redeem_select_${interaction.user.id}_${page}`)
        .setPlaceholder(lang.giftCode.autoRedeem.selectMenu.selectAlliances.placeholder)
        .setMaxValues(selectOptions.length) // Cannot exceed the number of available options
        .addOptions(selectOptions);

    const selectRow = new ActionRowBuilder().addComponents(allianceSelect);
    const components = [];

    // Add pagination buttons
    const paginationConfig = {
        feature: 'toggle_auto_redeem',
        userId: interaction.user.id,
        currentPage: page,
        totalPages,
        lang
    };

    components.push(selectRow);

    const paginationRow = createUniversalPaginationButtons(paginationConfig);
    if (paginationRow) {
        components.push(paginationRow);
    }

    // Build container
    const container = [
        new ContainerBuilder()
            .setAccentColor(2417109) // blue
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.giftCode.autoRedeem.content.title.base}\n${lang.giftCode.autoRedeem.content.description}\n${lang.pagination.text.pageInfo}`
                        .replace('{current}', (page + 1).toString())
                        .replace('{total}', totalPages.toString())
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addActionRowComponents(components)
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    await interaction.update({
        components: content,
        flags: MessageFlags.IsComponentsV2
    });
}

/**
 * Handle pagination for toggle auto-redeem list
 * @param {Object} interaction - Discord interaction
 * @returns {Promise<void>}
 */
async function handleToggleAutoRedeemPagination(interaction) {
    // Get language preference first 
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {

        // Parse pagination data from custom ID
        const { userId, newPage } = parsePaginationCustomId(interaction.customId, 0);

        if (interaction.user.id !== userId) {
            return await interaction.reply({
                content: lang.common.notForYou,
                ephemeral: true
            });
        }

        // Check permissions: must be owner, have FULL_ACCESS, or have ALLIANCE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.ALLIANCE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get all alliances again
        const allAlliances = allianceQueries.getAllAlliances();

        if (!allAlliances || allAlliances.length === 0) {
            return await interaction.reply({
                content: lang.giftCode.autoRedeem.errors.noAlliances,
                ephemeral: true
            });
        }

        // Display the new page
        await displayToggleAutoRedeemPage(interaction, allAlliances, newPage, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleToggleAutoRedeemPagination');
    }
}

/**
 * Handle alliance selection for toggle auto-redeem
 * @param {Object} interaction - Discord interaction
 * @returns {Promise<void>}
 */
async function handleToggleAutoRedeemSelect(interaction) {
    // Get language preference first
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        // Extract user ID from custom ID for security check
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[4]; // toggle_auto_redeem_select_userId

        // Security check
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions: must be owner, have FULL_ACCESS, or have ALLIANCE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.ALLIANCE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const selectedAllianceIds = interaction.values; // Array of selected alliance IDs (strings)

        // Toggle auto_redeem for each selected alliance
        const enabledAlliances = [];
        const disabledAlliances = [];

        for (const allianceIdStr of selectedAllianceIds) {
            const allianceId = parseInt(allianceIdStr);
            const alliance = allianceQueries.getAllianceById(allianceId);
            if (!alliance) continue;

            const newAutoRedeem = alliance.auto_redeem ? 0 : 1; // Invert

            // Update the database
            allianceQueries.updateAlliance(
                alliance.priority,
                alliance.name,
                alliance.guide_id,
                alliance.channel_id,
                alliance.interval,
                newAutoRedeem,
                alliance.id
            );

            if (newAutoRedeem) {
                enabledAlliances.push(alliance.name);
            } else {
                disabledAlliances.push(alliance.name);
            }
        }

        // Build the result display
        let resultText = `${lang.giftCode?.autoRedeem.content.title.results}\n`;

        if (enabledAlliances.length > 0) {
            resultText += `${lang.giftCode.autoRedeem.content.enabledField.name}\n`;
            resultText += enabledAlliances.map(name => lang.giftCode.autoRedeem.content.enabledField.value.replace('{enabledAlliances}', name)).join('\n') + '\n';
        }

        if (disabledAlliances.length > 0) {
            resultText += `${lang.giftCode.autoRedeem.content.disabledField.name}\n`;
            resultText += disabledAlliances.map(name => lang.giftCode.autoRedeem.content.disabledField.value.replace('{disabledAlliances}', name)).join('\n');
        }

        const container = [
            new ContainerBuilder()
                .setAccentColor(enabledAlliances.length > 0 && disabledAlliances.length === 0 ? 65280 : (disabledAlliances.length > 0 && enabledAlliances.length === 0 ? 16711680 : 16776960)) // Green, Red, or Yellow
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(resultText)
                )
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleToggleAutoRedeemSelect');
    }
}

module.exports = {
    createToggleAutoRedeemButton,
    handleToggleAutoRedeemButton,
    handleToggleAutoRedeemSelect,
    handleToggleAutoRedeemPagination
};
