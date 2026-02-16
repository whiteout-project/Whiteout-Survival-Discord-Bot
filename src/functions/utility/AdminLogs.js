const { adminLogQueries } = require('./database');

/**
 * Admin Log Codes System
 * Code ranges:
 * - Alliance: 10000-19999
 * - Players: 20000-29999
 * - Notification: 40000-49999
 * - Settings: 50000-59999
 */

const LOG_CODES = {
    // Alliance Management (10000-19999)
    ALLIANCE: {
        CREATED_PENDING: 10001,
        SETUP_COMPLETED: 10002,
        UPDATED_NAME: 10003,
        UPDATED_CHANNEL: 10004,
        DELETE_REQUESTED: 10005,
        DELETED: 10006,
        DELETE_DENIED: 10007
    },

    // Player Management (20000-29999)
    PLAYERS: {
        REMOVED: 20001
    },

    // Notification Management (40000-49999)
    NOTIFICATION: {
        CREATED: 40001,
        MESSAGE_UPDATED: 40002,
        EMBED_TOGGLED: 40003,
        EMBED_UPDATED: 40004,
        PATTERN_SET: 40005,
        PATTERN_CUSTOM: 40006,
        REPEAT_SET: 40007,
        SETUP_COMPLETED: 40008,
        TIME_UPDATED: 40009,
        DELETED: 40010,
        EDITED: 40011,
        EXPORTED: 40012,
        IMPORTED: 40013
    },

    // Settings Management (50000-59999)
    SETTINGS: {
        ADMIN_ADDED: 50001,
        ADMIN_REMOVED: 50002,
        PERMISSIONS_UPDATED: 50003,
        ID_CHANNEL_LINKED: 50004,
        ID_CHANNEL_UNLINKED: 50005
    }
};

/**
 * Get category from log code
 * @param {number} code - Log code
 * @returns {string} Category name (alliance, players, giftcode, notification, settings)
 */
function getCodeCategory(code) {
    if (code >= 10000 && code < 20000) return 'alliance';
    if (code >= 20000 && code < 30000) return 'players';
    if (code >= 40000 && code < 50000) return 'notification';
    if (code >= 50000 && code < 60000) return 'settings';
    return 'unknown';
}

/**
 * Get code ranges for types filter
 * @param {Array<string>} types - Array of type names (e.g., ['alliance', 'players'])
 * @returns {Array<{min: number, max: number}>} Array of code ranges
 */
function getCodeRangesForTypes(types) {
    const typeRanges = {
        alliance: { min: 10000, max: 19999 },
        players: { min: 20000, max: 29999 },
        notification: { min: 40000, max: 49999 },
        settings: { min: 50000, max: 59999 }
    };

    return types.map(type => typeRanges[type.toLowerCase()]).filter(Boolean);
}

/**
 * Get log code name from code number
 * @param {number} code - Log code
 * @returns {string|null} Log code name (e.g., 'CREATED', 'DELETED')
 */
function getLogCodeName(code) {
    for (const category in LOG_CODES) {
        for (const [name, value] of Object.entries(LOG_CODES[category])) {
            if (value === code) {
                return name;
            }
        }
    }
    return null;
}

/**
 * Replace placeholders in template string with data
 * @param {string} template - Template string with {placeholders}
 * @param {Object} data - Data object with values
 * @returns {string} Formatted string
 */
function replacePlaceholders(template, data) {
    if (!template || typeof template !== 'string') return '';
    if (!data) return template;

    return template.replace(/\{(\w+)\}/g, (match, key) => {
        if (data.hasOwnProperty(key)) {
            const value = data[key];
            // Handle null/undefined
            if (value === null || value === undefined) return '{missing}';
            return String(value);
        }
        return '{missing}';
    });
}

/**
 * Get i18n key path for log code
 * @param {number} code - Log code
 * @returns {string} Dot-notation path (e.g., 'logs.alliance.created')
 */
function getI18nKeyForCode(code) {
    const category = getCodeCategory(code);
    const codeName = getLogCodeName(code);

    if (!codeName) return null;

    // Convert CREATED_PENDING to createdPending (camelCase)
    const actionName = codeName.toLowerCase().replace(/_([a-z])/g, (g) => g[1].toUpperCase());

    return `logs.${category}.${actionName}`;
}

/**
 * Format a single log entry
 * @param {Object} log - Log entry from database
 * @param {Object} lang - Language object
 * @returns {Object} Formatted log with {id, timestamp, message, rawData, code, category}
 */
function formatLogEntry(log, lang) {
    const timestamp = new Date(log.time).toLocaleString();

    // Parse details JSON
    let details = {};
    if (log.details) {
        try {
            details = JSON.parse(log.details);
        } catch (error) {
            details = { parseError: true };
        }
    }

    // Get i18n template
    const i18nKey = getI18nKeyForCode(log.log_code);
    if (!i18nKey) {
        return {
            id: log.id,
            timestamp: timestamp,
            message: `Unknown log code: ${log.log_code}`,
            rawData: details,
            code: log.log_code,
            category: getCodeCategory(log.log_code)
        };
    }

    const keyParts = i18nKey.split('.');

    // Navigate to nested key (e.g., lang.logs.alliance.created)
    let template = lang;
    for (const part of keyParts) {
        template = template?.[part];
        if (!template) break;
    }

    // Handle missing template
    if (!template || typeof template !== 'string') {
        return {
            id: log.id,
            timestamp: timestamp,
            message: `Missing template for: ${i18nKey}`,
            rawData: details,
            code: log.log_code,
            category: getCodeCategory(log.log_code)
        };
    }

    // Replace placeholders
    const message = replacePlaceholders(template, details);

    return {
        id: log.id,
        timestamp: timestamp,
        message: message,
        rawData: details,
        code: log.log_code,
        category: getCodeCategory(log.log_code)
    };
}

/**
 * Parse range string to get start and end indices
 * @param {string} range - Range string (e.g., "30-40", "all")
 * @param {number} totalLogs - Total number of logs
 * @returns {{start: number, end: number}} Start and end indices (1-based, inclusive)
 */
function parseRange(range, totalLogs) {
    if (range === 'all' || !range) {
        return { start: 1, end: totalLogs };
    }

    const match = range.match(/^(\d+)-(\d+)$/);
    if (!match) {
        throw new Error(`Invalid range format: ${range}. Expected format: "30-40" or "all"`);
    }

    const start = parseInt(match[1]);
    const end = parseInt(match[2]);

    if (start < 1 || end < start) {
        throw new Error(`Invalid range: ${range}. Start must be >= 1 and end must be >= start`);
    }

    return { start, end };
}

/**
 * Format admin logs with i18n support
 * @param {Object} lang - Language object from i18n
 * @param {string} adminUserId - Discord user ID of admin
 * @param {Object} options - Filtering options
 * @param {string} options.range - Range of logs to retrieve (e.g., "30-40", "all")
 * @param {Array<string>} options.types - Array of log types to filter (e.g., ['alliance', 'players']). Null/undefined = all types
 * @param {number} options.limit - Maximum number of logs to return (overrides range)
 * @param {number} options.offset - Number of logs to skip (for pagination)
 * @returns {Array<Object>} Array of formatted logs
 */
function formatLogs(lang, adminUserId, options = {}) {
    const {
        range = 'all',
        types = null,
        limit = null,
        offset = 0
    } = options;

    try {
        let logs = [];

        // If types filter is specified, use code range queries
        if (types && Array.isArray(types) && types.length > 0) {
            const codeRanges = getCodeRangesForTypes(types);

            if (codeRanges.length === 0) {
                // No valid types specified
                return [];
            } else if (codeRanges.length === 1) {
                // Single type - use getLogsByCodeRange
                const range = codeRanges[0];
                logs = adminLogQueries.getLogsByCodeRange(
                    adminUserId,
                    range.min,
                    range.max,
                    limit || 9999,
                    offset
                );
            } else {
                // Multiple types - use DB helper to fetch only matching ranges with limit/offset
                logs = adminLogQueries.getLogsByCodeRanges(adminUserId, codeRanges, limit || 9999, offset);
            }
        } else {
            // No types filter - get all logs
            if (limit !== null) {
                logs = adminLogQueries.getAdminLogs(adminUserId, limit, offset);
            } else {
                logs = adminLogQueries.getLogsByUser(adminUserId);

                // Apply range if specified
                if (range !== 'all') {
                    const totalLogs = logs.length;
                    const { start, end } = parseRange(range, totalLogs);

                    // Convert to 0-based indices
                    const startIdx = start - 1;
                    const endIdx = Math.min(end, totalLogs);

                    logs = logs.slice(startIdx, endIdx);
                }
            }
        }

        // Format all logs
        return logs.map(log => formatLogEntry(log, lang));

    } catch (error) {
        // Return error info
        return [{
            id: -1,
            timestamp: new Date().toLocaleString(),
            message: `Error formatting logs: ${error.message}`,
            rawData: { error: error.message },
            code: null,
            category: 'error'
        }];
    }
}

module.exports = {
    LOG_CODES,
    formatLogs,
    getCodeCategory,
    getCodeRangesForTypes,
    getLogCodeName,
    getI18nKeyForCode,
    formatLogEntry,
    replacePlaceholders
};
