const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
const { giftCodeQueries, giftCodeUsageQueries } = require('../utility/database');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { sendError, getAdminLang, assertUserMatches, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji, replaceEmojiPlaceholders } = require('../utility/emojis');

/**
 * Creates a view gift codes button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The view gift codes button
 */
function createViewGiftButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`view_gift_${userId}`)
        .setLabel(lang.giftCode.mainPage.buttons.viewGiftCodes)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1049'));
}

/**
 * Handle view gift codes button - Shows list of gift codes with usage statistics
 * @param {Object} interaction - Discord interaction
 * @returns {Promise<void>}
 */
async function handleViewGiftButton(interaction) {
    // Get language preference first (needed for all messages including errors)
    const { lang } = getAdminLang(interaction.user.id);

    try {
        // Extract user ID from custom ID for security check
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[2]; // view_gift_userId

        // Security check
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Get all gift codes from database
        const allGiftCodes = giftCodeQueries.getAllGiftCodes();

        if (!allGiftCodes || allGiftCodes.length === 0) {
            return await interaction.reply({
                content: lang.giftCode.viewGiftCodes.errors.noGiftCodes,
                ephemeral: true
            });
        }

        // Get usage counts for all gift codes in batch
        const giftCodeIds = allGiftCodes.map(code => code.gift_code);
        const usageCounts = giftCodeUsageQueries.getUsageCountsBatch(giftCodeIds);

        const giftCodesWithUsage = allGiftCodes.map(code => {
            return {
                ...code,
                usageCount: usageCounts[code.gift_code] || 0
            };
        });

        // Sort by usage count (descending) then by status
        giftCodesWithUsage.sort((a, b) => {
            if (b.usageCount !== a.usageCount) {
                return b.usageCount - a.usageCount;
            }
            return a.status === 'active' ? -1 : 1;
        });

        // Pagination settings
        const itemsPerPage = 10;
        const totalPages = Math.ceil(giftCodesWithUsage.length / itemsPerPage);
        const currentPage = 1;

        await displayGiftCodePage(interaction, giftCodesWithUsage, currentPage, totalPages, itemsPerPage, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleViewGiftButton');
    }
}

/**
 * Handle pagination for view gift codes
 * @param {Object} interaction - Discord interaction
 * @returns {Promise<void>}
 */
async function handleViewGiftPagination(interaction) {
    // Get language preference first (needed for all messages including errors)
    const { lang } = getAdminLang(interaction.user.id);

    try {

        // Parse pagination custom ID
        const { userId, newPage } = parsePaginationCustomId(interaction.customId, 0);

        // Security check
        if (!(await assertUserMatches(interaction, userId, lang))) return;

        // Get all gift codes from database
        const allGiftCodes = giftCodeQueries.getAllGiftCodes();

        if (!allGiftCodes || allGiftCodes.length === 0) {
            return await interaction.reply({
                content: lang.giftCode.viewGiftCodes.errors.noGiftCodes,
                ephemeral: true
            });
        }

        // Get usage counts for all gift codes in batch
        const giftCodeIds = allGiftCodes.map(code => code.gift_code);
        const usageCounts = giftCodeUsageQueries.getUsageCountsBatch(giftCodeIds);

        const giftCodesWithUsage = allGiftCodes.map(code => {
            return {
                ...code,
                usageCount: usageCounts[code.gift_code] || 0
            };
        });

        // Sort by usage count (descending) then by status
        giftCodesWithUsage.sort((a, b) => {
            if (b.usageCount !== a.usageCount) {
                return b.usageCount - a.usageCount;
            }
            return a.status === 'active' ? -1 : 1;
        });

        // Pagination settings
        const itemsPerPage = 10;
        const totalPages = Math.ceil(giftCodesWithUsage.length / itemsPerPage);

        await displayGiftCodePage(interaction, giftCodesWithUsage, newPage, totalPages, itemsPerPage, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleViewGiftPagination');
    }
}

/**
 * Display a page of gift codes
 * @param {Object} interaction - Discord interaction
 * @param {Array} giftCodes - Array of gift codes with usage data
 * @param {number} currentPage - Current page number
 * @param {number} totalPages - Total number of pages
 * @param {number} itemsPerPage - Items per page
 * @param {Object} lang - Language object

 */
async function displayGiftCodePage(interaction, giftCodes, currentPage, totalPages, itemsPerPage, lang) {
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const pageGiftCodes = giftCodes.slice(startIndex, endIndex);

    // Calculate statistics
    const totalCodes = giftCodes.length;
    const activeCodes = giftCodes.filter(c => c.status === 'active').length;
    const invalidCodes = giftCodes.filter(c => c.status === 'invalid').length;
    const totalUsages = giftCodes.reduce((sum, c) => sum + c.usageCount, 0);
    const vipCodes = giftCodes.filter(c => c.is_vip).length;

    // Create pagination buttons
    const paginationRow = createUniversalPaginationButtons({
        feature: 'view_gift',
        userId: interaction.user.id,
        currentPage: currentPage,
        totalPages: totalPages,
        lang: lang
    });

    const emojiMap = getEmojiMapForAdmin(interaction.user.id);

    const container = [
        new ContainerBuilder()
            .setAccentColor(3447003) // blue
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(        // Title with header formatting
                    `${lang.giftCode.viewGiftCodes.content.title}\n` +
                    lang.giftCode.viewGiftCodes.content.description
                        .replace('{totalCodesCount}', totalCodes)
                        .replace('{activeCodesCount}', activeCodes)
                        .replace('{invalidCodesCount}', invalidCodes)
                        .replace('{vipCodesCount}', vipCodes)
                        .replace('{totalUsages}', totalUsages)
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
            )
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    pageGiftCodes.map((code, index) => {
                        const statusEmoji = code.status === 'active' ? replaceEmojiPlaceholders('{emoji.1004}', emojiMap) : replaceEmojiPlaceholders('{emoji.1051}', emojiMap);
                        const vipBadge = code.is_vip ? replaceEmojiPlaceholders(' {emoji.1023}', emojiMap) : '';
                        const sourceInfo = code.source ? `${code.source}` : 'Unknown';
                        return `${startIndex + index + 1}. ${statusEmoji} \`${code.gift_code}\`${vipBadge}\n` +
                            lang.giftCode.viewGiftCodes.content.giftCodeDetails
                                .replace('{usageCount}', code.usageCount)
                                .replace('{source}', sourceInfo);
                    }).join('\n')
                )
            )
    ];

    if (totalPages > 1) {
        container[0].addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
        )
            .addActionRowComponents(
                new ActionRowBuilder().addComponents(paginationRow)
            );
    }

    const content = updateComponentsV2AfterSeparator(interaction, container);

    // Send or update the message
    await interaction.update({
        components: content,
        flags: MessageFlags.IsComponentsV2
    });
}

module.exports = {
    createViewGiftButton,
    handleViewGiftButton,
    handleViewGiftPagination
};
