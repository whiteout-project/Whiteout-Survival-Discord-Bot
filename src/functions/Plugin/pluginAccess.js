const {
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ActionRowBuilder,
    escapeMarkdown
} = require('discord.js');
const { getUserInfo, handleError, assertUserMatches } = require('../utility/commonFunctions');
const { createBackToPluginsButton, createPluginsComponents } = require('./plugins');
const { loadedPlugins } = require('./pluginsLoader');
const { createUniversalPaginationButtons } = require('../Pagination/universalPagination');

/**
 * Gets the slash command names registered by a plugin
 * @param {Object} pluginData - Plugin data from loadedPlugins
 * @returns {string[]} Array of command names
 */
function getPluginCommandNames(pluginData) {
    const commandNames = [];
    for (const filePath of pluginData.commands) {
        try {
            const command = require(filePath);
            if (command?.data?.name) {
                commandNames.push(command.data.name);
            }
        } catch {
            // Command file may have been removed
        }
    }
    return commandNames;
}

/**
 * Handles the access menu — shows installed plugins with details
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handlePluginsAccessMenu(interaction) {
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
        const parts = interaction.customId.split('_');
        const requestedPage = Number(parts[4]) + (parts[2] === 'next' ? 1 : -1);
        const totalPages = Math.max(1, Math.ceil(loadedPlugins.size / 5));
        const currentPage = Number.isFinite(requestedPage) ? Math.max(0, Math.min(totalPages - 1, requestedPage)) : 0;

        const container = new ContainerBuilder()
            .setAccentColor(0x3498db);
        const components = createPluginsComponents(interaction, lang, [container]);
        const mainLength = components[0].toJSON().components.reduce((length, component) => length + (component.content?.length || 0), 0);

        if (loadedPlugins.size === 0) {
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(pluginLang.content.noInstalled || 'No plugins installed.')
            );
        } else {
            const heading = `**${(pluginLang.content.installed || 'Installed Plugins')
                .replace('{count}', String(loadedPlugins.size))}**`;
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(heading));

            container.addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            );

            const plugins = Array.from(loadedPlugins.values()).slice(currentPage * 5, (currentPage + 1) * 5);
            const itemLimit = Math.floor((4000 - mainLength - heading.length) / plugins.length);
            plugins.forEach((plugin, index) => {
                const commandNames = getPluginCommandNames(plugin);
                const commandMentions = commandNames.map(name => {
                    const commandId = interaction.client.commandIds?.get(name);
                    return commandId ? `</${name}:${commandId}>` : `\`/${name}\``;
                });

                let content = `- **${escapeMarkdown(String(plugin.name).slice(0, 64))}**\n` +
                    `  - \`v${escapeMarkdown(String(plugin.version).slice(0, 64))}\``;
                if (plugin.thirdParty) content += `\n  - ${pluginLang.upload.thirdParty}`;
                content += `\n  - ${escapeMarkdown(String(plugin.description || '—').slice(0, 220))}`;

                const visibleCommands = [];
                let remaining = Math.min(300, itemLimit - content.length - 5);
                for (const mention of commandMentions) {
                    if (mention.length > remaining) break;
                    visibleCommands.push(mention);
                    remaining -= mention.length + 2;
                }
                if (visibleCommands.length) content += `\n  - ${visibleCommands.join(', ')}`;

                container.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(content.slice(0, itemLimit))
                );

                if (index < plugins.length - 1) {
                    container.addSeparatorComponents(
                        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false)
                    );
                }
            });
        }

        container.addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        );

        container.addActionRowComponents(
            new ActionRowBuilder().addComponents(
                createBackToPluginsButton(userId, pluginLang)
            )
        );
        const pagination = createUniversalPaginationButtons({ feature: 'plugins_access', userId, currentPage, totalPages, lang });
        if (pagination) container.addActionRowComponents(pagination);

        await interaction.update({
            components,
            attachments: [],
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: { parse: [] }
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handlePluginsAccessMenu');
    }
}

module.exports = {
    handlePluginsAccessMenu
};
