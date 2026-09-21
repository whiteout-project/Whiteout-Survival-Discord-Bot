const { EmbedBuilder } = require('discord.js');

const { handleError } = require('../utility/commonFunctions');
const {
    createProcess,
    updateProcessProgress,
    getProcessById
} = require('../Processes/createProcesses');
const { queueManager } = require('../Processes/queueManager');
const { processExecutor } = require('../Processes/executeProcesses');
const { systemLogQueries, giftCodeQueries, playerQueries, giftCodeUsageQueries, stateSearchRetryQueries, settingsQueries, processQueries: processDbQueries, allianceQueries } = require('../utility/database');
const { getTestPlayerForValidation } = require('./setTestId');
const { API_CONFIG, getApiConfig } = require('../utility/apiConfig');
const { getDefaultGameType } = require('../utility/gameRuntime');
const { nativePost } = require('../utility/apiClient');
const { isProxyConfiguredFor } = require('../utility/proxySupport');
const { formatPlayerWithId } = require('../Players/playerDisplay');
const { getPlayerStateInfo, queueStateSearch } = require('./stateSearch');

const isDevMode = process.env.WOSLAND_DEV_MODE === '1';
function devLog(...args) {
    if (isDevMode) console.log('[DEV][redeem]', ...args);
}

// Update embed progress every N players processed (not a time interval)
const EMBED_UPDATE_INTERVAL = 10;
const PROGRESS_EMBED_COLOR = 0x3498db;
const PROGRESS_EMBED_COLOR_COMPLETE = 0x2ecc71;
const PROGRESS_EMBED_COLOR_FAILED = 0xe74c3c;
const ABORTABLE_STATUSES = new Set(['USED', 'TIME ERROR', 'CDK NOT FOUND']);

// In-memory lock to prevent TOCTOU race between duplicate check and createProcess
// Key format: "allianceId:giftCode"
const pendingRedeemCreations = new Set();

// Rate limit tracking — 30 requests per 60-second window per endpoint
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_PER_WINDOW = 30;
const RATE_LIMIT_SAFE_MARGIN = 2; // pre-emptively pause when remaining ≤ this

/**
 * Module-level rate limit tracker updated by redeem responses.
 * Tracks remaining budget per endpoint and estimates window timing.
 */
const rateLimitState = {
    redeem: RATE_LIMIT_PER_WINDOW,
    windowStart: 0
};

/**
 * Updates rate limit state from an API response.
 * Detects window resets (remaining goes up) and resets the window timer.
 * @param {'redeem'} endpoint - Which endpoint's counter to update
 * @param {number|undefined} remaining - X-RateLimit-Remaining value from response
 */
function updateRateLimit(endpoint, remaining) {
    if (remaining === undefined) return;
    if (remaining > rateLimitState[endpoint]) {
        // Window has reset — remaining went up
        rateLimitState.windowStart = Date.now();
    }
    rateLimitState[endpoint] = remaining;
}

// Status arrays for cleaner comparisons
const ALREADY_REDEEMED_STATUSES = ['RECEIVED', 'SAME TYPE EXCHANGE'];
const VIP_RESTRICTION_STATUSES = ['RECHARGE_MONEY ERROR', 'RECHARGE_MONEY_VIP ERROR'];
const LEVEL_RESTRICTION_STATUSES = ['STOVE_LV ERROR'];
const WRONG_STATE_STATUS = 'USER INFO ERROR';
const FAILURE_STATUS_LABELS = {
    NETWORK_ERROR: 'Network',
    PROXY_ERROR: 'Proxy/Network',
    HTTP_ERROR: 'HTTP',
    EMPTY_RESPONSE: 'Empty response',
    UNKNOWN_API_RESPONSE: 'Unknown response',
    STATE_REQUIRED: 'State required',
    UNHANDLED_ERROR: 'Unhandled',
    ANALYSIS_ERROR: 'Analysis',
    'TIMEOUT RETRY': 'Timeout',
    'ROLE NOT EXIST': 'Player missing',
    'NOT LOGIN': 'Not logged in',
    'SIGN ERROR': 'Sign error'
};
// Discord embed field limits: 1024 chars per value; cap groups shown to keep it readable.
const MAX_FAILURE_GROUPS = 8;

// API status code mapping for response analysis with error codes
const API_STATUS_MAP = {
    'TIMEOUT RETRY': { success: false, giftCodeActive: true, retry: { type: 'rate', delay: API_CONFIG.RATE_LIMIT_DELAY }, errCode: 40004 },
    'ROLE NOT EXIST': { success: false, giftCodeActive: true, playerNotExist: true, errCode: 40001 },
    'SUCCESS': { success: true, giftCodeActive: true },
    'RECEIVED': { success: true, giftCodeActive: true, errCode: 40008 },
    'SAME TYPE EXCHANGE': { success: true, giftCodeActive: true, errCode: 40011 },
    'USED': { success: true, giftCodeActive: true, errCode: 40005 },
    'TIME ERROR': { success: true, giftCodeActive: false, errCode: 40007 },
    'CDK NOT FOUND': { success: true, giftCodeActive: false, errCode: 40014 },
    'STOVE_LV ERROR': { success: true, giftCodeActive: true, errCode: 40006 },
    'RECHARGE_MONEY ERROR': { success: true, giftCodeActive: true, errCode: 40017 },
    'RECHARGE_MONEY_VIP ERROR': { success: true, giftCodeActive: true, errCode: 40018 },
    [WRONG_STATE_STATUS]: { success: false, giftCodeActive: true, wrongState: true, errCode: 40020 },
    'NOT LOGIN': { success: false, giftCodeActive: null },
    'SIGN ERROR': { success: false, giftCodeActive: null }
};

// Reverse mapping: error code to status key (for handling numeric error codes from API)
const ERROR_CODE_TO_STATUS = {
    40001: 'ROLE NOT EXIST',
    40004: 'TIMEOUT RETRY',
    40005: 'USED',
    40006: 'STOVE_LV ERROR',
    40007: 'TIME ERROR',
    40008: 'RECEIVED',
    40011: 'SAME TYPE EXCHANGE',
    40014: 'CDK NOT FOUND',
    40017: 'RECHARGE_MONEY ERROR',
    40018: 'RECHARGE_MONEY_VIP ERROR',
    40020: WRONG_STATE_STATUS
};

// Persistent module state — stored on global so values survive hot-reloads.
// A plain module-level variable would reset to 0 / an empty Map every time
// `reload files` re-requires this module; global state keeps validation
// completion promises alive across hot reloads.
if (!global._wosRedeemModuleState) {
    global._wosRedeemModuleState = {
        processCompletionResolvers: new Map()
    };
}
const moduleState = global._wosRedeemModuleState;

const RESOLVER_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes — safety net for stale resolvers

function registerProcessCompletion(processId) {
    return new Promise((resolve) => {
        moduleState.processCompletionResolvers.set(processId, resolve);

        // Safety timeout: auto-resolve if the process never completes (deleted, killed, etc.)
        const timeoutId = setTimeout(() => {
            if (moduleState.processCompletionResolvers.has(processId)) {
                moduleState.processCompletionResolvers.delete(processId);
                resolve({
                    success: false,
                    results: [],
                    error: `Process ${processId} completion timed out after 30 minutes`
                });
            }
        }, RESOLVER_TIMEOUT_MS);

        // Store the timeout so resolveProcessCompletion can clear it
        moduleState.processCompletionTimeouts ??= new Map();
        moduleState.processCompletionTimeouts.set(processId, timeoutId);
    });
}

function resolveProcessCompletion(processId, payload) {
    const resolver = moduleState.processCompletionResolvers.get(processId);
    if (resolver) {
        resolver(payload);
        moduleState.processCompletionResolvers.delete(processId);
    }

    // Clear the safety timeout
    const timeoutId = moduleState.processCompletionTimeouts?.get(processId);
    if (timeoutId) {
        clearTimeout(timeoutId);
        moduleState.processCompletionTimeouts.delete(processId);
    }
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gets status configuration from API_STATUS_MAP for a given error message
 * @param {string} errorMessage - Raw error message from API
 * @returns {Object|null} Status configuration or null if not found
 */
function getStatusConfig(errorMessage) {
    if (!errorMessage) return null;
    const statusKey = errorMessage.toUpperCase().replace(/[.\s]+$/g, '');
    return API_STATUS_MAP[statusKey] || null;
}

/**
 * Creates a standardized error result object
 * @param {string} status - Status code
 * @param {string} message - Error message
 * @param {boolean} giftCodeActive - Whether gift code is still active
 * @returns {Object} Error result object
 */
function createErrorResult(status, message, giftCodeActive = false) {
    return {
        success: false,
        status,
        message,
        giftCodeActive
    };
}

// encodeData and postForm are now imported from shared apiClient.js
// postForm is aliased as nativePost in the import above
const postForm = nativePost;

function resolveRedeemApiConfig(gameType = getDefaultGameType()) {
    return getApiConfig(gameType);
}

function classifyGiftCodeValidationResult(result) {
    if (!result || result.rateLimited || result.retry || result.wrongState || result.playerNotExist) return 'retry';
    if (result.giftCodeActive === true) return 'active';
    if (result.success === true && result.giftCodeActive === false) return 'invalid';
    return 'retry';
}

// Transport/server statuses that mean validation could not get a definitive answer
const NETWORK_FAILURE_STATUSES = new Set([
    'NETWORK_ERROR',
    'PROXY_ERROR',
    'HTTP_ERROR',
    'EMPTY_RESPONSE',
    'UNKNOWN_API_RESPONSE'
]);

const NETWORK_ERROR_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE'
]);

function isNetworkError(error) {
    return !!error && (
        NETWORK_ERROR_CODES.has(error.code) ||
        /timed out|socket hang up|proxy|tunnel/i.test(error.message || '')
    );
}

/**
 * Classifies a validation result into a user-facing failure kind:
 * 'active' | 'invalid' | 'network' | 'rateLimit' | 'testId' | 'unknown'
 */
function getValidationFailureKind(result) {
    const disposition = classifyGiftCodeValidationResult(result);
    if (disposition === 'active') return 'active';
    if (disposition === 'invalid') return 'invalid';
    if (!result) return 'unknown';
    if (result.rateLimited || result.retry) return 'rateLimit';
    if (result.wrongState || result.playerNotExist || result.status === 'STATE_REQUIRED' || result.status === 'TEST_ID_REQUIRED') return 'testId';
    if (NETWORK_FAILURE_STATUSES.has(result.status)) return 'network';
    return 'unknown';
}

/**
 * Pre-filters players who have already redeemed a gift code
 * Returns items to process and pre-filtered results
 * @param {Array} redeemItems - Items with status='redeem' and valid IDs
 * @param {string} giftCode - Gift code to check
 * @returns {Object} { itemsToProcess, preFilteredResults }
 */
function preFilterAlreadyRedeemed(redeemItems, giftCode, gameType = getDefaultGameType()) {
    const preFilteredResults = [];

    if (redeemItems.length === 0) {
        return { itemsToProcess: [], preFilteredResults };
    }

    try {
        const redeemedFidsList = giftCodeUsageQueries.getFidsWhoRedeemedCode(giftCode, gameType);
        const alreadyRedeemedFids = new Set(redeemedFidsList.map(fid => String(fid)));

        if (alreadyRedeemedFids.size > 0) {

            for (const item of redeemItems) {
                if (alreadyRedeemedFids.has(String(item.id))) {
                    const previousUsage = giftCodeUsageQueries.checkUsage(item.id, giftCode, gameType);
                    const previousStatus = previousUsage?.status || 'RECEIVED';

                    preFilteredResults.push({
                        success: true,
                        status: previousStatus,
                        message: `Already redeemed (Previous: ${previousStatus})`,
                        playerId: item.id,
                        identifier: item.id,
                        giftCode: giftCode,
                        operation: 'redeem',
                        preFiltered: true
                    });

                    devLog(`Player ${item.id} already redeemed with status: ${previousStatus}`);
                }
            }
        }

        const itemsToProcess = redeemItems.filter(item => !alreadyRedeemedFids.has(String(item.id)));
        return { itemsToProcess, preFilteredResults };

    } catch (error) {
        console.error('Error pre-filtering already redeemed players:', error);
        // On error, return all items without filtering
        return { itemsToProcess: redeemItems, preFilteredResults };
    }
}

/**
 * Creates and executes a redeem process for gift codes
 * @param {Array} redeemData - Array of objects with {id, giftCode, status}
 * @returns {Promise<Object>} Result of the redeem operation
 */
async function createRedeemProcess(redeemData, options = {}) {
    try {
        if (!Array.isArray(redeemData) || redeemData.length === 0) {
            throw new Error('Invalid redeem data: must be non-empty array');
        }


        const {
            adminId: providedAdminId,
            allianceContext: providedAllianceContext,
            gameType: providedGameType,
            deferQueue = false
        } = options;

        const adminId = providedAdminId || 'SYSTEM_AUTO_REDEEM';
        const gameType = providedGameType || providedAllianceContext?.gameType || getDefaultGameType();
        const storedAlliance = providedAllianceContext?.id != null
            ? allianceQueries.getAllianceById(providedAllianceContext.id, gameType)
            : null;

        const allianceContext = providedAllianceContext
            ? {
                id: providedAllianceContext.id != null ? String(providedAllianceContext.id) : null,
                name: providedAllianceContext.name || null,
                channelId: providedAllianceContext.channelId || null,
                guildId: providedAllianceContext.guildId || null,
                state: storedAlliance?.state || null
            }
            : null;

        const normalisedItems = redeemData.map((item, index) => ({
            id: item.id != null ? String(item.id) : null,
            giftCode: item.giftCode,
            status: (item.status || 'redeem').toLowerCase(),
            index
        }));

        // PRE-FILTER: Check who already redeemed this gift code BEFORE starting the process
        const giftCode = normalisedItems[0].giftCode;
        const redeemItems = normalisedItems.filter(item => item.status === 'redeem' && item.id);

        if (redeemItems.length > 0 && (!Number.isSafeInteger(allianceContext?.state) || allianceContext.state <= 0)) {
            return {
                success: true,
                skipped: true,
                processId: null,
                message: 'Alliance skipped because it has no valid state'
            };
        }

        const { itemsToProcess: filteredRedeemItems, preFilteredResults } =
            preFilterAlreadyRedeemed(redeemItems, giftCode, gameType);

        // Combine validation items FIRST, then redeem items
        // This ensures validation runs before bulk redemption to avoid API rate limit exhaustion
        const validationItems = normalisedItems.filter(item => item.status === 'validation');
        const itemsToProcess = [...validationItems, ...filteredRedeemItems];

        const identifiers = normalisedItems.map((item) => item.id || `validation_${item.index}`);
        const identifiersToProcess = itemsToProcess.map((item) => item.id || `validation_${item.index}`);
        const existingIdentifiers = identifiers.filter(id => !identifiersToProcess.includes(id));

        devLog(`Pre-filter: ${normalisedItems.length} total, ${itemsToProcess.length} to process, ${existingIdentifiers.length} already redeemed, code: ${giftCode}`);

        // Duplicate process guard: skip if a queued/active redeem process already exists
        // for the same alliance + gift code combination
        const allianceIdForProcess = allianceContext?.id || 0;
        const lockKey = `${allianceIdForProcess}:${giftCode}`;

        // In-memory lock: prevent TOCTOU race between sync duplicate check and async createProcess
        if (pendingRedeemCreations.has(lockKey)) {
            return {
                success: true,
                processId: null,
                message: 'Duplicate process skipped — creation already in progress for this alliance and gift code'
            };
        }

        const existingProcesses = processDbQueries.getProcessesByActionAndTarget('redeem_giftcode', String(allianceIdForProcess));
        if (existingProcesses && existingProcesses.length > 0) {
            const isDuplicate = existingProcesses.some(proc => {
                try {
                    const progress = JSON.parse(proc.progress);
                    return progress?.redeemData?.giftCode === giftCode;
                } catch {
                    return false;
                }
            });

            if (isDuplicate) {
                return {
                    success: true,
                    processId: null,
                    message: 'Duplicate process skipped — already queued or active for this alliance and gift code'
                };
            }
        }

        // Acquire lock before async createProcess to prevent concurrent duplicates
        pendingRedeemCreations.add(lockKey);

        let processResult;
        try {
            processResult = await createProcess({
                admin_id: adminId,
                alliance_id: allianceIdForProcess,
                player_ids: identifiers.join(','),
                action: 'redeem_giftcode'
            });
        } finally {
            pendingRedeemCreations.delete(lockKey);
        }

        if (!processResult || !processResult.process_id) {
            throw new Error('Failed to create redeem process');
        }

        const processId = processResult.process_id;

        const redeemContext = {
            items: itemsToProcess, // Only items that need processing
            allItems: normalisedItems, // Keep all items for reference
            giftCode: giftCode,
            createdAt: Date.now(),
            alliance: allianceContext,
            gameType
        };

        const initialProgress = {
            pending: identifiersToProcess, // Only pending items to process
            done: [],
            failed: [],
            existing: existingIdentifiers, // Pre-filtered already-redeemed players
            redeemData: redeemContext,
            redeemResults: preFilteredResults, // Include pre-filtered results
            embedState: allianceContext
                ? {
                    channelId: allianceContext.channelId || null,
                    guildId: allianceContext.guildId || null,
                    messageId: null,
                    lastUpdateCount: 0,
                    disabled: !allianceContext.channelId,
                    initialized: false
                }
                : null
        };

        await updateProcessProgress(processId, initialProgress);

        const shouldAwaitCompletion = normalisedItems.every((item) => item.status === 'validation');
        const completionPromise = shouldAwaitCompletion ? registerProcessCompletion(processId) : null;

        if (!deferQueue) await queueManager.manageQueue(processResult);

        if (completionPromise) {
            const completion = await completionPromise;

            // For validation operations, determine if the gift code is valid
            if (shouldAwaitCompletion && completion.results && completion.results.length > 0) {
                const validationResult = completion.results[0];

                const validationDisposition = classifyGiftCodeValidationResult(validationResult);
                const isValidGiftCode = validationDisposition === 'active';

                return {
                    success: isValidGiftCode,
                    processId,
                    message: isValidGiftCode
                        ? 'Gift code is valid'
                        : (validationResult.message || 'Gift code is not valid'),
                    results: completion.results
                };
            }

            return {
                ...completion,
                processId
            };
        }

        return {
            success: true,
            processId,
            message: 'Redeem process queued'
        };

    } catch (error) {
        await handleError(null, null, error, 'createRedeemProcess', false);

        return {
            success: false,
            message: error.message
        };
    }
}

/**
 * Handles VIP tracking for VIP/Recharge restricted gift codes
 * @param {string} playerId - Player FID
 * @param {string} giftCode - Gift code being redeemed
 * @param {Object} outcome - Redeem outcome with status
 * @param {Object|null} [cachedGiftCodeData=null] - Pre-fetched gift code row; falls back to a DB query if not provided
 */
async function handleVipTracking(playerId, giftCode, outcome, cachedGiftCodeData = null) {
    try {
        // Use the pre-fetched row when available to avoid repeated DB reads in the loop
        const giftCodeData = cachedGiftCodeData ?? giftCodeQueries.getGiftCode(giftCode, outcome.gameType || getDefaultGameType());
        if (!giftCodeData || !giftCodeData.is_vip) {
            return; // Not a VIP code, no tracking needed
        }

        const player = playerQueries.getPlayer(playerId, outcome.gameType || getDefaultGameType());
        if (!player) {
            devLog(`Player ${playerId} not found for VIP tracking`);
            return;
        }

        // Check if the redeem was successful (player was able to claim)
        const wasSuccessful = outcome.status === 'SUCCESS' ||
            outcome.status === 'RECEIVED' ||
            outcome.status === 'SAME TYPE EXCHANGE';

        // Check if player failed due to VIP/Recharge restrictions (NOT level restrictions)
        const wasVipRestricted = outcome.status === 'RECHARGE_MONEY ERROR' ||
            outcome.status === 'RECHARGE_MONEY_VIP ERROR';

        if (wasSuccessful) {
            // Player successfully redeemed - mark as rich if not already
            if (!player.is_rich) {
                playerQueries.updatePlayerRichStatus(true, playerId);
            }
        } else if (wasVipRestricted) {
            // Player failed due to VIP/Recharge restrictions ONLY
            // STOVE_LV ERROR is excluded (it's a level restriction, not VIP)
            // THIS is when we increment VIP count - only on failure due to VIP restrictions
            if (!player.is_rich) {
                const currentVipCount = player.vip_count || 0;

                if (currentVipCount >= 5) {
                    // Reset to 1 if count is 5 or more
                    playerQueries.resetPlayerVipCount(playerId);
                } else {
                    // Increment by 1 for any count 0-4
                    playerQueries.updatePlayerVipCount(currentVipCount + 1, playerId);
                }
            }
        }

    } catch (error) {
        await handleError(null, null, error, 'handleVipTracking', false);
        // Don't throw - VIP tracking shouldn't break the redeem process
    }
}

/**
 * Handles post-redemption operations: VIP tracking and usage tracking
 * @param {string} playerId - Player FID
 * @param {string} giftCode - Gift code that was redeemed
 * @param {Object} outcome - Redemption outcome with status
 * @param {Object|null} [cachedGiftCodeData=null] - Pre-fetched gift code row (avoids repeated DB reads per player)
 */
async function handlePostRedemption(playerId, giftCode, outcome, cachedGiftCodeData = null) {
    // A corrected alliance state must allow this player to be retried later.
    if (outcome.status === WRONG_STATE_STATUS) return;

    // Handle VIP tracking for VIP/Recharge codes
    await handleVipTracking(playerId, giftCode, outcome, cachedGiftCodeData);

    // Track gift code usage for this player
    try {
        giftCodeUsageQueries.addUsage(playerId, giftCode, outcome.status || 'UNKNOWN', outcome.gameType || getDefaultGameType());
    } catch (usageError) {
        // Ignore duplicate entry errors (player already has this usage tracked)
        if (!usageError.message.includes('UNIQUE constraint')) {
            console.error(`Error tracking usage for player ${playerId}:`, usageError.message);
        }
    }
    stateSearchRetryQueries.remove(playerId, giftCode, outcome.gameType || getDefaultGameType());
}

/**
 * Processes a single redeem item (validation or redemption)
 * @param {Object} item - Redeem item with id, giftCode, status (validation/redeem)
 * @returns {Promise<Object>} Outcome with success, status, message, etc.
 */
async function processSingleRedeemItem(item, gameType = getDefaultGameType(), state = null) {
    try {
        if (item.status === 'validation') {
            return await validateGiftCode(item.giftCode, gameType);
        } else if (item.status === 'redeem') {
            if (!item.id) {
                throw new Error('Missing player ID for redeem operation');
            }
            return await redeemGiftCodeForPlayer(item.id, item.giftCode, gameType, state);
        } else {
            throw new Error(`Unknown operation status: ${item.status}`);
        }
    } catch (error) {
        await handleError(null, null, error, 'processSingleRedeemItem', false);
        return {
            success: false,
            status: 'UNHANDLED_ERROR',
            message: error.message
        };
    }
}

/**
 * Executes the actual redeem operation for a gift code
 * @param {number} processId - Process ID
 * @returns {Promise<Object>} Redeem result
 */
async function executeRedeemOperation(processId) {
    try {
        const processData = await getProcessById(processId);
        if (!processData) {
            throw new Error(`Process ${processId} not found`);
        }

        const progress = processData.progress || {};
        const redeemContext = progress.redeemData;

        if (!redeemContext || !Array.isArray(redeemContext.items)) {
            throw new Error('No redeem data found in process');
        }

        devLog(`executeRedeemOperation started — processId: ${processId}, code: ${redeemContext.giftCode}, items: ${redeemContext.items.length}, alliance: ${redeemContext.alliance?.name || 'N/A'}`);

        // Process-scoped dev logger with processId and alliance context
        const allianceTag = redeemContext.alliance?.name || 'N/A';
        const pLog = (...args) => devLog(`[P${processId}|${allianceTag}]`, ...args);

        // Handle case where all players are pre-filtered (itemsToProcess is empty)
        if (redeemContext.items.length === 0 && Array.isArray(progress.existing) && progress.existing.length > 0) {

            const results = Array.isArray(progress.redeemResults) ? [...progress.redeemResults] : [];
            const current = {
                pending: [],
                done: [],
                failed: [],
                existing: Array.isArray(progress.existing) ? [...progress.existing] : []
            };

            const finalStats = computeRedeemStats(redeemContext, results, current);

            // Send final embed if alliance channel is configured
            let embedState = progress.embedState ? { ...progress.embedState } : null;
            if (embedState && !embedState.disabled) {
                embedState = await updateRedeemProgressEmbed(
                    processId,
                    embedState,
                    finalStats,
                    {
                        giftCode: redeemContext.giftCode,
                        alliance: redeemContext.alliance,
                        state: 'completed',
                        stateMessage: 'All players already redeemed this code',
                        processId
                    },
                    true
                );
            }

            const summary = {
                success: true,
                results
            };

            resolveProcessCompletion(processId, summary);
            return summary;
        }

        const current = {
            pending: Array.isArray(progress.pending) ? [...progress.pending] : [],
            done: Array.isArray(progress.done) ? [...progress.done] : [],
            failed: Array.isArray(progress.failed) ? [...progress.failed] : [],
            existing: Array.isArray(progress.existing) ? [...progress.existing] : []
        };

        const results = Array.isArray(progress.redeemResults) ? [...progress.redeemResults] : [];
        let lastProcessedIdentifier = progress.lastProcessedId || null;

        const totalRedeemMembers = redeemContext.items.filter((item) => item.status === 'redeem').length;

        let embedState = progress.embedState ? { ...progress.embedState } : null;
        if (!embedState && redeemContext.alliance && redeemContext.alliance.channelId && totalRedeemMembers > 0) {
            embedState = {
                channelId: redeemContext.alliance.channelId,
                guildId: redeemContext.alliance.guildId || null,
                messageId: null,
                lastUpdateCount: 0,
                disabled: false,
                initialized: false
            };
        } else if (embedState && totalRedeemMembers === 0) {
            embedState.disabled = true;
        }

        if (embedState && !embedState.disabled && !embedState.initialized) {
            const initialStats = computeRedeemStats(redeemContext, results, current);
            embedState = await updateRedeemProgressEmbed(
                processId,
                embedState,
                initialStats,
                {
                    giftCode: redeemContext.giftCode,
                    alliance: redeemContext.alliance,
                    state: 'in_progress',
                    stateMessage: 'Redeem process started'
                },
                true
            );
            embedState.initialized = true;
        }

        let abortReason = null;
        let abortSummary = null;
        let vipCodeDetected = false;
        let vipCodeDetectedAt = null;

        // Fetch gift code data once for the entire loop — passed to handlePostRedemption
        // to avoid 1 DB read per player for the same unchanging row.
        // Declared with let so it can be updated if VIP status is detected dynamically.
        let loopGiftCodeData = giftCodeQueries.getGiftCode(redeemContext.giftCode, redeemContext.gameType) || null;

        // Process only items that are still pending (handles crash recovery correctly)
        // This prevents re-processing items that were already completed before a crash
        const itemsToProcess = redeemContext.items.filter((item) => {
            const identifier = item.id || `validation_${item.index}`;
            return current.pending.includes(identifier);
        });

        // Apply per-player state overrides (admin-set via /set player) once per process.
        // Effective state = player override ?? alliance state when redeeming.
        const redeemFids = itemsToProcess
            .filter((item) => item.status === 'redeem' && item.id)
            .map((item) => String(item.id));
        if (redeemFids.length > 0) {
            try {
                const stateOverrideByFid = new Map();
                for (const player of playerQueries.getPlayersByFids(redeemFids, redeemContext.gameType)) {
                    if (player?.state_override != null) {
                        stateOverrideByFid.set(String(player.fid), player.state_override);
                    }
                }
                for (const item of itemsToProcess) {
                    if (item.status === 'redeem' && item.id && stateOverrideByFid.has(String(item.id))) {
                        item.effectiveState = stateOverrideByFid.get(String(item.id));
                    }
                }
            } catch (error) {
                // Overrides are an optimization for correctness; without them the
                // alliance state applies, so never let a lookup failure abort the run.
                await handleError(null, null, error, 'executeRedeemOperation_stateOverrides', false);
            }
        }

        // Retry queue system: rate-limited players are set aside
        // and other players continue processing. This mirrors the Python bot's approach
        // and avoids blocking the entire pipeline on a single 60s rate limit.
        const activeQueue = itemsToProcess.map(item => ({ item, cycle: 0 }));
        const retryQueue = []; // [{item, cycle, retryAfter}]
        let lastItemStatus = null;
        let processedCount = 0;

        // Initialize rate limit tracking for this operation
        rateLimitState.redeem = RATE_LIMIT_PER_WINDOW;
        rateLimitState.windowStart = Date.now();

        while (activeQueue.length > 0 || retryQueue.length > 0) {
            // Move ready retries back to active queue
            const now = Date.now();
            for (let r = retryQueue.length - 1; r >= 0; r--) {
                if (now >= retryQueue[r].retryAfter) {
                    activeQueue.push(retryQueue.splice(r, 1)[0]);
                }
            }

            // If no active items but retries pending, wait for the earliest one
            if (activeQueue.length === 0) {
                if (retryQueue.length > 0) {
                    const nextRetry = Math.min(...retryQueue.map(r => r.retryAfter));
                    const sleepTime = Math.max(100, nextRetry - Date.now());
                    pLog(`All ${retryQueue.length} player(s) rate-limited — waiting ${(sleepTime/1000).toFixed(1)}s for next retry`);
                    await wait(sleepTime);
                }
                continue;
            }

            const entry = activeQueue.shift();
            const item = entry.item;
            const cycle = entry.cycle;
            const identifier = item.id || `validation_${item.index}`;

            // Add API cooldown when transitioning from validation to redemption
            if (lastItemStatus === 'validation' && item.status === 'redeem') {
                const VALIDATION_TO_REDEEM_COOLDOWN = 3000;
                pLog(`Validation→Redeem transition — cooling down ${(VALIDATION_TO_REDEEM_COOLDOWN/1000).toFixed(1)}s`);
                await wait(VALIDATION_TO_REDEEM_COOLDOWN);
            }
            lastItemStatus = item.status;

            // Track processing start time for rate limiting calculations
            const processingStartTime = Date.now();

            // Check for preemption before processing each player (if processExecutor is available)
            if (processExecutor && typeof processExecutor.checkForPreemption === 'function') {
                const preemptionCheck = await processExecutor.checkForPreemption(processId);
                if (preemptionCheck.shouldStop) {
                    return {
                        success: false,
                        results: results,
                        preempted: true,
                        message: 'Process was preempted by higher priority process'
                    };
                }
            }

            // Read the current state and block before each request, including resumed processes.
            const stateInfo = item.status === 'redeem'
                ? getPlayerStateInfo(item.id, redeemContext.gameType)
                : null;
            const effectiveState = stateInfo?.effectiveState ?? item.effectiveState ?? redeemContext.alliance?.state;
            const outcome = stateInfo?.blocked
                ? {
                    success: false,
                    status: 'SKIPPED_STATE_SEARCH_BLOCKED',
                    message: 'Gift-code redemption is paused until this player\'s state is updated'
                }
                : await processSingleRedeemItem(item, redeemContext.gameType, effectiveState);

            // Rate-limited: put in retry queue and immediately process the next player
            // Rate limits don't increment cycle — they aren't the player's fault
            // (matches Python: cycle_for_next_retry = current_cycle_count for rate limits)
            if (outcome.rateLimited && cycle < API_CONFIG.MAX_RETRY_CYCLES) {
                const retryDelay = outcome.retryDelay || API_CONFIG.RATE_LIMIT_DELAY;
                pLog(`Player ${identifier} rate-limited — queued for retry in ${(retryDelay/1000).toFixed(1)}s (cycle ${cycle}/${API_CONFIG.MAX_RETRY_CYCLES})`);
                retryQueue.push({
                    item,
                    cycle,
                    retryAfter: Date.now() + retryDelay
                });
                continue;
            }

            const resultPayload = {
                ...outcome,
                playerId: item.id,
                identifier,
                giftCode: item.giftCode,
                operation: item.status
            };

            results.push(resultPayload);

            pLog(`[${processedCount + 1}] ${item.status} — ${identifier}: ${outcome.status || 'NO_STATUS'} (success: ${outcome.success}, attempts: ${outcome.attempts || 1})`);

            // DYNAMIC VIP CODE DETECTION: Check if this is actually a VIP code
            if (item.status === 'redeem' && !vipCodeDetected && VIP_RESTRICTION_STATUSES.includes(outcome.status)) {
                vipCodeDetected = true;
                vipCodeDetectedAt = results.length;

                console.warn(`VIP CODE DETECTED during redemption: ${item.giftCode} (Player ${item.id} got ${outcome.status})`);

                // Update gift code to VIP in database
                try {
                    giftCodeQueries.updateGiftCodeVipStatus(true, item.giftCode, redeemContext.gameType);
                    loopGiftCodeData = loopGiftCodeData
                        ? { ...loopGiftCodeData, is_vip: 1 }
                        : { is_vip: 1 };
                } catch (updateError) {
                    await handleError(null, null, updateError, 'updateGiftCodeVipStatus', false);
                }

                // Filter remaining pending players to VIP-eligible only
                const remainingPendingIdentifiers = current.pending.filter(id => id !== identifier);
                if (remainingPendingIdentifiers.length > 0) {
                    const remainingPlayers = remainingPendingIdentifiers
                        .map(id => {
                            const itemData = redeemContext.items.find(i => (i.id || `validation_${i.index}`) === id);
                            return itemData?.id;
                        })
                        .filter(fid => fid);

                    const nonVipEligiblePlayers = [];
                    const vipEligiblePlayers = [];

                    for (const fid of remainingPlayers) {
                        try {
                            const player = playerQueries.getPlayer(fid, processData.details?.game_type || getDefaultGameType());
                            if (!player) continue;

                            const isVipEligible = player.is_rich === 1 ||
                                player.vip_count === 0 ||
                                player.vip_count >= 5;

                            if (isVipEligible) {
                                vipEligiblePlayers.push(fid);
                            } else {
                                nonVipEligiblePlayers.push(fid);
                            }
                        } catch (error) {
                            await handleError(null, null, error, 'checkVipEligibility', false);
                        }
                    }

                    // Skip non-VIP-eligible players immediately
                    if (nonVipEligiblePlayers.length > 0) {
                        for (const fid of nonVipEligiblePlayers) {
                            const skipIdentifier = fid;

                            const skipPayload = {
                                success: false,
                                status: 'SKIPPED_NON_VIP_ELIGIBLE',
                                message: `Skipped: Code detected as VIP, player not VIP-eligible`,
                                playerId: fid,
                                identifier: skipIdentifier,
                                giftCode: item.giftCode,
                                operation: 'redeem',
                                vipSkipped: true
                            };

                            results.push(skipPayload);
                            current.pending = current.pending.filter(id => id !== skipIdentifier);
                            if (!current.failed.includes(skipIdentifier)) {
                                current.failed.push(skipIdentifier);
                            }

                            // Also remove from activeQueue and retryQueue
                            for (let q = activeQueue.length - 1; q >= 0; q--) {
                                if (activeQueue[q].item.id === fid) activeQueue.splice(q, 1);
                            }
                            for (let q = retryQueue.length - 1; q >= 0; q--) {
                                if (retryQueue[q].item.id === fid) retryQueue.splice(q, 1);
                            }
                        }

                        const updatedProgress = {
                            ...progress,
                            pending: current.pending,
                            done: current.done,
                            failed: current.failed,
                            existing: current.existing,
                            redeemResults: results,
                            lastProcessedId: lastProcessedIdentifier,
                            lastProcessedAt: Date.now(),
                            embedState
                        };

                        await updateProcessProgress(processId, updatedProgress);
                    }
                }
            }

            if (item.status === 'redeem' && item.id && outcome.wrongState) {
                try {
                    await queueStateSearch(item.id, redeemContext.gameType, effectiveState, item.giftCode);
                } catch (searchError) {
                    await handleError(null, null, searchError, 'queueStateSearch', false);
                }
            }

            // Handle post-redemption operations (VIP tracking + usage tracking)
            if (item.status === 'redeem' && item.id && outcome.status !== 'SKIPPED_STATE_SEARCH_BLOCKED') {
                await handlePostRedemption(item.id, item.giftCode, outcome, loopGiftCodeData);
            }

            current.pending = current.pending.filter((value) => value !== identifier);
            if (outcome.success) {
                if (!current.done.includes(identifier)) {
                    current.done.push(identifier);
                }
            } else if (!current.failed.includes(identifier)) {
                current.failed.push(identifier);
            }

            lastProcessedIdentifier = identifier;
            processedCount++;

            if (embedState && !embedState.disabled && item.status === 'redeem') {
                // Only compute stats when the embed will actually update (every EMBED_UPDATE_INTERVAL players)
                const shouldComputeStats =
                    !embedState.lastUpdateCount ||
                    processedCount - (embedState.lastUpdateCount || 0) >= EMBED_UPDATE_INTERVAL ||
                    (activeQueue.length === 0 && retryQueue.length === 0); // last item

                if (shouldComputeStats) {
                    const stats = computeRedeemStats(redeemContext, results, current);
                    embedState = await updateRedeemProgressEmbed(
                        processId,
                        embedState,
                        stats,
                        {
                            giftCode: redeemContext.giftCode,
                            alliance: redeemContext.alliance,
                            state: 'in_progress',
                            stateMessage: 'Redeeming in progress...'
                        },
                        false
                    );
                }
            }

            // Batch progress persistence: write every EMBED_UPDATE_INTERVAL players or on last item
            const isLastItem = activeQueue.length === 0 && retryQueue.length === 0;
            const shouldPersist = isLastItem ||
                processedCount % EMBED_UPDATE_INTERVAL === 0;

            if (shouldPersist) {
                const updatedProgress = {
                    ...progress,
                    pending: current.pending,
                    done: current.done,
                    failed: current.failed,
                    existing: current.existing,
                    redeemResults: results,
                    lastProcessedId: lastProcessedIdentifier,
                    lastProcessedAt: Date.now(),
                    embedState
                };

                await updateProcessProgress(processId, updatedProgress);
            }

            // Memory optimization: trigger GC hint periodically (every 50 players)
            if (processedCount > 0 && processedCount % 50 === 0 && global.gc) {
                global.gc();
            }

            if (item.status === 'redeem' && ABORTABLE_STATUSES.has(outcome.status)) {
                abortReason = outcome.status;
                console.warn(`Stopping redeem process ${processId} due to status "${outcome.status}"`);
                break;
            }

            // Adaptive rate-limit-aware delay between players
            const hasMoreActive = activeQueue.length > 0;
            if (item.status === 'redeem' && hasMoreActive) {
                const minRemaining = rateLimitState.redeem;

                if (minRemaining <= RATE_LIMIT_SAFE_MARGIN) {
                    // Budget is low — wait for the rate limit window to reset
                    const elapsed = Date.now() - rateLimitState.windowStart;
                    const windowRemaining = Math.max(0, RATE_LIMIT_WINDOW - elapsed + 1000); // +1s safety buffer
                    if (windowRemaining > 0) {
                        pLog(`[RateLimit] Redeem budget low (${rateLimitState.redeem}) — pausing ${(windowRemaining/1000).toFixed(1)}s for window reset`);
                        await wait(windowRemaining);
                    }
                    // Reset tracker for fresh window
                    rateLimitState.redeem = RATE_LIMIT_PER_WINDOW;
                    rateLimitState.windowStart = Date.now();
                } else {
                    // Normal pacing delay
                    const processingEndTime = Date.now();
                    const elapsedTime = processingEndTime - processingStartTime;
                    const targetDelay = API_CONFIG.MEMBER_PROCESS_DELAY_MIN +
                        Math.random() * (API_CONFIG.MEMBER_PROCESS_DELAY_MAX - API_CONFIG.MEMBER_PROCESS_DELAY_MIN);
                    const remainingDelay = Math.max(0, targetDelay - elapsedTime);
                    if (remainingDelay > 0) {
                        await wait(remainingDelay);
                    }
                }
            }
        }

        if (abortReason && current.pending.length > 0) {
            abortSummary = skipRemainingRedeems(current, redeemContext, results, abortReason);
            lastProcessedIdentifier = abortSummary?.lastIdentifier || lastProcessedIdentifier;

            const abortedProgress = {
                ...progress,
                pending: current.pending,
                done: current.done,
                failed: current.failed,
                existing: current.existing,
                redeemResults: results,
                lastProcessedId: lastProcessedIdentifier,
                lastProcessedAt: Date.now(),
                embedState
            };

            await updateProcessProgress(processId, abortedProgress);
        }

        const summary = {
            success: !abortReason && results.every((entry) => entry.success),
            results
        };

        pLog(`Finished — success: ${summary.success}, processed: ${results.length}, done: ${current.done.length}, failed: ${current.failed.length}, existing: ${current.existing.length}${abortReason ? `, aborted: ${abortReason}` : ''}`);

        if (embedState && !embedState.disabled) {
            const finalStats = computeRedeemStats(redeemContext, results, current);
            const hasFailures = !summary.success || abortReason !== null;
            const state = abortReason ? 'aborted' : hasFailures ? 'failed' : 'completed';
            const stateMessage = abortSummary?.message
                || (abortReason ? getAbortReasonMessage(abortReason, redeemContext.giftCode)
                    : hasFailures
                        ? 'Redeem process completed with errors'
                        : 'Redeem process completed successfully');

            embedState = await updateRedeemProgressEmbed(
                processId,
                embedState,
                finalStats,
                {
                    giftCode: redeemContext.giftCode,
                    alliance: redeemContext.alliance,
                    state,
                    stateMessage
                },
                true
            );

            const finalProgress = {
                ...progress,
                pending: current.pending,
                done: current.done,
                failed: current.failed,
                existing: current.existing,
                redeemResults: results,
                lastProcessedId: lastProcessedIdentifier,
                lastProcessedAt: Date.now(),
                embedState
            };

            await updateProcessProgress(processId, finalProgress);
        }

        resolveProcessCompletion(processId, summary);

        return summary;

    } catch (error) {
        resolveProcessCompletion(processId, {
            success: false,
            results: [],
            error: error.message
        });

        // Let the idle timer handle model cleanup

        throw error;
    }
}

/**
 * Validates if a gift code is active
 * @param {string} giftCode - Gift code to validate
 * @returns {Promise<Object>} Validation result with is_vip flag
 */
async function validateGiftCode(giftCode, gameType = getDefaultGameType()) {
    try {
        // Validation uses a locally stored test player so its alliance supplies
        // the state required by the new one-request API.
        const testPlayer = getTestPlayerForValidation(gameType);

        if (!testPlayer) {
            return {
                success: false,
                status: 'TEST_ID_REQUIRED',
                message: 'Set the test ID to an existing player in an alliance with a valid state',
                is_vip: false
            };
        }

        const { fid: testId, state } = testPlayer;


        // Make API call to validate gift code
        const result = await makeGiftCodeAPIRequest(testId, giftCode, 'validation', { gameType, state });

        // Detect if this is a VIP code based on validation result
        const isVipCode = VIP_RESTRICTION_STATUSES.includes(result.status);

        // Track usage for test ID to prevent it from being redeemed again in auto-redeem
        // This marks the test ID as "already redeemed" for this gift code
        if (result.status && result.status !== WRONG_STATE_STATUS && result.status !== 'UNHANDLED_ERROR' && result.status !== 'ANALYSIS_ERROR') {
            try {
                giftCodeUsageQueries.addUsage(testId, giftCode, result.status, gameType);
            } catch (usageError) {
                // Ignore duplicate entry errors (test ID already has this usage tracked)
                if (!usageError.message.includes('UNIQUE constraint')) {
                    console.error(`Error tracking validation usage for test ID ${testId}:`, usageError.message);
                }
            }
        }

        // Add is_vip flag to result
        return {
            ...result,
            gameType,
            is_vip: isVipCode
        };

    } catch (error) {
        await handleError(null, null, error, 'validateGiftCode', false);
        return {
            success: false,
            message: `Validation error: ${error.message}`,
            is_vip: false
        };
    }
}

/**
 * Redeems a gift code for a specific player
 * @param {string} playerId - Player ID to redeem for
 * @param {string} giftCode - Gift code to redeem
 * @returns {Promise<Object>} Redeem result
 */
async function redeemGiftCodeForPlayer(playerId, giftCode, gameType = getDefaultGameType(), state = null) {
    try {
        devLog(`Redeeming code "${giftCode}" for player ${playerId}`);

        // Make API call to redeem gift code
        const result = await makeGiftCodeAPIRequest(playerId, giftCode, 'redeem', { gameType, state });
        result.gameType = gameType;

        // Reset exist counter if player returned valid data (false positive detection)
        if (result.success) {
            try {
                const playerData = playerQueries.getPlayer(playerId, gameType);
                if (playerData && playerData.exist > 0) {
                    playerQueries.resetPlayerExist(playerId, gameType);
                }
            } catch (dbError) {
                console.error(`Error resetting exist counter for player ${playerId}:`, dbError);
            }
        }

        // Handle ROLE NOT EXIST error - increment exist counter
        if (result.playerNotExist) {
            try {
                playerQueries.incrementPlayerExist(playerId, gameType);

                // Check if player reached 3 exist count
                const playerData = playerQueries.getPlayer(playerId, gameType);
                if (playerData && playerData.exist >= 3) {
                    // Get auto_delete setting
                    const settings = settingsQueries.getSettings.get();
                    const autoDelete = settings?.auto_delete ?? 1; // Default to true

                    if (autoDelete) {
                        // Delete player if auto_delete is enabled
                        playerQueries.deletePlayer(playerId, gameType);
                    }
                }
            } catch (dbError) {
                console.error(`Error handling non-existent player ${playerId}:`, dbError);
            }
        }

        return result;

    } catch (error) {
        await handleError(null, null, error, 'redeemGiftCodeForPlayer', false);
        return {
            success: false,
            message: `Redeem error: ${error.message}`
        };
    }
}

/**
 * Makes the actual API request to the gift code endpoint
 * @param {string} fid - Player FID
 * @param {string} giftCode - Gift code
 * @param {string} operation - 'validation' or 'redeem'
 * @returns {Promise<Object>} API result
 */
async function makeGiftCodeAPIRequest(fid, giftCode, operation, options = {}) {
    const apiConfig = resolveRedeemApiConfig(options.gameType);
    const state = Number(options.state);
    if (!Number.isSafeInteger(state) || state <= 0) {
        return createErrorResult('STATE_REQUIRED', 'A valid alliance state is required', false);
    }

    const maxAttempts = apiConfig.MAX_REDEEM_ATTEMPTS || apiConfig.MAX_RETRIES || 3;
    let lastResult = null;
    let lastError = null;
    const proxyConfigured = isProxyConfiguredFor(apiConfig.GIFT_CODE_URL);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await postForm(
                apiConfig.GIFT_CODE_URL,
                {
                    fid: String(fid),
                    cdk: giftCode,
                    kid: String(state),
                    time: Math.floor(Date.now() / 1000).toString()
                },
                'Gift code',
                apiConfig
            );

            updateRateLimit('redeem', response.rateLimit?.remaining);

            if (response.status === 429) {
                return {
                    ...createErrorResult('HTTP_ERROR', 'HTTP 429 Too Many Requests', false),
                    rateLimited: true,
                    retryDelay: apiConfig.RATE_LIMIT_DELAY,
                    attempts: attempt
                };
            }

            if (!response.ok || !response.data) {
                lastResult = createErrorResult('HTTP_ERROR', `HTTP ${response.status}`, false);
            } else {
                const analysis = analyzeAPIResponse(response.data, operation);
                const result = { ...analysis, attempts: attempt };

                if (analysis.retry?.type === 'rate') {
                    return {
                        ...result,
                        rateLimited: true,
                        retryDelay: analysis.retry.delay ?? apiConfig.RATE_LIMIT_DELAY
                    };
                }

                return result;
            }
        } catch (error) {
            lastError = error;
            const status = proxyConfigured && isNetworkError(error) ? 'PROXY_ERROR' : 'NETWORK_ERROR';
            lastResult = createErrorResult(status, error.message, false);
        }

        if (attempt < maxAttempts) await wait(apiConfig.RETRY_DELAY);
    }

    if (lastError) {
        // Surface transport failures in production logs/system log so proxy/network
        // outages are visible instead of silently showing up as failed players.
        await handleError(null, null, lastError, `makeGiftCodeAPIRequest_${operation}`, false);
    }

    return { ...lastResult, attempts: maxAttempts };
}

/**
 * Analyzes the API response and returns structured result
 * Based on the response structure from test_model_live.js
 * @param {Object} data - API response data
 * @param {string} operation - 'validation' or 'redeem'
 * @returns {Object} Analyzed result
 */
function analyzeAPIResponse(data, operation) {
    try {
        if (!data || typeof data !== 'object') {
            return createErrorResult('EMPTY_RESPONSE', 'Empty API response', false);
        }

        const errCode = Number(data.err_code ?? data.errCode ?? 0);
        let rawMessage;
        let statusKey;

        // Handle both string and numeric error codes from API
        if (typeof data.msg === 'string') {
            rawMessage = data.msg;
            statusKey = rawMessage.toUpperCase().replace(/[.\s]+$/g, '');
        } else if (typeof data.msg === 'number' || (data.msg && !isNaN(Number(data.msg)))) {
            // API returned numeric error code as msg - look it up
            const numericCode = Number(data.msg);
            const mappedStatus = ERROR_CODE_TO_STATUS[numericCode];
            if (mappedStatus) {
                rawMessage = mappedStatus;
                statusKey = mappedStatus;
            } else {
                // Unknown numeric error code
                rawMessage = `Error ${numericCode}`;
                statusKey = `ERROR_${numericCode}`;
            }
        } else {
            rawMessage = '';
            statusKey = '';
        }

        const message = rawMessage || 'Unknown response';

        const base = {
            message,
            status: statusKey || 'UNKNOWN_API_RESPONSE',
            errCode,
            details: data
        };

        // Use status map for known statuses with error code validation
        const statusConfig = getStatusConfig(rawMessage);
        if (statusConfig) {
            // Validate error code if it's defined in the status map
            if (statusConfig.errCode !== undefined && errCode !== 0 && errCode !== statusConfig.errCode) {
                console.warn(`Error code mismatch for "${statusKey}": expected ${statusConfig.errCode}, got ${errCode}`);
                // Log the mismatch but still use the status config
                systemLogQueries.addLog(
                    'error_code_mismatch',
                    `API error code mismatch detected`,
                    JSON.stringify({
                        status: statusKey,
                        expectedCode: statusConfig.errCode,
                        actualCode: errCode,
                        operation: operation
                    })
                );
            }
            return { ...base, ...statusConfig };
        }

        // Fallback: Try to look up by error code if status string lookup failed
        if (errCode !== 0 && ERROR_CODE_TO_STATUS[errCode]) {
            const fallbackStatus = ERROR_CODE_TO_STATUS[errCode];
            const fallbackConfig = getStatusConfig(fallbackStatus);
            if (fallbackConfig) {
                return {
                    ...base,
                    status: fallbackStatus,
                    message: fallbackStatus,
                    ...fallbackConfig
                };
            }
        }

        // Default response for unknown status codes
        return {
            ...base,
            success: false,
            giftCodeActive: false
        };

    } catch (error) {
        console.error('Error analyzing API response:', error.message);
        return {
            success: false,
            status: 'ANALYSIS_ERROR',
            message: error.message,
            giftCodeActive: false
        };
    }
}

function computeRedeemStats(redeemContext, results, current) {
    // Use allItems if available (includes pre-filtered), otherwise use items
    const allRedeemItems = Array.isArray(redeemContext.allItems)
        ? redeemContext.allItems.filter((item) => item.status === 'redeem')
        : Array.isArray(redeemContext.items)
            ? redeemContext.items.filter((item) => item.status === 'redeem')
            : [];

    // Failed excludes outcomes that have their own dedicated result group.
    const isFailedEntry = (entry) =>
        !entry.preFiltered && entry.success === false && !entry.vipSkipped && entry.status !== WRONG_STATE_STATUS;

    const total = allRedeemItems.length;
    const processedResults = Array.isArray(results)
        ? results.filter((entry) => entry.operation === 'redeem')
        : [];

    const processed = processedResults.length; // Total including pre-filtered
    const success = processedResults.filter((entry) => !entry.preFiltered && entry.status === 'SUCCESS').length;

    // Already redeemed includes:
    // 1. Pre-filtered players (redeemed before process started)
    // 2. Players who got RECEIVED/SAME TYPE EXCHANGE during this process
    const alreadyRedeemed = processedResults.filter((entry) =>
        entry.preFiltered === true || ALREADY_REDEEMED_STATUSES.includes(entry.status)
    ).length;

    // Poor players: VIP restrictions + Level restrictions + VIP-skipped (detected mid-process)
    const vipRestricted = processedResults.filter((entry) =>
        !entry.preFiltered && VIP_RESTRICTION_STATUSES.includes(entry.status)
    ).length;

    const levelRestricted = processedResults.filter((entry) =>
        !entry.preFiltered && LEVEL_RESTRICTION_STATUSES.includes(entry.status)
    ).length;

    const vipSkippedCount = processedResults.filter((entry) =>
        !entry.preFiltered && entry.vipSkipped === true
    ).length;

    const restricted = vipRestricted + levelRestricted + vipSkippedCount;

    const wrongStateIds = [...new Set(processedResults
        .filter((entry) => !entry.preFiltered && entry.status === WRONG_STATE_STATUS)
        .map((entry) => String(entry.playerId || entry.identifier || ''))
        .filter(Boolean))];

    const stateSearchBlocked = processedResults.filter((entry) =>
        entry.status === 'SKIPPED_STATE_SEARCH_BLOCKED'
    ).length;

    const failed = processedResults.filter(isFailedEntry).length;

    // Break down failed players by status so embeds can explain WHY they failed.
    const failedByStatus = {};
    for (const entry of processedResults) {
        if (isFailedEntry(entry)) {
            const statusKey = entry.status || 'UNKNOWN';
            failedByStatus[statusKey] = (failedByStatus[statusKey] || 0) + 1;
        }
    }

    // Total pending = items that still need processing (NOT pre-filtered, NOT processed yet)
    const totalPending = current && Array.isArray(current.pending)
        ? current.pending.length // Pending only contains items to be processed
        : 0;

    const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

    return {
        total,
        processed,
        totalPending,
        success,
        alreadyRedeemed,
        restricted,
        wrongStateIds,
        stateSearchBlocked,
        failed,
        failedByStatus,
        percent
    };
}

async function updateRedeemProgressEmbed(processId, embedState, stats, context, force = false) {
    if (!embedState || embedState.disabled || !embedState.channelId) {
        return embedState;
    }

    const shouldUpdate =
        force ||
        !embedState.lastUpdateCount ||
        stats.total === 0 ||
        stats.processed === stats.total ||
        stats.processed - (embedState.lastUpdateCount || 0) >= EMBED_UPDATE_INTERVAL;

    if (!shouldUpdate) {
        return embedState;
    }

    try {
        const { client } = require('../../index');
        const channel = await client.channels.fetch(embedState.channelId);
        if (!channel) {
            throw new Error(`Channel ${embedState.channelId} not found`);
        }

        const embed = buildRedeemProgressEmbed(stats, { ...context, processId });

        const publishEmbed = async () => {
            let message = null;
            if (embedState.messageId) {
                try {
                    message = await channel.messages.fetch(embedState.messageId);
                } catch (error) {
                    message = null;
                }
            }

            if (!message) {
                message = await channel.send({ embeds: [embed] });
                embedState.messageId = message.id;
                embedState.guildId = channel.guildId;
                return;
            }

            try {
                await message.edit({ embeds: [embed] });
            } catch (error) {
                // If the original message is gone or edit temporarily fails,
                // recreate it so the final batch does not get stuck on stale progress.
                message = await channel.send({ embeds: [embed] });
                embedState.messageId = message.id;
                embedState.guildId = channel.guildId;
            }
        };

        await publishEmbed();

        if (force && stats.wrongStateIds?.length && !embedState.wrongStateReportSent) {
            const configuredState = context?.alliance?.state;
            const gameType = context?.alliance?.gameType || getDefaultGameType();
            const wrongStatePlayers = playerQueries.getPlayersByFids(stats.wrongStateIds, gameType);
            const playerById = new Map(wrongStatePlayers.map(p => [String(p.fid), p]));
            const idList = stats.wrongStateIds
                .map(id => formatPlayerWithId(playerById.get(String(id)) || { fid: id }))
                .join('\n');
            const heading = `**${WRONG_STATE_STATUS}** — ${stats.wrongStateIds.length} player(s) do not match${configuredState ? ` state ${configuredState}` : ' the configured alliance state'}.`;

            if (heading.length + idList.length + 1 <= 2000) {
                await channel.send({ content: `${heading}\n${idList}` });
            } else {
                await channel.send({
                    content: heading,
                    files: [{
                        attachment: Buffer.from(`${idList}\n`, 'utf8'),
                        name: `wrong-state-fids-${processId}.txt`
                    }]
                });
            }
            embedState.wrongStateReportSent = true;
        }

        embedState.lastUpdateCount = stats.processed;
        embedState.lastState = context.state;

    } catch (error) {
        await handleError(null, null, error, 'updateRedeemProgressEmbed', false);
        embedState.disabled = true;
    }

    return embedState;
}

function buildRedeemProgressEmbed(stats, context) {
    const allianceName = context?.alliance?.name || 'Alliance';
    const state = context?.state || 'in_progress';
    const progressBar = createProgressBar(stats.processed, stats.total, 20, context?.processId || 0);
    const descriptionParts = [];

    if (context?.giftCode) {
        descriptionParts.push(`Gift code: \`${context.giftCode}\``);
    }

    descriptionParts.push(`Progress: ${progressBar} (${stats.processed}/${stats.total || 0})`);

    if (context?.stateMessage) {
        descriptionParts.push(context.stateMessage);
    }

    let color = PROGRESS_EMBED_COLOR;
    if (state === 'completed') {
        color = PROGRESS_EMBED_COLOR_COMPLETE;
    } else if (state === 'failed' || state === 'aborted') {
        color = PROGRESS_EMBED_COLOR_FAILED;
    }

    const fields = [
        { name: 'Success', value: String(stats.success), inline: true },
        { name: 'Already Redeemed', value: String(stats.alreadyRedeemed), inline: true },
        { name: 'Poor/Weak', value: String(stats.restricted || 0), inline: true },
        { name: 'Failed', value: String(stats.failed), inline: true }
    ];

    if (stats.stateSearchBlocked) {
        fields.push({ name: 'Waiting for state update', value: String(stats.stateSearchBlocked), inline: true });
    }

    if (stats.wrongStateIds?.length) {
        const ids = stats.wrongStateIds.join(', ');
        fields.push({
            name: `Wrong State • ${WRONG_STATE_STATUS} (${stats.wrongStateIds.length})`,
            value: ids.length > 1024 ? `${ids.slice(0, 1020)}...` : ids
        });
    }

    if (stats.failed > 0) {
        const failureGroups = Object.entries(stats.failedByStatus || {})
            .map(([status, count]) => {
                const label = status === 'SKIPPED_STATE_SEARCH_BLOCKED'
                    ? 'State search blocked'
                    : status.startsWith('SKIPPED_')
                    ? 'Skipped'
                    : (FAILURE_STATUS_LABELS[status] || status);
                return `${label}: ${count}`;
            })
            .sort();
        const shownGroups = failureGroups.slice(0, MAX_FAILURE_GROUPS);
        if (failureGroups.length > MAX_FAILURE_GROUPS) {
            shownGroups.push(`+${failureGroups.length - MAX_FAILURE_GROUPS} more`);
        }
        let value = shownGroups.join(' • ') || String(stats.failed);
        if (value.length > 1024) value = `${value.slice(0, 1020)}...`;
        fields.push({
            name: 'Failure reasons',
            value,
            inline: false
        });
    }

    return new EmbedBuilder()
        .setTitle(`Redeem Progress • ${allianceName}`)
        .setDescription(descriptionParts.join('\n'))
        .setColor(color)
        .addFields(...fields)
        .setTimestamp(new Date());
}

function createProgressBar(processed, total, length = 20, processId = 0) {
    const styles = [
        { filled: '█', empty: '░' },
        { filled: '▰', empty: '▱' },
        { filled: '▶', empty: '▷' },
        { filled: '★', empty: '☆' }
    ];
    // Use processId to pick a consistent style per process instead of randomizing on every update
    const style = styles[processId % styles.length];

    if (total <= 0) {
        return style.empty.repeat(length) + ' 0%';
    }

    const ratio = Math.max(0, Math.min(1, processed / total));
    const filled = Math.round(ratio * length);
    const empty = Math.max(length - filled, 0);
    const percent = Math.min(100, Math.round(ratio * 100));
    return style.filled.repeat(filled) + style.empty.repeat(empty) + ` ${percent}%`;
}

function skipRemainingRedeems(current, redeemContext, results, abortStatus) {
    if (!current || !Array.isArray(current.pending) || current.pending.length === 0) {
        return null;
    }

    const reason = getAbortReasonMessage(abortStatus, redeemContext.giftCode);
    let lastIdentifier = null;

    const remaining = [...current.pending];
    for (const identifier of remaining) {
        const item = redeemContext.items.find((entry) => (entry.id || `validation_${entry.index}`) === identifier);
        const payload = {
            success: false,
            status: `SKIPPED_${abortStatus.replace(/\s+/g, '_')}`,
            message: reason,
            playerId: item?.id || null,
            identifier,
            giftCode: redeemContext.giftCode,
            operation: item?.status || 'redeem',
            aborted: true,
            abortReason: abortStatus,
            attempts: 0
        };

        results.push(payload);

        if (!current.failed.includes(identifier)) {
            current.failed.push(identifier);
        }

        lastIdentifier = identifier;
    }

    current.pending = [];

    return {
        message: reason,
        lastIdentifier
    };
}

function getAbortReasonMessage(status, giftCode) {
    switch (status) {
        case 'USED':
            return `Gift code \`${giftCode}\` reached its usage limit. Remaining members were skipped.`;
        case 'TIME ERROR':
            return `Gift code \`${giftCode}\` expired. Remaining members were skipped.`;
        case 'CDK NOT FOUND':
            return `Gift code \`${giftCode}\` is invalid. Remaining members were skipped.`;
        default:
            return `Redeem process stopped due to status: ${status}.`;
    }
}

module.exports = {
    createRedeemProcess,
    executeRedeemOperation,
    validateGiftCode,
    redeemGiftCodeForPlayer,
    makeGiftCodeAPIRequest,
    analyzeAPIResponse,
    classifyGiftCodeValidationResult,
    getValidationFailureKind,
    computeRedeemStats,
    handleVipTracking,
    handlePostRedemption
};
