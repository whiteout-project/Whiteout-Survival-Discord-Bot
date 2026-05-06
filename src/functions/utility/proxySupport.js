const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

const agentCache = new Map();
let cachedProxyUrl;
let proxyWasLogged = false;

function readCliProxyUrl(argv = process.argv.slice(2)) {
    const proxyFlagIndex = argv.indexOf('--proxy');
    if (proxyFlagIndex === -1) return null;

    const nextArg = argv[proxyFlagIndex + 1];
    const rawProxyUrl = (nextArg && !nextArg.startsWith('--')) ? nextArg : 'http://localhost:18080';

    try {
        const parsed = new URL(rawProxyUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error('Proxy URL must use http or https');
        }
        return rawProxyUrl;
    } catch (error) {
        console.error(`[proxy] Invalid proxy URL "${rawProxyUrl}": ${error.message}`);
        return null;
    }
}

function getConfiguredProxyUrl() {
    if (cachedProxyUrl !== undefined) return cachedProxyUrl;
    cachedProxyUrl = readCliProxyUrl();
    return cachedProxyUrl;
}

function isCenturyGameUrl(input) {
    try {
        const targetUrl = input instanceof URL ? input : new URL(input);
        return targetUrl.hostname.toLowerCase().endsWith('.centurygame.com');
    } catch {
        return false;
    }
}

function getGameProxyAgent(url) {
    if (!isCenturyGameUrl(url)) return null;

    const proxyUrl = getConfiguredProxyUrl();
    if (!proxyUrl) return null;

    const targetUrl = url instanceof URL ? url : new URL(url);
    const isSecureTarget = targetUrl.protocol === 'https:';
    const cacheKey = `${isSecureTarget ? 'https' : 'http'}:${proxyUrl}`;

    if (!agentCache.has(cacheKey)) {
        agentCache.set(
            cacheKey,
            isSecureTarget ? new HttpsProxyAgent(proxyUrl) : new HttpProxyAgent(proxyUrl)
        );
    }

    if (!proxyWasLogged) {
        console.log(`[proxy] Century Games API traffic routed through: ${proxyUrl}`);
        proxyWasLogged = true;
    }

    return agentCache.get(cacheKey);
}

module.exports = {
    getGameProxyAgent,
    isCenturyGameUrl
};
