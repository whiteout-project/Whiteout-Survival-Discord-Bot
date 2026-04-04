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
const { createFeatureAccessButton } = require('./featureAccess');
const { createEmojiThemeButton } = require('./theme/emojis');
const { createDBMigrationButton } = require('./migration');
const { createBackupButton } = require('./backup/backup');
const { createBackToPanelButton } = require('../Panel/backToPanel');
const { createBackToSettingsButton } = require('./backToSettings');
const { createAutoUpdateButton } = require('./autoUpdate');
const { getUserInfo, assertUserMatches, handleError, hasPermission } = require('../utility/commonFunctions');
const { getComponentEmoji, getEmojiMapForUser } = require('../utility/emojis');


/**
 * Creates a settings button for the main panel
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The settings button
 */
function createSettingsButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`settings_${userId}`)
        .setLabel(lang.panel.mainPage.buttons.settings)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1038'));
}

/**
 * Creates the main settings page with category buttons
 * @param {Object} interaction - Interaction object
 * @param {Object} adminData - Admin data from database
 * @param {Object} lang - Language object
 * @returns {Array} Components V2 array
 */
function createSettingsComponents(interaction, adminData, lang) {
    const userId = interaction.user.id;
    const cat = lang.settings.mainPage.categories;

    // Non-admin users: show only preferences (language + theme)
    if (!adminData) {
        return createPreferencesCategory(userId, adminData, lang);
    }

    // Admin users: show category selection
    const emojiMap = getEmojiMapForUser(userId);

    const preferencesButton = new ButtonBuilder()
        .setCustomId(`settings_cat_preferences_${userId}`)
        .setLabel(cat.preferences.button)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(emojiMap, '1018'));

    const featuresButton = new ButtonBuilder()
        .setCustomId(`settings_cat_features_${userId}`)
        .setLabel(cat.features.button)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(emojiMap, '1011'));

    const advancedButton = new ButtonBuilder()
        .setCustomId(`settings_cat_advanced_${userId}`)
        .setLabel(cat.advanced.button)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(emojiMap, '1038'));

    const container = new ContainerBuilder()
        .setAccentColor(0xe67e22)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `${lang.settings.mainPage.content.title}\n` +
                `${lang.settings.mainPage.content.description}\n` +
                `${cat.preferences.description}\n` +
                `${cat.features.description}\n` +
                `${cat.advanced.description}\n`
            )
        )
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(
                preferencesButton,
                featuresButton,
                advancedButton,
                createBackToPanelButton(userId, lang)
            )
        );

    return [container];
}

/**
 * Creates the Preferences category page (Language, Emoji Theme)
 * @param {string} userId
 * @param {Object} adminData
 * @param {Object} lang
 * @returns {Array} Components V2 array
 */
function createPreferencesCategory(userId, adminData, lang) {
    const content = lang.settings.mainPage.content;
    const backButton = adminData
        ? createBackToSettingsButton(userId, lang)
        : createBackToPanelButton(userId, lang);

    const container = new ContainerBuilder()
        .setAccentColor(0xe67e22)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `${lang.settings.mainPage.categories.preferences.title}\n` +
                `${content.languageField.name}\n${content.languageField.value}\n` +
                `${content.themeField.name}\n${content.themeField.value}\n`
            )
        )
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(
                createChangeLanguageButton(userId, lang),
                createEmojiThemeButton(userId, lang),
                backButton
            )
        );

    return [container];
}

/**
 * Creates the Features Access category page (Admins, Feature Access, Auto Delete)
 * @param {string} userId
 * @param {Object} adminData
 * @param {Object} lang
 * @returns {Array} Components V2 array
 */
function createFeaturesCategory(userId, adminData, lang) {
    const content = lang.settings.mainPage.content;
    const hasFullAccess = hasPermission(adminData);
    const settings = settingsQueries.getSettings.get();
    const autoDelete = settings?.auto_delete ?? 1;

    const manageAdminsButton = createManageAdminsButton(userId, lang);
    if (!hasFullAccess) manageAdminsButton.setDisabled(true);

    const featureAccessButton = createFeatureAccessButton(userId, lang);
    if (!hasFullAccess) featureAccessButton.setDisabled(true);

    const autoDeleteButton = createAutoDeleteButton(userId, lang, autoDelete);
    if (!hasFullAccess) autoDeleteButton.setDisabled(true);

    const container = new ContainerBuilder()
        .setAccentColor(0xe67e22)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `${lang.settings.mainPage.categories.features.title}\n` +
                `${content.adminManagementField.name}\n${content.adminManagementField.value}\n` +
                `${content.featureAccessField.name}\n${content.featureAccessField.value}\n` +
                `${content.autoDeleteField.name}\n${content.autoDeleteField.value.replace('{autoDelete}', autoDelete ? content.enabled : content.disabled)}\n`
            )
        )
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(
                manageAdminsButton,
                featureAccessButton,
                autoDeleteButton,
                createBackToSettingsButton(userId, lang)
            )
        );

    return [container];
}

/**
 * Creates the Advanced category page (Backup, Migration, Auto Update)
 * @param {string} userId
 * @param {Object} adminData
 * @param {Object} lang
 * @returns {Array} Components V2 array
 */
function createAdvancedCategory(userId, adminData, lang) {
    const content = lang.settings.mainPage.content;
    const hasFullAccess = hasPermission(adminData);

    const backupButton = createBackupButton(userId, lang);
    if (!hasFullAccess) backupButton.setDisabled(true);

    const migrationButton = createDBMigrationButton(userId, lang);
    if (!hasFullAccess) migrationButton.setDisabled(true);

    const autoUpdateButton = createAutoUpdateButton(userId, lang);
    if (!hasFullAccess) autoUpdateButton.setDisabled(true);

    const container = new ContainerBuilder()
        .setAccentColor(0xe67e22)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `${lang.settings.mainPage.categories.advanced.title}\n` +
                `${content.backupField.name}\n${content.backupField.value}\n` +
                `${content.mergeField.name}\n${content.mergeField.value}\n` +
                `${content.autoUpdateField.name}\n${content.autoUpdateField.value}\n`
            )
        )
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(
                backupButton,
                migrationButton,
                autoUpdateButton,
                createBackToSettingsButton(userId, lang)
            )
        );

    return [container];
}

/**
 * Handles settings button interaction and shows settings main page
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleSettingsButton(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[1];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const newSection = createSettingsComponents(interaction, adminData, lang);
        await interaction.update({
            components: newSection,
            flags: MessageFlags.IsComponentsV2
        });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleSettingsButton');
    }
}

/**
 * Handles category button clicks — routes to the correct category page
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleSettingsCategoryButton(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        // settings_cat_{category}_{userId}
        const category = parts[2];
        const expectedUserId = parts[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const userId = interaction.user.id;
        let components;
        switch (category) {
            case 'preferences':
                components = createPreferencesCategory(userId, adminData, lang);
                break;
            case 'features':
                components = createFeaturesCategory(userId, adminData, lang);
                break;
            case 'advanced':
                components = createAdvancedCategory(userId, adminData, lang);
                break;
            default:
                components = createSettingsComponents(interaction, adminData, lang);
                break;
        }

        await interaction.update({
            components,
            flags: MessageFlags.IsComponentsV2
        });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleSettingsCategoryButton');
    }
}

module.exports = {
    createSettingsButton,
    handleSettingsButton,
    handleSettingsCategoryButton,
    createSettingsComponents,
    createPreferencesCategory,
    createFeaturesCategory,
    createAdvancedCategory
};