const fs = require('fs');
const path = require('path');
const {
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ActionRowBuilder
} = require('discord.js');
const { settingsQueries, adminQueries } = require('../utility/database');
const { getUserInfo, handleError, assertUserMatches, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getComponentEmoji, getEmojiMapForUser, replaceEmojiPlaceholders } = require('../utility/emojis');

const PENDING_UPDATE_PATH = path.join(__dirname, '..', '..', 'temp', 'pending_update.json');
const AUTO_UPDATE_INTERVAL_MS = 5 * 60 * 1000;
const DOCKER_SOCKET = '/var/run/docker.sock';

let autoUpdateInterval = null;
let lastNotifiedVersion = null;
/** Tracks which plugin versions have already triggered a notification to avoid DM spam */
const lastNotifiedPluginVersions = new Map();

// -------------------------------------------------------
// Docker Engine API (direct Unix socket communication)
// -------------------------------------------------------

/**
 * Checks whether the Docker socket is available for self-hosted Docker updates.
 * @returns {boolean}
 */
function hasDockerSocket() {
    return global.isDocker && fs.existsSync(DOCKER_SOCKET);
}

/**
 * Makes an HTTP request to the Docker Engine API via Unix socket.
 * @param {string} method - HTTP method
 * @param {string} apiPath - API path (e.g. /containers/json)
 * @param {object|null} body - JSON body for POST/PUT
 * @returns {Promise<{statusCode: number, data: any}>}
 */
function dockerApi(method, apiPath, body = null) {
    const httpModule = require('http');
    return new Promise((resolve, reject) => {
        const options = {
            socketPath: DOCKER_SOCKET,
            path: apiPath,
            method,
            headers: {},
            timeout: 30000
        };

        if (body) {
            const bodyStr = JSON.stringify(body);
            options.headers['Content-Type'] = 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }

        const req = httpModule.request(options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString();
                let data;
                try { data = JSON.parse(raw); } catch { data = raw; }
                resolve({ statusCode: res.statusCode, data });
            });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Docker API timeout')); });
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

/**
 * Pulls an image via Docker Engine API (consumes the streaming response).
 * @param {string} image - Image name without tag
 * @param {string} tag - Image tag
 * @returns {Promise<boolean>}
 */
function pullDockerImage(image, tag = 'latest') {
    const httpModule = require('http');
    return new Promise((resolve, reject) => {
        const encodedImage = encodeURIComponent(image);
        const encodedTag = encodeURIComponent(tag);

        const req = httpModule.request({
            socketPath: DOCKER_SOCKET,
            path: `/images/create?fromImage=${encodedImage}&tag=${encodedTag}`,
            method: 'POST',
            timeout: 120000
        }, (res) => {
            res.on('data', () => {});
            res.on('end', () => {
                if (res.statusCode === 200) resolve(true);
                else reject(new Error(`Image pull failed with HTTP ${res.statusCode}`));
            });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Image pull timeout')); });
        req.end();
    });
}

/**
 * Checks for a Docker image update by comparing the running container's
 * image ID against the latest pulled image ID.
 * @returns {Promise<{available: boolean, current: string|null, latest: string|null}>}
 */
async function checkDockerUpdate() {
    const botContainer = process.env.BOT_CONTAINER || 'woslandjs';
    const botImage = process.env.BOT_IMAGE || 'ghcr.io/whiteout-project/whiteout-survival-discord-bot';

    const { statusCode: cStatus, data: cData } = await dockerApi('GET', `/containers/${botContainer}/json`);
    if (cStatus !== 200) throw new Error(`Cannot inspect container: HTTP ${cStatus}`);

    const currentImageId = cData.Image;
    const currentVersion = cData.Config?.Labels?.['org.opencontainers.image.version'] || null;

    await pullDockerImage(botImage, 'latest');

    const encodedRef = encodeURIComponent(`${botImage}:latest`);
    const { statusCode: iStatus, data: iData } = await dockerApi('GET', `/images/${encodedRef}/json`);
    if (iStatus !== 200) throw new Error(`Cannot inspect image: HTTP ${iStatus}`);

    const latestImageId = iData.Id;
    const latestVersion = iData.Config?.Labels?.['org.opencontainers.image.version'] || null;

    return {
        available: currentImageId !== null && latestImageId !== null && currentImageId !== latestImageId,
        current: currentVersion,
        latest: latestVersion || currentVersion
    };
}

/**
 * Pulls the latest image, stops the old container, and recreates it
 * with the same configuration but the new image.
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function applyDockerUpdate() {
    const botContainer = process.env.BOT_CONTAINER || 'woslandjs';
    const botImage = process.env.BOT_IMAGE || 'ghcr.io/whiteout-project/whiteout-survival-discord-bot';

    console.log('[AUTO-UPDATE] Pulling latest Docker image...');
    await pullDockerImage(botImage, 'latest');

    console.log('[AUTO-UPDATE] Inspecting current container...');
    const { statusCode: inspectStatus, data: containerInfo } = await dockerApi('GET', `/containers/${botContainer}/json`);
    if (inspectStatus !== 200) throw new Error(`Failed to inspect container: HTTP ${inspectStatus}`);

    console.log('[AUTO-UPDATE] Stopping bot container...');
    const { statusCode: stopStatus } = await dockerApi('POST', `/containers/${botContainer}/stop`);
    if (stopStatus !== 204 && stopStatus !== 304) throw new Error(`Failed to stop container: HTTP ${stopStatus}`);

    console.log('[AUTO-UPDATE] Removing old container...');
    const { statusCode: rmStatus } = await dockerApi('DELETE', `/containers/${botContainer}`);
    if (rmStatus !== 204) throw new Error(`Failed to remove container: HTTP ${rmStatus}`);

    const createBody = {
        ...containerInfo.Config,
        Image: `${botImage}:latest`,
        HostConfig: containerInfo.HostConfig,
        NetworkingConfig: { EndpointsConfig: {} }
    };

    for (const [networkName, networkConfig] of Object.entries(containerInfo.NetworkSettings?.Networks || {})) {
        createBody.NetworkingConfig.EndpointsConfig[networkName] = {
            IPAMConfig: networkConfig.IPAMConfig,
            Aliases: networkConfig.Aliases
        };
    }

    console.log('[AUTO-UPDATE] Creating updated container...');
    const { statusCode: createStatus, data: createData } = await dockerApi('POST', `/containers/create?name=${botContainer}`, createBody);
    if (createStatus !== 201) throw new Error(`Failed to create container: HTTP ${createStatus} - ${JSON.stringify(createData)}`);

    console.log('[AUTO-UPDATE] Starting updated container...');
    const { statusCode: startStatus } = await dockerApi('POST', `/containers/${createData.Id}/start`);
    if (startStatus !== 204 && startStatus !== 304) throw new Error(`Failed to start container: HTTP ${startStatus}`);

    console.log('[AUTO-UPDATE] Bot container updated and started.');
    return { success: true, message: 'Update applied successfully.' };
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
    const { adminData, lang } = getUserInfo(interaction.user.id);
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
        if (typeof global.pluginManager?.checkUpdates === 'function') {
            const pluginResult = await global.pluginManager.checkUpdates();
            if (pluginResult && pluginResult.updates.length > 0) {
                pluginUpdates = pluginResult.updates;
                statusText += settingsLang.pluginUpdates.title;
                for (const pu of pluginUpdates) {
                    statusText += settingsLang.pluginUpdates.item
                        .replace('{name}', pu.name)
                        .replace('{current}', pu.current)
                        .replace('{latest}', pu.latest);
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

                // Save pending update reference for post-restart message
                try {
                    fs.writeFileSync(PENDING_UPDATE_PATH, JSON.stringify({
                        channelId: interaction.channelId,
                        messageId: interaction.message.id,
                        userId: interaction.user.id
                    }));
                } catch (writeError) {
                    console.error('Failed to save pending update reference:', writeError.message);
                }

                // Pull + recreate -- this will kill this container
                result = await applyDockerUpdate();
                if (!result.success) {
                    throw new Error(result.message || 'Docker update failed');
                }
                // If we reach here, the container is about to be replaced
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
            const isAutoRestart = hasParentWrapper || global.isDocker;
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

            if (hasParentWrapper || global.isDocker) {
                // Parent wrapper or Docker -- save message ref for post-restart update
                try {
                    fs.writeFileSync(PENDING_UPDATE_PATH, JSON.stringify({
                        channelId: interaction.channelId,
                        messageId: interaction.message.id,
                        userId: interaction.user.id
                    }));
                } catch (writeError) {
                    console.error('Failed to save pending update reference:', writeError.message);
                }

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
            setTimeout(() => global.restartBot(), 2000);
        }

    } catch (error) {
        await handleError(interaction, lang, error, 'handleAutoUpdatePlugin');
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
function downloadAssetContent(url) {
    const https = require('https');
    return new Promise((resolve) => {
        const req = https.get(url, { headers: { 'User-Agent': 'WhiteoutSurvivalBot' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadAssetContent(res.headers.location).then(resolve);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return resolve(null);
            }
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(body.trim() || null));
        });
        req.on('error', () => resolve(null));
        req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    });
}

/**
 * Resolves localized release description from assets, falling back to release body
 * @param {Array<{name: string, url: string}>} assets - Release assets
 * @param {string} languageCode - Owner's language code (e.g., 'en', 'fr')
 * @param {string} fallbackBody - Default release body from GitHub
 * @returns {Promise<string>} The resolved description
 */
async function resolveLocalizedDescription(assets, languageCode, fallbackBody) {
    if (!assets?.length) return fallbackBody;

    const assetPatterns = [`release_${languageCode}.md`, `release_${languageCode}.txt`];
    const matchedAsset = assets.find(a => assetPatterns.includes(a.name.toLowerCase()));

    if (matchedAsset?.url) {
        const content = await downloadAssetContent(matchedAsset.url);
        if (content) return content;
    }

    return fallbackBody;
}

/**
 * Sends a Components V2 container DM to the bot owner about an available update
 * @param {import('discord.js').Client} client
 * @param {string} latestVersion - The new version available
 * @param {boolean} willAutoApply - Whether the update will be auto-applied
 * @param {string} [releaseBody] - Default GitHub release body (fallback)
 * @param {Array<{name: string, url: string}>} [assets] - Release assets for localized descriptions
 */
async function notifyOwnerOfUpdate(client, latestVersion, willAutoApply, releaseBody, assets) {
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

        const description = await resolveLocalizedDescription(assets || [], userLang, releaseBody || '');

        const replacePlaceholders = (text) => replaceEmojiPlaceholders(
            text
                .replace('{latestVersion}', latestVersion)
                .replace('{currentVersion}', currentVersion),
            emojiMap
        );

        const title = willAutoApply ? dmLang.title : dmLang.titleNotify;
        const subtext = willAutoApply ? dmLang.autoApply : dmLang.notifyOnly;
        if (!title) return;

        const container = new ContainerBuilder();
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(replacePlaceholders(title)));
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(replacePlaceholders(dmLang.version || '')));

        if (description) {
            container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(description));
        }

        if (subtext) {
            container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(replacePlaceholders(subtext)));
        }

        await owner.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
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
        const { lang } = getUserInfo(ownerId);
        const emojiMap = getEmojiMapForUser(ownerId);
        const dmLang = lang.settings?.autoUpdate?.dm || {};

        const title = willAutoApply ? (dmLang.pluginTitle || '## Plugin Updates Applied!') : (dmLang.pluginTitleNotify || '## Plugin Updates Available!');
        const subtext = willAutoApply ? (dmLang.pluginApplied || '') : (dmLang.pluginNotifyOnly || '');
        const itemTemplate = dmLang.pluginItem || '- **{name}**: v{current} → v{latest}';

        const listText = updates
            .map(u => itemTemplate.replace('{name}', u.name).replace('{current}', u.current).replace('{latest}', u.latest))
            .join('\n');

        const container = new ContainerBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(replaceEmojiPlaceholders(title, emojiMap)))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(listText));

        if (subtext) {
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(subtext));
        }

        await owner.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
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
        try {
            // ── 1. Check bot update availability ──────────────────────────
            let botUpdateAvailable = false;
            let latestVersion = null;
            let releaseBody = null;
            let releaseAssets = null;

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
                    }
                }
            }

            // ── 2. Check plugin update availability ───────────────────────
            let newPluginUpdates = [];
            if (typeof global.pluginManager?.checkUpdates === 'function') {
                const { updates: pluginUpdates = [] } = await global.pluginManager.checkUpdates();
                newPluginUpdates = pluginUpdates.filter(pu => lastNotifiedPluginVersions.get(pu.name) !== pu.latest);
            }

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
                    await notifyOwnerOfUpdate(client, latestVersion, false, releaseBody, releaseAssets);
                }
                if (hasPluginUpdates) {
                    for (const pu of newPluginUpdates) lastNotifiedPluginVersions.set(pu.name, pu.latest);
                    console.log(`[AUTO-UPDATE] Plugin updates available: ${newPluginUpdates.map(p => p.name).join(', ')} -- notifying owner`);
                    await notifyOwnerOfPluginUpdates(client, newPluginUpdates, false);
                }
                return;
            }

            // ── 4. Auto-apply mode: plugins first, then bot update ────────

            // Apply available plugin updates before any restart
            let pluginsUpdated = false;
            if (hasPluginUpdates) {
                for (const pu of newPluginUpdates) {
                    lastNotifiedPluginVersions.set(pu.name, pu.latest);
                    const result = await global.pluginManager.update(pu.name);
                    if (result.success) {
                        pluginsUpdated = true;
                        console.log(`[AUTO-UPDATE] Plugin ${pu.name} updated to v${pu.latest}`);
                    } else {
                        console.error(`[AUTO-UPDATE] Plugin ${pu.name} update failed: ${result.message}`);
                    }
                }
                // Notify owner about applied plugin updates
                const appliedUpdates = newPluginUpdates.filter(pu => lastNotifiedPluginVersions.get(pu.name) === pu.latest);
                if (appliedUpdates.length > 0) {
                    await notifyOwnerOfPluginUpdates(client, appliedUpdates, true);
                }
            }

            // Apply bot update (includes restart — plugin files are already updated on disk)
            if (hasBotUpdate && latestVersion !== lastNotifiedVersion) {
                lastNotifiedVersion = latestVersion;
                console.log(`[AUTO-UPDATE] New version v${latestVersion} found -- notifying and applying...`);
                await notifyOwnerOfUpdate(client, latestVersion, true, releaseBody, releaseAssets);

                if (hasDockerSocket()) {
                    try {
                        const result = await applyDockerUpdate();
                        if (!result.success) {
                            console.error('[AUTO-UPDATE] Docker update failed:', result.message);
                        }
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

                console.log('[AUTO-UPDATE] Update applied successfully -- restarting bot...');
                if (typeof global.restartBot === 'function') {
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
                    await global.restartBot();
                } else {
                    process.exit(0);
                }
            }
        } catch (error) {
            console.error('[AUTO-UPDATE] Scheduler error:', error.message);
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
