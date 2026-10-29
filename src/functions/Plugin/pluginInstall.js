const fs = require('fs');
const path = require('path');
const https = require('https');
const AdmZip = require('adm-zip');
const {
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SectionBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    escapeMarkdown
} = require('discord.js');
const { getUserInfo, handleError, assertUserMatches } = require('../utility/commonFunctions');
const { createPluginsComponents } = require('./plugins');
const { getComponentEmoji, getEmojiMapForUser } = require('../utility/emojis');
const { createUniversalPaginationButtons } = require('../Pagination/universalPagination');
const { isGitMetadataPath } = require('./pluginGitMetadata');
const { isProtectedPluginPath, beginPluginUpdate, hasPendingPluginUpdate, claimPluginRecoveryAttempt, hasIncompleteOfficialInstall } = require('./pluginUpdateTransaction');
const { dependencyFingerprint } = require('./pluginDependencies');
const semver = require('semver');
const {
    PLUGINS_DIR, loadedPlugins, validateManifest, registerPluginModules, getPluginPreserveConfig, getInstalledPluginManifests
} = require('./pluginsLoader');
const {
    acquireUpdateLock,
    releaseUpdateLock,
    formatActiveUpdateMessage
} = require('../Settings/updateCoordinator');
const i18n = require('../../i18n');

// ============================================================
// INSTALL-SPECIFIC CONSTANTS & UTILITIES
// ============================================================

const PLUGIN_REPO = 'whiteout-project/wosJS-plugins';
const PLUGIN_REGISTRY_PROXY_URL = process.env.PLUGIN_REGISTRY_PROXY_URL || 'https://wosland.com/api/plugins/registry';
const PLUGIN_UPDATE_PROXY_URL = process.env.PLUGIN_UPDATE_CHECK_PROXY_URL || 'https://wosland.com/api/updates/plugins';

const MAX_REDIRECTS = 5;

/**
 * Fetches JSON from a URL via HTTPS GET
 * @param {string} url - URL to fetch
 * @param {number} [remainingRedirects] - Redirect depth limit
 * @returns {Promise<Object|null>} Parsed JSON or null on error
 */
function httpsGetJSON(url, remainingRedirects = MAX_REDIRECTS, headers = {}) {
    return new Promise((resolve) => {
        let target;
        try {
            target = new URL(url);
            if (target.protocol !== 'https:' || target.username || target.password) return resolve(null);
        } catch { return resolve(null); }
        const req = https.get(target, {
            headers: {
                'User-Agent': 'WhiteoutSurvivalBot',
                ...headers
            }
        }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && remainingRedirects > 0) {
                res.resume();
                let next;
                try { next = new URL(res.headers.location, target).href; }
                catch { return resolve(null); }
                return httpsGetJSON(next, remainingRedirects - 1, headers).then(resolve, () => resolve(null));
            }
            if (res.statusCode !== 200) { res.resume(); return resolve(null); }

            let body = '';
            let bytes = 0;
            res.on('error', () => resolve(null));
            res.on('aborted', () => resolve(null));
            res.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > 2 * 1024 * 1024) { req.destroy(); resolve(null); }
                else body += chunk;
            });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(10000, () => { req.destroy(); resolve(null); });
        const deadline = setTimeout(() => { req.destroy(); resolve(null); }, 10000);
        req.on('close', () => clearTimeout(deadline));
    });
}

function requestPluginUpdatesViaProxy(installedPlugins) {
    return new Promise((resolve) => {
        try {
            const body = JSON.stringify({ plugins: installedPlugins });
            const parsedUrl = new URL(PLUGIN_UPDATE_PROXY_URL);
            const httpModule = parsedUrl.protocol === 'http:' ? require('http') : require('https');

            const req = httpModule.request(parsedUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'User-Agent': 'WhiteoutSurvivalBot'
                }
            }, (res) => {
                let responseBody = '';
                res.on('data', chunk => responseBody += chunk);
                res.on('end', () => {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        resolve(null);
                        return;
                    }

                    try {
                        const parsed = JSON.parse(responseBody);
                        if (Array.isArray(parsed?.updates)) {
                            resolve(parsed);
                            return;
                        }
                    } catch {
                        // Ignore parse errors and fall back to local error path.
                    }

                    resolve(null);
                });
            });

            req.on('error', () => resolve(null));
            req.setTimeout(10000, () => { req.destroy(); resolve(null); });
            req.write(body);
            req.end();
        } catch {
            resolve(null);
        }
    });
}

/**
 * Downloads a file from URL to disk
 * @param {string} url - URL to download
 * @param {string} destPath - Destination file path
 * @param {number} [remainingRedirects] - Redirect depth limit
 * @returns {Promise<boolean>} True if successful
 */
function downloadFile(url, destPath, remainingRedirects = MAX_REDIRECTS) {
    return new Promise((resolve) => {
        let target;
        try {
            target = new URL(url);
            if (target.protocol !== 'https:' || target.username || target.password) return resolve(false);
        } catch { return resolve(false); }
        const file = fs.createWriteStream(destPath);
        file.on('error', () => resolve(false));
        const cleanupFile = (callback) => {
            file.close(() => {
                if (fs.existsSync(destPath)) {
                    try { fs.unlinkSync(destPath); } catch { /* best-effort cleanup */ }
                }
                callback();
            });
        };

        const request = https.get(target, { headers: { 'User-Agent': 'WhiteoutSurvivalBot' } }, (res) => {
            if ((res.statusCode === 301 || res.statusCode === 302) && remainingRedirects > 0) {
                res.resume();
                cleanupFile(() => {
                    let next;
                    try { next = new URL(res.headers.location, target).href; }
                    catch { return resolve(false); }
                    downloadFile(next, destPath, remainingRedirects - 1).then(resolve, () => resolve(false));
                });
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                cleanupFile(() => resolve(false));
                return;
            }
            let bytes = 0;
            res.on('data', chunk => { bytes += chunk.length; if (bytes > 64 * 1024 * 1024) request.destroy(new Error('Plugin archive exceeds download limit.')); });
            res.on('error', () => cleanupFile(() => resolve(false)));
            res.pipe(file);
            file.on('finish', () => { file.close(() => resolve(true)); });
        }).on('error', () => {
            cleanupFile(() => resolve(false));
        });
        request.setTimeout(30000, () => request.destroy(new Error('Plugin download timed out.')));
        const deadline = setTimeout(() => request.destroy(new Error('Plugin download timed out.')), 30000);
        request.on('close', () => clearTimeout(deadline));
    });
}

/**
 * Recursively copies a directory
 * @param {string} src - Source directory
 * @param {string} dest - Destination directory
 */
function copyDirRecursive(src, dest) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        if (isGitMetadataPath(entry.name)) continue;
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

/**
 * Cleans up a downloaded archive or extracted temp directory.
 * @param {string[]} pathsToCleanup - Temp paths to delete
 */
function cleanupTempPaths(...pathsToCleanup) {
    for (const cleanupPath of pathsToCleanup) {
        try {
            if (!cleanupPath || !fs.existsSync(cleanupPath)) continue;
            const stat = fs.statSync(cleanupPath);
            if (stat.isDirectory()) {
                fs.rmSync(cleanupPath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(cleanupPath);
            }
        } catch { /* best-effort cleanup */ }
    }
}

/**
 * Resolves the extracted plugin root from an extracted archive directory.
 * @param {string} extractDir - Extraction directory
 * @returns {string} Plugin root directory
 */
function getExtractedPluginRoot(extractDir) {
    let pluginRoot = extractDir;
    const extracted = fs.readdirSync(extractDir);
    if (extracted.length === 1 && fs.statSync(path.join(extractDir, extracted[0])).isDirectory()) {
        pluginRoot = path.join(extractDir, extracted[0]);
    }
    return pluginRoot;
}

/**
 * Downloads and extracts a plugin archive from a URL.
 * @param {string} pluginName - Plugin name for temp file naming
 * @param {string} downloadUrl - ZIP download URL
 * @returns {Promise<{ zipPath: string, extractDir: string, pluginRoot: string }>}
 */
async function downloadAndExtractPluginArchive(pluginName, downloadUrl, entry = {}) {
    const os = require('os');
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), `wos_plugin_${pluginName}_`));
    const zipPath = `${extractDir}.zip`;

    console.log(`[PLUGINS] Downloading ${pluginName}...`);
    const downloaded = await downloadFile(downloadUrl, zipPath);
    if (!downloaded) {
        cleanupTempPaths(extractDir, zipPath);
        throw new Error(`Failed to download plugin "${pluginName}".`);
    }

    try {
        const buffer = fs.readFileSync(zipPath);
        if (entry.size !== undefined && buffer.length !== entry.size) throw new Error('Plugin archive size mismatch.');
        if (entry.sha256 && require('crypto').createHash('sha256').update(buffer).digest('hex') !== entry.sha256) throw new Error('Plugin archive checksum mismatch.');
        extractOfficialArchive(buffer, extractDir);
    } catch (error) {
        cleanupTempPaths(extractDir, zipPath);
        throw new Error(`Failed to extract plugin: ${error.message}`);
    }

    const pluginRoot = getExtractedPluginRoot(extractDir);
    if (!fs.existsSync(path.join(pluginRoot, 'plugin.json'))) {
        cleanupTempPaths(extractDir, zipPath);
        throw new Error(`Plugin "${pluginName}" archive is missing plugin.json.`);
    }

    return { zipPath, extractDir, pluginRoot };
}

function extractOfficialArchive(buffer, extractDir) {
    if (buffer.length > 64 * 1024 * 1024) throw new Error('Plugin archive is too large.');
    const entries = new AdmZip(buffer).getEntries();
    if (!entries.length || entries.length > 5000) throw new Error('Plugin archive has too many entries.');
    const names = new Map();
    let total = 0;
    for (const entry of entries) {
        const name = entry.entryName.replace(/\/$/, '');
        const parts = name.split('/');
        const mode = (entry.attr >>> 16) & 0xf000;
        if (!name || parts.some(part => !part || part === '.' || part === '..' || /[\\:\x00-\x1f<>"|?*]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
            mode === 0xa000 || (mode && mode !== 0x8000 && mode !== 0x4000) || names.has(name.toLowerCase()) || (entry.header.flags & 1)) throw new Error('Unsafe plugin archive entry.');
        names.set(name.toLowerCase(), entry.isDirectory);
        total += entry.header.size;
        if (entry.header.size > 32 * 1024 * 1024 || total > 256 * 1024 * 1024) throw new Error('Plugin extraction limit exceeded.');
    }
    for (const [name] of names) {
        const parts = name.split('/');
        for (let i = 1; i < parts.length; i++) if (names.get(parts.slice(0, i).join('/')) === false) throw new Error('Conflicting plugin archive paths.');
    }
    for (const entry of entries) {
        const target = path.resolve(extractDir, entry.entryName);
        if (!target.startsWith(path.resolve(extractDir) + path.sep)) throw new Error('Plugin extraction outside staging directory.');
        if (entry.isDirectory) fs.mkdirSync(target, { recursive: true });
        else {
            const data = entry.getData();
            if (data.length !== entry.header.size) throw new Error('Invalid plugin archive size.');
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, data, { flag: 'wx' });
        }
    }
}

/**
 * Installs plugin dependencies if package.json exists.
 * @param {string} pluginName - Plugin name for logs
 * @param {string} pluginDir - Plugin directory
 */
function installPluginDependencies(pluginName, pluginDir) {
    const { execSync } = require('child_process');
    const pluginPkgPath = path.join(pluginDir, 'package.json');
    if (!fs.existsSync(pluginPkgPath)) return;

    console.log(`[PLUGINS] Installing dependencies for ${pluginName}...`);
    try {
        execSync('npm install --omit=optional --production', { cwd: pluginDir, stdio: 'pipe', timeout: 180000 });
    } catch (error) {
        throw new Error(`Dependency installation failed for ${pluginName}.`);
    }
}

/**
 * Calculates MD5 hash of a file for comparison.
 * @param {string} filePath - Path to the file
 * @returns {string|null} MD5 hash or null if missing/unreadable
 */
function getFileHash(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        const crypto = require('crypto');
        const fileBuffer = fs.readFileSync(filePath);
        return crypto.createHash('md5').update(fileBuffer).digest('hex');
    } catch {
        return null;
    }
}

/**
 * Merges preserve configs from the installed and downloaded manifests.
 * @param  {...{ dirs: Set<string>, files: Set<string>, extensions: Set<string> }} configs - Preserve configs to merge
 * @returns {{ dirs: Set<string>, files: Set<string>, extensions: Set<string> }}
 */
function mergePreserveConfigs(...configs) {
    const merged = { dirs: new Set(), files: new Set(), extensions: new Set() };
    for (const config of configs) {
        if (!config) continue;
        for (const dir of config.dirs || []) merged.dirs.add(dir);
        for (const file of config.files || []) merged.files.add(file);
        for (const extension of config.extensions || []) merged.extensions.add(extension);
    }
    return merged;
}

/**
 * Resolves the preserve config used for an update.
 * If the downloaded manifest explicitly defines preserveOnUpdate, treat it as
 * the source of truth so removed preserve rules can take effect on users'
 * next update. If the field is absent entirely, fall back to merging with the
 * installed manifest for backward compatibility.
 * @param {object} installedManifest
 * @param {object} downloadedManifest
 * @returns {{ dirs: Set<string>, files: Set<string>, extensions: Set<string> }}
 */
function resolveUpdatePreserveConfig(installedManifest = {}, downloadedManifest = {}) {
    if (
        downloadedManifest &&
        Object.prototype.hasOwnProperty.call(downloadedManifest, 'preserveOnUpdate')
    ) {
        return getPluginPreserveConfig(downloadedManifest);
    }

    return mergePreserveConfigs(
        getPluginPreserveConfig(installedManifest),
        getPluginPreserveConfig(downloadedManifest)
    );
}

/**
 * Returns true if a relative plugin path must be preserved during update.
 * @param {string} relativePath - Path relative to plugin root
 * @param {boolean} isDirectory - Whether the path is a directory
 * @param {{ dirs: Set<string>, files: Set<string>, extensions: Set<string> }} preserveConfig
 * @returns {boolean}
 */
/**
 * Copies changed plugin files from the extracted update into the installed plugin directory.
 * Protected files and directories are skipped.
 * @param {string} srcDir - Extracted plugin root
 * @param {string} destDir - Installed plugin directory
 * @param {{ dirs: Set<string>, files: Set<string>, extensions: Set<string> }} preserveConfig
 * @param {string} [baseDir=srcDir] - Root directory for relative path calculations
 * @returns {{ updated: number, added: number, skipped: number, failed: number }}
 */
function copyUpdatedPluginFiles(srcDir, destDir, preserveConfig, baseDir = srcDir) {
    const stats = { updated: 0, added: 0, skipped: 0, failed: 0 };
    if (!fs.existsSync(srcDir)) return stats;

    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);
        const relativePath = path.relative(baseDir, srcPath).replace(/\\/g, '/');

        if (isGitMetadataPath(relativePath)) {
            stats.skipped++;
            continue;
        }

        if (entry.isDirectory()) {
            if (isProtectedPluginPath(relativePath, true, preserveConfig) && fs.existsSync(destPath)) {
                console.log(`[PLUGINS] Preserving directory: ${relativePath}`);
                stats.skipped++;
                continue;
            }

            if (!fs.existsSync(destPath)) {
                fs.mkdirSync(destPath, { recursive: true });
            }

            const subStats = copyUpdatedPluginFiles(srcPath, destPath, preserveConfig, baseDir);
            stats.updated += subStats.updated;
            stats.added += subStats.added;
            stats.skipped += subStats.skipped;
            stats.failed += subStats.failed;
            continue;
        }

        const destExists = fs.existsSync(destPath);
        if (isProtectedPluginPath(relativePath, false, preserveConfig) && destExists) {
            console.log(`[PLUGINS] Preserving file: ${relativePath}`);
            stats.skipped++;
            continue;
        }

        const srcHash = getFileHash(srcPath);
        const destHash = destExists ? getFileHash(destPath) : null;

        try {
            if (!destHash) {
                fs.mkdirSync(path.dirname(destPath), { recursive: true });
                fs.copyFileSync(srcPath, destPath);
                console.log(`[PLUGINS] Added: ${relativePath}`);
                stats.added++;
            } else if (srcHash !== destHash) {
                fs.copyFileSync(srcPath, destPath);
                console.log(`[PLUGINS] Updated: ${relativePath}`);
                stats.updated++;
            } else {
                stats.skipped++;
            }
        } catch (error) {
            console.error(`[PLUGINS] Failed to sync ${relativePath}: ${error.message}`);
            stats.failed++;
        }
    }

    return stats;
}

/**
 * Deletes stale plugin files/dirs that no longer exist in the extracted update.
 * Protected files and directories are kept.
 * @param {string} destDir - Installed plugin directory
 * @param {string} srcDir - Extracted plugin root
 * @param {{ dirs: Set<string>, files: Set<string>, extensions: Set<string> }} preserveConfig
 * @param {string} [baseDir=destDir] - Root directory for relative path calculations
 * @returns {{ removed: number, skipped: number, failed: number }}
 */
function removeStalePluginFiles(destDir, srcDir, preserveConfig, baseDir = destDir) {
    const stats = { removed: 0, skipped: 0, failed: 0 };
    if (!fs.existsSync(destDir)) return stats;

    const entries = fs.readdirSync(destDir, { withFileTypes: true });
    for (const entry of entries) {
        const destPath = path.join(destDir, entry.name);
        const srcPath = path.join(srcDir, entry.name);
        const relativePath = path.relative(baseDir, destPath).replace(/\\/g, '/');

        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') {
                stats.skipped++;
                continue;
            }

            if (isProtectedPluginPath(relativePath, true, preserveConfig)) {
                console.log(`[PLUGINS] Keeping protected directory: ${relativePath}`);
                stats.skipped++;
                continue;
            }

            const subStats = removeStalePluginFiles(destPath, srcPath, preserveConfig, baseDir);
            stats.removed += subStats.removed;
            stats.skipped += subStats.skipped;
            stats.failed += subStats.failed;

            try {
                if (fs.existsSync(destPath) && fs.readdirSync(destPath).length === 0) {
                    fs.rmdirSync(destPath);
                    stats.removed++;
                }
            } catch { /* best-effort cleanup */ }
            continue;
        }

        if (isProtectedPluginPath(relativePath, false, preserveConfig)) {
            console.log(`[PLUGINS] Keeping protected file: ${relativePath}`);
            stats.skipped++;
            continue;
        }

        if (!fs.existsSync(srcPath)) {
            try {
                fs.unlinkSync(destPath);
                console.log(`[PLUGINS] Removed stale file: ${relativePath}`);
                stats.removed++;
            } catch (error) {
                console.error(`[PLUGINS] Failed to remove stale file ${relativePath}: ${error.message}`);
                stats.failed++;
            }
        } else {
            stats.skipped++;
        }
    }

    return stats;
}

/**
 * Compares two semver version strings
 * @param {string} a - Version A
 * @param {string} b - Version B
 * @returns {number} 1 if a > b, -1 if a < b, 0 if equal
 */
function compareVersions(a, b) {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const numA = partsA[i] || 0;
        const numB = partsB[i] || 0;
        if (numA > numB) return 1;
        if (numA < numB) return -1;
    }
    return 0;
}

const ITEMS_PER_PAGE = 5;

function isPendingOfficialRepair(name) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return false;
    const dir = path.join(PLUGINS_DIR, name);
    return fs.existsSync(dir) && !fs.lstatSync(dir).isSymbolicLink() && fs.lstatSync(dir).isDirectory() &&
        !fs.lstatSync(path.join(dir, '.wosland-upload.json'), { throwIfNoEntry: false }) &&
        (hasIncompleteOfficialInstall(PLUGINS_DIR, name) || hasPendingPluginUpdate(PLUGINS_DIR, name));
}

/** Builds the install section with paginated official plugins and interrupted-update repairs. */
function buildInstallSection({ userId, pluginLang, lang, available, registryError, page }) {
    const totalPages = Math.max(1, Math.ceil(available.length / ITEMS_PER_PAGE));
    const currentPage = Math.min(page, totalPages - 1);
    const emojiMap = getEmojiMapForUser(userId);

    const container = new ContainerBuilder()
        .setAccentColor(0x2ecc71)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                registryError
                    ? pluginLang.content.registryError
                    : available.length === 0
                        ? pluginLang.content.noAvailable
                        : `**${pluginLang.content.available}**` +
                          (totalPages > 1
                              ? `\n${lang.pagination.text.pageInfo
                                    .replace('{current}', String(currentPage + 1))
                                    .replace('{total}', String(totalPages))}`
                              : '')
            )
        );

    if (available.length > 0) {
        container.addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        );

        const pagePlugins = available.slice(currentPage * ITEMS_PER_PAGE, (currentPage + 1) * ITEMS_PER_PAGE);

        pagePlugins.forEach((plugin, index) => {
            const compatible = validateManifest(plugin, 'registry').valid;
            const requirements = plugin.engines
                ? `\n${pluginLang.upload.compatibility}: Bot ${plugin.engines.bot || '—'} · Node.js ${plugin.engines.node || '—'}`
                : '';
            const installButton = new ButtonBuilder()
                .setCustomId(`plugins_install_${plugin.name}_${userId}`)
                .setLabel(isPendingOfficialRepair(plugin.name) ? pluginLang.buttons.repair : pluginLang.buttons.install)
                .setStyle(ButtonStyle.Success)
                .setDisabled(!compatible)
                .setEmoji(getComponentEmoji(emojiMap, '1004'));

            const section = new SectionBuilder()
                .setButtonAccessory(installButton)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `**${escapeMarkdown(String(plugin.name).slice(0, 64))}**\n` +
                        `- ${escapeMarkdown(String(plugin.description || '—').slice(0, 200))}\n` +
                        `- \`v${escapeMarkdown(String(plugin.version).slice(0, 64))}\`` +
                        escapeMarkdown(requirements.slice(0, 180)) +
                        (compatible ? '' : `\n${pluginLang.upload.errors.compatibility}`)
                    )
                );

            container.addSectionComponents(section);

            if (index < pagePlugins.length - 1) {
                container.addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false)
                );
            }
        });
    }

    // Pagination + back button
    container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    );

    const paginationRow = createUniversalPaginationButtons({
        feature: 'plugins_install',
        userId,
        currentPage,
        totalPages,
        lang
    });

    if (paginationRow) {
        container.addActionRowComponents(paginationRow);
    }

    return [container];
}

/**
 * Handles the install menu — shows available plugins as a section below the main container
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {number} [page=0] - Page number (0-indexed)
 */
async function handlePluginsInstallMenu(interaction, page = 0) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!adminData || !adminData.is_owner) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        await interaction.deferUpdate();

        const pluginLang = lang.plugins;
        const userId = interaction.user.id;
        // Fetch installed and registry
        const installed = getInstalledPluginManifests();

        let registry = null;
        let registryError = false;
        if (typeof global.pluginManager?.fetchRegistry === 'function') {
            registry = await global.pluginManager.fetchRegistry();
        }
        if (!registry) registryError = true;

        const installedNames = new Set(installed.map(p => p.name));
        const available = registry?.plugins?.filter(p => (!installedNames.has(p.name) || isPendingOfficialRepair(p.name)) && validateManifest(p, 'registry', { checkCompatibility: false }).valid) || [];

        const sectionComponents = buildInstallSection({
            userId, pluginLang, lang, available, registryError, page
        });

        const components = createPluginsComponents(interaction, lang, sectionComponents);

        await interaction.editReply({
            components,
            attachments: [],
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handlePluginsInstallMenu');
    }
}

/**
 * Handles pagination for the install section
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handlePluginsInstallPagination(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        // customId: plugins_install_prev_{userId}_{currentPage} or plugins_install_next_{userId}_{currentPage}
        const parts = interaction.customId.split('_');
        const direction = parts[2]; // prev or next
        const expectedUserId = parts[3];
        const currentPage = parseInt(parts[4], 10);

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!adminData || !adminData.is_owner) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        await interaction.deferUpdate();

        const pluginLang = lang.plugins;
        const userId = interaction.user.id;

        const installed = getInstalledPluginManifests();

        let registry = null;
        let registryError = false;
        if (typeof global.pluginManager?.fetchRegistry === 'function') {
            registry = await global.pluginManager.fetchRegistry();
        }
        if (!registry) registryError = true;

        const installedNames = new Set(installed.map(p => p.name));
        const available = registry?.plugins?.filter(p => (!installedNames.has(p.name) || isPendingOfficialRepair(p.name)) && validateManifest(p, 'registry', { checkCompatibility: false }).valid) || [];

        const newPage = direction === 'next' ? currentPage + 1 : currentPage - 1;

        const sectionComponents = buildInstallSection({
            userId, pluginLang, lang, available, registryError, page: newPage
        });

        const components = createPluginsComponents(interaction, lang, sectionComponents);

        await interaction.editReply({
            components,
            attachments: [],
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handlePluginsInstallPagination');
    }
}

/**
 * Handles installing a plugin via section button click
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handlePluginInstall(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    let updateLock;
    let keepLock = false;
    try {
        // customId: plugins_install_{pluginName}_{userId}
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[parts.length - 1];
        const pluginName = parts.slice(2, -1).join('_');

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!adminData || !adminData.is_owner) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const pluginLang = lang.plugins;
        const userId = interaction.user.id;
        const repairing = isPendingOfficialRepair(pluginName);
        updateLock = acquireUpdateLock(`plugin install: ${pluginName}`);
        if (!updateLock.acquired) {
            return await interaction.reply({
                content: formatActiveUpdateMessage(updateLock.active),
                ephemeral: true
            });
        }

        await interaction.deferUpdate();

        // Show installing status as section
        const installingContainer = new ContainerBuilder()
            .setAccentColor(0xffa500)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    (repairing ? pluginLang.content.repairing : pluginLang.content.installing).replace('{name}', pluginName)
                )
            );

        const loadingComponents = createPluginsComponents(interaction, lang, [installingContainer]);
        await interaction.editReply({
            components: loadingComponents,
            attachments: [],
            flags: MessageFlags.IsComponentsV2
        });

        // Install the plugin
        const result = await global.pluginManager.install(pluginName);

        const resultText = result.success
            ? (repairing ? pluginLang.content.repairSuccess : pluginLang.content.installSuccess).replace('{name}', pluginName)
            : (repairing ? pluginLang.content.repairFailed : pluginLang.content.installFailed)
                .replace('{name}', pluginName)
                .replace('{error}', result.message);
        const color = result.success ? 0x2ecc71 : 0xff0000;

        const resultContainer = new ContainerBuilder()
            .setAccentColor(color)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(resultText)
            );

        await interaction.editReply({
            components: createPluginsComponents(interaction, lang, [resultContainer]),
            attachments: [],
            flags: MessageFlags.IsComponentsV2
        });

        if (result.success && typeof global.restartBot === 'function') {
            keepLock = true;
            setTimeout(() => global.restartBot(), 2000);
        }

    } catch (error) {
        await handleError(interaction, lang, error, 'handlePluginInstall');
    } finally {
        if (!keepLock && updateLock?.token) {
            releaseUpdateLock(updateLock.token);
        }
    }
}

// ============================================================
// PLUGIN INSTALL / REGISTRY / UPDATE LOGIC
// ============================================================

/**
 * Fetches the remote plugin registry (list of available plugins)
 * @returns {Promise<Object[]|null>} Array of plugin entries or null on error
 */
async function fetchRegistry() {
    const registry = await httpsGetJSON(PLUGIN_REGISTRY_PROXY_URL);
    if (registry?.plugins && Array.isArray(registry.plugins)) {
        return registry;
    }
    return null;
}

/**
 * Installs a plugin from the remote registry by name.
 * Downloads the plugin ZIP from GitHub, extracts it, and loads it.
 * @param {string} pluginName - Plugin name from registry
 * @param {Object} registrar - Register functions from index.js
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function installPlugin(pluginName, registrar, options = {}) {
    const { beforeRegister = null } = options;
    let archive;
    let installedDir;
    let installedIdentity;

    try {
        if (!/^[a-zA-Z0-9_-]+$/.test(pluginName)) {
            return { success: false, message: `Invalid plugin name: "${pluginName}"` };
        }

        if (loadedPlugins.has(pluginName)) {
            return { success: false, message: `Plugin "${pluginName}" is already installed.` };
        }

        const destDir = path.join(PLUGINS_DIR, pluginName);
        if (isPendingOfficialRepair(pluginName)) return await updatePlugin(pluginName, registrar, { repair: true });
        if (fs.existsSync(destDir)) {
            return {
                success: false,
                message: `Plugin folder "${pluginName}" already exists. Update it or move it before installing.`
            };
        }

        const registry = await fetchRegistry();
        if (!registry || !Array.isArray(registry.plugins)) {
            return { success: false, message: 'Could not fetch plugin registry.' };
        }

        const entry = registry.plugins.find(p => p.name === pluginName);
        if (!entry) {
            return { success: false, message: `Plugin "${pluginName}" not found in registry.` };
        }
        const compatibility = validateManifest(entry, 'registry');
        if (!compatibility.valid) return { success: false, message: compatibility.error };

        const downloadUrl = entry.downloadUrl;
        if (!downloadUrl) {
            return {
                success: false,
                message: `Plugin "${pluginName}" is missing a release download URL from the central proxy.`
            };
        }
        archive = await downloadAndExtractPluginArchive(pluginName, downloadUrl, entry);
        const { pluginRoot } = archive;
        const manifest = validateDownloadedPlugin(pluginRoot, entry);

        if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true });
        // Recheck after downloading: another installation must never be overwritten.
        fs.mkdirSync(destDir);
        installedDir = destDir;
        installedIdentity = fs.lstatSync(destDir);
        fs.writeFileSync(path.join(destDir, '.wosland-install-pending.json'), '{}', { flag: 'wx' });
        copyDirRecursive(pluginRoot, destDir);

        installPluginDependencies(pluginName, destDir);

        if (typeof beforeRegister === 'function') {
            await beforeRegister(destDir);
        }

        await waitForPluginReady(registerPluginModules(destDir, manifest, registrar));
        fs.unlinkSync(path.join(destDir, '.wosland-install-pending.json'));
        console.log(`[PLUGINS] Installed: ${manifest.name} v${manifest.version}`);

        return { success: true, message: `Plugin "${manifest.name}" v${manifest.version} installed successfully.` };
    } catch (error) {
        if (installedDir) {
            require('./pluginsLoader').unloadPlugin(pluginName, registrar);
            try {
                const current = fs.lstatSync(installedDir);
                if (
                    current.isSymbolicLink() ||
                    current.ino !== installedIdentity.ino ||
                    current.dev !== installedIdentity.dev
                )
                    throw new Error('Installation folder changed.');
                fs.rmSync(installedDir, { recursive: true, force: true });
            } catch {
                return {
                    success: false,
                    message:
                        'Installation failed and could not be removed. The pending installation remains disabled; inspect its folder before restarting.'
                };
            }
        }
        return { success: false, message: `Install failed: ${error.message}` };
    } finally {
        cleanupTempPaths(archive?.extractDir, archive?.zipPath);
    }
}

function validateDownloadedPlugin(pluginRoot, entry, { allowPendingInstall = false } = {}) {
    if (
        fs.existsSync(path.join(pluginRoot, '.wosland-upload.json')) ||
        (!allowPendingInstall && fs.existsSync(path.join(pluginRoot, '.wosland-install-pending.json')))
    )
        throw new Error('Official archive contains an installation marker.');
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8'));
    const validation = validateManifest(manifest, pluginRoot);
    if (!validation.valid) throw new Error(validation.error);
    if (manifest.name !== entry.name || manifest.version !== entry.version)
        throw new Error('Plugin manifest does not match the inspected registry entry.');
    const packagePath = path.join(pluginRoot, 'package.json');
    if (fs.existsSync(packagePath)) {
        const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        if (
            pkg.engines?.node &&
            (!semver.validRange(pkg.engines.node) || !semver.satisfies(process.versions.node, pkg.engines.node))
        )
            throw new Error(`Plugin requires Node.js ${pkg.engines.node}.`);
    }
    return manifest;
}

async function waitForPluginReady(plugin) {
    let timer;
    try {
        await Promise.race([
            plugin.ready,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Plugin startup timed out.')), 100000);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Checks for updates for all installed plugins against the registry
 * @returns {Promise<{ updates: { name: string, current: string, latest: string }[], error?: string }>}
 */
async function checkPluginUpdates() {
    const installedPlugins = getInstalledPluginManifests().filter(plugin => !plugin.thirdParty);
    const proxyPayload = await requestPluginUpdatesViaProxy(installedPlugins);
    if (proxyPayload?.updates) {
        return {
            updates: proxyPayload.updates.filter(
                update =>
                    installedPlugins.some(plugin => plugin.name === update.name) &&
                    validateManifest({ name: update.name, version: update.latest, engines: update.engines }, 'registry')
                        .valid
            )
        };
    }
    return { updates: [], error: 'Could not check plugin updates.' };
}

/**
 * Updates a specific plugin to the latest version from the registry.
 * Validates before unloading, saves replaceable code/dependencies, and restores
 * the previous installation if copying, dependency installation or loading fails.
 * @param {string} pluginName - Plugin name to update
 * @param {Object} registrar - Register/unregister functions
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function updatePlugin(pluginName, registrar, { repair = false } = {}) {
    const { unloadPlugin } = require('./pluginDelete');

    const pluginDir = path.join(PLUGINS_DIR, pluginName);
    const pluginManifestPath = path.join(pluginDir, 'plugin.json');
    let zipPath = null;
    let extractDir = null;
    let transaction;
    let wasLoaded = false;
    let installedManifest;
    let stage = 'validation';

    try {
        if (!/^[a-zA-Z0-9_-]+$/.test(pluginName)) {
            return { success: false, message: `Invalid plugin name: "${pluginName}"` };
        }

        if (!fs.existsSync(pluginDir)) {
            return { success: false, message: `Plugin "${pluginName}" is not installed.` };
        }

        if (fs.lstatSync(path.join(pluginDir, '.wosland-upload.json'), { throwIfNoEntry: false })) {
            return {
                success: false,
                message: 'Uploaded third-party plugins cannot be updated from the official catalog.'
            };
        }
        if (!repair && fs.existsSync(path.join(pluginDir, '.wosland-install-pending.json')))
            return {
                success: false,
                message: 'This installation is incomplete. Use Plugins → Install → Repair.'
            };

        const registry = await fetchRegistry();
        if (!registry || !Array.isArray(registry.plugins)) {
            return { success: false, message: 'Could not fetch plugin registry.' };
        }

        const entry = registry.plugins.find(p => p.name === pluginName);
        if (!entry) {
            return { success: false, message: `Plugin "${pluginName}" not found in registry.` };
        }
        if (repair && (!isPendingOfficialRepair(pluginName) || !/^[a-f0-9]{64}$/i.test(entry.sha256 || '')))
            return { success: false, message: 'Repair requires an interrupted official installation and a verified release checksum.' };
        const compatibility = validateManifest(entry, 'registry');
        if (!compatibility.valid) return { success: false, message: compatibility.error };

        const downloadUrl = entry.downloadUrl;
        if (!downloadUrl) {
            return {
                success: false,
                message: `Plugin "${pluginName}" is missing a release download URL from the central proxy.`
            };
        }
        stage = 'download';
        const archive = await downloadAndExtractPluginArchive(pluginName, downloadUrl, entry);
        zipPath = archive.zipPath;
        extractDir = archive.extractDir;

        stage = 'validation';
        const downloadedManifest = validateDownloadedPlugin(archive.pluginRoot, entry);

        if (fs.lstatSync(pluginDir).isSymbolicLink()) throw new Error('Installed plugin must not be a link.');
        try { installedManifest = JSON.parse(fs.readFileSync(pluginManifestPath, 'utf8')); }
        catch (error) {
            if (!repair || !isPendingOfficialRepair(pluginName)) throw error;
            installedManifest = downloadedManifest;
        }
        if (installedManifest.name !== pluginName)
            throw new Error('Installed plugin identity does not match its folder.');
        if (semver.lt(downloadedManifest.version, installedManifest.version))
            throw new Error('Refusing to downgrade an installed plugin.');

        const preserveConfig = repair
            ? mergePreserveConfigs(getPluginPreserveConfig(installedManifest), getPluginPreserveConfig(downloadedManifest))
            : resolveUpdatePreserveConfig(installedManifest, downloadedManifest);
        // Keep the official install blocker through file replacement, startup and rollback.
        if (repair) preserveConfig.files.add('.wosland-install-pending.json');

        const shouldInstallDependencies =
            fs.existsSync(path.join(archive.pluginRoot, 'package.json')) &&
            (repair || dependencyFingerprint(pluginDir) !== dependencyFingerprint(archive.pluginRoot) ||
                !fs.existsSync(path.join(pluginDir, 'node_modules')));

        // The official archive has already passed integrity and compatibility checks.
        stage = 'backup';
        transaction = beginPluginUpdate(PLUGINS_DIR, pluginName, preserveConfig, { repair });
        wasLoaded = loadedPlugins.has(pluginName);
        unloadPlugin(pluginName, registrar);
        transaction.apply();

        stage = 'file replacement';
        const copyStats = copyUpdatedPluginFiles(archive.pluginRoot, pluginDir, preserveConfig);
        const removeStats = removeStalePluginFiles(pluginDir, archive.pluginRoot, preserveConfig);
        if (copyStats.failed || removeStats.failed) throw new Error('Could not replace all plugin files.');

        if (shouldInstallDependencies) {
            stage = 'dependencies';
            transaction.replaceDependencies();
            installPluginDependencies(pluginName, pluginDir);
        }

        const finalManifest = validateDownloadedPlugin(pluginDir, entry, { allowPendingInstall: repair });

        stage = 'startup';
        loadedPlugins.delete(pluginName);
        await waitForPluginReady(registerPluginModules(pluginDir, finalManifest, registrar));
        stage = 'commit';
        transaction.commit({ keepBackup: repair });
        transaction = null;
        console.log(`[PLUGINS] Updated: ${finalManifest.name} v${finalManifest.version}`);

        cleanupTempPaths(extractDir, zipPath);
        const summary = [
            `${copyStats.updated} files updated`,
            `${copyStats.added} files added`,
            `${removeStats.removed} stale entries removed`
        ];
        return {
            success: true,
            message: `Plugin "${finalManifest.name}" v${finalManifest.version} updated successfully. ${summary.join(', ')}.`
        };
    } catch (error) {
        if (repair) console.warn(`[PLUGINS] Repair for ${pluginName} failed during ${stage} (${error.code || 'FAILED'}).`);
        if (transaction) {
            unloadPlugin(pluginName, registrar);
            try {
                transaction.rollback();
            } catch {
                return {
                    success: false,
                    message:
                        'Plugin update failed. Its previous files could not be fully restored; inspect the preserved update backup before restarting.'
                };
            }
            try {
                if (wasLoaded) await waitForPluginReady(registerPluginModules(pluginDir, installedManifest, registrar));
            } catch {
                return {
                    success: false,
                    message:
                        'Plugin update failed. Its previous files were restored, but the previous plugin could not be loaded. Restart the bot after checking the plugin.'
                };
            }
            return { success: false, message: repair
                ? 'Repair failed. The plugin remains disabled and its backups are preserved. Try Repair again after checking file access and the bot configuration.'
                : `Update failed; previous plugin restored: ${error.message}` };
        }
        return { success: false, message: repair
            ? 'Repair could not finish. The plugin remains disabled and its backup is preserved. Check the bot console for the failed step.'
            : `Update failed: ${error.message}` };
    } finally {
        cleanupTempPaths(extractDir, zipPath);
    }
}

/** Retry interrupted official updates before Discord registers plugin commands. */
async function recoverPendingPlugins(registrar) {
    const results = { recovered: [], failed: [] };
    if (!fs.existsSync(PLUGINS_DIR)) return results;
    const pending = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && isPendingOfficialRepair(entry.name)).map(entry => entry.name);
    if (!pending.length) return results;
    const lock = acquireUpdateLock('automatic plugin recovery');
    if (!lock.acquired) return results;
    try {
        for (const name of pending) {
            try {
                while (isPendingOfficialRepair(name)) {
                    const attempt = claimPluginRecoveryAttempt(PLUGINS_DIR, name);
                    if (attempt === null) break;
                    console.log(`[PLUGINS] Recovering ${name} (attempt ${attempt}/3).`);
                    if (attempt > 1) await new Promise(resolve => setTimeout(resolve, attempt === 2 ? 1000 : 3000));
                    const result = await updatePlugin(name, registrar, { repair: true });
                    if (result.success) {
                        results.recovered.push(name);
                        break;
                    }
                }
                if (!results.recovered.includes(name)) {
                    results.failed.push(name);
                    console.warn(`[PLUGINS] Automatic recovery for ${name} did not complete. Backups are preserved. Use Plugins → Install → Repair.`);
                }
            } catch (error) {
                results.failed.push(name);
                console.warn(`[PLUGINS] Automatic recovery for ${name} stopped (${error.code || 'RECOVERY_FAILED'}). Backups are preserved. Use Plugins → Install → Repair.`);
            }
        }
    } finally {
        releaseUpdateLock(lock.token);
    }
    return results;
}

module.exports = {
    fetchRegistry,
    installPlugin,
    checkPluginUpdates,
    updatePlugin,
    recoverPendingPlugins,
    handlePluginsInstallMenu,
    handlePluginsInstallPagination,
    handlePluginInstall
};
