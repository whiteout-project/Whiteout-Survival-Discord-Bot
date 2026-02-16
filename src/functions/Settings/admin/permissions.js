// Permission bit flags
const PERMISSIONS = {
    ALLIANCE_MANAGEMENT: 1 << 0,    // 1
    PLAYER_MANAGEMENT: 1 << 1,      // 2
    GIFT_CODE_MANAGEMENT: 1 << 2,   // 4
    NOTIFICATIONS_MANAGEMENT: 1 << 3, // 8
    FULL_ACCESS: 1 << 4             // 16
};

const { getEmojiMapForAdmin, getComponentEmoji } = require('../../utility/emojis');

/**
 * Gets permission descriptions using the language system
 * @param {Object} lang - Language object
 * @param {string} userId - User ID for emoji mapping
 * @returns {Object} Permission descriptions object
 */
function getPermissionDescriptions(lang, userId) {
    const emojiMap = getEmojiMapForAdmin(userId);
    return {
        [PERMISSIONS.ALLIANCE_MANAGEMENT]: {
            name: lang.permissions.alliance.name,
            description: lang.permissions.alliance.description,
            emoji: getComponentEmoji(emojiMap, '1001'),
            emoji_display: emojiMap['1001'] || getComponentEmoji(emojiMap, '1001')
        },
        [PERMISSIONS.PLAYER_MANAGEMENT]: {
            name: lang.permissions.players.name,
            description: lang.permissions.players.description,
            emoji: getComponentEmoji(emojiMap, '1027'),
            emoji_display: emojiMap['1027'] || getComponentEmoji(emojiMap, '1027')
        },
        [PERMISSIONS.GIFT_CODE_MANAGEMENT]: {
            name: lang.permissions.giftCodes.name,
            description: lang.permissions.giftCodes.description,
            emoji: getComponentEmoji(emojiMap, '1013'),
            emoji_display: emojiMap['1013'] || getComponentEmoji(emojiMap, '1013')
        },
        [PERMISSIONS.NOTIFICATIONS_MANAGEMENT]: {
            name: lang.permissions.notifications.name,
            description: lang.permissions.notifications.description,
            emoji: getComponentEmoji(emojiMap, '1022'),
            emoji_display: emojiMap['1022'] || getComponentEmoji(emojiMap, '1022')
        },
        [PERMISSIONS.FULL_ACCESS]: {
            name: lang.permissions.fullAccess.name,
            description: lang.permissions.fullAccess.description,
            emoji: getComponentEmoji(emojiMap, '1011'),
            emoji_display: emojiMap['1011'] || getComponentEmoji(emojiMap, '1011')
        }
    };
}

module.exports = {
    PERMISSIONS,
    getPermissionDescriptions
};
