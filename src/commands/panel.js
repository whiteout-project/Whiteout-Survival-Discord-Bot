const { SlashCommandBuilder, MessageFlags, ActionRowBuilder, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ButtonBuilder, ButtonStyle } = require('discord.js');
const { adminQueries, userQueries } = require('../functions/utility/database');
const { createLanguageSelectionForm } = require('../functions/Settings/language');
const { createSettingsButton } = require('../functions/Settings/settings');
const { createAllianceManagementButton } = require('../functions/Alliance/Alliance');
const { createPlayerManagementButton } = require('../functions/Players/players');
const { createGiftCodeManagementButton } = require('../functions/GiftCode/giftCode');
const { createNotificationManagementButton } = require('../functions/Notification/notification');
const { createSupportButton } = require('../functions/Support/support');
const { createCalculatorsButton } = require('../functions/Calculators/calculators');
const { createPluginsButton } = require('../functions/Plugin/plugins');
const { PERMISSIONS } = require('../functions/Settings/admin/permissions');
const { getUserInfo, handleError, hasPermission } = require('../functions/utility/commonFunctions');
const { checkFeatureAccess } = require('../functions/utility/checkAccess');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('panel')
        .setDescription('Access the bot features panel.'),

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
                        1                       // is_owner
                    );
                } catch (error) {
                    console.error('Error creating owner admin:', error);
                    return await interaction.reply({
                        content: 'Failed to initialize admin system. Please try again.',
                        ephemeral: true
                    });
                }

                // Ensure a users record exists for the new owner
                userQueries.upsertUser(interaction.user.id);

                // Prompt for language selection
                const { components } = createLanguageSelectionForm('en', interaction);

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

            if (adminData) {
                // Admin path: ensure users record exists, check language
                userQueries.upsertUser(interaction.user.id);
                const userData = userQueries.getUser(interaction.user.id);

                if (!userData?.language) {
                    const { components } = createLanguageSelectionForm('en', interaction);
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

                // Admin with language set — show the main admin panel
                await module.exports.showMainPanel(interaction);

            } else {
                // Non-admin user path: auto-create users record, prompt language if needed
                userQueries.upsertUser(interaction.user.id);
                const userData = userQueries.getUser(interaction.user.id);

                if (!userData?.language) {
                    const { components } = createLanguageSelectionForm('en', interaction);
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

                // Regular user with language set — show user panel
                const { lang } = getUserInfo(interaction.user.id);
                const { components } = module.exports.createUserPanelContainer(interaction, lang);
                await interaction.reply({
                    components: components,
                    flags: MessageFlags.IsComponentsV2
                });
            }

        } catch (error) {
            await handleError(interaction, null, error, 'panel command');
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
        const { adminData, lang } = getUserInfo(interaction.user.id);
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
        const hasCalculatorsAccess = checkFeatureAccess('calculators', interaction);

        // Create buttons
        const allianceButton = createAllianceManagementButton(interaction.user.id, lang);
        if (!hasAllianceManagement) allianceButton.setDisabled(true);

        const playerButton = createPlayerManagementButton(interaction.user.id, lang);
        if (!hasPlayerManagement) playerButton.setDisabled(true);

        const giftCodeButton = createGiftCodeManagementButton(interaction.user.id, lang);
        if (!hasGiftCodeManagement) giftCodeButton.setDisabled(true);

        const notificationButton = createNotificationManagementButton(interaction.user.id, lang);
        const settingsButton = createSettingsButton(interaction.user.id, lang);
        const calculatorsButton = createCalculatorsButton(interaction.user.id, lang);
        if (!hasCalculatorsAccess) calculatorsButton.setDisabled(true);

        const pluginsButton = createPluginsButton(interaction.user.id, lang);
        if (!adminData?.is_owner) pluginsButton.setDisabled(true);

        const supportButton = createSupportButton(interaction.user.id, lang);

        // Build Components 
        const components = [
            new ContainerBuilder()
                .setAccentColor(2417109) // blue
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.panel.mainPage.content.title}\n` +
                        `${lang.panel.mainPage.content.description}\n` +

                        `${lang.panel.mainPage.content.allianceField.name}\n` +
                        `${lang.panel.mainPage.content.allianceField.value}\n` +

                        `${lang.panel.mainPage.content.playersField.name}\n` +
                        `${lang.panel.mainPage.content.playersField.value}\n` +

                        `${lang.panel.mainPage.content.giftCodesField.name}\n` +
                        `${lang.panel.mainPage.content.giftCodesField.value}\n` +

                        `${lang.panel.mainPage.content.notificationField.name}\n` +
                        `${lang.panel.mainPage.content.notificationField.value}\n` +

                        `${lang.panel.mainPage.content.calculatorsField.name}\n` +
                        `${lang.panel.mainPage.content.calculatorsField.value}\n` +

                        `${lang.panel.mainPage.content.pluginsField.name}\n` +
                        `${lang.panel.mainPage.content.pluginsField.value}\n` +

                        `${lang.panel.mainPage.content.settingsField.name}\n` +
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
                        supportButton
                    ),
                    new ActionRowBuilder().addComponents(
                        calculatorsButton,
                        pluginsButton,
                        settingsButton
                    )
                ),
        ];

        return { components };
    },

    /**
     * Creates the user (non-admin) panel with 4 buttons: calculators, notifications, settings, support
     * @param {import('discord.js').Interaction} interaction
     * @param {Object} lang - Language object
     * @returns {Object} Object containing components array
     */
    createUserPanelContainer(interaction, lang) {
        const userId = interaction.user.id;

        const hasCalculatorsAccess = checkFeatureAccess('calculators', interaction);
        const calculatorsButton = createCalculatorsButton(userId, lang);
        if (!hasCalculatorsAccess) calculatorsButton.setDisabled(true);

        const notificationButton = createNotificationManagementButton(userId, lang);
        const settingsButton = createSettingsButton(userId, lang);
        const supportButton = createSupportButton(userId, lang);

        const components = [
            new ContainerBuilder()
                .setAccentColor(0x3498db)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.panel.mainPage.content.title}\n` +
                        `${lang.panel.mainPage.content.description}\n` +

                        `${lang.panel.mainPage.content.calculatorsField.name}\n` +
                        `${lang.panel.mainPage.content.calculatorsField.value}\n` +

                        `${lang.panel.mainPage.content.notificationField.name}\n` +
                        `${lang.panel.mainPage.content.notificationField.value}\n` +

                        `${lang.panel.mainPage.content.settingsField.name}\n` +
                        `${lang.panel.mainPage.content.settingsField.value}\n`
                    )
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                )
                .addActionRowComponents(
                    new ActionRowBuilder().addComponents(
                        calculatorsButton,
                        notificationButton,
                        supportButton,
                        settingsButton
                    )
                )
        ];

        return { components };
    }
};