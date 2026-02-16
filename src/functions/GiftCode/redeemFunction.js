const path = require('path');
const fs = require('fs').promises;
const onnx = require('onnxruntime-node');
const sharp = require('sharp');
const { EmbedBuilder } = require('discord.js');
const { sendError } = require('../utility/commonFunctions');
const {
    createProcess,
    updateProcessProgress,
    getProcessById
} = require('../Processes/createProcesses');
const { queueManager } = require('../Processes/queueManager');
const { processExecutor } = require('../Processes/executeProcesses');
const { systemLogQueries, giftCodeQueries, playerQueries, giftCodeUsageQueries, settingsQueries } = require('../utility/database');
const { getTestIdForValidation } = require('./setTestId');
const { API_CONFIG } = require('../utility/apiConfig');
const { encodeData, nativePost } = require('../utility/apiClient');

const MODEL_CONFIG = {
    modelPath: path.join(__dirname, '../../model/captcha_model.onnx'),
    metadataPath: path.join(__dirname, '../../model/captcha_model_metadata.json')
};

// Update embed progress every N players processed (not a time interval)
const EMBED_UPDATE_INTERVAL = 10;
const PROGRESS_EMBED_COLOR = 0x3498db;
const PROGRESS_EMBED_COLOR_COMPLETE = 0x2ecc71;
const PROGRESS_EMBED_COLOR_FAILED = 0xe74c3c;
const ABORTABLE_STATUSES = new Set(['USED', 'TIME ERROR', 'CDK NOT FOUND']);

// Status arrays for cleaner comparisons
const ALREADY_REDEEMED_STATUSES = ['RECEIVED', 'SAME TYPE EXCHANGE'];
const VIP_RESTRICTION_STATUSES = ['RECHARGE_MONEY ERROR', 'RECHARGE_MONEY_VIP ERROR'];
const LEVEL_RESTRICTION_STATUSES = ['STOVE_LV ERROR'];

// API status code mapping for response analysis with error codes
const API_STATUS_MAP = {
    'CAPTCHA CHECK ERROR': { success: false, giftCodeActive: null, retry: { type: 'captcha' }, errCode: 40103 },
    'CAPTCHA EXPIRED': { success: false, giftCodeActive: null, retry: { type: 'captcha' }, errCode: 40102 },
    'CAPTCHA GET TOO FREQUENT': { success: false, giftCodeActive: true, retry: { type: 'rate', delay: API_CONFIG.RATE_LIMIT_DELAY }, errCode: 40100 },
    'CAPTCHA CHECK TOO FREQUENT': { success: false, giftCodeActive: true, retry: { type: 'rate', delay: API_CONFIG.RATE_LIMIT_DELAY }, errCode: 40101 },
    'TIMEOUT RETRY': { success: false, giftCodeActive: true, retry: { type: 'rate', delay: API_CONFIG.RATE_LIMIT_DELAY }, errCode: 40004 },
    'ROLE NOT EXIST': { success: false, giftCodeActive: true, playerNotExist: true, errCode: 40001 },
    'SUCCESS': { success: true, giftCodeActive: true },
    'RECEIVED': { success: true, giftCodeActive: true, errCode: 40008 },
    'SAME TYPE EXCHANGE': { success: true, giftCodeActive: true, errCode: 40011 },
    'USED': { success: true, giftCodeActive: false, errCode: 40005 },
    'TIME ERROR': { success: true, giftCodeActive: false, errCode: 40007 },
    'CDK NOT FOUND': { success: true, giftCodeActive: false, errCode: 40014 },
    'STOVE_LV ERROR': { success: true, giftCodeActive: true, errCode: 40006 },
    'RECHARGE_MONEY ERROR': { success: true, giftCodeActive: true, errCode: 40017 },
    'RECHARGE_MONEY_VIP ERROR': { success: true, giftCodeActive: true, errCode: 40018 },
    'NOT LOGIN': { success: false, giftCodeActive: null, retry: { type: 'captcha' } },
    'SIGN ERROR': { success: false, giftCodeActive: null, retry: { type: 'captcha' } }
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
    40100: 'CAPTCHA GET TOO FREQUENT',
    40101: 'CAPTCHA CHECK TOO FREQUENT',
    40102: 'CAPTCHA EXPIRED',
    40103: 'CAPTCHA CHECK ERROR'
};

// Captcha rate limiter to prevent hitting API rate limits
// Tracks the last captcha fetch timestamp globally across all processes
let lastCaptchaFetchTime = 0;

const processCompletionResolvers = new Map();

class CaptchaSolver {
    constructor() {
        this.initialising = null;
        this.session = null;
        this.metadata = null;
        this.idleTimer = null;
        this.IDLE_TIMEOUT = 2 * 60 * 1000; // 2 minutes of inactivity before unloading
    }

    async ensureReady() {
        // Clear any existing idle timer
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }

        // Load model if not already loaded
        if (!this.session || !this.metadata) {
            if (!this.initialising) {
                this.initialising = this.loadModel();
            }
            await this.initialising;
        }

        // Set timer to unload model after idle period
        this.idleTimer = setTimeout(() => this.unload(), this.IDLE_TIMEOUT);
    }

    async loadModel() {
        try {
            const [modelExists, metadataExists] = await Promise.all([
                fileExists(MODEL_CONFIG.modelPath),
                fileExists(MODEL_CONFIG.metadataPath)
            ]);

            if (!modelExists || !metadataExists) {
                throw new Error('Captcha model or metadata not found. Please ensure the ONNX model is deployed under src/model/.');
            }

            this.session = await onnx.InferenceSession.create(MODEL_CONFIG.modelPath);

            const metadataContent = await fs.readFile(MODEL_CONFIG.metadataPath, 'utf8');
            this.metadata = JSON.parse(metadataContent);

            this.initialising = null; // Reset initializing flag

        } catch (error) {
            this.session = null;
            this.metadata = null;
            this.initialising = null;
            await sendError(null, null, error, 'loadCaptchaModel', false);
            throw error;
        }
    }

    unload() {
        if (this.session || this.metadata) {
            this.session = null;
            this.metadata = null;
            this.initialising = null;

            // Force garbage collection if available (requires --expose-gc flag)
            if (global.gc) {
                global.gc();
            }
        }

        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    async solve(imageBuffer) {
        await this.ensureReady();

        const { metadata, session } = this;
        const [channels, height, width] = metadata.input_shape;

        const processedBuffer = await sharp(imageBuffer)
            .resize(width, height, { fit: 'fill' })
            .grayscale()
            .raw()
            .toBuffer();

        const imageData = new Float32Array(processedBuffer.length);
        const mean = metadata.normalization.mean[0];
        const std = metadata.normalization.std[0];

        for (let i = 0; i < processedBuffer.length; i++) {
            imageData[i] = (processedBuffer[i] / 255.0 - mean) / std;
        }

        const inputTensor = new onnx.Tensor('float32', imageData, [1, channels, height, width]);

        const feeds = { image: inputTensor };
        const results = await session.run(feeds);

        let predictedText = '';
        const confidences = [];

        for (let pos = 0; pos < metadata.output_positions; pos++) {
            const outputKey = `position_${pos}`;
            const probabilities = results[outputKey].data;

            let maxProb = -Infinity;
            let maxIdx = 0;
            for (let i = 0; i < probabilities.length; i++) {
                if (probabilities[i] > maxProb) {
                    maxProb = probabilities[i];
                    maxIdx = i;
                }
            }

            const char = metadata.idx_to_char[maxIdx.toString()];
            predictedText += char;
            confidences.push(maxProb);
        }

        const avgConfidence = confidences.reduce((sum, value) => sum + value, 0) / confidences.length;

        return {
            text: predictedText,
            confidence: avgConfidence
        };
    }
}

const captchaSolver = new CaptchaSolver();

function fileExists(targetPath) {
    return fs
        .access(targetPath)
        .then(() => true)
        .catch(() => false);
}

function registerProcessCompletion(processId) {
    return new Promise((resolve) => {
        processCompletionResolvers.set(processId, resolve);
    });
}

function resolveProcessCompletion(processId, payload) {
    const resolver = processCompletionResolvers.get(processId);
    if (resolver) {
        resolver(payload);
        processCompletionResolvers.delete(processId);
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

async function authenticatePlayer(fid) {
    let lastError = null;

    // Retry authentication up to 3 times
    for (let attempt = 1; attempt <= API_CONFIG.MAX_RETRIES; attempt++) {
        try {
            const response = await postForm(
                API_CONFIG.PLAYER_URL,
                {
                    fid: String(fid),
                    time: Math.floor(Date.now() / 1000).toString()
                },
                'Player authentication'
            );


            // Check for success (case-insensitive)
            const msgLower = typeof response.data?.msg === 'string' ? response.data.msg.toLowerCase() : '';
            if (response.ok && response.data && msgLower === 'success' && response.data.data) {
                return {
                    stoveLv: response.data.data.stove_lv || 1,
                    nickname: response.data.data.nickname || 'Unknown'
                };
            }

            // Rate limit detected - wait longer
            if (response.status === 429 || msgLower.includes('too frequent') || msgLower.includes('timeout')) {
                lastError = `Rate limited (attempt ${attempt}/${API_CONFIG.MAX_RETRIES})`;
                console.warn(`Player auth rate limited for FID ${fid}, waiting ${API_CONFIG.RATE_LIMIT_DELAY}ms...`);
                await wait(API_CONFIG.RATE_LIMIT_DELAY);
                continue;
            }

            // Check for non-retryable errors (player doesn't exist)
            // Don't waste time and rate limits retrying for invalid player IDs
            if (msgLower.includes('role not exist') ||
                msgLower.includes('not exist') ||
                msgLower.includes('invalid')) {
                // Return object indicating player doesn't exist (not null)
                return { playerNotExist: true, message: response.data?.msg || 'Player not found' };
            }

            // Other error - shorter retry delay
            lastError = `Auth failed: ${response.data?.msg || 'Unknown error'} (HTTP ${response.status})`;
            if (attempt < API_CONFIG.MAX_RETRIES) {
                // console.warn(`Player auth failed for FID ${fid} (attempt ${attempt}/${API_CONFIG.MAX_RETRIES}), retrying in ${API_CONFIG.RETRY_DELAY}ms...`);
                await wait(API_CONFIG.RETRY_DELAY);
            }

        } catch (error) {
            lastError = error.message;
            // console.error(`Player auth exception for FID ${fid} (attempt ${attempt}/${API_CONFIG.MAX_RETRIES}):`, error.message);
            if (attempt < API_CONFIG.MAX_RETRIES) {
                await wait(API_CONFIG.RETRY_DELAY);
            }
        }
    }

    // All retries exhausted
    console.error(`Player authentication failed for FID ${fid} after ${API_CONFIG.MAX_RETRIES} attempts. Last error: ${lastError}`);
    return { authFailed: true, message: lastError };
}

async function fetchCaptchaImage(fid) {
    const response = await postForm(
        API_CONFIG.CAPTCHA_URL,
        {
            fid: String(fid),
            time: Date.now().toString(),
            init: '0'
        },
        'Captcha fetch'
    );

    // Handle HTTP 429 (rate limit) specifically before checking response structure
    if (response.status === 429) {
        /*
        console.warn(`Captcha API rate limited (HTTP 429) for FID ${fid}`, {
            status: response.status,
            ok: response.ok,
            data: response.data,
            raw: response.raw ? response.raw.substring(0, 500) : 'N/A' // Truncate raw response to prevent log spam
        });
        */
        return { error: 'CAPTCHA GET TOO FREQUENT', authError: false };
    }

    if (!response.ok || !response.data || typeof response.data !== 'object') {
        /*
        console.error('Invalid captcha response structure:', {
            ok: response.ok,
            status: response.status,
            dataType: typeof response.data,
            data: response.data,
            raw: response.raw ? response.raw.substring(0, 500) : 'N/A' // Include raw response for diagnosis
        });
        */
        return { error: 'INVALID_RESPONSE', authError: false };
    }

    const { data } = response;

    if (
        (data.msg === 'SUCCESS' || data.msg === 'success') &&
        data.data &&
        typeof data.data.img === 'string'
    ) {
        const base64String = data.data.img.startsWith('data:')
            ? data.data.img.split(',')[1]
            : data.data.img;

        try {
            return { buffer: Buffer.from(base64String, 'base64'), authError: false };
        } catch (error) {
            // console.error('Failed to decode captcha image:', error.message);
            return { error: 'DECODE_ERROR', authError: false };
        }
    }

    // Check if this is an authentication error (NOT LOGIN, SIGN ERROR)
    const isAuthError = data.msg === 'NOT LOGIN.' ||
        data.msg === 'NOT LOGIN' ||
        data.msg === 'SIGN ERROR.' ||
        data.msg === 'SIGN ERROR';

    /*
    console.error('Captcha fetch failed:', {
        msg: data.msg,
        errCode: data.err_code,
        authError: isAuthError
    });
    */

    return { error: data.msg || 'UNKNOWN_ERROR', authError: isAuthError };
}

/**
 * Pre-filters players who have already redeemed a gift code
 * Returns items to process and pre-filtered results
 * @param {Array} redeemItems - Items with status='redeem' and valid IDs
 * @param {string} giftCode - Gift code to check
 * @returns {Object} { itemsToProcess, preFilteredResults }
 */
function preFilterAlreadyRedeemed(redeemItems, giftCode) {
    const preFilteredResults = [];

    if (redeemItems.length === 0) {
        return { itemsToProcess: [], preFilteredResults };
    }

    try {
        const redeemedFidsList = giftCodeUsageQueries.getFidsWhoRedeemedCode(giftCode);
        const alreadyRedeemedFids = new Set(redeemedFidsList.map(fid => String(fid)));

        if (alreadyRedeemedFids.size > 0) {

            for (const item of redeemItems) {
                if (alreadyRedeemedFids.has(String(item.id))) {
                    const previousUsage = giftCodeUsageQueries.checkUsage(item.id, giftCode);
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

                    // console.log(`Player ${item.id} already redeemed with status: ${previousStatus}`);
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
            allianceContext: providedAllianceContext
        } = options;

        const allianceContext = providedAllianceContext
            ? {
                id: providedAllianceContext.id != null ? String(providedAllianceContext.id) : null,
                name: providedAllianceContext.name || null,
                channelId: providedAllianceContext.channelId || null,
                guildId: providedAllianceContext.guildId || null
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

        const { itemsToProcess: filteredRedeemItems, preFilteredResults } =
            preFilterAlreadyRedeemed(redeemItems, giftCode);

        // Combine validation items FIRST, then redeem items
        // This ensures validation runs before bulk redemption to avoid API rate limit exhaustion
        const validationItems = normalisedItems.filter(item => item.status === 'validation');
        const itemsToProcess = [...validationItems, ...filteredRedeemItems];

        const identifiers = normalisedItems.map((item) => item.id || `validation_${item.index}`);
        const identifiersToProcess = itemsToProcess.map((item) => item.id || `validation_${item.index}`);
        const existingIdentifiers = identifiers.filter(id => !identifiersToProcess.includes(id));

        // To-do: implement debug mode to turn on this logging
        // console.log(`Pre-filter results: ${normalisedItems.length} total, ${itemsToProcess.length} to process, ${existingIdentifiers.length} already redeemed`);

        const adminId = providedAdminId || 'SYSTEM_AUTO_REDEEM';

        const processResult = await createProcess({
            admin_id: adminId,
            alliance_id: allianceContext?.id || 0, // Use 0 for system validation processes (no real alliance)
            player_ids: identifiers.join(','),
            action: 'redeem_giftcode'
        });

        if (!processResult || !processResult.process_id) {
            throw new Error('Failed to create redeem process');
        }

        const processId = processResult.process_id;

        const redeemContext = {
            items: itemsToProcess, // Only items that need processing
            allItems: normalisedItems, // Keep all items for reference
            giftCode: giftCode,
            createdAt: Date.now(),
            alliance: allianceContext
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

        await queueManager.manageQueue(processResult);

        if (completionPromise) {
            const completion = await completionPromise;

            // For validation operations, determine if the gift code is valid
            if (shouldAwaitCompletion && completion.results && completion.results.length > 0) {
                const validationResult = completion.results[0];

                // A gift code is valid if:
                // 1. giftCodeActive is true (code exists and can be used)
                // 2. OR it returned a success status indicating the code is valid (like SAME TYPE EXCHANGE, RECEIVED, SUCCESS, etc.)
                const isValidGiftCode = validationResult.giftCodeActive === true;

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
        await sendError(null, null, error, 'createRedeemProcess', false);

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
 */
async function handleVipTracking(playerId, giftCode, outcome) {
    try {
        // Check if this is a VIP/Recharge restricted code
        const giftCodeData = giftCodeQueries.getGiftCode(giftCode);
        if (!giftCodeData || !giftCodeData.is_vip) {
            return; // Not a VIP code, no tracking needed
        }

        const player = playerQueries.getPlayer(playerId);
        if (!player) {
            // console.warn(`Player ${playerId} not found for VIP tracking`);
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
        await sendError(null, null, error, 'handleVipTracking', false);
        // Don't throw - VIP tracking shouldn't break the redeem process
    }
}

/**
 * Handles post-redemption operations: VIP tracking and usage tracking
 * @param {string} playerId - Player FID
 * @param {string} giftCode - Gift code that was redeemed
 * @param {Object} outcome - Redemption outcome with status
 */
async function handlePostRedemption(playerId, giftCode, outcome) {
    // Handle VIP tracking for VIP/Recharge codes
    await handleVipTracking(playerId, giftCode, outcome);

    // Track gift code usage for this player
    try {
        giftCodeUsageQueries.addUsage(playerId, giftCode, outcome.status || 'UNKNOWN');;
    } catch (usageError) {
        // Ignore duplicate entry errors (player already has this usage tracked)
        if (!usageError.message.includes('UNIQUE constraint')) {
            console.error(`Error tracking usage for player ${playerId}:`, usageError.message);
        }
    }
}

/**
 * Processes a single redeem item (validation or redemption)
 * @param {Object} item - Redeem item with id, giftCode, status (validation/redeem)
 * @returns {Promise<Object>} Outcome with success, status, message, etc.
 */
async function processSingleRedeemItem(item) {
    try {
        if (item.status === 'validation') {
            return await validateGiftCode(item.giftCode);
        } else if (item.status === 'redeem') {
            if (!item.id) {
                throw new Error('Missing player ID for redeem operation');
            }
            return await redeemGiftCodeForPlayer(item.id, item.giftCode);
        } else {
            throw new Error(`Unknown operation status: ${item.status}`);
        }
    } catch (error) {
        await sendError(null, null, error, 'processSingleRedeemItem', false);
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

        // Process only items that are still pending (handles crash recovery correctly)
        // This prevents re-processing items that were already completed before a crash
        const itemsToProcess = redeemContext.items.filter((item) => {
            const identifier = item.id || `validation_${item.index}`;
            return current.pending.includes(identifier);
        });


        for (let i = 0; i < itemsToProcess.length; i++) {
            const item = itemsToProcess[i];
            const identifier = item.id || `validation_${item.index}`;

            // Add API cooldown when transitioning from validation to redemption
            // This ensures the API rate limit window has reset before bulk operations start
            if (i > 0 && itemsToProcess[i - 1].status === 'validation' && item.status === 'redeem') {
                const VALIDATION_TO_REDEEM_COOLDOWN = 3000; // 3 seconds cooldown
                await wait(VALIDATION_TO_REDEEM_COOLDOWN);
            }

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

            // Process this redeem item
            const outcome = await processSingleRedeemItem(item);

            const resultPayload = {
                ...outcome,
                playerId: item.id,
                identifier,
                giftCode: item.giftCode,
                operation: item.status
            };

            results.push(resultPayload);

            // DYNAMIC VIP CODE DETECTION: Check if this is actually a VIP code
            if (item.status === 'redeem' && !vipCodeDetected && VIP_RESTRICTION_STATUSES.includes(outcome.status)) {
                vipCodeDetected = true;
                vipCodeDetectedAt = results.length;

                console.warn(`VIP CODE DETECTED during redemption: ${item.giftCode} (Player ${item.id} got ${outcome.status})`);

                // Update gift code to VIP in database
                try {
                    giftCodeQueries.updateGiftCodeVipStatus(true, item.giftCode);

                    systemLogQueries.addLog(
                        'vip_detection',
                        `Gift code dynamically detected as VIP: ${item.giftCode}`,
                        JSON.stringify({
                            giftCode: item.giftCode,
                            detectedAt: vipCodeDetectedAt,
                            detectedByPlayer: item.id,
                            status: outcome.status,
                            processId: processId
                        })
                    );
                } catch (updateError) {
                    await sendError(null, null, updateError, 'updateGiftCodeVipStatus', false);
                }

                // Filter remaining pending players to VIP-eligible only
                const remainingPendingIdentifiers = current.pending.filter(id => id !== identifier);
                if (remainingPendingIdentifiers.length > 0) {
                    const remainingPlayers = remainingPendingIdentifiers
                        .map(id => {
                            const itemData = redeemContext.items.find(i => (i.id || `validation_${i.index}`) === id);
                            return itemData?.id;
                        })
                        .filter(fid => fid); // Remove nulls

                    // Check which remaining players are VIP-eligible
                    const nonVipEligiblePlayers = [];
                    const vipEligiblePlayers = [];

                    for (const fid of remainingPlayers) {
                        try {
                            const player = playerQueries.getPlayer(fid);
                            if (!player) continue;

                            // VIP-eligible: is_rich = 1 OR vip_count = 0 OR vip_count >= 5
                            const isVipEligible = player.is_rich === 1 ||
                                player.vip_count === 0 ||
                                player.vip_count >= 5;

                            if (isVipEligible) {
                                vipEligiblePlayers.push(fid);
                            } else {
                                nonVipEligiblePlayers.push(fid);
                            }
                        } catch (error) {
                            await sendError(null, null, error, 'checkVipEligibility', false);
                        }
                    }


                    // Skip non-VIP-eligible players immediately
                    if (nonVipEligiblePlayers.length > 0) {
                        for (const fid of nonVipEligiblePlayers) {
                            const skipIdentifier = fid;
                            const skipItem = redeemContext.items.find(i => i.id === fid);

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

                        }

                        // Update progress to reflect skipped players
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

            // Handle post-redemption operations (VIP tracking + usage tracking)
            if (item.status === 'redeem' && item.id) {
                await handlePostRedemption(item.id, item.giftCode, outcome);
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

            if (embedState && !embedState.disabled && item.status === 'redeem') {
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

            // Memory optimization: trigger GC hint periodically (every 50 players)
            if (i > 0 && i % 50 === 0 && global.gc) {
                global.gc();
            }

            if (item.status === 'redeem' && ABORTABLE_STATUSES.has(outcome.status)) {
                abortReason = outcome.status;
                console.warn(`Stopping redeem process ${processId} due to status "${outcome.status}"`);

                // Mark gift code as invalid if it expired/was used/not found during redemption
                if (outcome.status === 'USED' || outcome.status === 'TIME ERROR' || outcome.status === 'CDK NOT FOUND') {
                    try {
                        giftCodeQueries.updateGiftCodeStatus('invalid', item.giftCode);

                        systemLogQueries.addLog(
                            'code_invalidated',
                            `Gift code became invalid during redemption: ${item.giftCode}`,
                            JSON.stringify({
                                giftCode: item.giftCode,
                                reason: outcome.status,
                                processId: processId,
                                processedPlayers: results.length,
                                remainingPlayers: current.pending.length
                            })
                        );
                    } catch (updateError) {
                        await sendError(null, null, updateError, 'updateGiftCodeVipStatus', false);
                    }
                }

                break;
            }

            // Add delay between redemptions (BEFORE next redemption starts)
            // This prevents captcha API rate limiting by spacing out captcha fetches
            // Calculate time taken and only wait the remaining time to reach 2 seconds
            // Skip delay only for the last player
            const isLastItem = (i === itemsToProcess.length - 1);
            if (item.status === 'redeem' && !isLastItem) {
                const processingEndTime = Date.now();
                const elapsedTime = processingEndTime - processingStartTime;

                // Calculate remaining delay needed to reach 2 seconds minimum
                const remainingDelay = Math.max(0, API_CONFIG.BETWEEN_REDEMPTIONS_DELAY - elapsedTime);

                if (remainingDelay > 0) {
                    await wait(remainingDelay);
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

        // Memory optimization: Unload captcha model after completion
        captchaSolver.unload();

        // Trigger GC if available
        if (global.gc) {
            global.gc();
        }

        return summary;

    } catch (error) {
        resolveProcessCompletion(processId, {
            success: false,
            results: [],
            error: error.message
        });

        systemLogQueries.addLog(
            'error',
            `Error executing redeem operation for process ${processId}`,
            JSON.stringify({
                processId,
                error: error.message,
                stack: error.stack,
                function: 'executeRedeemOperation'
            })
        );

        // Memory cleanup on error
        captchaSolver.unload();
        if (global.gc) {
            global.gc();
        }

        throw error;
    }
}

/**
 * Validates if a gift code is active
 * @param {string} giftCode - Gift code to validate
 * @returns {Promise<Object>} Validation result with is_vip flag
 */
async function validateGiftCode(giftCode) {
    try {
        // Get test ID for validation
        const testId = getTestIdForValidation();

        if (!testId) {
            return {
                success: false,
                message: 'No test ID available for validation',
                is_vip: false
            };
        }


        // Make API call to validate gift code
        const result = await makeGiftCodeAPIRequest(testId, giftCode, 'validation');

        // Detect if this is a VIP code based on validation result
        const isVipCode = VIP_RESTRICTION_STATUSES.includes(result.status);

        // Track usage for test ID to prevent it from being redeemed again in auto-redeem
        // This marks the test ID as "already redeemed" for this gift code
        if (result.status && result.status !== 'UNHANDLED_ERROR' && result.status !== 'ANALYSIS_ERROR') {
            try {
                giftCodeUsageQueries.addUsage(testId, giftCode, result.status);
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
            is_vip: isVipCode
        };

    } catch (error) {
        await sendError(null, null, error, 'validateGiftCode', false);
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
async function redeemGiftCodeForPlayer(playerId, giftCode) {
    try {
        // to-do: implement debug mode to turn on this logging
        //console.log(`Redeeming gift code "${giftCode}" for player: ${playerId}`);

        // Make API call to redeem gift code
        const result = await makeGiftCodeAPIRequest(playerId, giftCode, 'redeem');

        // Reset exist counter if player returned valid data (false positive detection)
        if (result.success) {
            try {
                const playerData = playerQueries.getPlayer(playerId);
                if (playerData && playerData.exist > 0) {
                    playerQueries.resetPlayerExist(playerId);
                }
            } catch (dbError) {
                console.error(`Error resetting exist counter for player ${playerId}:`, dbError);
            }
        }

        // Handle ROLE NOT EXIST error - increment exist counter
        if (result.playerNotExist) {
            try {
                playerQueries.incrementPlayerExist(playerId);

                // Check if player reached 3 exist count
                const playerData = playerQueries.getPlayer(playerId);
                if (playerData && playerData.exist >= 3) {
                    // Get auto_delete setting
                    const settings = settingsQueries.getSettings.get();
                    const autoDelete = settings?.auto_delete ?? 1; // Default to true

                    if (autoDelete) {
                        // Delete player if auto_delete is enabled
                        playerQueries.deletePlayer(playerId);
                    }
                }
            } catch (dbError) {
                console.error(`Error handling non-existent player ${playerId}:`, dbError);
            }
        }

        return result;

    } catch (error) {
        await sendError(null, null, error, 'redeemGiftCodeForPlayer', false);
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
async function makeGiftCodeAPIRequest(fid, giftCode, operation) {
    const timings = { auth: 0, captchaFetch: 0, captchaSolve: 0, apiCall: 0, retries: 0, delays: 0 };
    const startTime = Date.now();

    // IMPORTANT: Authenticate player ONCE before captcha retry loop
    // This prevents duplicate authentication calls on each captcha retry
    const authStart = Date.now();
    let authInfo = await authenticatePlayer(fid);
    timings.auth = Date.now() - authStart;

    if (!authInfo || authInfo.authFailed || authInfo.playerNotExist) {
        // Check if this is a "player doesn't exist" case
        if (authInfo?.playerNotExist) {
            // Return proper response with playerNotExist flag to trigger exist counter tracking
            return {
                success: false,
                status: 'ROLE NOT EXIST',
                message: authInfo.message || 'Player does not exist',
                giftCodeActive: true,
                playerNotExist: true
            };
        }
        // Generic auth failure
        console.error(`Player authentication failed for FID: ${fid} - cannot proceed with ${operation}`);
        return createErrorResult('PLAYER_AUTH_FAILED', `Player authentication failed for FID ${fid}`, false);
    }

    let attempt = 0;
    let lastResult = null;
    let consecutiveRateLimits = 0;
    let authRetryCount = 0;
    const MAX_CONSECUTIVE_RATE_LIMITS = 2; // Give up after 2 consecutive rate limits
    const MAX_AUTH_RETRIES = 2; // Maximum auth retries to prevent infinite loops

    while (attempt < API_CONFIG.MAX_CAPTCHA_ATTEMPTS) {
        attempt++;
        timings.retries = attempt - 1;

        // Rate limit captcha fetches to prevent API rate limit errors
        // Ensure minimum delay between captcha fetch requests across all players
        const now = Date.now();
        const timeSinceLastFetch = now - lastCaptchaFetchTime;
        const minDelayBetweenFetches = API_CONFIG.BETWEEN_REDEMPTIONS_DELAY;

        if (lastCaptchaFetchTime > 0 && timeSinceLastFetch < minDelayBetweenFetches) {
            const waitTime = minDelayBetweenFetches - timeSinceLastFetch;
            await wait(waitTime);
            timings.delays += waitTime;
        }

        // Update last fetch time before fetching (not after) to prevent concurrent fetches
        lastCaptchaFetchTime = Date.now();

        const captchaFetchStart = Date.now();
        const captchaResult = await fetchCaptchaImage(fid);
        timings.captchaFetch += (Date.now() - captchaFetchStart);

        // Handle captcha fetch failure
        if (!captchaResult || !captchaResult.buffer) {
            // Check if this is an authentication error (session expired)
            if (captchaResult?.authError) {
                // console.warn(`Authentication expired for FID ${fid}, re-authenticating...`);

                // Re-authenticate player
                authInfo = await authenticatePlayer(fid);
                if (!authInfo || authInfo.authFailed || authInfo.playerNotExist) {
                    // Check if player doesn't exist during re-auth
                    if (authInfo?.playerNotExist) {
                        return {
                            success: false,
                            status: 'ROLE NOT EXIST',
                            message: authInfo.message || 'Player does not exist',
                            giftCodeActive: true,
                            playerNotExist: true
                        };
                    }
                    // console.error(`Re-authentication failed for FID: ${fid}`);
                    return createErrorResult('REAUTH_FAILED', `Re-authentication failed for FID ${fid}`, false);
                }


                // Retry captcha fetch immediately without incrementing attempt counter
                attempt--;
                continue;
            }

            // Use API_STATUS_MAP to determine how to handle captcha fetch errors
            const errorMsg = captchaResult?.error || 'UNKNOWN_ERROR';
            const statusConfig = getStatusConfig(errorMsg);

            if (statusConfig?.retry?.type === 'rate') {
                consecutiveRateLimits++;

                // Give up if we've hit too many consecutive rate limits
                if (consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) {
                    console.error(`Giving up on FID ${fid} after ${consecutiveRateLimits} consecutive rate limits`);
                    return createErrorResult(
                        'RATE_LIMIT_EXCEEDED',
                        `Too many consecutive rate limits (${consecutiveRateLimits})`,
                        statusConfig.giftCodeActive
                    );
                }

                // Exponential backoff: increase delay for consecutive rate limits
                const backoffMultiplier = Math.pow(1.5, consecutiveRateLimits - 1);
                const adjustedDelay = Math.min(
                    statusConfig.retry.delay * backoffMultiplier,
                    120000 // Cap at 2 minutes
                );

                // console.warn(`Captcha rate limited for FID ${fid} (attempt ${consecutiveRateLimits}/${MAX_CONSECUTIVE_RATE_LIMITS}), waiting ${Math.round(adjustedDelay)}ms...`);
                lastResult = {
                    success: false,
                    status: errorMsg.toUpperCase().replace(/[.\s]+$/g, ''),
                    message: errorMsg,
                    giftCodeActive: statusConfig.giftCodeActive,
                    retry: statusConfig.retry
                };
                const delayStart = Date.now();
                await wait(adjustedDelay);
                timings.delays += (Date.now() - delayStart);
                continue;
            }

            // Reset consecutive rate limit counter for non-rate-limit errors
            consecutiveRateLimits = 0;

            // Other non-auth, non-rate-limit error, treat as normal retry
            lastResult = createErrorResult('CAPTCHA_FETCH_FAILED', 'Unable to fetch captcha image', false);
            const delayStart1 = Date.now();
            await wait(API_CONFIG.RETRY_DELAY);
            timings.delays += (Date.now() - delayStart1);
            continue;
        }

        // Successfully got captcha image - reset counters
        consecutiveRateLimits = 0;
        authRetryCount = 0;
        let captchaImage = captchaResult.buffer;

        let solved;
        const solveStart = Date.now();
        try {
            solved = await captchaSolver.solve(captchaImage);
            timings.captchaSolve += (Date.now() - solveStart);
        } catch (error) {
            console.error('Captcha solving failed:', error.message);
            lastResult = createErrorResult('CAPTCHA_SOLVE_FAILED', error.message, false);

            // Clean up captcha buffer to free memory
            captchaImage = null;

            const delayStart2 = Date.now();
            await wait(API_CONFIG.RETRY_DELAY);
            timings.delays += (Date.now() - delayStart2);
            continue;
        }

        // Clean up captcha buffer after solving to free memory
        captchaImage = null;

        const apiCallStart = Date.now();
        const response = await postForm(
            API_CONFIG.GIFT_CODE_URL,
            {
                fid: String(fid),
                cdk: giftCode,
                captcha_code: solved.text,
                time: Date.now().toString()
            },
            'Gift code'
        );
        timings.apiCall += (Date.now() - apiCallStart);

        if (!response.ok || !response.data) {
            lastResult = createErrorResult('HTTP_ERROR', `HTTP ${response.status}`, false);

            const delayStart3 = Date.now();
            if (response.status === 429) {
                await wait(API_CONFIG.RATE_LIMIT_DELAY);
            } else {
                await wait(API_CONFIG.RETRY_DELAY);
            }
            timings.delays += (Date.now() - delayStart3);
            continue;
        }

        const analysis = analyzeAPIResponse(response.data, operation);
        const totalTime = Date.now() - startTime;
        const result = {
            ...analysis,
            success: analysis.success,
            captchaText: solved.text,
            captchaConfidence: solved.confidence,
            attempts: attempt
        };

        // Clean up solved captcha data
        solved = null;

        /*
        if (totalTime > 2000) {
            result.timings = { ...timings, total: totalTime };
            console.log(`Slow player ${fid}: ${totalTime}ms total | Auth: ${timings.auth}ms | Captcha Fetch: ${timings.captchaFetch}ms | Solve: ${timings.captchaSolve}ms | API Call: ${timings.apiCall}ms | Delays: ${timings.delays}ms | Retries: ${timings.retries}`);
        }
        */

        if (analysis.retry?.type === 'captcha') {
            lastResult = result;
            const delayStart4 = Date.now();
            await wait(API_CONFIG.RETRY_DELAY);
            timings.delays += (Date.now() - delayStart4);
            continue;
        }

        if (analysis.retry?.type === 'rate') {
            lastResult = result;
            const delayStart5 = Date.now();
            await wait(analysis.retry.delay ?? API_CONFIG.RATE_LIMIT_DELAY);
            timings.delays += (Date.now() - delayStart5);
            continue;
        }

        return result;
    }

    // Clean up resources before returning
    authInfo = null;
    lastResult = null;

    const totalTime = Date.now() - startTime;
    const finalResult = lastResult || createErrorResult('MAX_ATTEMPTS_EXCEEDED', 'Maximum captcha attempts exceeded', false);

    /*
    if (totalTime > 2000) {
        console.log(`Failed player ${fid}: ${totalTime}ms total | Auth: ${timings.auth}ms | Captcha Fetch: ${timings.captchaFetch}ms | Solve: ${timings.captchaSolve}ms | API Call: ${timings.apiCall}ms | Delays: ${timings.delays}ms | Retries: ${timings.retries}`);
    }
    */

    // Force early captcha model unload on repeated failures
    if (attempt >= API_CONFIG.MAX_CAPTCHA_ATTEMPTS || authRetryCount > MAX_AUTH_RETRIES) {
        captchaSolver.unload();
    }

    return finalResult;
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

    const total = allRedeemItems.length;
    const processedResults = Array.isArray(results)
        ? results.filter((entry) => entry.operation === 'redeem')
        : [];

    const processed = processedResults.length; // Total including pre-filtered
    const success = processedResults.filter((entry) => entry.status === 'SUCCESS').length;

    // Already redeemed includes:
    // 1. Pre-filtered players (redeemed before process started)
    // 2. Players who got RECEIVED/SAME TYPE EXCHANGE during this process
    const alreadyRedeemed = processedResults.filter((entry) =>
        entry.preFiltered === true || ALREADY_REDEEMED_STATUSES.includes(entry.status)
    ).length;

    // Poor players: VIP restrictions + Level restrictions
    const vipRestricted = processedResults.filter((entry) =>
        !entry.preFiltered && VIP_RESTRICTION_STATUSES.includes(entry.status)
    ).length;

    const levelRestricted = processedResults.filter((entry) =>
        !entry.preFiltered && LEVEL_RESTRICTION_STATUSES.includes(entry.status)
    ).length;

    const restricted = vipRestricted + levelRestricted;

    // Failed includes actual failures + VIP-skipped players (skipped after VIP detection)
    const failed = processedResults.filter((entry) =>
        !entry.preFiltered && (entry.success === false || entry.vipSkipped === true)
    ).length;

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
        failed,
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
        } else {
            await message.edit({ embeds: [embed] });
        }

        embedState.lastUpdateCount = stats.processed;
        embedState.lastState = context.state;

    } catch (error) {
        await sendError(null, null, error, 'updateRedeemProgressEmbed', false);
        embedState.disabled = true;
    }

    return embedState;
}

function buildRedeemProgressEmbed(stats, context) {
    const allianceName = context?.alliance?.name || 'Alliance';
    const state = context?.state || 'in_progress';
    const progressBar = createProgressBar(stats.processed, stats.total);
    const descriptionParts = [];

    if (context?.giftCode) {
        descriptionParts.push(`Gift code: \`${context.giftCode}\``);
    }

    descriptionParts.push(`Progress: \`${progressBar}\` (${stats.processed}/${stats.total || 0})`);

    if (context?.stateMessage) {
        descriptionParts.push(context.stateMessage);
    }

    let color = PROGRESS_EMBED_COLOR;
    if (state === 'completed') {
        color = PROGRESS_EMBED_COLOR_COMPLETE;
    } else if (state === 'failed' || state === 'aborted') {
        color = PROGRESS_EMBED_COLOR_FAILED;
    }

    return new EmbedBuilder()
        .setTitle(`Redeem Progress • ${allianceName}`)
        .setDescription(descriptionParts.join('\n'))
        .setColor(color)
        .addFields(
            { name: 'Success', value: String(stats.success), inline: true },
            { name: 'Already Redeemed', value: String(stats.alreadyRedeemed), inline: true },
            { name: 'Poor/Weak', value: String(stats.restricted || 0), inline: true },
            { name: 'Failed', value: String(stats.failed), inline: true }
        )
        .setFooter({ text: `Process ID: ${context?.processId || 'unknown'}` })
        .setTimestamp(new Date());
}

function createProgressBar(processed, total, length = 20) {
    if (total <= 0) {
        return `[${'-'.repeat(length)}] 0%`;
    }

    const ratio = Math.max(0, Math.min(1, processed / total));
    const filled = Math.round(ratio * length);
    const bar = `${'='.repeat(filled)}${'-'.repeat(Math.max(length - filled, 0))}`;
    const percent = Math.min(100, Math.round(ratio * 100));
    return `[${bar}] ${percent}%`;
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
    handleVipTracking
};
