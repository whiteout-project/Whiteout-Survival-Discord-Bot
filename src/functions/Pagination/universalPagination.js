const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../utility/emojis');

/**
 * Universal pagination helper for consistent button creation across all features
 * 
 * @param {Object} options - Pagination configuration
 * @param {string} options.feature - Feature name (e.g., 'edit_admin', 'view_alliance')
 * @param {string} [options.subtype] - Optional subtype (e.g., 'source', 'dest', 'player')
 * @param {string} options.userId - User ID who can interact with buttons
 * @param {number} options.currentPage - Current page number (0-indexed)
 * @param {number} options.totalPages - Total number of pages
 * @param {Object} options.lang - Language object for labels
 * @param {Array<string|number>} [options.contextData] - Optional context-specific data (e.g., [sourceId, destId])
 * @returns {ActionRowBuilder|null} Pagination button row or null if only one page
 */
function createUniversalPaginationButtons(options) {
    const {
        feature,
        subtype = null,
        userId,
        currentPage,
        totalPages,
        lang,
        contextData = []
    } = options;

    // No pagination needed for single page
    if (totalPages <= 1) return null;

    const paginationRow = new ActionRowBuilder();

    // Build base custom ID pattern
    // Format: {feature}_{subtype?}_prev/next_{userId}_{contextData...}_{currentPage}
    const baseId = subtype
        ? `${feature}_${subtype}`
        : feature;

    // Add context data to ID if provided
    const contextPart = contextData.length > 0
        ? `_${contextData.join('_')}`
        : '';

    const prevId = `${baseId}_prev_${userId}${contextPart}_${currentPage}`;
    const nextId = `${baseId}_next_${userId}${contextPart}_${currentPage}`;

    // Previous button
    paginationRow.addComponents(
        new ButtonBuilder()
            .setCustomId(prevId)
            .setLabel(lang.pagination.buttons.previous)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1019'))
            .setDisabled(currentPage === 0)
    );

    // Next button
    paginationRow.addComponents(
        new ButtonBuilder()
            .setCustomId(nextId)
            .setLabel(lang.pagination.buttons.next)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1034'))
            .setDisabled(currentPage >= totalPages - 1)
    );

    return paginationRow;
}

/**
 * Parses pagination button custom ID to extract data
 * 
 * @param {string} customId - The button's custom ID
 * @param {number} contextDataCount - Number of context data elements expected (for validation)
 * @returns {Object} Parsed pagination data
 * @returns {string} return.feature - Feature name
 * @returns {string|null} return.subtype - Subtype if present
 * @returns {string} return.direction - 'prev' or 'next'
 * @returns {string} return.userId - User ID
 * @returns {number} return.currentPage - Current page number
 * @returns {Array<string>} return.contextData - Array of context data
 */
function parsePaginationCustomId(customId, contextDataCount = 0) {
    const parts = customId.split('_');

    // Find indices of key components
    const directionIndex = parts.findIndex(p => p === 'prev' || p === 'next');
    if (directionIndex === -1) {
        throw new Error(`Invalid pagination custom ID: no direction found in "${customId}"`);
    }

    const direction = parts[directionIndex];
    const userId = parts[directionIndex + 1];

    // Current page is always the last element
    const currentPage = parseInt(parts[parts.length - 1]);
    if (isNaN(currentPage)) {
        throw new Error(`Invalid pagination custom ID: page number is not valid in "${customId}"`);
    }

    // Context data is between userId and currentPage
    const contextStartIndex = directionIndex + 2;
    const contextEndIndex = parts.length - 1;
    const contextData = parts.slice(contextStartIndex, contextEndIndex);

    // Validate context data count if specified
    if (contextDataCount > 0 && contextData.length !== contextDataCount) {
        console.warn(
            `⚠️ Context data count mismatch in pagination: expected ${contextDataCount}, got ${contextData.length} in "${customId}"`
        );
    }

    // Feature and subtype are before direction
    const featureParts = parts.slice(0, directionIndex);
    let feature, subtype = null;

    if (featureParts.length > 2) {
        // Has subtype: feature_subtype_direction
        feature = featureParts.slice(0, -1).join('_');
        subtype = featureParts[featureParts.length - 1];
    } else if (featureParts.length === 2) {
        // Could be feature_subtype or feature only
        // Check if last part looks like a subtype (common ones: source, dest, player, alliance, admin)
        const possibleSubtype = featureParts[1];
        if (['source', 'dest', 'player', 'alliance', 'admin', 'logs'].includes(possibleSubtype)) {
            feature = featureParts[0];
            subtype = possibleSubtype;
        } else {
            feature = featureParts.join('_');
        }
    } else {
        feature = featureParts[0];
    }

    return {
        feature,
        subtype,
        direction,
        userId,
        currentPage,
        contextData,
        newPage: direction === 'next' ? currentPage + 1 : currentPage - 1
    };
}

/**
 * Example usage patterns for different features:
 * 
 * // Simple pagination (no subtype, no context)
 * createUniversalPaginationButtons({
 *     feature: 'view_alliances',
 *     userId: interaction.user.id,
 *     currentPage: 0,
 *     totalPages: 5,
 *     lang: lang
 * });
 * // Creates: view_alliances_prev_userId_0 and view_alliances_next_userId_0
 * 
 * // With subtype and context
 * createUniversalPaginationButtons({
 *     feature: 'move_players',
 *     subtype: 'source',
 *     userId: interaction.user.id,
 *     currentPage: 2,
 *     totalPages: 10,
 *     lang: lang
 * });
 * // Creates: move_players_source_prev_userId_2 and move_players_source_next_userId_2
 * 
 * // With multiple context data
 * createUniversalPaginationButtons({
 *     feature: 'move_players',
 *     subtype: 'player',
 *     userId: interaction.user.id,
 *     currentPage: 1,
 *     totalPages: 3,
 *     lang: lang,
 *     contextData: [sourceAllianceId, destAllianceId]
 * });
 * // Creates: move_players_player_prev_userId_sourceId_destId_1
 * 
 * // Parsing example
 * const parsed = parsePaginationCustomId('edit_admin_next_123456_3', 0);
 * // Returns: { feature: 'edit_admin', subtype: null, direction: 'next', 
 * //           userId: '123456', currentPage: 3, newPage: 4, contextData: [] }
 */

module.exports = {
    createUniversalPaginationButtons,
    parsePaginationCustomId
};
