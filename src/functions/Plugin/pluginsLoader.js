const fs = require('fs');
const path = require('path');
const semver = require('semver');
const i18n = require('../../i18n');
const { recoverPluginUpdates, hasPendingPluginUpdate, hasIncompleteOfficialInstall } = require('./pluginUpdateTransaction');

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
function validateManifest(
    manifest,
    pluginDir,
    {
        checkCompatibility = true,
        botVersion = require('../../../package.json').version,
        nodeVersion = process.versions.node
    } = {}
) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        return { valid: false, error: 'Plugin manifest must be an object' };
    }
    if (!manifest.name || typeof manifest.name !== 'string') {
        return { valid: false, error: `Plugin at ${pluginDir} missing required "name" field` };
    }
    if (!manifest.version || typeof manifest.version !== 'string') {
        return { valid: false, error: `Plugin "${manifest.name}" missing required "version" field` };
    }
    if (!semver.valid(manifest.version))
        return { valid: false, error: `Plugin "${manifest.name}" has an invalid semantic version.` };
    if (!/^[a-zA-Z0-9_-]+$/.test(manifest.name)) {
        return {
            valid: false,
            error: `Plugin name "${manifest.name}" contains invalid characters (use a-z, 0-9, _, -)`
        };
    }
    if (manifest.engines !== undefined) {
        if (!manifest.engines || typeof manifest.engines !== 'object' || Array.isArray(manifest.engines)) {
            return { valid: false, error: `Plugin "${manifest.name}" has invalid compatibility requirements.` };
        }
        for (const [engine, version] of [
            ['bot', botVersion],
            ['node', nodeVersion]
        ]) {
            const range = manifest.engines[engine];
            if (range === undefined) continue;
            if (typeof range !== 'string' || range.length > 120 || !semver.validRange(range))
                return { valid: false, error: `Invalid ${engine} requirement for "${manifest.name}".` };
            if (checkCompatibility && !semver.satisfies(version, range))
                return {
                    valid: false,
                    error: `Plugin "${manifest.name}" requires ${engine} ${range}; current version is ${version}. Update ${engine} first.`
                };
        }
    }

    const isStringArray = value => Array.isArray(value) && value.every(item => typeof item === 'string');
    const preserve = manifest.preserveOnUpdate;
    if (preserve !== undefined) {
        if (!preserve || typeof preserve !== 'object' || Array.isArray(preserve)) {
            return { valid: false, error: `Plugin "${manifest.name}" field "preserveOnUpdate" must be an object` };
        }
        if (preserve.dirs !== undefined && !isStringArray(preserve.dirs)) {
            return {
                valid: false,
                error: `Plugin "${manifest.name}" field "preserveOnUpdate.dirs" must be an array of strings`
            };
        }
        if (preserve.files !== undefined && !isStringArray(preserve.files)) {
            return {
                valid: false,
                error: `Plugin "${manifest.name}" field "preserveOnUpdate.files" must be an array of strings`
            };
        }
        if (preserve.extensions !== undefined && !isStringArray(preserve.extensions)) {
            return {
                valid: false,
                error: `Plugin "${manifest.name}" field "preserveOnUpdate.extensions" must be an array of strings`
            };
        }
    }

    return { valid: true };
}

function normalizeRelativePath(input) {
    if (typeof input !== 'string') return '';
    return input
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean)
        .join('/');
}

function getPluginPreserveConfig(manifest = {}) {
    const preserve = manifest.preserveOnUpdate || {};

    return {
        dirs: new Set((preserve.dirs || []).map(normalizeRelativePath).filter(Boolean)),
        files: new Set((preserve.files || []).map(normalizeRelativePath).filter(Boolean)),
        extensions: new Set((preserve.extensions || []).map(ext => ext.toLowerCase()).filter(Boolean))
    };
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
        thirdParty: fs.existsSync(path.join(pluginDir, '.wosland-upload.json')),
        dir: pluginDir,
        cacheRoot: fs.realpathSync(pluginDir),
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
function registerPluginModules(pluginDir, manifest, registrar, compatibility = {}) {
    const validation = validateManifest(manifest, pluginDir, compatibility);
    if (!validation.valid) throw new Error(validation.error);
    const pluginData = buildPluginData(pluginDir, manifest);
    if (loadedPlugins.has(manifest.name)) throw new Error(`Plugin "${manifest.name}" is already loaded`);
    // Publish rollback metadata before the first module can register anything.
    loadedPlugins.set(manifest.name, pluginData);
    try {
        const readiness = [];
        for (const [kind, files] of [
            ['Command', pluginData.commands],
            ['Event', pluginData.events],
            ['Handler', pluginData.handlers]
        ]) {
            for (const file of files) {
                const registration = registrar[`register${kind}`](file);
                if (registration?.ready) {
                    const ready = Promise.resolve(registration.ready);
                    ready.catch(() => {});
                    readiness.push(ready);
                }
            }
        }
        pluginData.ready = Promise.all(readiness);
        pluginData.ready.catch(() => {});
        const localesDir = path.join(pluginDir, 'locales');
        if (fs.existsSync(localesDir)) i18n.mergePluginLocales(manifest.name, localesDir);
        return pluginData;
    } catch (error) {
        unloadPlugin(manifest.name, registrar);
        throw error;
    }
}

function unloadPlugin(pluginName, registrar) {
    const plugin = loadedPlugins.get(pluginName);
    if (!plugin) return false;
    for (const [kind, files] of [['Command', plugin.commands], ['Event', plugin.events], ['Handler', plugin.handlers]]) {
        for (const file of files) {
            try { registrar[`unregister${kind}`]?.(file); } catch (error) {
                console.warn(`[PLUGINS] Could not unregister ${kind} for ${pluginName}: ${error?.name || 'Error'}`);
            }
        }
    }
    try { i18n.removePluginLocales(pluginName); } catch (error) {
        console.warn(`[PLUGINS] Could not remove locales for ${pluginName}: ${error?.name || 'Error'}`);
    }
    const root = plugin.cacheRoot || path.resolve(plugin.dir);
    for (const [file, cached] of Object.entries(require.cache)) {
        const relative = path.relative(root, file);
        if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
            try {
                if (typeof cached.exports?.close === 'function') Promise.resolve(cached.exports.close()).catch(() => {});
            } catch { /* best effort */ }
            finally { delete require.cache[file]; }
        }
    }
    loadedPlugins.delete(pluginName);
    return true;
}

function isIncompleteInstall(pluginDir) {
    try {
        if (fs.lstatSync(path.join(pluginDir, '.wosland-install-pending.json'), { throwIfNoEntry: false })) return true;
        const marker = path.join(pluginDir, '.wosland-upload.json');
        const stat = fs.lstatSync(marker, { throwIfNoEntry: false });
        if (!stat) return false;
        if (!stat.isFile() || stat.isSymbolicLink()) return true;
        return JSON.parse(fs.readFileSync(marker, 'utf8')).status !== 'installed';
    } catch { return true; }
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

    recoverPluginUpdates(PLUGINS_DIR);
    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === '.updates') continue;

        const pluginDir = path.join(PLUGINS_DIR, entry.name);
        const manifestPath = path.join(pluginDir, 'plugin.json');

        if (hasPendingPluginUpdate(PLUGINS_DIR, entry.name)) {
            results.failed.push({ name: entry.name, error: 'An interrupted plugin update could not be recovered. Its backup is preserved.' });
            continue;
        }

        if (isIncompleteInstall(pluginDir)) {
            const uploaded = !hasIncompleteOfficialInstall(PLUGINS_DIR, entry.name);
            results.failed.push({ name: entry.name, error: uploaded
                ? 'Incomplete third-party installation is disabled; review its files before trying again.'
                : 'Incomplete official installation is disabled. Use Plugins → Install → Repair if automatic recovery cannot finish.' });
            continue;
        }

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

            const registered = registerPluginModules(pluginDir, manifest, registrar);
            registered.ready.catch(() => {
                if (loadedPlugins.get(manifest.name) === registered) unloadPlugin(manifest.name, registrar);
                console.error(`[PLUGINS] Startup failed for ${manifest.name}.`);
            });
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
function getInstalledPluginManifests() {
    const installed = new Map();

    for (const plugin of loadedPlugins.values()) {
        installed.set(plugin.name, {
            name: plugin.name,
            version: plugin.version,
            description: plugin.description,
            author: plugin.author,
            thirdParty: plugin.thirdParty
        });
    }

    if (!fs.existsSync(PLUGINS_DIR)) {
        return Array.from(installed.values());
    }

    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const pluginDir = path.join(PLUGINS_DIR, entry.name);
        const manifestPath = path.join(pluginDir, 'plugin.json');
        if (!fs.existsSync(manifestPath)) continue;

        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const validation = validateManifest(manifest, pluginDir, { checkCompatibility: false });
            if (!validation.valid) continue;

            installed.set(manifest.name, {
                name: manifest.name,
                version: manifest.version,
                description: manifest.description || '',
                author: manifest.author || 'Unknown',
                thirdParty: fs.existsSync(path.join(pluginDir, '.wosland-upload.json'))
            });
        } catch (error) {
            console.warn(`[PLUGINS] Failed to read installed manifest for ${entry.name}: ${error.message}`);
        }
    }

    return Array.from(installed.values());
}

function getInstalledPlugins() {
    return getInstalledPluginManifests();
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
        if (!entry.isDirectory() || entry.name === '.updates' || hasPendingPluginUpdate(PLUGINS_DIR, entry.name)) continue;

        const pluginDir = path.join(PLUGINS_DIR, entry.name);
        if (isIncompleteInstall(pluginDir)) continue;
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
    getPluginPreserveConfig,
    getInstalledPluginManifests,
    registerPluginModules,
    unloadPlugin,
    loadPlugins,
    rebuildPluginMap,
    getInstalledPlugins,
    getPluginCount
};
