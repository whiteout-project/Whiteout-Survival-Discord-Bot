const fs = require('fs');
const path = require('path');
const i18n = require('../../i18n');

// ============================================================
// PLUGIN SYSTEM — Core loader, validation, and shared state
// ============================================================

/** Root plugins directory (at project root, NOT inside src/) */
const PLUGINS_DIR = path.join(__dirname, '..', '..', '..', 'plugins');

/** In-memory map of loaded plugins: pluginName -> pluginData */
const loadedPlugins = new Map();

// ============================================================
// PLUGIN MANIFEST VALIDATION
// ============================================================

/**
 * Validates a plugin.json manifest
 * @param {Object} manifest - Parsed plugin.json
 * @param {string} pluginDir - Directory path for context in error messages
 * @returns {{ valid: boolean, error?: string }}
 */
function validateManifest(manifest, pluginDir) {
    if (!manifest.name || typeof manifest.name !== 'string') {
        return { valid: false, error: `Plugin at ${pluginDir} missing required "name" field` };
    }
    if (!manifest.version || typeof manifest.version !== 'string') {
        return { valid: false, error: `Plugin "${manifest.name}" missing required "version" field` };
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(manifest.name)) {
        return { valid: false, error: `Plugin name "${manifest.name}" contains invalid characters (use a-z, 0-9, _, -)` };
    }
    return { valid: true };
}

// ============================================================
// PLUGIN DATA BUILDER (shared by registerPluginModules and rebuildPluginMap)
// ============================================================

/**
 * Scans a plugin directory and builds its metadata object
 * @param {string} pluginDir - Absolute path to the plugin directory
 * @param {Object} manifest - Parsed plugin.json manifest
 * @returns {Object} Plugin data with file paths for commands, events, handlers
 */
function buildPluginData(pluginDir, manifest) {
    const scanModuleDir = (subdir) => {
        const dirPath = path.join(pluginDir, subdir);
        if (!fs.existsSync(dirPath)) return [];
        return fs.readdirSync(dirPath)
            .filter(f => f.endsWith('.js'))
            .map(f => path.join(dirPath, f));
    };

    return {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description || '',
        author: manifest.author || 'Unknown',
        dir: pluginDir,
        commands: scanModuleDir('commands'),
        events: scanModuleDir('events'),
        handlers: scanModuleDir('handlers')
    };
}

// ============================================================
// PLUGIN REGISTRATION (shared by loadPlugins and installPlugin)
// ============================================================

/**
 * Registers a plugin's commands, events, handlers, and locales.
 * Shared by both startup loading and runtime installation.
 * @param {string} pluginDir - Absolute path to the plugin directory
 * @param {Object} manifest - Parsed plugin.json manifest
 * @param {Object} registrar - Object with registerCommand, registerEvent, registerHandler
 * @returns {Object} The pluginData entry that was added to loadedPlugins
 */
function registerPluginModules(pluginDir, manifest, registrar) {
    const pluginData = buildPluginData(pluginDir, manifest);

    for (const filePath of pluginData.commands) {
        registrar.registerCommand(filePath);
    }
    for (const filePath of pluginData.events) {
        registrar.registerEvent(filePath);
    }
    for (const filePath of pluginData.handlers) {
        registrar.registerHandler(filePath);
    }

    const localesDir = path.join(pluginDir, 'locales');
    if (fs.existsSync(localesDir)) {
        i18n.mergePluginLocales(manifest.name, localesDir);
    }

    loadedPlugins.set(manifest.name, pluginData);
    return pluginData;
}

// ============================================================
// PLUGIN LOADING (startup)
// ============================================================

/**
 * Loads all plugins from the plugins directory.
 * Called once during bot startup after core modules are loaded.
 * @param {Object} registrar - Object with { registerCommand, registerEvent, registerHandler } functions
 * @returns {{ loaded: string[], failed: { name: string, error: string }[] }}
 */
function loadPlugins(registrar) {
    const results = { loaded: [], failed: [] };

    if (!fs.existsSync(PLUGINS_DIR)) {
        fs.mkdirSync(PLUGINS_DIR, { recursive: true });
        return results;
    }

    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const pluginDir = path.join(PLUGINS_DIR, entry.name);
        const manifestPath = path.join(pluginDir, 'plugin.json');

        if (!fs.existsSync(manifestPath)) {
            results.failed.push({ name: entry.name, error: 'Missing plugin.json' });
            continue;
        }

        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const validation = validateManifest(manifest, pluginDir);
            if (!validation.valid) {
                results.failed.push({ name: entry.name, error: validation.error });
                continue;
            }

            if (loadedPlugins.has(manifest.name)) {
                results.failed.push({ name: manifest.name, error: 'Duplicate plugin name' });
                continue;
            }

            registerPluginModules(pluginDir, manifest, registrar);
            results.loaded.push(manifest.name);
            console.log(`[PLUGINS] Loaded: ${manifest.name} v${manifest.version}`);

        } catch (error) {
            results.failed.push({ name: entry.name, error: error.message });
            console.error(`[PLUGINS] Failed to load ${entry.name}:`, error.message);
        }
    }

    if (results.loaded.length > 0) {
        console.log(`[PLUGINS] ${results.loaded.length} plugin(s) loaded successfully.`);
    }
    if (results.failed.length > 0) {
        console.warn(`[PLUGINS] ${results.failed.length} plugin(s) failed to load.`);
    }

    return results;
}

// ============================================================
// GETTERS
// ============================================================

/**
 * Gets list of installed plugins with their metadata
 * @returns {Array<{ name: string, version: string, description: string, author: string }>}
 */
function getInstalledPlugins() {
    return Array.from(loadedPlugins.values()).map(p => ({
        name: p.name,
        version: p.version,
        description: p.description,
        author: p.author
    }));
}

/**
 * Gets count of loaded plugins
 * @returns {number}
 */
function getPluginCount() {
    return loadedPlugins.size;
}

/**
 * Rebuilds the loadedPlugins Map from disk without re-registering modules.
 * Used after hot-reload clears the require cache (modules are already
 * re-registered by the core reload loop, only the Map needs repopulating).
 */
function rebuildPluginMap() {
    loadedPlugins.clear();

    if (!fs.existsSync(PLUGINS_DIR)) return;

    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const pluginDir = path.join(PLUGINS_DIR, entry.name);
        const manifestPath = path.join(pluginDir, 'plugin.json');
        if (!fs.existsSync(manifestPath)) continue;

        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const validation = validateManifest(manifest, pluginDir);
            if (!validation.valid) continue;

            const pluginData = buildPluginData(pluginDir, manifest);
            loadedPlugins.set(manifest.name, pluginData);
        } catch (error) {
            console.warn(`[PLUGINS] Failed to rebuild entry for ${entry.name}:`, error.message);
        }
    }
}

module.exports = {
    PLUGINS_DIR,
    loadedPlugins,
    validateManifest,
    registerPluginModules,
    loadPlugins,
    rebuildPluginMap,
    getInstalledPlugins,
    getPluginCount
};
