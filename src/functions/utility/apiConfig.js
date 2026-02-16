/**
 * Shared API configuration
 * All API secrets and URLs are centralized here.
 * Secrets are read from environment variables with hardcoded fallbacks for backward compatibility.
 */

const API_CONFIG = {
    SECRET: process.env.API_SECRET || 'tB87#kPtkxqOS2',
    API_URL: 'https://wos-giftcode-api.centurygame.com/api/player', // Alias for PLAYER_URL
    PLAYER_URL: 'https://wos-giftcode-api.centurygame.com/api/player',
    GIFT_CODE_URL: 'https://wos-giftcode-api.centurygame.com/api/gift_code',
    CAPTCHA_URL: 'https://wos-giftcode-api.centurygame.com/api/captcha',
    ORIGIN: 'https://wos-giftcode.centurygame.com',
    RATE_LIMIT_DELAY: 60000, // 60 seconds
    RETRY_DELAY: 3000, // 3 seconds
    MAX_RETRIES: 3,
    MAX_CAPTCHA_ATTEMPTS: 5,
    UPDATE_INTERVAL: 10, // Update embed every 10 processed players
    BETWEEN_REDEMPTIONS_DELAY: 2050 // 2.05 second delay between each player redemption
};

const GIFT_CODE_API_CONFIG = {
    API_KEY: process.env.GIFT_CODE_API_KEY || 'super_secret_bot_token_nobody_will_ever_find',
    API_URL: 'http://gift-code-api.whiteout-bot.com/giftcode_api.php',
};

module.exports = { API_CONFIG, GIFT_CODE_API_CONFIG };
