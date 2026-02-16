const { SlashCommandBuilder, MessageFlags, ActionRowBuilder, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ButtonBuilder } = require('discord.js');
const { adminQueries } = require('../functions/utility/database');
const { createLanguageSelectionForm } = require('../functions/Settings/language');
const { createSettingsButton } = require('../functions/Settings/settings');
const { createAllianceManagementButton } = require('../functions/Alliance/Alliance');
const { createPlayerManagementButton } = require('../functions/Players/players');
const { createGiftCodeManagementButton } = require('../functions/GiftCode/giftCode');
const { createNotificationManagementButton } = require('../functions/Notification/notification');
const { createSupportButton } = require('../functions/Support/support');
const { PERMISSIONS } = require('../functions/Settings/admin/permissions');
const { getAdminLang, sendError, hasPermission } = require('../functions/utility/commonFunctions');


module.exports = {
    data: new SlashCommandBuilder()
        .setName('panel')
        .setDescription('Access the bot control panel'),

    async execute(interaction) {
        try {
            // Check if there are any admins in the database
            const admins = await adminQueries.getAllAdmins();

            // If no admins exist, make the first user the owner admin
            if (admins.length === 0) {
                // Create the owner admin record
                try {
                    adminQueries.addAdmin(
                        interaction.user.id,    // user_id
                        'system',               // added_by
                        0,                      // permissions 
                        '[]',                   // alliances (empty array)
                        1,                      // is_owner (1 for true, 0 for false)
                        'NA'                    // language set to "NA" to prompt for language selection
                    );

                } catch (error) {
                    console.error('Error creating owner admin:', error);
                    return await interaction.reply({
                        content: 'Failed to initialize admin system. Please try again.',
                        ephemeral: true
                    });
                }

                // Prompt for language selection
                const { components } = createLanguageSelectionForm('en', interaction);
                
                // Add welcome message as TextDisplay at the start
                components.unshift(
                    new TextDisplayBuilder().setContent(
                        '**Welcome! You are now the bot owner.**\nPlease select your preferred language to continue:'
                    )
                );

                return await interaction.reply({
                    components: components,
                    flags: MessageFlags.IsComponentsV2
                });
            }
            // Check if user is an admin
            const adminData = await adminQueries.getAdmin(interaction.user.id);

            if (!adminData) {
                // User is not an admin
                return await interaction.reply({
                    content: 'You do not have permission to access the management panel.',
                    ephemeral: true
                });
            }

            // Check if admin needs to select a language first
            if (adminData.language === 'NA') {
                // Admin hasn't selected a language yet - prompt for language selection
                const { components } = createLanguageSelectionForm('en', interaction);
                
                // Add welcome message as TextDisplay at the start
                components.unshift(
                    new TextDisplayBuilder().setContent(
                        '**Welcome!** Please select your preferred language to continue:'
                    )
                );

                return await interaction.reply({
                    components: components,
                    flags: MessageFlags.IsComponentsV2
                });
            }

            // User is an admin with language set - show the main panel
            await module.exports.showMainPanel(interaction);

        } catch (error) {
            await sendError(interaction, null, error, 'panel command');
            console.error('Error executing panel command:', error);
        }
    },
    /**
     * Shows the main management panel
     * @param {import('discord.js').ChatInputCommandInteraction} interaction 
     * @param {Object} adminData - Admin data from database
     */
    async showMainPanel(interaction) {
        // Get admin language preference
        const { adminData, lang } = getAdminLang(interaction.user.id);
        const { components } = module.exports.createPanelContainer(interaction, adminData, lang);

        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({
                components: components,
                flags: MessageFlags.IsComponentsV2
            });
        } else {
            await interaction.reply({
                components: components,
                flags: MessageFlags.IsComponentsV2
            });
        }
    },

    /**
     * Creates the panel components using Components v2
     * @param {import('discord.js').Interaction} interaction 
     * @param {Object} adminData - Admin data from database
     * @param {Object} lang - Language object
     * @returns {Object} Object containing components array
     */
    createPanelContainer(interaction, adminData, lang) {
        // Check permissions
        const hasAllianceManagement = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.ALLIANCE_MANAGEMENT);
        const hasPlayerManagement = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.PLAYER_MANAGEMENT);
        const hasGiftCodeManagement = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);

        // Create buttons
        const allianceButton = createAllianceManagementButton(interaction.user.id, lang);
        if (!hasAllianceManagement) allianceButton.setDisabled(true);

        const playerButton = createPlayerManagementButton(interaction.user.id, lang);
        if (!hasPlayerManagement) playerButton.setDisabled(true);

        const giftCodeButton = createGiftCodeManagementButton(interaction.user.id, lang);
        if (!hasGiftCodeManagement) giftCodeButton.setDisabled(true);

        const notificationButton = createNotificationManagementButton(interaction.user.id, lang);
        const settingsButton = createSettingsButton(interaction.user.id, lang);
        const supportButton = createSupportButton(interaction.user.id, lang);

        // Build Components v2 layout
        const components = [
            new ContainerBuilder()
            .setAccentColor(2417109) // blue
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.panel.mainPage.content.title}\n`+
                        `${lang.panel.mainPage.content.description}\n`+
                    
                        `${lang.panel.mainPage.content.allianceField.name}\n`+
                        `${lang.panel.mainPage.content.allianceField.value}\n`+

                        `${lang.panel.mainPage.content.playersField.name}\n`+
                        `${lang.panel.mainPage.content.playersField.value}\n`+

                        `${lang.panel.mainPage.content.giftCodesField.name}\n`+
                        `${lang.panel.mainPage.content.giftCodesField.value}\n`+

                        `${lang.panel.mainPage.content.notificationField.name}\n`+
                        `${lang.panel.mainPage.content.notificationField.value}\n`+

                        `${lang.panel.mainPage.content.settingsField.name}\n`+
                        `${lang.panel.mainPage.content.settingsField.value}\n`
                    )
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                )
                .addActionRowComponents(
                    new ActionRowBuilder().addComponents(
                        allianceButton,
                        playerButton,
                        giftCodeButton,
                        notificationButton,
                        supportButton,
                    ),
                    new ActionRowBuilder().addComponents(
                        settingsButton
                    )
            ),
        ];

        return { components };
    }
};