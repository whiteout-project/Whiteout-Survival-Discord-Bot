const fetch = require('node-fetch');
const { EmbedBuilder } = require('discord.js');
const { giftCodeQueries, adminQueries, allianceQueries, playerQueries, systemLogQueries } = require('../utility/database');
const { createRedeemProcess } = require('./redeemFunction');
const languages = require('../../i18n');
const { getAdminLang, sendError } = require('../utility/commonFunctions');
const { GIFT_CODE_API_CONFIG } = require('../utility/apiConfig');


/**
 * Gift Code API Client for syncing gift codes between bots
 * Handles periodic synchronization with the central gift code API
 */
class GiftCodeAPI {
    constructor(bot) {
        this.bot = bot;
        this.apiUrl = GIFT_CODE_API_CONFIG.API_URL;
        this.apiKey = GIFT_CODE_API_CONFIG.API_KEY;

        // Random 5-10min check interval to help reduce API load
        this.minCheckInterval = 300000; // 5 minutes in ms
        this.maxCheckInterval = 600000; // 10 minutes in ms
        this.checkInterval = this.randomInt(this.minCheckInterval, this.maxCheckInterval);

        // Rate limiting controls
        this.lastApiCall = 0;
        this.minApiCallInterval = 3000; // 3 seconds
        this.errorBackoffTime = 30000; // 30 seconds
        this.cloudflareBackoffTime = 15000; // 15 seconds
        this.maxBackoffTime = 300000; // 5 minutes
        this.currentBackoff = this.errorBackoffTime;

        // Start periodic API synchronization
        this.startApiCheck();

    }

    /**
     * Generate random integer between min and max (inclusive)
     */
    randomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    /**
     * Generate random float between min and max
     */
    randomFloat(min, max) {
        return Math.random() * (max - min) + min;
    }

    /**
     * Sleep for specified milliseconds
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Enforce rate limiting between API calls
     */
    async waitForRateLimit() {
        const now = Date.now();
        const timeSinceLastCall = now - this.lastApiCall;

        if (timeSinceLastCall < this.minApiCallInterval) {
            const sleepTime = this.minApiCallInterval - timeSinceLastCall;
            const jitter = this.randomFloat(0, 500); // Add 0-500ms jitter
            await this.sleep(sleepTime + jitter);
        }

        this.lastApiCall = Date.now();
    }

    /**
     * Handle API errors with appropriate backoff strategies
     */
    async handleApiError(response, responseText) {
        const status = response.status;

        if (status === 429) {
            // Rate limit triggered - standard backoff
            console.warn(`Rate limit triggered: ${status}`);
            let backoff = Math.max(this.cloudflareBackoffTime, this.currentBackoff);
            backoff *= this.randomFloat(1.0, 1.5);
            this.currentBackoff = Math.min(this.currentBackoff * 2, this.maxBackoffTime);
            return backoff;
        } else if (status === 502 || status === 503 || status === 504) {
            // Server errors - back off with increasing delay
            console.warn(`Server error: ${status}`);
            const backoff = this.currentBackoff * this.randomFloat(0.75, 1.25);
            this.currentBackoff = Math.min(this.currentBackoff * 2, this.maxBackoffTime);
            return backoff;
        } else {
            // Other errors - standard backoff
            console.error(`API error: ${status}, ${responseText.substring(0, 200)}`);
            return this.currentBackoff * this.randomFloat(0.75, 1.25);
        }
    }

    /**
     * Start periodic API synchronization with exponential backoff on failures
     */
    async startApiCheck() {
        try {
            // Initial delay before first check
            await this.sleep(60000); // 1 minute

            while (true) {
                try {
                    const success = await this.syncWithAPI();

                    if (success) {
                        // Also check for codes that need revalidation (24 hours)
                        await this.validateExistingCodes().catch(error => {
                            console.error('Error validating existing codes:', error);
                        });

                        // Reset backoff on success
                        this.currentBackoff = this.errorBackoffTime;
                        this.checkInterval = this.randomInt(this.minCheckInterval, this.maxCheckInterval);
                        await this.sleep(this.checkInterval);
                    } else {
                        // Added jitter on failure to prevent thundering herd
                        const jitter = this.randomFloat(0.75, 1.25);
                        const backoffTime = Math.min(this.currentBackoff * jitter, this.maxBackoffTime);
                        console.warn(`API sync failed, backing off for ${(backoffTime / 1000).toFixed(1)} seconds`);
                        await this.sleep(backoffTime);
                        this.currentBackoff = Math.min(this.currentBackoff * 2, this.maxBackoffTime);
                    }
                } catch (error) {
                    console.error('Error in API check loop:', error);
                    const sleepTime = Math.min(
                        this.currentBackoff * this.randomFloat(0.75, 1.25),
                        this.maxBackoffTime
                    );
                    await this.sleep(sleepTime);
                    this.currentBackoff = Math.min(this.currentBackoff * 2, this.maxBackoffTime);
                }
            }
        } catch (error) {
            await sendError(null, null, error, 'startApiCheck', false);
        }
    }

    /**
     * Validate existing gift codes that haven't been checked in 24 hours
     */
    async validateExistingCodes() {
        try {
            const codesToValidate = giftCodeQueries.getCodesNeedingValidation();

            if (codesToValidate.length === 0) {
                // to-do: Implement debug mode to uncomment this line
                // console.log('ℹ️ No gift codes need revalidation');
                return;
            }


            for (const codeData of codesToValidate) {
                try {
                    await this.waitForRateLimit();


                    // Use process system for validation (same as addGift.js)
                    const validationResult = await createRedeemProcess([
                        {
                            id: null,
                            giftCode: codeData.gift_code,
                            status: 'validation'
                        }
                    ], {
                        adminId: 'SYSTEM_24H_VALIDATION'
                    });

                    // Check giftCodeActive instead of success
                    // success=true just means we got a definitive answer (including TIME ERROR, USED, etc.)
                    // giftCodeActive=false means the code is expired/invalid and cannot be redeemed
                    if (validationResult?.success && validationResult.results?.[0]?.giftCodeActive === true) {
                        // Code is still valid and can be used - update last_validated timestamp
                        giftCodeQueries.updateLastValidated(codeData.gift_code);
                    } else {
                        // Code is now invalid/expired/used - mark it and remove from API
                        const message = validationResult?.message || validationResult?.results?.[0]?.message || 'Unknown error';
                        const status = validationResult?.results?.[0]?.status || 'UNKNOWN';
                        giftCodeQueries.updateGiftCodeStatus('invalid', codeData.gift_code);

                        // Remove from API
                        try {
                            await this.removeGiftcode(codeData.gift_code, true);
                        } catch (removeError) {
                            console.error(`Failed to remove invalid code ${codeData.gift_code} from API:`, removeError);
                        }

                        systemLogQueries.addLog(
                            '24h_validation',
                            `Gift code became invalid after 24h check: ${codeData.gift_code}`,
                            JSON.stringify({
                                giftCode: codeData.gift_code,
                                reason: message,
                                status: status,
                                lastValidated: codeData.last_validated,
                                action: 'marked_invalid'
                            })
                        );
                    }
                } catch (error) {
                    await sendError(null, null, error, 'validateExistingCodes', false);
                }
            }

        } catch (error) {
            await sendError(null, null, error, 'validateExistingCodes', false);
        }
    }

    /**
     * Synchronize gift codes with the API
     */
    async syncWithAPI() {
        try {

            // Get all gift codes from local database
            const dbCodes = {};
            const allCodes = giftCodeQueries.getAllGiftCodes();
            allCodes.forEach(row => {
                dbCodes[row.gift_code] = {
                    date: row.date,
                    status: row.status,
                    source: row.source || 'manual',        // Track where code came from: 'api' or 'manual'
                    api_pushed: row.api_pushed || false    // Track if manually added code was pushed to API
                };
            });

            const headers = {
                'X-API-Key': this.apiKey,
                'Content-Type': 'application/json'
            };

            await this.waitForRateLimit();

            try {
                const response = await fetch(this.apiUrl, {
                    method: 'GET',
                    headers: headers
                });

                const responseText = await response.text();

                if (response.status !== 200) {
                    const backoffTime = await this.handleApiError(response, responseText);
                    console.warn(`API request failed, backing off for ${(backoffTime / 1000).toFixed(1)} seconds`);
                    await this.sleep(backoffTime);
                    return false;
                }

                try {
                    const result = JSON.parse(responseText);

                    if (result.error || result.detail) {
                        const errorMsg = result.error || result.detail || 'Unknown error';
                        console.error(`API returned error: ${errorMsg}`);
                        return false;
                    }

                    const apiGiftcodes = result.codes || [];

                    // Validate and parse codes
                    const validCodes = [];
                    const invalidCodes = [];

                    for (const codeLine of apiGiftcodes) {
                        const parts = codeLine.trim().split(/\s+/);
                        if (parts.length !== 2) {
                            invalidCodes.push(codeLine);
                            continue;
                        }

                        const [code, dateStr] = parts;

                        // Validate code format (alphanumeric only)
                        if (!/^[a-zA-Z0-9]+$/.test(code)) {
                            invalidCodes.push(codeLine);
                            continue;
                        }

                        // Parse date (format: DD.MM.YYYY)
                        const dateMatch = dateStr.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
                        if (!dateMatch) {
                            invalidCodes.push(codeLine);
                            continue;
                        }

                        const [, day, month, year] = dateMatch;
                        const formattedDate = `${year}-${month}-${day}`; // Convert to YYYY-MM-DD

                        validCodes.push({ code, date: formattedDate });
                    }

                    // Delete invalid codes from API
                    if (invalidCodes.length > 0) {
                        console.warn(`Found ${invalidCodes.length} invalid code formats from API`);

                        for (const invalidCode of invalidCodes) {
                            try {
                                const code = invalidCode.includes(' ')
                                    ? invalidCode.split(/\s+/)[0]
                                    : invalidCode.trim();

                                await this.waitForRateLimit();

                                const deleteResponse = await fetch(this.apiUrl, {
                                    method: 'DELETE',
                                    headers: headers,
                                    body: JSON.stringify({ code })
                                });

                                if (deleteResponse.status !== 200) {
                                    const backoffTime = await this.handleApiError(
                                        deleteResponse,
                                        await deleteResponse.text()
                                    );
                                    await this.sleep(backoffTime);
                                }
                            } catch (error) {
                                await sendError(null, null, error, 'deleteInvalidCode', false);
                            }
                        }
                    }

                    // Find codes that are new to us (not in database)
                    const newCodesToValidate = [];
                    for (const { code, date } of validCodes) {
                        if (!dbCodes[code]) {
                            newCodesToValidate.push({ code, date });
                        }
                    }

                    // Validate new codes BEFORE adding them to database
                    if (newCodesToValidate.length > 0) {

                        // PHASE 1: Validate ALL codes first and collect valid ones
                        // This prevents validation processes from preempting auto-redeem processes
                        const validCodesForAutoRedeem = [];

                        for (const { code, date } of newCodesToValidate) {
                            try {
                                // Validate the gift code using process system (same as addGift.js)

                                const validationResult = await createRedeemProcess([
                                    {
                                        id: null,
                                        giftCode: code,
                                        status: 'validation'
                                    }
                                ], {
                                    adminId: 'SYSTEM_API_SYNC'
                                });

                                // Check giftCodeActive instead of success
                                // success=true just means we got a definitive answer (including TIME ERROR, USED, etc.)
                                // giftCodeActive=true means the code exists and can still be redeemed
                                if (validationResult?.success && validationResult.results?.[0]?.giftCodeActive === true) {
                                    // Code is VALID and ACTIVE - collect for database addition and auto-redeem
                                    // Get VIP status from validation result
                                    const isVipCode = validationResult.results?.[0]?.is_vip || false;

                                    validCodesForAutoRedeem.push({ code, date, isVipCode });

                                    try {
                                        // addGiftCode(giftCode, status, addedBy, source, apiPushed, isVip)
                                        giftCodeQueries.addGiftCode(code, 'active', 'system', 'api', true, isVipCode);

                                        // Set last_validated timestamp to prevent re-validation by validateExistingCodes
                                        giftCodeQueries.updateLastValidated(code);

                                        // VIP count is NOT incremented here anymore
                                        // It will be incremented individually for each player that FAILS to redeem due to VIP restrictions
                                        // This happens in handleVipTracking() during the redeem process
                                    } catch (dbError) {
                                        console.error(`Error adding code ${code} to database:`, dbError);
                                        continue; // Skip to next code if database add fails
                                    }

                                } else {
                                    // Code is INVALID/EXPIRED/USED - do NOT add to database, remove from API
                                    const message = validationResult?.message || validationResult?.results?.[0]?.message || 'Unknown error';
                                    const status = validationResult?.results?.[0]?.status || 'UNKNOWN';

                                    // Remove invalid code from API
                                    try {
                                        await this.removeGiftcode(code, true);
                                    } catch (removeError) {
                                        console.error(`Failed to remove inactive code ${code} from API:`, removeError);
                                    }

                                    systemLogQueries.addLog(
                                        'api_validation',
                                        `Inactive/expired code from API (not added to database): ${code}`,
                                        JSON.stringify({
                                            giftCode: code,
                                            reason: message,
                                            status: status,
                                            giftCodeActive: validationResult?.results?.[0]?.giftCodeActive,
                                            date: date,
                                            action: 'rejected'
                                        })
                                    );
                                }
                            } catch (error) {
                                await sendError(null, null, error, 'validateNewCode', false);
                            }
                        }

                        // PHASE 2: Create auto-redeem processes for ALL valid codes across ALL alliances
                        // This happens AFTER all validation completes to prevent preemption issues
                        if (validCodesForAutoRedeem.length > 0) {
                            const autoRedeemAlliances = allianceQueries.getAlliancesWithAutoRedeem();

                            // Create ALL processes in parallel (non-blocking)
                            const processCreationPromises = [];

                            for (const { code, date, isVipCode } of validCodesForAutoRedeem) {
                                for (const alliance of autoRedeemAlliances) {
                                    processCreationPromises.push({
                                        code,
                                        allianceId: alliance.id,
                                        allianceName: alliance.name,
                                        promise: this.createAutoRedeemProcessForCodeAndAlliance(code, alliance, isVipCode)
                                    });
                                }
                            }

                            // Wait for ALL processes to finish (don't fail fast) and log per-alliance failures
                            const creationResults = await Promise.allSettled(processCreationPromises.map(p => p.promise));

                            creationResults.forEach((result, idx) => {
                                const { code, allianceId, allianceName } = processCreationPromises[idx];
                                if (result.status === 'rejected') {
                                    sendError(null, null, result.reason, `autoRedeemProcessCreation_${code}_${allianceId}`, false);
                                } else if (result.value === null) {
                                    // Null indicates no eligible players or other early exit; log for visibility
                                    // console.warn(`Auto-redeem process not created for code ${code} in alliance ${allianceName} (${allianceId}) - no eligible players or skipped.`);
                                }
                            });

                            // Notify owner admins about VALID codes only (if bot is ready)
                            if (this.bot.isReady()) {
                                const allAdmins = adminQueries.getAllAdmins();
                                const ownerAdmins = allAdmins.filter(admin => admin.is_owner === 1);

                                if (ownerAdmins.length > 0) {
                                    const autoRedeemCount = allianceQueries.getAlliancesWithAutoRedeem().length;

                                    // Send notification to each owner admin with ALL codes in one message
                                    for (const admin of ownerAdmins) {
                                        const { lang } = getAdminLang(admin.user_id);

                                        // Create embeds for all valid codes
                                        const embeds = validCodesForAutoRedeem.map(({ code, date }) => {
                                            const adminEmbed = new EmbedBuilder()
                                                .setTitle(lang.giftCode.apiGiftCode.content.title)
                                                .setFields(
                                                    {
                                                        name: lang.giftCode.apiGiftCode.content.giftCodeDetailsField.name,
                                                        value: lang.giftCode.apiGiftCode.content.giftCodeDetailsField.value
                                                            .replace('{giftCode}', code)
                                                            .replace('{date}', date)
                                                            .replace('{source}', lang.giftCode.apiGiftCode.content.sourceAPI)
                                                            .replace('{time}', `<t:${Math.floor(Date.now() / 1000)}:R>`)
                                                    }
                                                )
                                                .setColor("#2ecc71"); // Green color

                                            if (autoRedeemCount > 0) {
                                                adminEmbed.addFields(
                                                    {
                                                        name: lang.giftCode.apiGiftCode.content.autoRedeem,
                                                        value: lang.giftCode.apiGiftCode.content.autoRedeemValue
                                                            .replace('{count}', autoRedeemCount),
                                                    }
                                                );
                                            }

                                            return adminEmbed;
                                        });

                                        // Send all embeds in one message (Discord allows up to 10 embeds per message)
                                        // If more than 10 codes, split into multiple messages
                                        try {
                                            const user = await this.bot.users.fetch(admin.user_id);

                                            // Split embeds into chunks of 10 (Discord's limit)
                                            for (let i = 0; i < embeds.length; i += 10) {
                                                const embedChunk = embeds.slice(i, i + 10);
                                                await user.send({ embeds: embedChunk });
                                            }
                                        } catch (error) {
                                            await sendError(null, null, error, 'sendAdminNotifications', false);
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Push our manually added codes to API if they're not already there
                    // Only push codes that were added manually (not from API) and are still active
                    const apiCodeSet = new Set(validCodes.map(c => c.code));
                    const codesToPush = [];

                    for (const [dbCode, dbInfo] of Object.entries(dbCodes)) {
                        // Only push codes that meet ALL these criteria:
                        // 1. Not invalid (status !== 'invalid')
                        // 2. Source is 'manual', NOT from API
                        // 3. Not already pushed to API (api_pushed === false)
                        // 4. Not already in API
                        if (dbInfo.status !== 'invalid' &&
                            dbInfo.source === 'manual' &&
                            dbInfo.api_pushed === false &&
                            !apiCodeSet.has(dbCode)) {
                            codesToPush.push({ code: dbCode, date: dbInfo.date });
                        }
                    }

                    if (codesToPush.length > 0) {

                        for (const { code, date } of codesToPush) {
                            try {
                                // Check if code already exists in API
                                const existsInAPI = await this.checkGiftcode(code);
                                if (existsInAPI) {
                                    giftCodeQueries.updateApiPushed(true, code);
                                    continue;
                                }

                                // Convert date format from YYYY-MM-DD to DD.MM.YYYY
                                const [year, month, day] = date.split('-');
                                const formattedDate = `${day}.${month}.${year}`;

                                await this.waitForRateLimit();

                                const postResponse = await fetch(this.apiUrl, {
                                    method: 'POST',
                                    headers: headers,
                                    body: JSON.stringify({
                                        code: code,
                                        date: formattedDate
                                    })
                                });

                                if (postResponse.status === 409 || postResponse.status === 200) {
                                    giftCodeQueries.updateApiPushed(true, code);
                                }
                            } catch (error) {
                                await sendError(null, null, error, 'pushCodeToAPI', false);
                                await this.sleep(this.errorBackoffTime);
                            }
                        }
                    }

                    // Reset backoff on successful sync
                    this.currentBackoff = this.errorBackoffTime;

                    return true;

                } catch (jsonError) {
                    await sendError(null, null, jsonError, 'syncWithAPI_jsonError', false);
                    return false;
                }
            } catch (fetchError) {
                await sendError(null, null, fetchError, 'syncWithAPI_fetchError', false);
                return false;
            }
        } catch (error) {
            await sendError(null, null, error, 'syncWithAPI_unexpectedError', false);
            return false;
        }
    }

    /**
     * Add a gift code to the API
     */
    async addGiftcode(giftcode) {
        try {
            // Check if code already exists in our database
            const existing = giftCodeQueries.getGiftCode(giftcode);
            if (existing) {
                // Don't add invalid codes to API
                if (existing.status === 'invalid') {
                    return false;
                }
            }

            // Check if code already exists in API
            const existsInAPI = await this.checkGiftcode(giftcode);
            if (existsInAPI) {
                return true;
            }

            const headers = {
                'Content-Type': 'application/json',
                'X-API-Key': this.apiKey
            };

            const now = new Date();
            const dateStr = `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}`;

            await this.waitForRateLimit();

            try {
                const response = await fetch(this.apiUrl, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({
                        code: giftcode,
                        date: dateStr
                    })
                });

                const responseText = await response.text();

                if (response.status === 200) {
                    try {
                        const result = JSON.parse(responseText);
                        if (result.success === true) {
                            // Add to local database as active
                            // addGiftCode(giftCode, status, addedBy, source, apiPushed, isVip)
                            // This function is called programmatically (no user context), so use 'system'
                            // Since code is immediately pushed to API, mark api_pushed as true
                            giftCodeQueries.addGiftCode(giftcode, 'active', 'system', 'manual', true, false);

                            return true;
                        } else {
                            console.warn(`API didn't confirm success for code ${giftcode}: ${responseText.substring(0, 200)}`);
                            return false;
                        }
                    } catch (jsonError) {
                        await sendError(null, null, jsonError, 'addGiftcode_jsonError', false);
                        return false;
                    }
                } else if (response.status === 409) {
                    return true;
                } else {
                    console.warn(`Failed to add code ${giftcode} to API: ${response.status}, ${responseText.substring(0, 200)}`);

                    // Check if code was rejected as invalid
                    if (responseText.toLowerCase().includes('invalid')) {
                        console.warn(`Code ${giftcode} marked invalid by API`);
                        giftCodeQueries.updateGiftCodeStatus('invalid', giftcode);
                    }

                    const backoffTime = await this.handleApiError(response, responseText);
                    await this.sleep(backoffTime);
                    return false;
                }
            } catch (fetchError) {
                await sendError(null, null, fetchError, 'addGiftcode_fetchError', false);
                return false;
            }
        } catch (error) {
            await sendError(null, null, error, 'addGiftcode_unexpectedError', false);
            return false;
        }
    }

    /**
     * Remove a gift code from the API (only called from validation)
     */
    async removeGiftcode(giftcode, fromValidation = false) {
        try {
            if (!fromValidation) {
                console.warn(`Attempted to remove code ${giftcode} without validation flag`);
                return false;
            }

            // Check if code exists in API
            const existsInAPI = await this.checkGiftcode(giftcode);
            if (!existsInAPI) {
                giftCodeQueries.updateGiftCodeStatus('invalid', giftcode);
                return true;
            }

            const headers = {
                'Content-Type': 'application/json',
                'X-API-Key': this.apiKey
            };

            await this.waitForRateLimit();

            try {
                const response = await fetch(this.apiUrl, {
                    method: 'DELETE',
                    headers: headers,
                    body: JSON.stringify({ code: giftcode })
                });

                const responseText = await response.text();

                if (response.status === 200) {
                    try {
                        const result = JSON.parse(responseText);
                        if (result.success === true) {
                            giftCodeQueries.updateGiftCodeStatus('invalid', giftcode);
                            return true;
                        } else {
                            console.warn(`API didn't confirm removal of code ${giftcode}: ${responseText.substring(0, 200)}`);
                            return false;
                        }
                    } catch (jsonError) {
                        console.warn(`Invalid JSON response when removing code ${giftcode}: ${responseText.substring(0, 200)}`);
                        return false;
                    }
                } else {
                    console.warn(`Failed to remove code ${giftcode} from API: ${response.status}, ${responseText.substring(0, 200)}`);
                    const backoffTime = await this.handleApiError(response, responseText);
                    await this.sleep(backoffTime);
                    return false;
                }
            } catch (fetchError) {
                await sendError(null, null, fetchError, 'removeGiftcode_fetchError', false);
                return false;
            }
        } catch (error) {
            await sendError(null, null, error, 'removeGiftcode_unexpectedError', false);
            return false;
        }
    }

    /**
     * Check if a gift code exists in the API
     */
    async checkGiftcode(giftcode) {
        try {
            const headers = {
                'X-API-Key': this.apiKey
            };

            await this.waitForRateLimit();

            try {
                const response = await fetch(
                    `${this.apiUrl}?action=check&giftcode=${encodeURIComponent(giftcode)}`,
                    { method: 'GET', headers: headers }
                );

                if (response.status === 200) {
                    try {
                        const result = await response.json();
                        return result.exists || false;
                    } catch (jsonError) {
                        console.warn(`Invalid JSON response when checking code ${giftcode}`);
                        return false;
                    }
                } else {
                    console.warn(`Failed to check code ${giftcode}: ${response.status}`);
                    const backoffTime = await this.handleApiError(response, await response.text());
                    await this.sleep(backoffTime);
                    return false;
                }
            } catch (fetchError) {
                await sendError(null, null, fetchError, 'checkGiftcode_fetchError', false);
                return false;
            }
        } catch (error) {
            await sendError(null, null, error, 'checkGiftcode_unexpectedError', false);
            return false;
        }
    }

    /**
     * Helper function to create auto-redeem process for a specific code and alliance
     * @param {string} code - Gift code
     * @param {Object} alliance - Alliance object
     * @param {boolean} isVipCode - Whether the code is VIP-only
     * @returns {Promise<Object|null>} Process result or null on error
     */
    async createAutoRedeemProcessForCodeAndAlliance(code, alliance, isVipCode) {
        try {
            const players = playerQueries.getPlayersByAllianceId(alliance.id);
            if (players.length === 0) {
                return null;
            }

            // VIP codes only redeem for rich players or those meeting VIP thresholds
            const eligiblePlayers = isVipCode
                ? players.filter(p => p.is_rich === 1 || p.vip_count === 0 || p.vip_count >= 5)
                : players;

            if (eligiblePlayers.length === 0) {
                return null;
            }

            // Create redeem data for all players in the alliance
            // Test IDs will be filtered by pre-filter via usage tracking (validation creates usage records)
            const redeemData = eligiblePlayers.map(player => ({
                id: player.fid,
                giftCode: code,
                status: 'redeem'
            }));

            // Create alliance context for progress tracking
            const allianceContext = {
                id: alliance.id,
                name: alliance.name,
                channelId: alliance.channel_id,
                guildId: null // Auto-redeem doesn't have guild context
            };

            // Create redeem process with SYSTEM_AUTO_REDEEM as admin
            const result = await createRedeemProcess(redeemData, {
                adminId: 'SYSTEM_AUTO_REDEEM',
                allianceContext: allianceContext
            });

            return result;

        } catch (error) {
            await sendError(null, null, error, 'createAutoRedeemProcessForCodeAndAlliance', false);
            return null;
        }
    }
}

// Singleton instance
let apiInstance = null;

/**
 * Initialize the Gift Code API client
 * @param {Object} bot - The Discord bot client
 */
function initializeGiftCodeAPI(bot) {
    if (!apiInstance) {
        apiInstance = new GiftCodeAPI(bot);
    }
    return apiInstance;
}

/**
 * Get the Gift Code API instance
 */
function getGiftCodeAPI() {
    if (!apiInstance) {
        throw new Error('Gift Code API not initialized. Call initializeGiftCodeAPI first.');
    }
    return apiInstance;
}

module.exports = {
    GiftCodeAPI,
    initializeGiftCodeAPI,
    getGiftCodeAPI
};
