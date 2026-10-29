const fs = require('fs');
const path = require('path');
const https = require('https');
const {
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MediaGalleryBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ActionRowBuilder,
    escapeMarkdown
} = require('discord.js');
const { settingsQueries, adminQueries } = require('../utility/database');
const { validateManifest } = require('../Plugin/pluginsLoader');
const { getUserInfo, handleError, assertUserMatches, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getComponentEmoji, getEmojiMapForUser, replaceEmojiPlaceholders } = require('../utility/emojis');
const {
    acquireUpdateLock,
    releaseUpdateLock,
    formatActiveUpdateMessage
} = require('./updateCoordinator');

const PENDING_UPDATE_PATH = path.join(__dirname, '..', '..', 'database', 'pending_update.json');
const AUTO_UPDATE_INTERVAL_MS = 5 * 60 * 1000;
const UPDATE_CHECK_PROXY_URL = process.env.UPDATE_CHECK_PROXY_URL || 'https://wosland.com/api/updates/latest';
const PLUGIN_UPDATE_PROXY_URL = process.env.PLUGIN_UPDATE_CHECK_PROXY_URL
    || new URL('/api/updates/plugins', UPDATE_CHECK_PROXY_URL).toString();

let autoUpdateInterval = null;
let lastNotifiedVersion = null;
/** Tracks which plugin versions have already triggered a notification to avoid DM spam */
const lastNotifiedPluginVersions = new Map();

const MAX_TEXT_BLOCK_CHARS = 3500;
const MAX_MEDIA_ITEMS_PER_GALLERY = 4;
const MAX_BLOCKS_PER_MESSAGE = 8;
const MAX_MESSAGES_PER_RELEASE_DM = 5;
const MAX_MESSAGE_TEXT_CHARS = 5500;
const MARKDOWN_IMAGE_LINE_REGEX = /^\s*!\[([^\]]*)\]\((https:\/\/[^\s)]+)\)\s*$/i;

function requestJson(url, { method = 'GET', timeoutMs = 5000, headers = {}, body = null } = {}) {
    return new Promise((resolve) => {
        try {
            const parsedUrl = new URL(url);
            const httpModule = parsedUrl.protocol === 'http:' ? require('http') : require('https');
            const req = httpModule.request(parsedUrl, { method, headers }, (res) => {
                let responseBody = '';
                res.on('data', chunk => responseBody += chunk);
                res.on('end', () => {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        resolve(null);
                        return;
                    }

                    try {
                        resolve(JSON.parse(responseBody));
                    } catch {
                        resolve(null);
                    }
                });
            });

            req.on('error', () => resolve(null));
            req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
            if (body) req.write(body);
            req.end();
        } catch {
            resolve(null);
        }
    });
}

function getInstalledPluginVersions() {
    if (typeof global.pluginManager?.getInstalled !== 'function') return [];

    return global.pluginManager.getInstalled()
        .filter(plugin => plugin?.name && plugin?.version && !plugin.thirdParty)
        .map(plugin => ({
            name: plugin.name,
            version: plugin.version
        }));
}

async function checkPluginUpdatesViaProxy() {
    const installedPlugins = getInstalledPluginVersions();
    if (installedPlugins.length === 0) {
        return { updates: [] };
    }

    const payload = await requestJson(PLUGIN_UPDATE_PROXY_URL, {
        method: 'POST',
        timeoutMs: 5000,
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'WhiteoutSurvivalBot'
        },
        body: JSON.stringify({ plugins: installedPlugins })
    });

    if (payload && Array.isArray(payload.updates)) {
        return {
            updates: payload.updates.filter(
                update =>
                    installedPlugins.some(plugin => plugin.name === update.name) &&
                    validateManifest({ name: update.name, version: update.latest, engines: update.engines }, 'registry')
                        .valid
            )
        };
    }

    if (typeof global.pluginManager?.checkUpdates === 'function') {
        return global.pluginManager.checkUpdates();
    }

    return { updates: [], error: 'Could not check plugin updates.' };
}

function savePendingUpdateReference(payload) {
    try {
        fs.mkdirSync(path.dirname(PENDING_UPDATE_PATH), { recursive: true });
        fs.writeFileSync(PENDING_UPDATE_PATH, JSON.stringify(payload));
    } catch (error) {
        console.error('Failed to save pending update reference:', error.message);
    }
}

/**
 * Checks whether the Docker socket is available for self-hosted Docker updates.
 * @returns {boolean}
 */
function hasDockerSocket() {
    const dockerSelfUpdate = require('./dockerSelfUpdate');
    return dockerSelfUpdate.hasDockerSocket();
}

/**
 * Checks for a Docker image update by comparing the running container's
 * image ID against the latest pulled image ID.
 * @returns {Promise<{available: boolean, current: string|null, latest: string|null}>}
 */
async function checkDockerUpdate() {
    const dockerSelfUpdate = require('./dockerSelfUpdate');
    const botContainer = process.env.BOT_CONTAINER || 'woslandjs';
    const botImage = process.env.BOT_IMAGE || 'ghcr.io/whiteout-project/whiteout-survival-discord-bot';

    return dockerSelfUpdate.checkDockerUpdate({
        targetContainer: botContainer,
        targetImage: botImage
    });
}

/**
 * Pulls the latest image and schedules an external helper container to
 * replace this bot container. The helper is required because this process
 * cannot stop its own container and then continue recreating it.
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function applyDockerUpdate() {
    const { scheduleDockerUpdate } = require('./dockerSelfUpdate');
    const botContainer = process.env.BOT_CONTAINER || 'woslandjs';
    const botImage = process.env.BOT_IMAGE || 'ghcr.io/whiteout-project/whiteout-survival-discord-bot';

    return scheduleDockerUpdate({
        targetContainer: botContainer,
        targetImage: botImage
    });
}

/**
 * Creates an auto-update button for the settings panel
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The auto-update button
 */
function createAutoUpdateButton(userId, lang) {
    return new ButtonBuilder()
        .setCustomId(`auto_update_page_${userId}`)
        .setLabel(lang.settings.mainPage.buttons.autoUpdate)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1033'));
}

/**
 * Shows the Update page with [Check for Updates] [Auto Update toggle] [Back] buttons
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleAutoUpdatePage(interaction) {
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

        const settings = settingsQueries.getSettings.get();
        const isAutoUpdateEnabled = settings?.auto_update ?? 1;
        const settingsLang = lang.settings.autoUpdate || {};
        const emojiMap = getEmojiMapForUser(interaction.user.id);

        const currentVersion = typeof global.getLocalVersion === 'function'
            ? global.getLocalVersion()
            : '?.?.?';

        const checkButton = new ButtonBuilder()
            .setCustomId(`auto_update_check_${interaction.user.id}`)
            .setLabel(settingsLang.buttons.checkUpdates)
            .setStyle(ButtonStyle.Primary)
            .setEmoji(getComponentEmoji(emojiMap, '1033'));

        const toggleButton = new ButtonBuilder()
            .setCustomId(`auto_update_toggle_${interaction.user.id}`)
            .setLabel(isAutoUpdateEnabled ? settingsLang.buttons.autoUpdateOn : settingsLang.buttons.autoUpdateOff)
            .setStyle(isAutoUpdateEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(emojiMap, '1004'));

        const container = new ContainerBuilder()
            .setAccentColor(0x3498db)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${settingsLang.content.title}\n` +
                    `${settingsLang.content.currentVersion.replace('{currentVersion}', currentVersion)}\n`
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(
                new ActionRowBuilder().addComponents(
                    checkButton,
                    toggleButton
                )
            );

        const content = updateComponentsV2AfterSeparator(interaction, [container]);

        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ components: content, flags: MessageFlags.IsComponentsV2 });
        } else {
            await interaction.update({ components: content, flags: MessageFlags.IsComponentsV2 });
        }
    } catch (error) {
        await handleError(interaction, lang, error, 'handleAutoUpdatePage');
    }
}

/**
 * Toggles auto-update on/off in database and refreshes the update page
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleToggleAutoUpdate(interaction) {
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

        const settings = settingsQueries.getSettings.get();
        const currentValue = settings?.auto_update ?? 1;
        const newValue = currentValue ? 0 : 1;

        settingsQueries.updateAutoUpdate.run(newValue);

        // Restart or stop the auto-update scheduler based on new value
        if (newValue && interaction.client) {
            startAutoUpdateScheduler(interaction.client);
        }

        // Re-render the update page with toggled state
        // Reuse handleAutoUpdatePage by faking the customId format it expects
        const originalCustomId = interaction.customId;
        interaction.customId = `auto_update_page_${interaction.user.id}`;
        await handleAutoUpdatePage(interaction);
        interaction.customId = originalCustomId;
    } catch (error) {
        await handleError(interaction, lang, error, 'handleToggleAutoUpdate');
    }
}

/**
 * Handles the auto-update check button interaction
 * Shows current version and checks for updates from GitHub
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleAutoUpdateCheck(interaction) {
    const { adminData, lang, userLang } = getUserInfo(interaction.user.id);
    try {
        // Extract user ID from custom ID: auto_update_check_userId
        const expectedUserId = interaction.customId.split('_')[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Only owner can use auto-update
        if (!adminData || !adminData.is_owner) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Defer the reply since update check may take a moment
        await interaction.deferUpdate();

        // Get current version
        const currentVersion = typeof global.getLocalVersion === 'function'
            ? global.getLocalVersion()
            : '?.?.?';

        // Check for updates -- use Docker Engine API or GitHub API
        let updateInfo = null;
        if (hasDockerSocket()) {
            try {
                const status = await checkDockerUpdate();
                updateInfo = {
                    available: status.available,
                    latest: status.latest || currentVersion
                };
            } catch (error) {
                console.error('[AUTO-UPDATE] Docker update check failed:', error.message);
            }
        } else if (typeof global.checkForUpdates === 'function') {
            updateInfo = await global.checkForUpdates();
        }

        const settingsLang = lang.settings.autoUpdate || {};
        let statusText = '';
        const components = [];

        if (!updateInfo) {
            // Could not check for updates
            statusText =
                `${settingsLang.content.title}\n` +
                `${settingsLang.content.description.checkFailed}\n` +
                `${settingsLang.content.currentVersion.replace('{currentVersion}', currentVersion)}\n`;
        } else if (!updateInfo.available) {
            // Already up to date
            statusText =
                `${settingsLang.content.title}\n` +
                `${settingsLang.content.description.upToDate}\n` +
                `${settingsLang.content.currentVersion.replace('{currentVersion}', currentVersion)}\n\n`;
        } else {
            // Update available
            statusText =
                `${settingsLang.content.title}\n` +
                `${settingsLang.content.description.updateAvailable}\n` +
                `${settingsLang.content.currentVersion.replace('{currentVersion}', currentVersion)}\n` +
                `${settingsLang.content.latestVersion.replace('{latestVersion}', updateInfo.latest)}\n`;

            const applyButton = new ButtonBuilder()
                .setCustomId(`auto_update_apply_${interaction.user.id}`)
                .setLabel(settingsLang.buttons.applyUpdate)
                .setStyle(ButtonStyle.Success)
                .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1004'));

            components.push(new ActionRowBuilder().addComponents(applyButton));
        }

        // Check for plugin updates
        let pluginUpdates = [];
        const pluginResult = await checkPluginUpdatesViaProxy();
        if (pluginResult && pluginResult.updates.length > 0) {
            pluginUpdates = pluginResult.updates;
            statusText += settingsLang.pluginUpdates.title;
            for (const pu of pluginUpdates) {
                statusText += settingsLang.pluginUpdates.item
                    .replace('{name}', pu.name)
                    .replace('{current}', pu.current)
                    .replace('{latest}', pu.latest);
                const assets = getPluginReleaseAssets(pu);
                const notes = assets.find(asset => asset.name === `release_${userLang}.md`) || assets.find(asset => asset.name === 'release_en.md');
                if (notes) statusText += `  [${settingsLang.pluginUpdates.releaseNotes}](${notes.url})\n`;
            }

            // Add update buttons for each plugin (max 5 per row)
            const pluginRow = new ActionRowBuilder();
            for (const pu of pluginUpdates.slice(0, 5)) {
                pluginRow.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`auto_update_plugin_${pu.name}_${interaction.user.id}`)
                        .setLabel(settingsLang.pluginUpdates.button.replace('{name}', pu.name))
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1033'))
                );
            }
            components.push(pluginRow);
        }

        // Build the container
        const containerBuilder = new ContainerBuilder()
            .setAccentColor(updateInfo?.available ? 0x2ecc71 : 0x3498db)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(statusText)
            );
        if (components.length > 0) {
            containerBuilder.addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            );
        }
        for (const row of components) {
            containerBuilder.addActionRowComponents(row);
        }

        const content = updateComponentsV2AfterSeparator(interaction, [containerBuilder]);

        await interaction.editReply({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handleAutoUpdateCheck');
    }
}

/**
 * Handles the apply update button interaction
 * Pulls latest changes from GitHub, installs dependencies only if package.json changed, and restarts
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleAutoUpdateApply(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        // Extract user ID from custom ID: auto_update_apply_userId
        const expectedUserId = interaction.customId.split('_')[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Only owner can apply updates
        if (!adminData || !adminData.is_owner) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const settingsLang = lang.settings?.autoUpdate || {};
        const updateLock = acquireUpdateLock('settings bot update');
        if (!updateLock.acquired) {
            return await interaction.reply({
                content: formatActiveUpdateMessage(updateLock.active),
                ephemeral: true
            });
        }

        let keepLock = false;

        // Defer the reply since update will take time
        await interaction.deferUpdate();

        // Show updating status
        const updatingText =
            `${settingsLang.content.title}\n` +
            `${settingsLang.content.description.applying}`;

        const updatingContainer = new ContainerBuilder()
            .setAccentColor(0xffa500) // orange
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(updatingText)
            );

        const updatingContent = updateComponentsV2AfterSeparator(interaction, [updatingContainer]);

        await interaction.editReply({
            components: updatingContent,
            flags: MessageFlags.IsComponentsV2
        });

        // Apply the update
        let result;
        if (hasDockerSocket()) {
            // Docker mode: pull new image, stop this container, recreate with new image
            try {
                // Show success message before Docker kills this container
                const successText = `${settingsLang.content.title}\n${settingsLang.content.success}`;

                const successContainer = new ContainerBuilder()
                    .setAccentColor(0x2ecc71)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(successText)
                    );

                const successContent = updateComponentsV2AfterSeparator(interaction, [successContainer]);

                await interaction.editReply({
                    components: successContent,
                    flags: MessageFlags.IsComponentsV2
                });

                savePendingUpdateReference({
                    channelId: interaction.channelId,
                    messageId: interaction.message.id,
                    userId: interaction.user.id
                });

                // Pull + recreate -- this will kill this container
                result = await applyDockerUpdate();
                if (!result.success) {
                    throw new Error(result.message || 'Docker update failed');
                }
                // If we reach here, the container is about to be replaced
                keepLock = true;
                return;
            } catch (error) {
                // Show failure if Docker update failed
                const failText =
                    `${settingsLang.content.title}\n` +
                    `${settingsLang.content.failed}\n` +
                    `${error.message}`;

                const failContainer = new ContainerBuilder()
                    .setAccentColor(0xff0000)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(failText)
                    );

                const failContent = updateComponentsV2AfterSeparator(interaction, [failContainer]);

                await interaction.editReply({
                    components: failContent,
                    flags: MessageFlags.IsComponentsV2
                });
                return;
            }
        }

        if (typeof global.applyUpdate !== 'function') {
            await interaction.followUp({
                content: settingsLang.errors.notAvailable,
                ephemeral: true
            });
            return;
        }

        result = await global.applyUpdate();

        if (result.success) {
            const hasParentWrapper = process.env.FULL_SELF_UPDATE === '1';

            // Show appropriate success message
            const isAutoRestart = hasParentWrapper;
            const successText = isAutoRestart
                ? `${settingsLang.content.title}\n${settingsLang.content.success}`
                : `${settingsLang.content.title}\n${settingsLang.content.description.stopping}`;

            const successContainer = new ContainerBuilder()
                .setAccentColor(0x2ecc71) // green
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(successText)
                );

            const successContent = updateComponentsV2AfterSeparator(interaction, [successContainer]);

            await interaction.editReply({
                components: successContent,
                flags: MessageFlags.IsComponentsV2
            });

            if (result.restartHandled) {
                keepLock = true;
                savePendingUpdateReference({
                    channelId: interaction.channelId,
                    messageId: interaction.message.id,
                    userId: interaction.user.id
                });
                return;
            }

            if (hasParentWrapper) {
                keepLock = true;
                savePendingUpdateReference({
                    channelId: interaction.channelId,
                    messageId: interaction.message.id,
                    userId: interaction.user.id
                });

                // Restart the bot after a short delay
                setTimeout(async () => {
                    if (typeof global.restartBot === 'function') {
                        await global.restartBot();
                    }
                }, 2000);
            } else {
                // No parent wrapper — DM the owner and stop the bot
                const currentVersion = typeof global.getLocalVersion === 'function'
                    ? global.getLocalVersion()
                    : '?.?.?';

                try {
                    const owner = await interaction.client.users.fetch(interaction.user.id);
                    const dmText = settingsLang.content.dmManualRestart
                        .replace('{version}', currentVersion);
                    await owner.send(dmText);
                } catch (dmError) {
                    console.error('Failed to DM owner about manual restart:', dmError.message);
                }

                setTimeout(() => process.exit(0), 2000);
            }
        } else {
            // Show failure
            const failText =
                `${settingsLang.content.title}\n` +
                `${settingsLang.content.failed}\n` +
                `${result.message}`;

            const failContainer = new ContainerBuilder()
                .setAccentColor(0xff0000) // red
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(failText)
                );

            const failContent = updateComponentsV2AfterSeparator(interaction, [failContainer]);

            await interaction.editReply({
                components: failContent,
                flags: MessageFlags.IsComponentsV2
            });
        }

    } catch (error) {
        await handleError(interaction, lang, error, 'handleAutoUpdateApply');
    } finally {
        if (typeof keepLock !== 'undefined' && !keepLock && typeof updateLock?.token !== 'undefined') {
            releaseUpdateLock(updateLock.token);
        }
    }
}

/**
 * Handles updating a single plugin via the auto-update panel button
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleAutoUpdatePlugin(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        // customId: auto_update_plugin_{pluginName}_{userId}
        const parts = interaction.customId.split('_');
        const pluginName = parts[3];
        const expectedUserId = parts[4];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!adminData || !adminData.is_owner) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const settingsLang = lang.settings?.autoUpdate || {};
        const updateLock = acquireUpdateLock(`plugin update: ${pluginName}`);
        if (!updateLock.acquired) {
            return await interaction.reply({
                content: formatActiveUpdateMessage(updateLock.active),
                ephemeral: true
            });
        }

        let keepLock = false;
        await interaction.deferUpdate();

        // Show updating status
        const updatingContainer = new ContainerBuilder()
            .setAccentColor(0xffa500)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${settingsLang.content.title}\n${settingsLang.pluginUpdates.updating.replace('{name}', pluginName)}`
                )
            );

        const updatingPluginContent = updateComponentsV2AfterSeparator(interaction, [updatingContainer]);
        await interaction.editReply({
            components: updatingPluginContent,
            flags: MessageFlags.IsComponentsV2
        });

        const result = await global.pluginManager.update(pluginName);

        const color = result.success ? 0x2ecc71 : 0xff0000;
        const resultMessage = result.success
            ? `${result.message}\n-# The bot is restarting to apply the update...`
            : result.message;

        const resultContainer = new ContainerBuilder()
            .setAccentColor(color)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${settingsLang.content.title}\n${resultMessage}`
                )
            );

        if (!result.success) {
            resultContainer
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                )
                .addActionRowComponents(
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`auto_update_check_${interaction.user.id}`)
                            .setLabel(settingsLang.buttons.back)
                            .setStyle(ButtonStyle.Secondary)
                    )
                );
        }

        const resultContent = updateComponentsV2AfterSeparator(interaction, [resultContainer]);
        await interaction.editReply({
            components: resultContent,
            flags: MessageFlags.IsComponentsV2
        });

        if (result.success && typeof global.restartBot === 'function') {
            keepLock = true;
            setTimeout(() => global.restartBot(), 2000);
        }

    } catch (error) {
        await handleError(interaction, lang, error, 'handleAutoUpdatePlugin');
    } finally {
        if (typeof keepLock !== 'undefined' && !keepLock && typeof updateLock?.token !== 'undefined') {
            releaseUpdateLock(updateLock.token);
        }
    }
}

/**
 * Checks for a pending update message and edits it to show restart completion.
 * Called from the ready event after all systems are initialized.
 * @param {import('discord.js').Client} client
 */
async function handlePostUpdateRestart(client) {
    if (!fs.existsSync(PENDING_UPDATE_PATH)) return;

    let pending;
    try {
        pending = JSON.parse(fs.readFileSync(PENDING_UPDATE_PATH, 'utf8'));
    } catch {
        fs.unlinkSync(PENDING_UPDATE_PATH);
        return;
    }

    // Always clean up the file, even if editing fails
    fs.unlinkSync(PENDING_UPDATE_PATH);

    const { channelId, messageId, userId } = pending;
    if (!channelId || !messageId || !userId) return;

    try {
        const { lang } = getUserInfo(userId);
        const settingsLang = lang.settings?.autoUpdate || {};

        const currentVersion = typeof global.getLocalVersion === 'function'
            ? global.getLocalVersion()
            : '?.?.?';

        const completeText =
            `${settingsLang.content.title}\n` +
            `${settingsLang.content.restartComplete.replace('{version}', currentVersion)}`;

        const container = new ContainerBuilder()
            .setAccentColor(0x2ecc71)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(completeText)
            );

        const channel = await client.channels.fetch(channelId);
        if (!channel) return;

        const message = await channel.messages.fetch(messageId);
        if (!message) return;

        await message.edit({
            components: [container],
            flags: MessageFlags.IsComponentsV2
        });
    } catch (error) {
        console.error('Failed to update post-restart message:', error.message);
    }
}

/**
 * Finds the bot owner's user ID from the admins table
 * @returns {string|null} Owner user ID or null if not found
 */
function findOwnerUserId() {
    const admins = adminQueries.getAllAdmins();
    const owner = admins.find(a => a.is_owner);
    return owner?.user_id ?? null;
}

/**
 * Downloads a release asset's text content via HTTPS
 * @param {string} url - The browser_download_url of the asset
 * @returns {Promise<string|null>} The text content, or null on failure
 */
function downloadAssetContent(url, expected = {}, remainingRedirects = 5) {
    const https = require('https');
    return new Promise((resolve) => {
        let deadline;
        const finish = value => { clearTimeout(deadline); resolve(value); };
        let target;
        try {
            target = new URL(url);
            if (target.protocol !== 'https:' || target.username || target.password || target.port ||
                !(target.hostname === 'github.com' || target.hostname.endsWith('.githubusercontent.com'))) return finish(null);
        } catch { return finish(null); }
        const req = https.get(target, { headers: { 'User-Agent': 'WhiteoutSurvivalBot' } }, (res) => {
            res.on('error', () => finish(null));
            res.on('aborted', () => finish(null));
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (!remainingRedirects) return finish(null);
                let next;
                try { next = new URL(res.headers.location, target).href; } catch { return finish(null); }
                return downloadAssetContent(next, expected, remainingRedirects - 1).then(finish, () => finish(null));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return finish(null);
            }
            const chunks = [];
            let size = 0;
            res.on('data', chunk => {
                size += chunk.length;
                if (size > Math.min(expected.size || 2 * 1024 * 1024, 2 * 1024 * 1024)) { finish(null); req.destroy(); }
                else chunks.push(chunk);
            });
            res.on('end', () => {
                const body = Buffer.concat(chunks);
                if ((expected.size && body.length !== expected.size) ||
                    (expected.sha256 && require('crypto').createHash('sha256').update(body).digest('hex') !== expected.sha256)) return finish(null);
                finish(body.toString('utf8').trim() || null);
            });
        });
        req.on('error', () => finish(null));
        req.setTimeout(5000, () => { finish(null); req.destroy(); });
        deadline = setTimeout(() => { finish(null); req.destroy(); }, 10000);
    });
}

function getPluginReleaseAssets(update) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(update?.name || '') || !/^\d+\.\d+\.\d+$/.test(update?.latest || '')) return [];
    const assets = [];
    for (const [language, note] of Object.entries(update.releaseNotes || {}).slice(0, 10)) {
        if (!/^[a-z]{2}$/.test(language) || !note || typeof note.url !== 'string' || note.url.length > 2048 ||
            !Number.isSafeInteger(note.size) || note.size < 1 || note.size > 64 * 1024 ||
            !/^[a-f0-9]{64}$/.test(note.sha256 || '')) continue;
        try {
            const url = new URL(note.url);
            const prefix = '/whiteout-project/wosJS-plugins/releases/download/';
            const parts = url.pathname.slice(prefix.length).split('/');
            if (url.origin !== 'https://github.com' || !url.pathname.startsWith(prefix) || parts.length !== 2 || !parts[0] ||
                parts[1] !== `${update.name}-v${update.latest}-release_${language}.md` || url.username || url.password || url.search || url.hash) continue;
            assets.push({ name: `release_${language}.md`, url: note.url, size: note.size, sha256: note.sha256 });
        } catch { /* Missing or invalid notes do not block plugin updates. */ }
    }
    return assets;
}

function isValidHttpsImageUrl(value) {
    try {
        const parsedUrl = new URL(value);
        return parsedUrl.protocol === 'https:';
    } catch {
        return false;
    }
}

function splitLongText(text, maxChars = MAX_TEXT_BLOCK_CHARS) {
    const normalizedText = String(text || '').trim();
    if (!normalizedText) return [];
    if (normalizedText.length <= maxChars) return [normalizedText];

    const chunks = [];
    const paragraphs = normalizedText.split(/\n{2,}/);
    let currentChunk = '';

    const pushChunk = () => {
        const trimmed = currentChunk.trim();
        if (trimmed) chunks.push(trimmed);
        currentChunk = '';
    };

    const appendParagraph = (paragraph) => {
        const candidate = currentChunk ? `${currentChunk}\n\n${paragraph}` : paragraph;
        if (candidate.length <= maxChars) {
            currentChunk = candidate;
            return;
        }

        if (currentChunk) pushChunk();

        if (paragraph.length <= maxChars) {
            currentChunk = paragraph;
            return;
        }

        let remainder = paragraph;
        while (remainder.length > maxChars) {
            let splitIndex = remainder.lastIndexOf('\n', maxChars);
            if (splitIndex <= 0) splitIndex = remainder.lastIndexOf(' ', maxChars);
            if (splitIndex <= 0) splitIndex = maxChars;

            const piece = remainder.slice(0, splitIndex).trim();
            if (piece) chunks.push(piece);
            remainder = remainder.slice(splitIndex).trimStart();
        }

        currentChunk = remainder;
    };

    for (const paragraph of paragraphs) {
        const trimmedParagraph = paragraph.trim();
        if (!trimmedParagraph) continue;
        appendParagraph(trimmedParagraph);
    }

    pushChunk();
    return chunks;
}

function flushPendingMediaBlocks(blocks, pendingImages) {
    if (!pendingImages.length) return;

    for (let index = 0; index < pendingImages.length; index += MAX_MEDIA_ITEMS_PER_GALLERY) {
        blocks.push({
            type: 'media',
            items: pendingImages.slice(index, index + MAX_MEDIA_ITEMS_PER_GALLERY)
        });
    }

    pendingImages.length = 0;
}

function flushPendingTextBlocks(blocks, pendingLines) {
    if (!pendingLines.length) return;

    const text = pendingLines.join('\n').trim();
    pendingLines.length = 0;
    if (!text) return;

    for (const chunk of splitLongText(text)) {
        blocks.push({ type: 'text', text: chunk });
    }
}

function parseReleaseMarkdown(markdown) {
    const blocks = [];
    const pendingLines = [];
    const pendingImages = [];
    const normalizedMarkdown = String(markdown || '').replace(/\r\n/g, '\n');

    for (const line of normalizedMarkdown.split('\n')) {
        const match = line.match(MARKDOWN_IMAGE_LINE_REGEX);
        const imageUrl = match?.[2];

        if (imageUrl && isValidHttpsImageUrl(imageUrl)) {
            flushPendingTextBlocks(blocks, pendingLines);
            pendingImages.push({
                description: (match[1] || '').trim(),
                url: imageUrl
            });
            continue;
        }

        flushPendingMediaBlocks(blocks, pendingImages);
        pendingLines.push(line);
    }

    flushPendingTextBlocks(blocks, pendingLines);
    flushPendingMediaBlocks(blocks, pendingImages);
    return blocks;
}

/**
 * Resolves localized release content from assets, falling back to release body
 * @param {Array<{name: string, url: string}>} assets - Release assets
 * @param {string} languageCode - Owner's language code (e.g., 'en', 'fr')
 * @param {string} fallbackBody - Default release body from GitHub
 * @returns {Promise<Array<{type: 'text', text: string} | {type: 'media', items: Array<{description: string, url: string}>}>>}
 */
async function resolveLocalizedReleaseBlocks(assets, languageCode, fallbackBody) {
    let sourceText = fallbackBody || '';

    if (assets?.length) {
        for (const language of [...new Set([languageCode, 'en'])]) {
            const assetPatterns = [`release_${language}.md`, `release_${language}.txt`];
            const matchedAsset = assets.find(a => assetPatterns.includes(a.name.toLowerCase()));
            if (!matchedAsset?.url) continue;
            try {
                const content = await downloadAssetContent(matchedAsset.url, matchedAsset);
                if (content) { sourceText = content; break; }
            } catch { /* A failed notes download must not suppress an update notice. */ }
        }
    }

    return parseReleaseMarkdown(sourceText);
}

function getReleaseContinuationHeading(languageCode) {
    return languageCode === 'fr'
        ? '## Notes de mise a jour (suite)'
        : '## Release notes continued';
}

function getReleaseOverflowNote(languageCode, releaseUrl) {
    if (languageCode === 'fr') {
        return releaseUrl
            ? `Notes completes : ${releaseUrl}`
            : 'Les notes completes sont disponibles sur GitHub.';
    }

    return releaseUrl
        ? `Full release notes: ${releaseUrl}`
        : 'Full release notes are available on GitHub.';
}

function estimateBlockTextLength(block) {
    if (block.type === 'text') return block.text.length;
    if (block.type === 'media') {
        return block.items.reduce((total, item) => total + (item.description?.length || 0), 0);
    }
    return 0;
}

function appendOverflowNote(messages, noteText) {
    if (!messages.length || !noteText) return;

    const overflowBlock = { type: 'text', text: noteText };
    const lastMessage = messages[messages.length - 1];

    while (
        lastMessage.blocks.length > 0 &&
        (lastMessage.blocks.length >= MAX_BLOCKS_PER_MESSAGE ||
            (lastMessage.textChars + noteText.length) > MAX_MESSAGE_TEXT_CHARS)
    ) {
        const removedBlock = lastMessage.blocks.pop();
        lastMessage.textChars -= estimateBlockTextLength(removedBlock);
    }

    if (
        lastMessage.blocks.length < MAX_BLOCKS_PER_MESSAGE &&
        (lastMessage.textChars + noteText.length) <= MAX_MESSAGE_TEXT_CHARS
    ) {
        lastMessage.blocks.push(overflowBlock);
        lastMessage.textChars += noteText.length;
    }
}

function buildReleaseDmMessages({
    titleText,
    versionText,
    subtextText,
    blocks,
    languageCode,
    releaseUrl
}) {
    const messages = [];
    const firstMessageBaseChars = titleText.length + versionText.length + subtextText.length;
    const continuationHeading = getReleaseContinuationHeading(languageCode);
    const continuationBaseChars = continuationHeading.length;
    const fallbackNote = getReleaseOverflowNote(languageCode, releaseUrl);

    let currentMessage = {
        continuation: false,
        blocks: [],
        textChars: firstMessageBaseChars
    };

    const pushCurrentMessage = () => {
        messages.push(currentMessage);
    };

    for (const block of blocks) {
        const blockCharLength = estimateBlockTextLength(block);
        const exceedsCurrentMessage =
            currentMessage.blocks.length >= MAX_BLOCKS_PER_MESSAGE ||
            (currentMessage.textChars + blockCharLength) > MAX_MESSAGE_TEXT_CHARS;

        if (exceedsCurrentMessage) {
            pushCurrentMessage();

            if (messages.length >= MAX_MESSAGES_PER_RELEASE_DM) {
                appendOverflowNote(messages, fallbackNote);
                return messages;
            }

            currentMessage = {
                continuation: true,
                blocks: [],
                textChars: continuationBaseChars
            };
        }

        currentMessage.blocks.push(block);
        currentMessage.textChars += blockCharLength;
    }

    if (!messages.length || currentMessage.blocks.length > 0) {
        pushCurrentMessage();
    }

    return messages.slice(0, MAX_MESSAGES_PER_RELEASE_DM);
}

function buildReleaseDmContainer(message, {
    titleText,
    versionText,
    subtextText,
    languageCode
}) {
    const container = new ContainerBuilder();

    if (message.continuation) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(getReleaseContinuationHeading(languageCode))
        );
    } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
        if (versionText) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(versionText));
    }

    if (message.blocks.length > 0) {
        container.addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
        );
    }

    for (const block of message.blocks) {
        if (block.type === 'text') {
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(block.text)
            );
            continue;
        }

        if (block.type === 'media' && block.items.length > 0) {
            container.addMediaGalleryComponents(
                new MediaGalleryBuilder({
                    items: block.items.map(item => ({
                        description: item.description || undefined,
                        media: { url: item.url }
                    }))
                })
            );
        }
    }

    if (!message.continuation && subtextText) {
        container.addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
        );
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(subtextText)
        );
    }

    return container;
}

/**
 * Sends a Components V2 container DM to the bot owner about an available update
 * @param {import('discord.js').Client} client
 * @param {string} latestVersion - The new version available
 * @param {boolean} willAutoApply - Whether the update will be auto-applied
 * @param {string} [releaseBody] - Default GitHub release body (fallback)
 * @param {Array<{name: string, url: string}>} [assets] - Release assets for localized descriptions
 * @param {string} [releaseUrl] - GitHub release URL
 */
async function notifyOwnerOfUpdate(client, latestVersion, willAutoApply, releaseBody, assets, releaseUrl) {
    const ownerId = findOwnerUserId();
    if (!ownerId) return;

    try {
        const owner = await client.users.fetch(ownerId);
        const { lang, userLang } = getUserInfo(ownerId);
        const emojiMap = getEmojiMapForUser(ownerId);
        const dmLang = lang.settings?.autoUpdate?.dm || {};

        const currentVersion = typeof global.getLocalVersion === 'function'
            ? global.getLocalVersion()
            : '?.?.?';

        const releaseBlocks = await resolveLocalizedReleaseBlocks(assets || [], userLang, releaseBody || '');

        const replacePlaceholders = (text) => replaceEmojiPlaceholders(
            text
                .replace('{latestVersion}', latestVersion)
                .replace('{currentVersion}', currentVersion),
            emojiMap
        );

        const title = willAutoApply ? dmLang.title : dmLang.titleNotify;
        const subtext = willAutoApply ? dmLang.autoApply : dmLang.notifyOnly;
        if (!title) return;

        const titleText = replacePlaceholders(title);
        const versionText = replacePlaceholders(dmLang.version || '');
        const subtextText = replacePlaceholders(subtext || '');
        const messages = buildReleaseDmMessages({
            titleText,
            versionText,
            subtextText,
            blocks: releaseBlocks,
            languageCode: userLang,
            releaseUrl
        });

        for (let index = 0; index < messages.length; index += 1) {
            const container = buildReleaseDmContainer(messages[index], {
                titleText,
                versionText,
                subtextText,
                languageCode: userLang
            });

            const flags = index === 0
                ? MessageFlags.IsComponentsV2
                : (MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications);

            try {
                await owner.send({ components: [container], flags });
            } catch (error) {
                console.error(`[AUTO-UPDATE] Failed to DM owner chunk ${index + 1}:`, error.message);
                break;
            }
        }
    } catch (error) {
        console.error('[AUTO-UPDATE] Failed to DM owner:', error.message);
    }
}

/**
 * Sends a DM to the owner listing plugin updates.
 * @param {import('discord.js').Client} client
 * @param {{ name: string, current: string, latest: string }[]} updates
 * @param {boolean} willAutoApply
 */
async function notifyOwnerOfPluginUpdates(client, updates, willAutoApply) {
    const ownerId = findOwnerUserId();
    if (!ownerId) return;

    try {
        const owner = await client.users.fetch(ownerId);
        const { lang, userLang } = getUserInfo(ownerId);
        const emojiMap = getEmojiMapForUser(ownerId);
        const dmLang = lang.settings?.autoUpdate?.dm || {};

        const title = willAutoApply ? (dmLang.pluginTitle || '## Plugin Updates Applied!') : (dmLang.pluginTitleNotify || '## Plugin Updates Available!');
        const subtext = willAutoApply ? (dmLang.pluginApplied || '') : (dmLang.pluginNotifyOnly || '');
        const itemTemplate = dmLang.pluginItem || '- **{name}**: v{current} → v{latest}';

        const versionText = updates.map(update => itemTemplate
            .replace('{name}', escapeMarkdown(update.name))
            .replace('{current}', update.current)
            .replace('{latest}', update.latest)).join('\n');
        const blocks = [];
        for (const update of updates) {
            const notes = await resolveLocalizedReleaseBlocks(getPluginReleaseAssets(update), userLang, '');
            if (notes.length) {
                blocks.push({ type: 'text', text: `### ${escapeMarkdown(update.name)} v${update.latest}` });
                blocks.push(...notes);
            }
        }
        const titleText = replaceEmojiPlaceholders(title, emojiMap);
        const subtextText = replaceEmojiPlaceholders(subtext, emojiMap);
        const releaseUrl = 'https://github.com/whiteout-project/wosJS-plugins/releases';
        const messages = buildReleaseDmMessages({ titleText, versionText, subtextText, blocks, languageCode: userLang, releaseUrl });
        for (let index = 0; index < messages.length; index++) {
            const container = buildReleaseDmContainer(messages[index], { titleText, versionText, subtextText, languageCode: userLang });
            await owner.send({ components: [container], allowedMentions: { parse: [] }, flags: MessageFlags.IsComponentsV2 | (index ? MessageFlags.SuppressNotifications : 0) });
        }
    } catch (error) {
        console.error('[AUTO-UPDATE] Failed to DM owner about plugin updates:', error.message);
    }
}

/**
 * Starts the auto-update scheduler that checks for updates every 5 minutes.
 * Always runs regardless of auto_update setting.
 * - If auto_update = 1: DMs owner, then applies update and restarts
 * - If auto_update = 0: DMs owner about available update without applying
 * @param {import('discord.js').Client} client
 */
function startAutoUpdateScheduler(client) {
    stopAutoUpdateScheduler();

    autoUpdateInterval = setInterval(async () => {
        let keepLock = false;
        let updateLock = null;
        try {
            // ── 1. Check bot update availability ──────────────────────────
            let botUpdateAvailable = false;
            let latestVersion = null;
            let releaseBody = null;
            let releaseAssets = null;
            let releaseUrl = null;

            if (hasDockerSocket()) {
                try {
                    const status = await checkDockerUpdate();
                    botUpdateAvailable = status.available;
                    latestVersion = status.latest;
                } catch (error) {
                    console.error('[AUTO-UPDATE] Docker update check failed:', error.message);
                    // Continue to plugin check even if Docker check fails
                }
            } else {
                if (typeof global.checkForUpdates === 'function') {
                    const updateInfo = await global.checkForUpdates();
                    if (updateInfo?.available) {
                        botUpdateAvailable = true;
                        latestVersion = updateInfo.latest;
                        releaseBody = updateInfo.body;
                        releaseAssets = updateInfo.assets;
                        releaseUrl = updateInfo.url;
                    }
                }
            }

            // ── 2. Check plugin update availability ───────────────────────
            const { updates: pluginUpdates = [] } = await checkPluginUpdatesViaProxy();
            const newPluginUpdates = pluginUpdates.filter(pu => lastNotifiedPluginVersions.get(pu.name) !== pu.latest);

            const hasBotUpdate = botUpdateAvailable && latestVersion;
            const hasPluginUpdates = newPluginUpdates.length > 0;
            if (!hasBotUpdate && !hasPluginUpdates) return;

            const settings = settingsQueries.getSettings.get();
            const isAutoUpdateEnabled = settings?.auto_update ?? 1;

            // ── 3. Notify-only mode ───────────────────────────────────────
            if (!isAutoUpdateEnabled) {
                if (hasBotUpdate && latestVersion !== lastNotifiedVersion) {
                    lastNotifiedVersion = latestVersion;
                    console.log(`[AUTO-UPDATE] New version v${latestVersion} available -- notifying owner (auto-apply disabled)`);
                    await notifyOwnerOfUpdate(client, latestVersion, false, releaseBody, releaseAssets, releaseUrl);
                }
                if (hasPluginUpdates) {
                    for (const pu of newPluginUpdates) lastNotifiedPluginVersions.set(pu.name, pu.latest);
                    console.log(`[AUTO-UPDATE] Plugin updates available: ${newPluginUpdates.map(p => p.name).join(', ')} -- notifying owner`);
                    await notifyOwnerOfPluginUpdates(client, newPluginUpdates, false);
                }
                return;
            }

            // ── 4. Auto-apply mode: plugins first, then bot update ────────

            updateLock = acquireUpdateLock('scheduled auto-update');
            if (!updateLock.acquired) {
                console.log(`[AUTO-UPDATE] ${formatActiveUpdateMessage(updateLock.active)}`);
                return;
            }

            // Apply available plugin updates before any restart
            let pluginsUpdated = false;
            const appliedUpdates = [];
            if (hasPluginUpdates) {
                for (const pu of newPluginUpdates) {
                    const result = await global.pluginManager.update(pu.name);
                    if (result.success) {
                        lastNotifiedPluginVersions.set(pu.name, pu.latest);
                        appliedUpdates.push(pu);
                        pluginsUpdated = true;
                        console.log(`[AUTO-UPDATE] Plugin ${pu.name} updated to v${pu.latest}`);
                    } else {
                        console.error(`[AUTO-UPDATE] Plugin ${pu.name} update failed: ${result.message}`);
                    }
                }
                // Notify owner about applied plugin updates
                if (appliedUpdates.length > 0) {
                    await notifyOwnerOfPluginUpdates(client, appliedUpdates, true);
                }
            }

            // Apply bot update (includes restart — plugin files are already updated on disk)
            if (hasBotUpdate && latestVersion !== lastNotifiedVersion) {
                lastNotifiedVersion = latestVersion;
                console.log(`[AUTO-UPDATE] New version v${latestVersion} found -- notifying and applying...`);
                await notifyOwnerOfUpdate(client, latestVersion, true, releaseBody, releaseAssets, releaseUrl);

                if (hasDockerSocket()) {
                    try {
                        const result = await applyDockerUpdate();
                        if (!result.success) {
                            console.error('[AUTO-UPDATE] Docker update failed:', result.message);
                            return;
                        }
                        keepLock = true;
                    } catch (error) {
                        console.error('[AUTO-UPDATE] Docker update failed:', error.message);
                    }
                    return;
                }

                if (typeof global.applyUpdate !== 'function') return;

                const result = await global.applyUpdate();
                if (!result.success) {
                    console.error('[AUTO-UPDATE] Update failed:', result.message);
                    return;
                }

                if (result.restartHandled) {
                    console.log('[AUTO-UPDATE] Update applied successfully -- restart already scheduled...');
                    keepLock = true;
                    return;
                }

                console.log('[AUTO-UPDATE] Update applied successfully -- restarting bot...');
                if (typeof global.restartBot === 'function') {
                    keepLock = true;
                    await global.restartBot();
                } else {
                    process.exit(0);
                }
                return;
            }

            // No bot update — restart only if plugins were updated
            if (pluginsUpdated) {
                console.log('[AUTO-UPDATE] Plugin updates applied -- restarting bot...');
                if (typeof global.restartBot === 'function') {
                    keepLock = true;
                    await global.restartBot();
                } else {
                    process.exit(0);
                }
            }
        } catch (error) {
            console.error('[AUTO-UPDATE] Scheduler error:', error.message);
        } finally {
            if (!keepLock && updateLock?.acquired && updateLock.token) {
                releaseUpdateLock(updateLock.token);
            }
        }
    }, AUTO_UPDATE_INTERVAL_MS);
}

/**
 * Stops the auto-update scheduler
 */
function stopAutoUpdateScheduler() {
    if (autoUpdateInterval) {
        clearInterval(autoUpdateInterval);
        autoUpdateInterval = null;
    }
}

/**
 * Handles the auto-update back button — returns to the Advanced category page
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleAutoUpdateBack(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const { createAdvancedCategory } = require('./settings');
        const components = createAdvancedCategory(interaction.user.id, adminData, lang);
        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleAutoUpdateBack');
    }
}

module.exports = {
    createAutoUpdateButton,
    handleAutoUpdatePage,
    handleAutoUpdateCheck,
    handleAutoUpdateApply,
    handleAutoUpdatePlugin,
    handleToggleAutoUpdate,
    handleAutoUpdateBack,
    handlePostUpdateRestart,
    startAutoUpdateScheduler,
    stopAutoUpdateScheduler
};
