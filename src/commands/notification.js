const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { createNotificationContainer } = require('../functions/Notification/notification');
const { getAdminLang, sendError } = require('../functions/utility/commonFunctions');
const { adminQueries } = require('../functions/utility/database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('notification')
        .setDescription('Access notification management and settings'),

    async execute(interaction) {
        const { adminData, lang } = getAdminLang(interaction.user.id);
        try {
            // Check if user is an admin
            if (!adminData) {
                return await interaction.reply({
                    content: 'You do not have permission to access notification management.',
                    ephemeral: true
                });
            }

            // Create notification management container using shared function
            // includePrivateNotifications = true for slash command
            const { components } = createNotificationContainer(interaction, lang);

            // Reply with the notification container
            await interaction.reply({
                components: components,
                flags: MessageFlags.IsComponentsV2,
            });

        } catch (error) {
            await sendError(interaction, lang, error, 'notification command');
        }
    }
};
