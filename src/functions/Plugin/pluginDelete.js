const fs = require('fs');
const path = require('path');
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
const { PLUGINS_DIR, loadedPlugins } = require('./pluginsLoader');
const i18n = require('../../i18n');

const ITEMS_PER_PAGE = 5;

/**
 * Builds the delete section container with paginated plugin sections
 * @param {Object} params
 * @returns {Array} Array of components for the section
 */
function buildDeleteSection({ userId, pluginLang, lang, installed, page }) {
    const totalPages = Math.max(1, Math.ceil(installed.length / ITEMS_PER_PAGE));
    const currentPage = Math.min(page, totalPages - 1);
    const emojiMap = getEmojiMapForUser(userId);

    const container = new ContainerBuilder()
        .setAccentColor(0xe74c3c)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                installed.length === 0
                    ? pluginLang.content.noInstalled
                    : `**${pluginLang.content.installed.replace('{count}', String(installed.length))}**` +
                      (totalPages > 1
                          ? `\n${lang.pagination.text.pageInfo
                                .replace('{current}', String(currentPage + 1))
                                .replace('{total}', String(totalPages))}`
                          : '')
            )
        );

    if (installed.length > 0) {
        container.addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        );

        const pagePlugins = installed.slice(currentPage * ITEMS_PER_PAGE, (currentPage + 1) * ITEMS_PER_PAGE);

        pagePlugins.forEach((plugin, index) => {
            const removeButton = new ButtonBuilder()
                .setCustomId(`plugins_remove_${plugin.name}_${userId}`)
                .setLabel(pluginLang.buttons.remove)
                .setStyle(ButtonStyle.Danger)
                .setEmoji(getComponentEmoji(emojiMap, '1046'));

            const section = new SectionBuilder()
                .setButtonAccessory(removeButton)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `**${plugin.name}** \`v${plugin.version || '?'}\`\n${plugin.description || '—'}`
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
        feature: 'plugins_delete',
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
 * Handles the delete menu — shows installed plugins as a section below the main container
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {number} [page=0] - Page number (0-indexed)
 */
async function handlePluginsDeleteMenu(interaction, page = 0) {
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

        const pluginLang = lang.plugins;
        const userId = interaction.user.id;

        const installed = typeof global.pluginManager?.getInstalled === 'function'
            ? global.pluginManager.getInstalled()
            : [];

        const sectionComponents = buildDeleteSection({
            userId, pluginLang, lang, installed, page
        });

        const components = updateComponentsV2AfterSeparator(interaction, sectionComponents);

        await interaction.update({
            components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handlePluginsDeleteMenu');
    }
}

/**
 * Handles pagination for the delete section
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handlePluginsDeletePagination(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        // customId: plugins_delete_prev_{userId}_{currentPage} or plugins_delete_next_{userId}_{currentPage}
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

        const pluginLang = lang.plugins;
        const userId = interaction.user.id;

        const installed = typeof global.pluginManager?.getInstalled === 'function'
            ? global.pluginManager.getInstalled()
            : [];

        const newPage = direction === 'next' ? currentPage + 1 : currentPage - 1;

        const sectionComponents = buildDeleteSection({
            userId, pluginLang, lang, installed, page: newPage
        });

        const components = updateComponentsV2AfterSeparator(interaction, sectionComponents);

        await interaction.update({
            components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handlePluginsDeletePagination');
    }
}

/**
 * Handles removing a plugin via section button click
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handlePluginRemove(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        // customId: plugins_remove_{pluginName}_{userId}
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

        // Remove the plugin
        const result = global.pluginManager.remove(pluginName);

        const resultText = result.success
            ? pluginLang.content.removeSuccess.replace('{name}', pluginName)
            : pluginLang.content.removeFailed
                .replace('{name}', pluginName)
                .replace('{error}', result.message);
        const color = result.success ? 0x2ecc71 : 0xff0000;

        const resultContainer = new ContainerBuilder()
            .setAccentColor(color)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(resultText)
            );

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
        await handleError(interaction, lang, error, 'handlePluginRemove');
    }
}

// ============================================================
// PLUGIN UNLOAD / REMOVE LOGIC
// ============================================================

/**
 * Unloads a plugin by name — removes its commands, events, and handlers
 * @param {string} pluginName - Name of the plugin to unload
 * @param {Object} registrar - Object with unregister functions
 * @returns {boolean} True if plugin was found and unloaded
 */
function unloadPlugin(pluginName, registrar) {
    const pluginData = loadedPlugins.get(pluginName);
    if (!pluginData) return false;

    for (const filePath of pluginData.commands) {
        try {
            registrar.unregisterCommand(filePath);
            delete require.cache[require.resolve(filePath)];
        } catch (error) {
            console.warn(`[PLUGINS] Failed to unregister command ${filePath}:`, error.message);
        }
    }

    for (const filePath of pluginData.events) {
        try {
            registrar.unregisterEvent(filePath);
            delete require.cache[require.resolve(filePath)];
        } catch (error) {
            console.warn(`[PLUGINS] Failed to unregister event ${filePath}:`, error.message);
        }
    }

    for (const filePath of pluginData.handlers) {
        try {
            registrar.unregisterHandler(filePath);
            delete require.cache[require.resolve(filePath)];
        } catch (error) {
            console.warn(`[PLUGINS] Failed to unregister handler ${filePath}:`, error.message);
        }
    }

    i18n.removePluginLocales(pluginName);

    loadedPlugins.delete(pluginName);
    console.log(`[PLUGINS] Unloaded: ${pluginName}`);
    return true;
}

/**
 * Removes a plugin by name — unloads and deletes its files
 * @param {string} pluginName - Name of the plugin
 * @param {Object} registrar - Unregister functions from index.js
 * @returns {{ success: boolean, message: string }}
 */
function removePlugin(pluginName, registrar) {
    try {
        const pluginDir = path.join(PLUGINS_DIR, pluginName);

        unloadPlugin(pluginName, registrar);

        if (fs.existsSync(pluginDir)) {
            fs.rmSync(pluginDir, { recursive: true, force: true });
        }

        console.log(`[PLUGINS] Removed: ${pluginName}`);
        return { success: true, message: `Plugin "${pluginName}" removed successfully.` };
    } catch (error) {
        return { success: false, message: `Remove failed: ${error.message}` };
    }
}

module.exports = {
    unloadPlugin,
    removePlugin,
    handlePluginsDeleteMenu,
    handlePluginsDeletePagination,
    handlePluginRemove
};
