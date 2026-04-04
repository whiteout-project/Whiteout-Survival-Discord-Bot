const {
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ActionRowBuilder
} = require('discord.js');
const { getUserInfo, handleError, assertUserMatches } = require('../utility/commonFunctions');
const { createBackToPluginsButton } = require('./plugins');
const { loadedPlugins } = require('./pluginsLoader');

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

        const container = new ContainerBuilder()
            .setAccentColor(0x3498db);

        if (loadedPlugins.size === 0) {
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(pluginLang.content.noInstalled || 'No plugins installed.')
            );
        } else {
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`**${pluginLang.content.installed || 'Installed Plugins'}**`)
            );

            container.addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            );

            const plugins = Array.from(loadedPlugins.values());
            plugins.forEach((plugin, index) => {
                const commandNames = getPluginCommandNames(plugin);
                const commandMentions = commandNames.map(name => {
                    const commandId = interaction.client.commandIds?.get(name);
                    return commandId ? `</${name}:${commandId}>` : `\`/${name}\``;
                });

                let content = `- **${plugin.name}**\n` +
                    `  - ${plugin.description || '—'}\n` +
                    `  - \`v${plugin.version}\``;

                if (commandMentions.length > 0) {
                    content += `\n  - ${commandMentions.join(', ')}`;
                }

                container.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(content)
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

        await interaction.update({
            components: [container],
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handlePluginsAccessMenu');
    }
}

module.exports = {
    handlePluginsAccessMenu
};
