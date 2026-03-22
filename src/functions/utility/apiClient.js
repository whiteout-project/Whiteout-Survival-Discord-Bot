/**
 * Shared API client for Whiteout Survival game API
 * Centralizes sign building, HTTP requests, and player data fetching
 * Used by: fetchPlayerData.js, refreshAlliance.js, redeemFunction.js
 */

const crypto = require('crypto');
const fetch = require('node-fetch');

const isDevMode = process.env.WOSLAND_DEV_MODE === '1';
const http = require('http');
const https = require('https');
const { API_CONFIG } = require('./apiConfig');
const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

// Persistent agents for gift code API — reuses TCP+TLS connections across requests
const giftCodeHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 5, keepAliveMsecs: 30000 });
const giftCodeHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 5, keepAliveMsecs: 30000 });

// Browser profiles for header randomization
const BROWSER_PROFILES = [
    {
        browser: 'Chrome',
        versions: [124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135],
        platforms: [
            { os: 'Windows NT 10.0; Win64; x64', secPlatform: '"Windows"' },
            { os: 'Windows NT 11.0; Win64; x64', secPlatform: '"Windows"' },
            { os: 'Macintosh; Intel Mac OS X 10_15_7', secPlatform: '"macOS"' },
            { os: 'X11; Linux x86_64', secPlatform: '"Linux"' }
        ],
        buildSecUa: (ver) => `"Not:A-Brand";v="99", "Google Chrome";v="${ver}", "Chromium";v="${ver}"`
    },
    {
        browser: 'Brave',
        versions: [132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145],
        platforms: [
            { os: 'Windows NT 10.0; Win64; x64', secPlatform: '"Windows"' },
            { os: 'Windows NT 11.0; Win64; x64', secPlatform: '"Windows"' },
            { os: 'Macintosh; Intel Mac OS X 10_15_7', secPlatform: '"macOS"' }
        ],
        buildSecUa: (ver) => `"Not:A-Brand";v="99", "Brave";v="${ver}", "Chromium";v="${ver}"`
    },
    {
        browser: 'Edge',
        versions: [124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135],
        platforms: [
            { os: 'Windows NT 10.0; Win64; x64', secPlatform: '"Windows"' },
            { os: 'Windows NT 11.0; Win64; x64', secPlatform: '"Windows"' },
            { os: 'Macintosh; Intel Mac OS X 10_15_7', secPlatform: '"macOS"' }
        ],
        buildSecUa: (ver) => `"Not A(B)rand";v="8", "Chromium";v="${ver}", "Microsoft Edge";v="${ver}"`
    }
];

/**
 * Generates randomized browser-like headers to avoid server-side bot detection.
 * Rotates browser type, version, OS, and related sec-* headers on every call.
 * @param {string} [origin] - Origin URL override. Defaults to API_CONFIG.ORIGIN.
 * @returns {Object} Headers object
 */
function generateBrowserHeaders(origin = API_CONFIG.ORIGIN) {
    const profile = BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)];
    const version = profile.versions[Math.floor(Math.random() * profile.versions.length)];
    const platform = profile.platforms[Math.floor(Math.random() * profile.platforms.length)];

    return {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.7',
        'Origin': origin,
        'Referer': `${origin}/`,
        'User-Agent': `Mozilla/5.0 (${platform.os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`,
        'sec-ch-ua': profile.buildSecUa(version),
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': platform.secPlatform,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        'sec-gpc': '1',
    };
}

/**
 * Builds MD5 signed form data for simple player API calls
 * Uses fixed key order: fid, time (milliseconds)
 * @param {string} playerId - Player FID
 * @returns {string} Signed form data string
 */
function buildPlayerPayload(playerId) {
    const currentTime = Date.now();
    const form = `fid=${playerId}&time=${currentTime}`;
    const sign = crypto.createHash('md5').update(form + API_CONFIG.SECRET).digest('hex');
    return `sign=${sign}&${form}`;
}

/**
 * Builds MD5 signed form data with alphabetically sorted keys
 * Used for gift code API calls (captcha, redeem, auth)
 * @param {Object} data - Key-value pairs to encode
 * @returns {string} Signed form data string
 */
function encodeData(data) {
    const sortedKeys = Object.keys(data).sort();
    const encodedData = sortedKeys
        .map(key => `${key}=${typeof data[key] === 'object' ? JSON.stringify(data[key]) : data[key]}`)
        .join('&');

    const sign = crypto.createHash('md5')
        .update(encodedData + API_CONFIG.SECRET)
        .digest('hex');

    return `sign=${sign}&${encodedData}`;
}

/**
 * Makes a POST request using node-fetch (for player API)
 * @param {string} url - API endpoint URL
 * @param {string} body - Signed form data string
 * @param {string} [origin] - Origin URL for headers. Defaults to API_CONFIG.ORIGIN.
 * @returns {Promise<{status: number, data: Object}>} Response
 */
async function fetchPost(url, body, origin = API_CONFIG.ORIGIN) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            ...generateBrowserHeaders(origin)
        },
        body,
        // disable keep-alive and add a timeout so we don't hang on stale sockets
        agent: url.startsWith('https') ? httpsAgent : httpAgent,
        timeout: 15000
    });

    if (response.status === 429) {
        throw new Error('RATE_LIMIT');
    }

    if (response.status !== 200) {
        throw new Error(`API returned status ${response.status}`);
    }

    const data = await response.json();
    return { status: response.status, data };
}

/**
 * Makes a POST request using native http/https (for gift code API)
 * Includes Origin header required by the gift code endpoint
 * @param {string} url - API endpoint URL
 * @param {Object} payload - Data to encode and send
 * @param {string} label - Label for error logging
 * @param {string} [cookies] - Optional cookie string to send with the request
 * @returns {Promise<{ok: boolean, status: number, data: Object, raw: string, cookies: string[]}>} Response
 */
async function nativePost(url, payload, label, cookies) {
    return new Promise((resolve, reject) => {
        const postData = encodeData(payload);

        const urlObject = new URL(url);
        const browserHeaders = generateBrowserHeaders();
        const isHttps = urlObject.protocol === 'https:';
        const agent = isHttps ? giftCodeHttpsAgent : giftCodeHttpAgent;
        const headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
            ...browserHeaders
        };

        // Send cookies from previous responses (session reuse)
        if (cookies) {
            headers['Cookie'] = cookies;
        }

        const options = {
            hostname: urlObject.hostname,
            port: urlObject.port || (isHttps ? 443 : 80),
            path: urlObject.pathname,
            method: 'POST',
            agent,
            headers
        };

        const client = urlObject.protocol === 'https:' ? https : http;
        const req = client.request(options, (res) => {
            let raw = '';

            // Capture Set-Cookie headers for session reuse
            const setCookies = res.headers['set-cookie'] || [];

            // Capture rate limit headers for adaptive throttling
            const rateLimit = {
                limit: res.headers['x-ratelimit-limit'] ? parseInt(res.headers['x-ratelimit-limit'], 10) : undefined,
                remaining: res.headers['x-ratelimit-remaining'] ? parseInt(res.headers['x-ratelimit-remaining'], 10) : undefined
            };

            res.on('data', (chunk) => {
                raw += chunk;
            });

            res.on('end', () => {
                let data;
                try {
                    data = JSON.parse(raw);
                } catch (error) {
                    data = raw;
                }

                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    data,
                    raw,
                    cookies: setCookies,
                    rateLimit
                });
            });
        });

        // Destroy the socket and reject if the server hangs for more than 15 seconds
        req.setTimeout(15000, () => {
            req.destroy();
            const msg = `${label} request timed out after 15 seconds`;
            console.warn(`[timeout] ${msg} — ${url}`);
            reject(new Error(msg));
        });

        req.on('error', (error) => {
            if (isDevMode) console.error(`${label} request failed:`, error.message);
            reject(error);
        });

        req.write(postData);
        req.end();
    });
}

/**
 * Manages dual-API routing and rate limiting for player data fetching.
 * Mirrors the Python LoginHandler dual-API approach: when both APIs are
 * reachable, alternates between them (1 player/second). Falls back to
 * single-API mode (1 player/2 seconds) when only one API is available.
 */
class PlayerApiManager {
    constructor() {
        /** @type {{url: string, origin: string}[]} index 0 = API 1, index 1 = API 2 */
        this.apis = [
            { url: API_CONFIG.PLAYER_URL,   origin: API_CONFIG.ORIGIN },
            { url: API_CONFIG.PLAYER_URL_2, origin: API_CONFIG.ORIGIN_2 }
        ];

        // Per-API request timestamp windows (rolling 60-second window)
        this.requestTimestamps = [[], []]; // index 0 = API 1, index 1 = API 2
        this.rateLimitPerApi   = 30;
        this.rateLimitWindow   = 60000; // ms

        this.lastApiUsed  = 0; // index into this.apis
        this.dualApiMode  = false;
        this.availableApis = [0]; // indices of available apis (starts with API 1 only)
        this.requestDelay  = 2000; // ms; updated by checkAvailability()
    }

    /**
     * Probes both player API endpoints to determine availability.
     * Updates dualApiMode and requestDelay accordingly.
     * Should be called once at bot startup.
     * @param {string} [testFid='46765089'] - Player FID used for availability probe
     * @returns {Promise<void>}
     */
    async checkAvailability(testFid = '46765089') {
        const results = await Promise.allSettled(
            this.apis.map(async (api) => {
                const body = buildPlayerPayload(testFid);
                const response = await fetch(api.url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        ...generateBrowserHeaders(api.origin)
                    },
                    body,
                    agent: api.url.startsWith('https') ? httpsAgent : httpAgent,
                    timeout: 5000
                });
                // 200 (success) or 429 (rate limited) both mean the API is reachable
                return response.status === 200 || response.status === 429;
            })
        );

        const available = results.map((r) => r.status === 'fulfilled' && r.value === true);
        this.availableApis = available.map((ok, i) => ok ? i : -1).filter(i => i !== -1);

        if (this.availableApis.length >= 2) {
            this.dualApiMode  = true;
            this.requestDelay = 1000; // 1s — alternating across two APIs
            console.log('[PlayerApiManager] Dual-API mode active (1 player/second)');
        } else if (this.availableApis.length === 1) {
            this.dualApiMode  = false;
            this.requestDelay = 2000; // 2s — 30 req/min on single API
            const unavailableIndex = this.availableApis[0] === 0 ? 1 : 0;
            console.log(`[PlayerApiManager] Single-API mode — API ${unavailableIndex + 1} unavailable (1 player/2 seconds)`);
        } else {
            // No APIs reachable; fall back to API 1 with conservative delay
            this.availableApis = [0];
            this.dualApiMode   = false;
            this.requestDelay  = 2000;
            console.warn('[PlayerApiManager] No player APIs reachable — defaulting to API 1');
        }
    }

    /**
     * Returns the next API endpoint info, respecting rate limits and alternation.
     * Records the request timestamp automatically.
     * @returns {{url: string, origin: string}}
     */
    getNextApi() {
        const now = Date.now();

        // Clean stale timestamps outside the rolling window
        for (let i = 0; i < 2; i++) {
            this.requestTimestamps[i] = this.requestTimestamps[i].filter(t => now - t < this.rateLimitWindow);
        }

        let selectedIndex;

        if (this.dualApiMode) {
            // Prefer the API that wasn't used last; fall back if at rate limit
            const candidates = this.availableApis.filter(
                i => this.requestTimestamps[i].length < this.rateLimitPerApi
            );
            if (candidates.length >= 2) {
                // Both have capacity — alternate
                selectedIndex = candidates.find(i => i !== this.lastApiUsed) ?? candidates[0];
            } else if (candidates.length === 1) {
                selectedIndex = candidates[0];
            } else {
                // Both at limit — fall back to API 1 (caller's rate limit handling kicks in)
                selectedIndex = 0;
            }
        } else {
            // Single-API mode: always use the first available
            const available = this.availableApis.find(
                i => this.requestTimestamps[i].length < this.rateLimitPerApi
            );
            selectedIndex = available ?? this.availableApis[0] ?? 0;
        }

        this.requestTimestamps[selectedIndex].push(now);
        this.lastApiUsed = selectedIndex;
        return this.apis[selectedIndex];
    }

    /**
     * Returns the current inter-request delay in milliseconds.
     * 1000ms in dual-API mode, 2000ms in single-API mode.
     * @returns {number}
     */
    getRequestDelay() {
        return this.requestDelay;
    }

    /**
     * Returns a human-readable description of the current API mode.
     * @returns {string}
     */
    getModeDescription() {
        if (this.dualApiMode) {
            return 'Dual-API mode active (1 player/second)';
        }
        const unavailable = this.availableApis[0] === 0 ? 2 : 1;
        return `Single-API mode (1 player/2 seconds) — API ${unavailable} unavailable`;
    }
}

/** Singleton instance shared across the entire bot process. */
const playerApiManager = new PlayerApiManager();

/**
 * Fetches player data from the game API with retry logic
 * @param {string} playerId - Player FID
 * @param {Object} [options] - Options
 * @param {Function} [options.onError] - Error callback: (error, context) => void
 * @param {Function} [options.delay] - Delay function: (ms) => Promise<void>
 * @param {boolean} [options.returnErrorObject] - If true, returns { error, playerNotExist } instead of null on failure
 * @returns {Promise<Object|null>} Player data, error object, or null
 */
async function fetchPlayerData(playerId, options = {}) {
    const { onError, delay, returnErrorObject = false } = options;
    const delayFn = delay || ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
    let retries = 0;

    while (retries < API_CONFIG.MAX_RETRIES) {
        try {
            const body = buildPlayerPayload(playerId);
            const { url: apiUrl, origin: apiOrigin } = playerApiManager.getNextApi();
            const { data } = await fetchPost(apiUrl, body, apiOrigin);

            // Check for player not exist
            if (data.err_code === 40001 || data.msg === 'ROLE NOT EXIST' || data.msg === 'ROLE NOT EXIST.') {
                if (returnErrorObject) {
                    return { error: 'ROLE NOT EXIST', playerNotExist: true };
                }
                // For fetchPlayerData.js style: report and return null
                const errorMsg = data.msg || 'ROLE NOT EXIST';
                if (onError) {
                    await onError(new Error(`Invalid player ID ${playerId}: ${errorMsg}`), 'fetchPlayerFromAPI');
                }
                return null;
            }

            // Check for non-retryable errors
            const errorMsg = (data.msg || '').toLowerCase();
            if (errorMsg.includes('not exist') || errorMsg.includes('invalid')) {
                if (returnErrorObject) {
                    return { error: data.msg || 'Unknown error', playerNotExist: true };
                }
                if (onError) {
                    await onError(new Error(`Invalid player ID ${playerId}: ${data.msg}`), 'fetchPlayerFromAPI');
                }
                return null;
            }

            // Success
            if (data.code === 0 && data.data) {
                return data.data;
            }

            throw new Error(`API returned error: ${data.msg || 'Unknown error'}`);

        } catch (error) {
            if (error.message === 'RATE_LIMIT') {
                throw error; // Caller handles rate limits
            }

            retries++;

            if (onError) {
                await onError(error, 'fetchPlayerFromAPI');
            }

            if (retries < API_CONFIG.MAX_RETRIES) {
                await delayFn(API_CONFIG.RETRY_DELAY);
            }
        }
    }

    // All retries exhausted
    if (returnErrorObject) {
        return { error: 'MAX_RETRIES_EXCEEDED', playerNotExist: false };
    }
    return null;
}

module.exports = {
    buildPlayerPayload,
    encodeData,
    fetchPost,
    nativePost,
    fetchPlayerData,
    playerApiManager
};
