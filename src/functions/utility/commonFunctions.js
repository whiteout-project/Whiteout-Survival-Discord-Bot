const { adminQueries, systemLogQueries } = require('./database');
const { SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
const languages = require('../../i18n');
const { getEmojiMapForAdmin, wrapLangWithEmojis, getComponentEmoji } = require('./emojis');
const path = require('path');

// Detect project root (where package.json is located)
const PROJECT_ROOT = path.resolve(__dirname, '../../../');

/**
 * Returns admin data and language object for a given user id.
 * The lang object automatically replaces {emoji.XXX} placeholders.
 * { adminData, userLang, lang }
 */
function getAdminLang(userId) {
    const adminData = adminQueries.getAdmin(userId);
    const userLang = adminData?.language || 'en';
    const baseLang = languages[userLang] || languages['en'];
    const emojiMap = getEmojiMapForAdmin(userId);
    const lang = wrapLangWithEmojis(baseLang, emojiMap);
    return { adminData, userLang, lang };
}

/**
 * Security helper to ensure an interaction is performed by the expected user.
 * Replies ephemeral with localized message when check fails.
 */
async function assertUserMatches(interaction, expectedUserId, lang) {
    try {
        if (String(interaction.user.id) !== String(expectedUserId)) {
            await interaction.reply({ content: lang?.common?.notForYou || 'This is not for you.', ephemeral: true });
            return false;
        }
        return true;
    } catch (err) {
        try {
            systemLogQueries.addLog('error', `assertUserMatches error: ${err.message}`, JSON.stringify({ user_id: interaction.user?.id, error: err.message, function: 'assertUserMatches' }));
        } catch (logErr) { /* swallow */ }
        return false;
    }
}

/**
 * Sanitizes file paths in stack traces to remove absolute paths
 * Works for any user by converting absolute paths to relative paths from project root
 * Example: "C:\Users\anyone\anywhere\project\src\file.js" → "src\file.js"
 */
function sanitizeStackTrace(stack) {
    if (!stack) return 'No stack trace available';

    // Escape special regex characters in project root path
    const escapedRoot = PROJECT_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Create regex to match project root with both forward and backward slashes
    const rootPattern = new RegExp(escapedRoot.replace(/\\\\/g, '[\\\\/]'), 'gi');

    // Replace absolute paths with relative paths
    let sanitized = stack.replace(rootPattern, '');

    // Remove file:/// protocol
    sanitized = sanitized.replace(/file:\/\/\//gi, '');

    // Clean up leading slashes/backslashes
    sanitized = sanitized.replace(/(\n\s+at\s+)[\\/]+/g, '$1');

    // Remove any remaining absolute path indicators (node_modules, etc.)
    sanitized = sanitized.replace(/[\\/]node_modules[\\/]/g, 'node_modules/');

    return sanitized;
}

/**
 * Check if error should be silently ignored (expected errors)
 * @param {Error} error - The error object
 * @returns {boolean} True if error should be ignored
 */
function shouldIgnoreError(error) {
    // Discord API errors that are expected after migration
    const ignoredCodes = [
        10003, // Unknown Channel - channel doesn't exist or bot has no access
        10013, // Unknown User - user doesn't exist or bot can't access
        50001, // Missing Access - bot removed from server
        50013  // Missing Permissions - bot lacks permissions
    ];

    // Check if it's a DiscordAPIError with an ignorable code
    if (error.code && ignoredCodes.includes(error.code)) {
        return true;
    }

    // Check error message for common patterns
    const ignoredPatterns = [
        /Unknown Channel/i,
        /Unknown User/i,
        /Missing Access/i,
        /Missing Permissions/i
    ];

    return ignoredPatterns.some(pattern => pattern.test(error.message));
}

/**
 * Centralized error handler: logs to system log and attempts to reply/followUp with localized error.
 */
async function sendError(interaction, lang, error, functionName = '', shouldReply = true) {
    try {
        // Silently ignore expected errors (Unknown Channel, Unknown User, etc.)
        if (shouldIgnoreError(error)) {
            return;
        }

        // Ensure lang is never null - use fallback if needed
        const safeLang = lang || languages['en'] || { common: { error: 'An error occurred' } };

        // Sanitize stack trace for database storage
        const sanitizedStack = sanitizeStackTrace(error.stack);

        // Enhanced error details for database
        const errorDetails = {
            user_id: interaction?.user?.id,
            guild_id: interaction?.guild?.id,
            channel_id: interaction?.channel?.id,
            interaction_type: interaction?.type,
            custom_id: interaction?.customId,
            function: functionName,
            error_name: error.name,
            error_message: error.message,
            error_code: error.code,
            stack_trace: sanitizedStack,
            timestamp: new Date().toISOString()
        };

        // Log to database with full sanitized details
        systemLogQueries.addLog(
            'error',
            `${functionName ? functionName + ': ' : ''}${error.message}`,
            JSON.stringify(errorDetails, null, 2)
        );

        // Enhanced console logging with full details
        console.error('\n' + '='.repeat(80));
        console.error(`[ERROR] ${new Date().toISOString()}`);
        console.error('='.repeat(80));
        console.error(`Function: ${functionName || 'Unknown'}`);
        console.error('-'.repeat(80));
        console.error(`Error Message: ${error.message || 'No message'}`);
        console.error('-'.repeat(80));
        console.error('Stack Trace:');
        console.error(error.stack || 'No stack trace available');
        console.error('='.repeat(80) + '\n');

        const errorMessage = safeLang?.common?.error || 'An error occurred';

        if (shouldReply && interaction) {
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: errorMessage, ephemeral: true });
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            }
        }
    } catch (responseError) {
        // Log response error to console as well
        console.error('\n' + '!'.repeat(80));
        console.error(`[CRITICAL] Error in sendError function - ${new Date().toISOString()}`);
        console.error('!'.repeat(80));
        console.error(`Original Error: ${error?.message || 'Unknown'}`);
        console.error(`Response Error: ${responseError.message}`);
        console.error(`Function: ${functionName || 'Unknown'}`);
        console.error('!'.repeat(80) + '\n');

        try {
            systemLogQueries.addLog('error', `Error sending error response: ${responseError.message}`, JSON.stringify({ user_id: interaction?.user?.id, original_error: error?.message, response_error: responseError.message, function: 'sendError' }));
        } catch (logErr) { /* swallow */ }
    }
}

/**
 * Checks if the admin has at least one of the specified permissions, or is an owner.
 * @param {Object} adminData - The admin data object from the database.
 * @param {...number} permissions - The permission flags to check (from PERMISSIONS).
 * @returns {boolean} True if the admin is owner or has at least one of the permissions.
 */
function hasPermission(adminData, ...permissions) {
    if (adminData?.is_owner) return true;
    for (const perm of permissions) {
        if (adminData?.permissions & perm) return true;
    }
    return false;
}

/**
 * Updates Components v2 interaction by replacing content after separator or adding new section.
 * Common pattern used in multi-step interactions (pagination, selections, etc.)
 * @param {Object} interaction - The Discord interaction object
 * @param {Array} newSection - Array of new components to add (ContainerBuilder, etc.)
 * @returns {Array} Updated components array ready for interaction.update()
 */
function updateComponentsV2AfterSeparator(interaction, newSection) {
    const currentComponents = interaction.message.components;
    const mainContainer = currentComponents[0];
    const separatorIndex = currentComponents.findIndex(c => c.type === 102); // 102 = separator

    let updatedComponents;
    if (separatorIndex === -1) {
        // No separator -> add one and append new section
        const separator = new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true);
        updatedComponents = [
            mainContainer,
            separator,
            ...newSection
        ];
    } else {
        // Separator exists -> replace everything after it
        updatedComponents = [
            mainContainer,
            currentComponents[separatorIndex],
            ...newSection
        ];
    }

    return updatedComponents;
}

/**
 * Creates a paginated alliance selection embed with customizable options
 * @param {Object} options - Configuration options
 * @param {Object} options.interaction - Discord interaction object
 * @param {Array} options.alliances - Array of alliance objects
 * @param {Object} options.lang - Language object
 * @param {number} [options.page=0] - Current page number
 * @param {string} options.customIdPrefix - Prefix for customId (e.g., 'alliance_select_add_player')
 * @param {string} options.feature - Pagination feature name
 * @param {string} [options.subtype] - Pagination subtype (optional)
 * @param {string} options.placeholder - Placeholder text for select menu
 * @param {string} options.title - Embed title
 * @param {string} options.description - Embed description
 * @param {number} [options.accentColor=0x3498db] - Accent color (default blue)
 * @param {Function} [options.optionMapper] - Custom function to map alliance to option object
 * @param {boolean} [options.showAll=true] - If true, show all alliances. If false, filter to assigned alliances only
 * @returns {Object} { components } ready for interaction.update()
 */
function createAllianceSelectionComponents(options) {
    const {
        interaction,
        alliances,
        lang,
        page = 0,
        customIdPrefix,
        feature,
        subtype = null,
        placeholder,
        title,
        description,
        accentColor = 0x3498db,
        optionMapper = null,
        showAll = true
    } = options;

    const { StringSelectMenuBuilder, ActionRowBuilder, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
    const { createUniversalPaginationButtons } = require('../Pagination/universalPagination');
    const { PERMISSIONS } = require('../Settings/admin/permissions');

    // Filter alliances based on showAll parameter
    let filteredAlliances = alliances;
    if (!showAll) {
        const adminData = adminQueries.getAdmin(interaction.user.id);
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

        if (!hasFullAccess) {
            // Filter to only assigned alliances
            const assignedAllianceIds = JSON.parse(adminData?.alliances || '[]');
            filteredAlliances = alliances.filter(alliance =>
                assignedAllianceIds.includes(alliance.id)
            );
        }
    }

    const itemsPerPage = 24;
    const totalPages = Math.ceil(filteredAlliances.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const currentPageAlliances = filteredAlliances.slice(startIndex, endIndex);

    // Create dropdown options using custom mapper or default
    const defaultMapper = (alliance) => ({
        label: alliance.name,
        value: alliance.id.toString(),
        emoji: getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1001')
    });
    const mapperFn = optionMapper || defaultMapper;
    const selectOptions = currentPageAlliances.map(mapperFn);

    // Create dropdown menu
    const allianceSelect = new StringSelectMenuBuilder()
        .setCustomId(`${customIdPrefix}_${interaction.user.id}_${page}`)
        .setPlaceholder(placeholder)
        .addOptions(selectOptions);

    const selectRow = new ActionRowBuilder().addComponents(allianceSelect);
    const components = [];

    // Add pagination buttons
    const paginationConfig = {
        feature,
        userId: interaction.user.id,
        currentPage: page,
        totalPages,
        lang
    };
    if (subtype) paginationConfig.subtype = subtype;

    components.push(selectRow);

    const paginationRow = createUniversalPaginationButtons(paginationConfig);
    if (paginationRow) {
        components.push(paginationRow);
    }

    // Build container
    const container = [
        new ContainerBuilder()
            .setAccentColor(accentColor)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${title}\n${description}\n${lang.pagination.text.pageInfo}`
                        .replace('{current}', (page + 1).toString())
                        .replace('{total}', totalPages.toString())
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addActionRowComponents(components)
    ];

    return { components: updateComponentsV2AfterSeparator(interaction, container) };
}

/**
 * Parses and validates refresh interval input.
 * Supports both minute-based (e.g., "60") and time-based (e.g., "@2:30") formats.
 * @param {string} input - The refresh interval input from user
 * @param {Object} lang - Language object for translations
 * @returns {{isValid: boolean, type: 'minutes'|'time'|null, value: number|string|null, error: string|null}}
 */
function parseRefreshInterval(input, lang) {
    const trimmed = input.trim();

    // Check if it's time-based format (@HH:MM)
    if (trimmed.startsWith('@')) {
        const timeStr = trimmed.substring(1); // Remove @ prefix
        const timeParts = timeStr.split(':');

        if (timeParts.length !== 2) {
            return { isValid: false, type: null, value: null, error: lang.alliance.createAlliance.errors.wrongTimeFormat };
        }

        const hours = parseInt(timeParts[0], 10);
        const minutes = parseInt(timeParts[1], 10);

        // Validate hours (0-23) and minutes (0-59)
        if (isNaN(hours) || hours < 0 || hours > 23) {
            return { isValid: false, type: null, value: null, error: lang.alliance.createAlliance.errors.wrongHourRange };
        }
        if (isNaN(minutes) || minutes < 0 || minutes > 59) {
            return { isValid: false, type: null, value: null, error: lang.alliance.createAlliance.errors.wrongMinuteRange };
        }

        // Return the original @HH:MM format for storage
        const formattedTime = `@${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
        return { isValid: true, type: 'time', value: formattedTime, error: null };
    }

    // Otherwise, treat as minute-based interval
    const intervalMinutes = parseInt(trimmed, 10);
    if (isNaN(intervalMinutes) || intervalMinutes < 0) {
        return { isValid: false, type: null, value: null, error: lang.alliance.createAlliance.errors.wrongValue };
    }

    return { isValid: true, type: 'minutes', value: intervalMinutes, error: null };
}

/**
 * Calculates milliseconds until the next occurrence of a specific UTC time.
 * @param {string} timeStr - Time string in format "HH:MM" (without @ prefix)
 * @returns {number} Milliseconds until next occurrence
 */
function calculateMillisecondsUntilTime(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);

    const now = new Date();
    const target = new Date();
    target.setUTCHours(hours, minutes, 0, 0);

    // If target time has already passed today, schedule for tomorrow
    if (target <= now) {
        target.setUTCDate(target.getUTCDate() + 1);
    }

    return target - now;
}

/**
 * Formats refresh interval for display.
 * @param {string|number} interval - The stored interval value (minutes or @HH:MM)
 * @param {Object} lang - Language object for translations
 * @returns {string} Formatted display string
 */
function formatRefreshInterval(interval, lang) {
    // Handle null/undefined/0 cases
    if (!interval || interval === 0 || interval === '0') {
        return lang.alliance.createAlliance.content.disabled;
    }

    // Check if it's time-based format
    if (typeof interval === 'string' && interval.startsWith('@')) {
        const timeStr = interval.substring(1);
        return lang.alliance.createAlliance.content.dailyAt.replace('{time}', timeStr);
    }

    // Otherwise it's minute-based
    const minutes = typeof interval === 'string' ? parseInt(interval, 10) : interval;
    return lang.alliance.createAlliance.content.minutes.replace('{min}', minutes.toString());
}

/**
 * Gets the timeout duration in milliseconds based on interval type.
 * @param {string|number} interval - The stored interval value
 * @returns {number} Milliseconds until next refresh
 */
function getRefreshTimeout(interval) {
    // Handle disabled refresh
    if (!interval || interval === 0 || interval === '0') {
        return 0;
    }

    // Time-based format (@HH:MM)
    if (typeof interval === 'string' && interval.startsWith('@')) {
        const timeStr = interval.substring(1);
        return calculateMillisecondsUntilTime(timeStr);
    }

    // Minute-based format
    const minutes = typeof interval === 'string' ? parseInt(interval, 10) : interval;
    return minutes * 60 * 1000;
}

/**
 * Encodes export filter selections into a compact string for custom_id storage.
 * Uses range compression for consecutive numbers and base85 encoding.
 * @param {Object} selections - Object with arrays: { states: [], allianceIds: [], furnaceLevels: [] }
 * @returns {string} Compact encoded string
 */
function encodeExportSelection(selections) {
    const ascii85 = require('ascii85');

    // Helper to compress consecutive numbers into ranges (e.g., [1,2,3,4,6,8,9,10] -> "1-4,6,8-10")
    function compressRanges(arr) {
        if (!arr || arr.length === 0) return '';
        const sorted = [...new Set(arr)].sort((a, b) => a - b);
        const ranges = [];
        let start = sorted[0];
        let end = sorted[0];

        for (let i = 1; i <= sorted.length; i++) {
            if (i < sorted.length && sorted[i] === end + 1) {
                end = sorted[i];
            } else {
                ranges.push(start === end ? `${start}` : `${start}-${end}`);
                if (i < sorted.length) {
                    start = sorted[i];
                    end = sorted[i];
                }
            }
        }
        return ranges.join(',');
    }

    const parts = [];
    if (selections.states && selections.states.length > 0) {
        parts.push('s:' + compressRanges(selections.states));
    }
    if (selections.allianceIds && selections.allianceIds.length > 0) {
        parts.push('a:' + compressRanges(selections.allianceIds));
    }
    if (selections.furnaceLevels && selections.furnaceLevels.length > 0) {
        parts.push('f:' + compressRanges(selections.furnaceLevels));
    }

    if (parts.length === 0) return 'none';

    const joined = parts.join('|');

    // Only encode if length benefit exists
    if (joined.length <= 20) return joined;

    try {
        const encoded = ascii85.encode(Buffer.from(joined, 'utf8')).toString();
        return encoded.length < joined.length ? `b85:${encoded}` : joined;
    } catch (err) {
        return joined; // Fallback to unencoded
    }
}

/**
 * Decodes export filter selections from a compact custom_id token.
 * @param {string} encodedStr - Encoded string from custom_id
 * @returns {Object} Decoded selections: { states: [], allianceIds: [], furnaceLevels: [] }
 */
function decodeExportSelection(encodedStr) {
    const ascii85 = require('ascii85');

    if (!encodedStr || encodedStr === 'none') {
        return { states: [], allianceIds: [], furnaceLevels: [] };
    }

    // Decode base85 if prefixed
    let decoded = encodedStr;
    if (encodedStr.startsWith('b85:')) {
        try {
            const b85Data = encodedStr.substring(4);
            decoded = ascii85.decode(b85Data).toString('utf8');
        } catch (err) {
            return { states: [], allianceIds: [], furnaceLevels: [] };
        }
    }

    // Helper to expand ranges (e.g., "1-4,6,8-10" -> [1,2,3,4,6,8,9,10])
    function expandRanges(str) {
        if (!str) return [];
        const parts = str.split(',');
        const result = [];

        for (const part of parts) {
            if (part.includes('-')) {
                const [start, end] = part.split('-').map(Number);
                for (let i = start; i <= end; i++) {
                    result.push(i);
                }
            } else {
                result.push(Number(part));
            }
        }
        return result;
    }

    const selections = { states: [], allianceIds: [], furnaceLevels: [] };
    const sections = decoded.split('|');

    for (const section of sections) {
        const [prefix, data] = section.split(':');
        if (prefix === 's') selections.states = expandRanges(data);
        else if (prefix === 'a') selections.allianceIds = expandRanges(data);
        else if (prefix === 'f') selections.furnaceLevels = expandRanges(data);
    }

    return selections;
}

/**
 * Validates that a custom_id string does not exceed Discord's limit.
 * @param {string} customId - The custom_id string to check
 * @param {number} maxLength - Maximum allowed length (default 100)
 * @returns {boolean} True if valid, false if too long
 */
function checkCustomIdLength(customId, maxLength = 100) {
    return customId.length <= maxLength;
}

module.exports = {
    getAdminLang,
    assertUserMatches,
    sendError,
    shouldIgnoreError,
    hasPermission,
    updateComponentsV2AfterSeparator,
    createAllianceSelectionComponents,
    parseRefreshInterval,
    calculateMillisecondsUntilTime,
    formatRefreshInterval,
    getRefreshTimeout,
    encodeExportSelection,
    decodeExportSelection,
    checkCustomIdLength
};