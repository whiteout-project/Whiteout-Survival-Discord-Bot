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

let autoUpdateInterval = null;
let lastNotifiedVersion = null;

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

        // Check for updates
        let updateInfo = null;
        if (typeof global.checkForUpdates === 'function') {
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

            // Add update button
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
        if (typeof global.applyUpdate !== 'function') {
            await interaction.followUp({
                content: settingsLang.errors.notAvailable,
                ephemeral: true
            });
            return;
        }

        const result = await global.applyUpdate();

        if (result.success) {
            const hasParentWrapper = process.env.FULL_SELF_UPDATE === '1';

            // Show appropriate success message
            const successText = hasParentWrapper
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

            if (hasParentWrapper) {
                // Parent wrapper available — save message ref for post-restart update
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
        const resultContainer = new ContainerBuilder()
            .setAccentColor(color)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${settingsLang.content.title}\n${result.message}`
                )
            )
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

        const resultContent = updateComponentsV2AfterSeparator(interaction, [resultContainer]);
        await interaction.editReply({
            components: resultContent,
            flags: MessageFlags.IsComponentsV2
        });

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
            if (typeof global.checkForUpdates !== 'function') return;

            const updateInfo = await global.checkForUpdates();
            if (!updateInfo?.available) return;

            const settings = settingsQueries.getSettings.get();
            const isAutoUpdateEnabled = settings?.auto_update ?? 1;

            if (!isAutoUpdateEnabled) {
                if (updateInfo.latest === lastNotifiedVersion) return;
                lastNotifiedVersion = updateInfo.latest;
                console.log(`[AUTO-UPDATE] New version v${updateInfo.latest} available — notifying owner (auto-apply disabled)`);
                await notifyOwnerOfUpdate(client, updateInfo.latest, false, updateInfo.body, updateInfo.assets);
                return;
            }

            console.log(`[AUTO-UPDATE] New version v${updateInfo.latest} found — notifying owner and applying update...`);
            await notifyOwnerOfUpdate(client, updateInfo.latest, true, updateInfo.body, updateInfo.assets);

            if (typeof global.applyUpdate !== 'function') return;

            const result = await global.applyUpdate();
            if (!result.success) {
                console.error('[AUTO-UPDATE] Update failed:', result.message);
                return;
            }

            console.log('[AUTO-UPDATE] Update applied successfully — restarting bot...');

            if (typeof global.restartBot === 'function') {
                await global.restartBot();
            } else {
                process.exit(0);
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
