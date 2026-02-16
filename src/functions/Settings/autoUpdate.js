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
const { getAdminLang, sendError, assertUserMatches, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getComponentEmoji, getEmojiMapForAdmin } = require('../utility/emojis');
const { container } = require('googleapis/build/src/apis/container');

/**
 * Creates an auto-update button for the settings panel
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The auto-update button
 */
function createAutoUpdateButton(userId, lang) {
    return new ButtonBuilder()
        .setCustomId(`auto_update_check_${userId}`)
        .setLabel(lang.settings.mainPage.buttons.autoUpdate)
        .setStyle(ButtonStyle.Primary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1033'));
}

/**
 * Handles the auto-update check button interaction
 * Shows current version and checks for updates from GitHub
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleAutoUpdateCheck(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
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
                .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1004'));

            components.push(new ActionRowBuilder().addComponents(applyButton));
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
        await sendError(interaction, lang, error, 'handleAutoUpdateCheck');
    }
}

/**
 * Handles the apply update button interaction
 * Pulls latest changes from GitHub, installs dependencies only if package.json changed, and restarts
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleAutoUpdateApply(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
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

        const content = updateComponentsV2AfterSeparator(interaction, [updatingContainer]);

        await interaction.editReply({
            components: content,
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
            // Show success and restart
            const successText =
                `${settingsLang.content.title}\n` +
                `${settingsLang.content.success}`;

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

            // Restart the bot after a short delay
            setTimeout(async () => {
                if (typeof global.restartBot === 'function') {
                    await global.restartBot();
                }
            }, 2000);
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
        await sendError(interaction, lang, error, 'handleAutoUpdateApply');
    }
}

module.exports = {
    createAutoUpdateButton,
    handleAutoUpdateCheck,
    handleAutoUpdateApply
};
