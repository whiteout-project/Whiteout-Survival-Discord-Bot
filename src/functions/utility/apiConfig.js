/**
 * Shared API configuration
 * All API secrets and URLs are centralized here.
 * Secrets are read from environment variables with hardcoded fallbacks for backward compatibility.
 */

const API_CONFIG = {
    SECRET: 'tB87#kPtkxqOS2',
    API_URL: 'https://wos-giftcode-api.centurygame.com/api/player', // Alias for PLAYER_URL
    PLAYER_URL: 'https://wos-giftcode-api.centurygame.com/api/player',
    PLAYER_URL_2: 'https://gof-report-api-formal.centurygame.com/api/player',
    GIFT_CODE_URL: 'https://wos-giftcode-api.centurygame.com/api/gift_code',
    CAPTCHA_URL: 'https://wos-giftcode-api.centurygame.com/api/captcha',
    ORIGIN: 'https://wos-giftcode.centurygame.com',
    ORIGIN_2: 'https://gof-report-api-formal.centurygame.com',
    RATE_LIMIT_DELAY: 60000, // 60 seconds
    RETRY_DELAY: 3000, // 3 seconds
    MAX_RETRIES: 3,
    MAX_CAPTCHA_ATTEMPTS: 10,
    UPDATE_INTERVAL: 10, // Update embed every 10 processed players
    MEMBER_PROCESS_DELAY_MIN: 700,   // min inter-player delay ms 
    MEMBER_PROCESS_DELAY_MAX: 1300,  // max inter-player delay ms 
    MAX_RETRY_CYCLES: 10,           // max retry cycles per player for rate limits / captcha exhaustion
    CAPTCHA_CYCLE_COOLDOWN: 30000   // 30s cooldown before re-attempting a captcha-exhausted player
};

const GIFT_CODE_API_CONFIG = {
    API_KEY: 'super_secret_bot_token_nobody_will_ever_find',
    API_URL: 'http://gift-code-api.whiteout-bot.com/giftcode_api.php',
};

module.exports = { API_CONFIG, GIFT_CODE_API_CONFIG };
