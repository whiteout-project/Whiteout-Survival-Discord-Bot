const fs = require('fs');
const path = require('path');

// Load all language files from i18n directory
const languages = {};

function flattenKeys(obj, prefix = '') {
    const keys = [];
    if (!obj || typeof obj !== 'object') return keys;
    for (const k of Object.keys(obj)) {
        const val = obj[k];
        const pathKey = prefix ? `${prefix}.${k}` : k;
        if (val && typeof val === 'object' && !Array.isArray(val)) {
            keys.push(...flattenKeys(val, pathKey));
        } else {
            keys.push(pathKey);
        }
    }
    return keys;
}

function loadLanguages() {
    const languageFiles = fs.readdirSync(__dirname).filter(file => file.endsWith('.json'));

    for (const file of languageFiles) {
        const languageCode = path.parse(file).name;
        const filePath = path.join(__dirname, file);
        
        try {
            const languageData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            languages[languageCode] = languageData;
        } catch (error) {
            console.error(`Failed to load language file ${file}: ${error.message}`);
        }
    }
}

function compareAllLanguages(mainLang = 'en') {
    if (!languages[mainLang]) {
        console.warn(`[i18n] Main language '${mainLang}' not found; skipping comparison.`);
        return;
    }

    const mainKeys = new Set(flattenKeys(languages[mainLang]));

    for (const [code, data] of Object.entries(languages)) {
        if (code === mainLang) continue;

        const langKeys = new Set(flattenKeys(data));

        const missing = [...mainKeys].filter(k => !langKeys.has(k));
        const extra = [...langKeys].filter(k => !mainKeys.has(k));

        if (missing.length === 0 && extra.length === 0) {
            continue;
        }

        console.groupCollapsed(`[i18n] ${code}: differences compared to ${mainLang} — missing: ${missing.length}, extra: ${extra.length}`);
        if (missing.length) {
            console.log(`Missing keys (${missing.length}) in ${code} compared to ${mainLang}:`);
            console.log(missing);
        }
        if (extra.length) {
            console.log(`Extra keys (${extra.length}) in ${code} not present in ${mainLang}:`);
            console.log(extra);
        }
        console.groupEnd();
    }
}

/**
 * Creates a proxy that falls back to the English value when a key is missing.
 * Works recursively for nested objects so `lang.a.b.c` resolves correctly.
 */
function createFallbackProxy(target, fallback) {
    return new Proxy(target, {
        get(obj, prop) {
            // Preserve internal/prototype access
            if (typeof prop === 'symbol' || prop === 'toJSON' || prop === 'constructor') {
                return obj[prop];
            }

            const value = obj[prop];
            const fbValue = fallback?.[prop];

            // Key missing in target — use fallback
            if (value === undefined) {
                return fbValue;
            }

            // Both are plain objects — proxy the nested level too
            if (value && typeof value === 'object' && !Array.isArray(value) &&
                fbValue && typeof fbValue === 'object' && !Array.isArray(fbValue)) {
                return createFallbackProxy(value, fbValue);
            }

            return value;
        }
    });
}

// Load languages on module initialization
loadLanguages();

// Run a comparison against the main language file to report missing/extra keys
try {
    compareAllLanguages('en');
} catch (err) {
    console.error('[i18n] Error while comparing languages:', err);
}

// Wrap non-English languages with a fallback proxy to English
const en = languages.en;
if (en) {
    for (const code of Object.keys(languages)) {
        if (code === 'en') continue;
        languages[code] = createFallbackProxy(languages[code], en);
    }
}

// Export the languages object that can be imported directly
module.exports = languages;

// Add reload function for hot reloading
module.exports.reload = function() {
    // Clear existing languages
    Object.keys(languages).forEach(key => delete languages[key]);
    // Reload from files
    loadLanguages();
    // Re-run comparison after reload
    try {
        compareAllLanguages('en');
    } catch (err) {
        console.error('[i18n] Error while comparing languages after reload:', err);
    }
    // Re-apply fallback proxies
    const enData = languages.en;
    if (enData) {
        for (const code of Object.keys(languages)) {
            if (code === 'en') continue;
            languages[code] = createFallbackProxy(languages[code], enData);
        }
    }
    console.log('i18n files reloaded');
};

// Expose comparison helper
module.exports.compareAllLanguages = compareAllLanguages;

// ============================================================
// PLUGIN LOCALE SUPPORT
// ============================================================

/**
 * Merges a plugin's locale strings into the in-memory language objects.
 * Plugin locale files should contain: { "plugins": { "pluginName": { ...keys } } }
 * Only the `plugins.<pluginName>` subtree is merged — other top-level keys are ignored for safety.
 *
 * @param {string} pluginName - Name of the plugin (used for namespacing and cleanup)
 * @param {string} localesDir - Absolute path to the plugin's `locales/` directory
 * @returns {string[]} List of locale codes that were merged (e.g., ['en', 'fr'])
 */
module.exports.mergePluginLocales = function (pluginName, localesDir) {
    const merged = [];
    const fs = require('fs');
    const path = require('path');

    if (!fs.existsSync(localesDir)) return merged;

    const files = fs.readdirSync(localesDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
        const langCode = path.parse(file).name;
        try {
            const data = JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8'));
            const pluginStrings = data?.plugins?.[pluginName];
            if (!pluginStrings || typeof pluginStrings !== 'object') continue;

            // Ensure the target language object exists (skip unknown locales)
            const target = languages[langCode];
            if (!target) continue;

            // Deep-unwrap proxies to get the raw object so we can mutate it
            const raw = target.__raw || target;

            // Ensure plugins namespace exists
            if (!raw.plugins) raw.plugins = {};
            raw.plugins[pluginName] = pluginStrings;

            merged.push(langCode);
        } catch (error) {
            console.error(`[i18n] Failed to load plugin locale ${file} for ${pluginName}:`, error.message);
        }
    }

    if (merged.length > 0) {
        console.log(`[i18n] Merged locales for plugin "${pluginName}": ${merged.join(', ')}`);
    }

    return merged;
};

/**
 * Removes a plugin's locale strings from the in-memory language objects.
 * Called when a plugin is unloaded or removed.
 *
 * @param {string} pluginName - Name of the plugin to remove locale data for
 */
module.exports.removePluginLocales = function (pluginName) {
    for (const langObj of Object.values(languages)) {
        const raw = langObj.__raw || langObj;
        if (raw.plugins?.[pluginName]) {
            delete raw.plugins[pluginName];
        }
    }
    console.log(`[i18n] Removed locales for plugin "${pluginName}"`);
};