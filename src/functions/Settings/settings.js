const {
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize
} = require('discord.js');
const { settingsQueries } = require('../utility/database');
const { createChangeLanguageButton } = require('./language');
const { createManageAdminsButton } = require('./admin');
const { createAutoDeleteButton } = require('./autoClean');
const { createEmojiThemeButton } = require('./theme/emojis');
const { createDBMigrationButton } = require('./migration');
const { createBackupButton } = require('./backup/backup');
const { createBackToPanelButton } = require('../Panel/backToPanel');
const { createAutoUpdateButton } = require('./autoUpdate');
const { getAdminLang, assertUserMatches, sendError } = require('../utility/commonFunctions');
const { getComponentEmoji, getEmojiMapForAdmin } = require('../utility/emojis');


/**
 * Creates a settings button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The settings button
 */
function createSettingsButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`settings_${userId}`)
        .setLabel(lang.panel.mainPage.buttons.settings)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1038'));
}

/**
 * Creates settings components for display
 * @param {Object} interaction - Interaction object
 * @param {Object} adminData - Admin data from database
 * @param {string} userLang - User's language code
 * @param {Object} lang - Language object for localized text
 * @returns {Array} Array of components ready for display
 */
function createSettingsComponents(interaction, adminData, lang) {
    // Get auto_delete setting
    const settings = settingsQueries.getSettings.get();
    const autoDelete = settings?.auto_delete ?? 1;

    // Create action row with settings buttons
    const actionRow = new ActionRowBuilder()
        .addComponents(
            createChangeLanguageButton(interaction.user.id, lang)
        );

    const secondRow = new ActionRowBuilder()

    // Add manage admins button (disabled if user is not owner)
    const manageAdminsButton = createManageAdminsButton(interaction.user.id, lang);
    if (!adminData.is_owner) {
        manageAdminsButton.setDisabled(true);
    }
    actionRow.addComponents(manageAdminsButton);


    // Add emoji theme button
    const emojiThemeButton = createEmojiThemeButton(interaction.user.id, lang);
    actionRow.addComponents(emojiThemeButton);

    // Add auto-delete toggle button
    const autoDeleteButton = createAutoDeleteButton(interaction.user.id, lang, autoDelete);
    if (!adminData.is_owner) {
        autoDeleteButton.setDisabled(true);
    }
    actionRow.addComponents(autoDeleteButton);

    // Create second action row for database button
    const migrationButton = createDBMigrationButton(interaction.user.id, lang);
    if (!adminData.is_owner) {
        migrationButton.setDisabled(true);
    }
    secondRow.addComponents(migrationButton);

    const backupButton = createBackupButton(interaction.user.id, lang);
    if (!adminData.is_owner) {
        backupButton.setDisabled(true);
    }
    secondRow.addComponents(backupButton);

    // Add auto-update button (owner only)
    const autoUpdateButton = createAutoUpdateButton(interaction.user.id, lang);
    if (!adminData.is_owner) {
        autoUpdateButton.setDisabled(true);
    }
    secondRow.addComponents(autoUpdateButton);

    secondRow.addComponents(createBackToPanelButton(interaction.user.id, lang));

    const newSection = [
        new ContainerBuilder()
            .setAccentColor(0xe67e22)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.settings.mainPage.content.title}\n` +
                    `${lang.settings.mainPage.content.description}\n` +

                    `${lang.settings.mainPage.content.languageField.name}\n` +
                    `${lang.settings.mainPage.content.languageField.value}\n` +

                    `${lang.settings.mainPage.content.adminManagementField.name}\n` +
                    `${lang.settings.mainPage.content.adminManagementField.value}\n` +

                    `${lang.settings.mainPage.content.themeField.name}\n` +
                    `${lang.settings.mainPage.content.themeField.value}\n` +

                    `${lang.settings.mainPage.content.autoDeleteField.name}\n` +
                    `${lang.settings.mainPage.content.autoDeleteField.value.replace('{autoDelete}', autoDelete ? lang.settings.mainPage.content.enabled : lang.settings.mainPage.content.disabled)}\n` +

                    `${lang.settings.mainPage.content.mergeField.name}\n` +
                    `${lang.settings.mainPage.content.mergeField.value}\n` +

                    `${lang.settings.mainPage.content.backupField.name}\n` +
                    `${lang.settings.mainPage.content.backupField.value}\n` +

                    `${lang.settings.mainPage.content.autoUpdateField.name}\n` +
                    `${lang.settings.mainPage.content.autoUpdateField.value}\n`
                )
            ).addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            ).addActionRowComponents(
                actionRow,
                secondRow
            )
    ];

    return newSection;
}

/**
 * Handles settings button interaction and updates embed to show settings
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleSettingsButton(interaction) {
    // Get user's language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[1];

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check if user is an admin
        if (!adminData) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Create settings components
        const newSection = createSettingsComponents(interaction, adminData, lang);

        await interaction.update({
            components: newSection,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleSettingsButton');
    }
}

module.exports = {
    createSettingsButton,
    handleSettingsButton,
    createSettingsComponents
};