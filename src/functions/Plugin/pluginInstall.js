const fs = require('fs');
const path = require('path');
const https = require('https');
const { acquire7z } = require('../utility/ensure7zip');
const {
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SectionBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize
} = require('discord.js');
const { getUserInfo, handleError, assertUserMatches, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getComponentEmoji, getEmojiMapForUser } = require('../utility/emojis');
const { createUniversalPaginationButtons } = require('../Pagination/universalPagination');
const { isGitMetadataPath } = require('./pluginGitMetadata');
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
        const req = https.get(url, {
            headers: {
                'User-Agent': 'WhiteoutSurvivalBot',
                ...headers
            }
        }, (res) => {
            if ((res.statusCode === 301 || res.statusCode === 302) && remainingRedirects > 0) {
                return httpsGetJSON(res.headers.location, remainingRedirects - 1, headers).then(resolve);
            }
            if (res.statusCode !== 200) return resolve(null);

            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(10000, () => { req.destroy(); resolve(null); });
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
        const file = fs.createWriteStream(destPath);
        const cleanupFile = (callback) => {
            file.close(() => {
                if (fs.existsSync(destPath)) {
                    try { fs.unlinkSync(destPath); } catch { /* best-effort cleanup */ }
                }
                callback();
            });
        };

        https.get(url, { headers: { 'User-Agent': 'WhiteoutSurvivalBot' } }, (res) => {
            if ((res.statusCode === 301 || res.statusCode === 302) && remainingRedirects > 0) {
                cleanupFile(() => {
                    downloadFile(res.headers.location, destPath, remainingRedirects - 1).then(resolve);
                });
                return;
            }
            if (res.statusCode !== 200) {
                cleanupFile(() => resolve(false));
                return;
            }
            res.pipe(file);
            file.on('finish', () => { file.close(() => resolve(true)); });
        }).on('error', () => {
            cleanupFile(() => resolve(false));
        });
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
async function downloadAndExtractPluginArchive(pluginName, downloadUrl) {
    const os = require('os');
    const { execSync } = require('child_process');

    const zipPath = path.join(os.tmpdir(), `wos_plugin_${pluginName}.zip`);
    const extractDir = path.join(os.tmpdir(), `wos_plugin_${pluginName}_extract`);

    console.log(`[PLUGINS] Downloading ${pluginName}...`);
    const downloaded = await downloadFile(downloadUrl, zipPath);
    if (!downloaded) {
        throw new Error(`Failed to download plugin "${pluginName}".`);
    }

    cleanupTempPaths(extractDir);
    fs.mkdirSync(extractDir, { recursive: true });

    const { binPath: sevenZipPath, cleanupPath: sevenZipCleanup } = await acquire7z(os.tmpdir());
    if (!sevenZipPath) {
        cleanupTempPaths(extractDir, zipPath);
        throw new Error('Could not locate 7-Zip binary for extraction.');
    }

    try {
        execSync(`"${sevenZipPath}" x "${zipPath}" -o"${extractDir}" -y`, { stdio: 'pipe' });
    } catch (error) {
        cleanupTempPaths(extractDir, zipPath);
        throw new Error(`Failed to extract plugin: ${error.message}`);
    } finally {
        if (sevenZipCleanup && fs.existsSync(sevenZipCleanup)) {
            try { fs.unlinkSync(sevenZipCleanup); } catch { /* best-effort cleanup */ }
        }
    }

    const pluginRoot = getExtractedPluginRoot(extractDir);
    if (!fs.existsSync(path.join(pluginRoot, 'plugin.json'))) {
        cleanupTempPaths(extractDir, zipPath);
        throw new Error(`Plugin "${pluginName}" archive is missing plugin.json.`);
    }

    return { zipPath, extractDir, pluginRoot };
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
        execSync('npm install --omit=optional --production', { cwd: pluginDir, stdio: 'pipe' });
    } catch (error) {
        console.warn(`[PLUGINS] Warning: dependency install for ${pluginName} failed: ${error.message}`);
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
function isProtectedPluginPath(relativePath, isDirectory, preserveConfig) {
    const normalizedPath = relativePath.replace(/\\/g, '/');

    if (isGitMetadataPath(normalizedPath)) return true;

    for (const protectedDir of preserveConfig.dirs) {
        if (normalizedPath === protectedDir || normalizedPath.startsWith(`${protectedDir}/`)) {
            return true;
        }
    }

    if (!isDirectory && preserveConfig.files.has(normalizedPath)) {
        return true;
    }

    if (!isDirectory && preserveConfig.extensions.has(path.extname(normalizedPath).toLowerCase())) {
        return true;
    }

    return false;
}

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

/**
 * Builds the install section container with paginated plugin sections
 * @param {Object} params
 * @returns {Array} Array of components for the section
 */
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
            const installButton = new ButtonBuilder()
                .setCustomId(`plugins_install_${plugin.name}_${userId}`)
                .setLabel(pluginLang.buttons.install)
                .setStyle(ButtonStyle.Success)
                .setEmoji(getComponentEmoji(emojiMap, '1004'));

            const section = new SectionBuilder()
                .setButtonAccessory(installButton)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `**${plugin.name}**\n` +
                        `- ${plugin.description || '—'}\n` +
                        `- \`v${plugin.version}\``
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
        const available = registry?.plugins?.filter(p => !installedNames.has(p.name)) || [];

        const sectionComponents = buildInstallSection({
            userId, pluginLang, lang, available, registryError, page
        });

        const components = updateComponentsV2AfterSeparator(interaction, sectionComponents);

        await interaction.editReply({
            components,
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
        const available = registry?.plugins?.filter(p => !installedNames.has(p.name)) || [];

        const newPage = direction === 'next' ? currentPage + 1 : currentPage - 1;

        const sectionComponents = buildInstallSection({
            userId, pluginLang, lang, available, registryError, page: newPage
        });

        const components = updateComponentsV2AfterSeparator(interaction, sectionComponents);

        await interaction.editReply({
            components,
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
        const updateLock = acquireUpdateLock(`plugin install: ${pluginName}`);
        if (!updateLock.acquired) {
            return await interaction.reply({
                content: formatActiveUpdateMessage(updateLock.active),
                ephemeral: true
            });
        }

        let keepLock = false;
        await interaction.deferUpdate();

        // Show installing status as section
        const installingContainer = new ContainerBuilder()
            .setAccentColor(0xffa500)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    pluginLang.content.installing.replace('{name}', pluginName)
                )
            );

        const loadingComponents = updateComponentsV2AfterSeparator(interaction, [installingContainer]);
        await interaction.editReply({
            components: loadingComponents,
            flags: MessageFlags.IsComponentsV2
        });

        // Install the plugin
        const result = await global.pluginManager.install(pluginName);

        const resultText = result.success
            ? pluginLang.content.installSuccess.replace('{name}', pluginName)
            : pluginLang.content.installFailed
                .replace('{name}', pluginName)
                .replace('{error}', result.message);
        const color = result.success ? 0x2ecc71 : 0xff0000;

        const resultContainer = new ContainerBuilder()
            .setAccentColor(color)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(resultText)
            );

        // Use the same structure: main container + separator + result
        const currentComponents = interaction.message.components;
        const mainContainer = currentComponents[0];
        const separator = new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true);

        await interaction.editReply({
            components: [mainContainer, separator, resultContainer],
            flags: MessageFlags.IsComponentsV2
        });

        if (result.success && typeof global.restartBot === 'function') {
            keepLock = true;
            setTimeout(() => global.restartBot(), 2000);
        }

    } catch (error) {
        await handleError(interaction, lang, error, 'handlePluginInstall');
    } finally {
        if (typeof keepLock !== 'undefined' && !keepLock && typeof updateLock?.token !== 'undefined') {
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

    try {
        if (!/^[a-zA-Z0-9_-]+$/.test(pluginName)) {
            return { success: false, message: `Invalid plugin name: "${pluginName}"` };
        }

        if (loadedPlugins.has(pluginName)) {
            return { success: false, message: `Plugin "${pluginName}" is already installed.` };
        }

        const destDir = path.join(PLUGINS_DIR, pluginName);
        if (fs.existsSync(destDir)) {
            return { success: false, message: `Plugin folder "${pluginName}" already exists. Update it or move it before installing.` };
        }

        const registry = await fetchRegistry();
        if (!registry || !Array.isArray(registry.plugins)) {
            return { success: false, message: 'Could not fetch plugin registry.' };
        }

        const entry = registry.plugins.find(p => p.name === pluginName);
        if (!entry) {
            return { success: false, message: `Plugin "${pluginName}" not found in registry.` };
        }

        const downloadUrl = entry.downloadUrl;
        if (!downloadUrl) {
            return { success: false, message: `Plugin "${pluginName}" is missing a release download URL from the central proxy.` };
        }
        const { zipPath, extractDir, pluginRoot } = await downloadAndExtractPluginArchive(pluginName, downloadUrl);

        if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true });

        copyDirRecursive(pluginRoot, destDir);

        cleanupTempPaths(extractDir, zipPath);

        installPluginDependencies(pluginName, destDir);

        if (typeof beforeRegister === 'function') {
            await beforeRegister(destDir);
        }

        const manifest = JSON.parse(fs.readFileSync(path.join(destDir, 'plugin.json'), 'utf8'));
        const validation = validateManifest(manifest, destDir);
        if (!validation.valid) {
            return { success: false, message: validation.error };
        }

        registerPluginModules(destDir, manifest, registrar);
        console.log(`[PLUGINS] Installed: ${manifest.name} v${manifest.version}`);

        return { success: true, message: `Plugin "${manifest.name}" v${manifest.version} installed successfully.` };

    } catch (error) {
        return { success: false, message: `Install failed: ${error.message}` };
    }
}

/**
 * Checks for updates for all installed plugins against the registry
 * @returns {Promise<{ updates: { name: string, current: string, latest: string }[], error?: string }>}
 */
async function checkPluginUpdates() {
    const installedPlugins = getInstalledPluginManifests();
    const proxyPayload = await requestPluginUpdatesViaProxy(installedPlugins);
    if (proxyPayload?.updates) {
        return { updates: proxyPayload.updates };
    }
    return { updates: [], error: 'Could not check plugin updates.' };
}

/**
 * Updates a specific plugin to the latest version from the registry.
 * Unloads the plugin first (closing DB connections so WAL is checkpointed),
 * then stages database files, wipes the directory, and reinstalls.
 * @param {string} pluginName - Plugin name to update
 * @param {Object} registrar - Register/unregister functions
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function updatePlugin(pluginName, registrar) {
    const { unloadPlugin } = require('./pluginDelete');

    const pluginDir = path.join(PLUGINS_DIR, pluginName);
    const pluginManifestPath = path.join(pluginDir, 'plugin.json');
    let zipPath = null;
    let extractDir = null;

    try {
        if (!/^[a-zA-Z0-9_-]+$/.test(pluginName)) {
            return { success: false, message: `Invalid plugin name: "${pluginName}"` };
        }

        if (!fs.existsSync(pluginDir)) {
            return { success: false, message: `Plugin "${pluginName}" is not installed.` };
        }

        const registry = await fetchRegistry();
        if (!registry || !Array.isArray(registry.plugins)) {
            return { success: false, message: 'Could not fetch plugin registry.' };
        }

        const entry = registry.plugins.find(p => p.name === pluginName);
        if (!entry) {
            return { success: false, message: `Plugin "${pluginName}" not found in registry.` };
        }

        const downloadUrl = entry.downloadUrl;
        if (!downloadUrl) {
            return { success: false, message: `Plugin "${pluginName}" is missing a release download URL from the central proxy.` };
        }
        const archive = await downloadAndExtractPluginArchive(pluginName, downloadUrl);
        zipPath = archive.zipPath;
        extractDir = archive.extractDir;

        const downloadedManifest = JSON.parse(fs.readFileSync(path.join(archive.pluginRoot, 'plugin.json'), 'utf8'));
        const downloadedValidation = validateManifest(downloadedManifest, archive.pluginRoot);
        if (!downloadedValidation.valid) {
            return { success: false, message: downloadedValidation.error };
        }

        let installedManifest = {};
        try {
            if (fs.existsSync(pluginManifestPath)) {
                installedManifest = JSON.parse(fs.readFileSync(pluginManifestPath, 'utf8'));
            }
        } catch (error) {
            console.warn(`[PLUGINS] Warning: could not read installed manifest for ${pluginName}: ${error.message}`);
        }

        const preserveConfig = resolveUpdatePreserveConfig(installedManifest, downloadedManifest);

        const oldPackageHash = getFileHash(path.join(pluginDir, 'package.json'));
        const newPackageHash = getFileHash(path.join(archive.pluginRoot, 'package.json'));
        const shouldInstallDependencies = !!newPackageHash && (
            oldPackageHash !== newPackageHash ||
            !fs.existsSync(path.join(pluginDir, 'node_modules'))
        );

        // Unload the plugin so file handles are released before overwriting files in place.
        unloadPlugin(pluginName, registrar);

        const copyStats = copyUpdatedPluginFiles(archive.pluginRoot, pluginDir, preserveConfig);
        const removeStats = removeStalePluginFiles(pluginDir, archive.pluginRoot, preserveConfig);

        if (shouldInstallDependencies) {
            installPluginDependencies(pluginName, pluginDir);
        }

        const finalManifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'));
        const validation = validateManifest(finalManifest, pluginDir);
        if (!validation.valid) {
            return { success: false, message: validation.error };
        }

        loadedPlugins.delete(pluginName);
        registerPluginModules(pluginDir, finalManifest, registrar);
        console.log(`[PLUGINS] Updated: ${finalManifest.name} v${finalManifest.version}`);

        cleanupTempPaths(extractDir, zipPath);
        const summary = [
            `${copyStats.updated} files updated`,
            `${copyStats.added} files added`,
            `${removeStats.removed} stale entries removed`
        ];
        const failureCount = copyStats.failed + removeStats.failed;
        if (failureCount > 0) {
            summary.push(`${failureCount} file operations failed`);
        }

        return {
            success: failureCount === 0,
            message: `Plugin "${finalManifest.name}" v${finalManifest.version} updated successfully. ${summary.join(', ')}.`
        };
    } catch (error) {
        return { success: false, message: `Update failed: ${error.message}` };
    } finally {
        cleanupTempPaths(extractDir, zipPath);
    }
}

module.exports = {
    fetchRegistry,
    installPlugin,
    checkPluginUpdates,
    updatePlugin,
    handlePluginsInstallMenu,
    handlePluginsInstallPagination,
    handlePluginInstall
};
