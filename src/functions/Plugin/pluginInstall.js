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
const {
    PLUGINS_DIR, loadedPlugins, validateManifest, registerPluginModules
} = require('./pluginsLoader');
const i18n = require('../../i18n');

// ============================================================
// INSTALL-SPECIFIC CONSTANTS & UTILITIES
// ============================================================

const PLUGIN_REPO = 'whiteout-project/wosJS-plugins';
const PLUGIN_REGISTRY_URL = `https://raw.githubusercontent.com/${PLUGIN_REPO}/main/registry.json`;

const MAX_REDIRECTS = 5;

/**
 * Fetches JSON from a URL via HTTPS GET
 * @param {string} url - URL to fetch
 * @param {number} [remainingRedirects] - Redirect depth limit
 * @returns {Promise<Object|null>} Parsed JSON or null on error
 */
function httpsGetJSON(url, remainingRedirects = MAX_REDIRECTS) {
    return new Promise((resolve) => {
        const req = https.get(url, { headers: { 'User-Agent': 'WhiteoutSurvivalBot' } }, (res) => {
            if ((res.statusCode === 301 || res.statusCode === 302) && remainingRedirects > 0) {
                return httpsGetJSON(res.headers.location, remainingRedirects - 1).then(resolve);
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
        const installed = typeof global.pluginManager?.getInstalled === 'function'
            ? global.pluginManager.getInstalled()
            : [];

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

        const installed = typeof global.pluginManager?.getInstalled === 'function'
            ? global.pluginManager.getInstalled()
            : [];

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
            setTimeout(() => global.restartBot(), 2000);
        }

    } catch (error) {
        await handleError(interaction, lang, error, 'handlePluginInstall');
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
    return await httpsGetJSON(PLUGIN_REGISTRY_URL);
}

/**
 * Installs a plugin from the remote registry by name.
 * Downloads the plugin ZIP from GitHub, extracts it, and loads it.
 * @param {string} pluginName - Plugin name from registry
 * @param {Object} registrar - Register functions from index.js
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function installPlugin(pluginName, registrar) {
    const os = require('os');
    const { execSync } = require('child_process');

    try {
        if (!/^[a-zA-Z0-9_-]+$/.test(pluginName)) {
            return { success: false, message: `Invalid plugin name: "${pluginName}"` };
        }

        if (loadedPlugins.has(pluginName)) {
            return { success: false, message: `Plugin "${pluginName}" is already installed.` };
        }

        const registry = await fetchRegistry();
        if (!registry || !Array.isArray(registry.plugins)) {
            return { success: false, message: 'Could not fetch plugin registry.' };
        }

        const entry = registry.plugins.find(p => p.name === pluginName);
        if (!entry) {
            return { success: false, message: `Plugin "${pluginName}" not found in registry.` };
        }

        const downloadUrl = entry.downloadUrl || `https://github.com/${PLUGIN_REPO}/raw/main/plugins/${pluginName}.zip`;
        const zipPath = path.join(os.tmpdir(), `wos_plugin_${pluginName}.zip`);
        const extractDir = path.join(os.tmpdir(), `wos_plugin_${pluginName}_extract`);

        console.log(`[PLUGINS] Downloading ${pluginName}...`);
        const downloaded = await downloadFile(downloadUrl, zipPath);
        if (!downloaded) {
            return { success: false, message: `Failed to download plugin "${pluginName}".` };
        }

        if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
        fs.mkdirSync(extractDir, { recursive: true });

        const { binPath: sevenZipPath, cleanupPath: sevenZipCleanup } = await acquire7z(os.tmpdir());
        if (!sevenZipPath) {
            if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
            if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
            return { success: false, message: 'Could not locate 7-Zip binary for extraction.' };
        }

        try {
            execSync(`"${sevenZipPath}" x "${zipPath}" -o"${extractDir}" -y`, { stdio: 'pipe' });
        } catch (e) {
            if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
            if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
            return { success: false, message: `Failed to extract plugin: ${e.message}` };
        } finally {
            if (sevenZipCleanup && fs.existsSync(sevenZipCleanup)) {
                try { fs.unlinkSync(sevenZipCleanup); } catch { /* best-effort cleanup */ }
            }
        }

        let pluginRoot = extractDir;
        const extracted = fs.readdirSync(extractDir);
        if (extracted.length === 1 && fs.statSync(path.join(extractDir, extracted[0])).isDirectory()) {
            pluginRoot = path.join(extractDir, extracted[0]);
        }

        if (!fs.existsSync(path.join(pluginRoot, 'plugin.json'))) {
            fs.rmSync(extractDir, { recursive: true, force: true });
            if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
            return { success: false, message: `Plugin "${pluginName}" archive is missing plugin.json.` };
        }

        const destDir = path.join(PLUGINS_DIR, pluginName);
        if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true });
        if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });

        copyDirRecursive(pluginRoot, destDir);

        fs.rmSync(extractDir, { recursive: true, force: true });
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

        const pluginPkgPath = path.join(destDir, 'package.json');
        if (fs.existsSync(pluginPkgPath)) {
            console.log(`[PLUGINS] Installing dependencies for ${pluginName}...`);
            try {
                execSync('npm install --omit=optional --production', { cwd: destDir, stdio: 'pipe' });
            } catch (e) {
                console.warn(`[PLUGINS] Warning: dependency install for ${pluginName} failed: ${e.message}`);
            }
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
    const registry = await fetchRegistry();
    if (!registry || !Array.isArray(registry.plugins)) {
        return { updates: [], error: 'Could not fetch plugin registry.' };
    }

    const updates = [];

    for (const [name, pluginData] of loadedPlugins) {
        const registryEntry = registry.plugins.find(p => p.name === name);
        if (!registryEntry || !registryEntry.version) continue;

        if (compareVersions(registryEntry.version, pluginData.version) > 0) {
            updates.push({
                name,
                current: pluginData.version,
                latest: registryEntry.version
            });
        }
    }

    return { updates };
}

/**
 * Updates a specific plugin to the latest version from the registry
 * @param {string} pluginName - Plugin name to update
 * @param {Object} registrar - Register/unregister functions
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function updatePlugin(pluginName, registrar) {
    const { unloadPlugin } = require('./pluginDelete');

    unloadPlugin(pluginName, registrar);

    const pluginDir = path.join(PLUGINS_DIR, pluginName);
    if (fs.existsSync(pluginDir)) {
        fs.rmSync(pluginDir, { recursive: true, force: true });
    }

    loadedPlugins.delete(pluginName);
    return await installPlugin(pluginName, registrar);
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
