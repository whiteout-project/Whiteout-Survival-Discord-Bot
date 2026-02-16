const {
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize
} = require('discord.js');
const { adminQueries } = require('../utility/database');
const languages = require('../../i18n');
const { getAdminLang, assertUserMatches, sendError, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getComponentEmoji, getEmojiMapForAdmin, getGlobalEmojiMap, wrapLangWithEmojis } = require('../utility/emojis');

/**
 * Creates a change language button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localization
 * @returns {ButtonBuilder} The change language button
 */
function createChangeLanguageButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`change_language_${userId}`)
        .setLabel(lang.settings.mainPage.buttons.language)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1018'));
}

/**
 * Handles change language button interaction and updates embed to show language selection
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleChangeLanguageButton(interaction) {
    // Get user's language preference
    const { adminData, userLang, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[2];
        
        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!adminData) {   
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }
        
        // Create language selection form
        const { components } = createLanguageSelectionForm(userLang, interaction);
        
        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleChangeLanguageButton');
    }
}

/**
 * Creates a language selection menu
 * @param {string} authorId - ID of the user who can interact with this menu
 * @returns {ActionRowBuilder} The action row with language select menu
 */
function createLanguageSelectMenu(authorId) {
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`language_select_${authorId}`)
        .setPlaceholder('Choose your language')
        .setMinValues(1)
        .setMaxValues(1);

    // Add language options
    const availableLanguages = getAvailableLanguages(authorId);
    availableLanguages.forEach(option => {
        selectMenu.addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(option.label)
                .setValue(option.value)
                .setEmoji(option.emoji)
                .setDescription(option.description)
        );
    });

    const actionRow = new ActionRowBuilder().addComponents(selectMenu);
    return actionRow;
}

/**
 * Creates a language selection form with embed
 * @param {string} userLang - Current user language
 * @param {import('discord.js').ButtonInteraction} interaction - Interaction object
 * @returns {Object} Object containing embed and components
 */
function createLanguageSelectionForm(userLang = 'en', interaction) {
    const { lang } = getAdminLang(interaction.user.id);
    const availableLanguages = getAvailableLanguages(interaction.user.id);

    // Default to 'en' if user has no language selected yet
    const effectiveUserLang = userLang === 'NA' ? 'en' : userLang;

    const currentLanguage = `${availableLanguages.find(opt => opt.value === effectiveUserLang)?.emoji} ${availableLanguages.find(opt => opt.value === effectiveUserLang)?.label}`;

    const components = createLanguageSelectMenu(interaction.user.id);
    const newSection = [
        new ContainerBuilder()
        .setAccentColor(0x3498db) // Blue accent
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `${lang.settings.language.content.title.base}\n`+
                `${lang.settings.language.content.description}\n`+

                `${lang.settings.language.content.currentLanguageField.name}\n`+
                `${lang.settings.language.content.currentLanguageField.value.replace('{languageName}', currentLanguage)}`
            )
        )
        .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        )
        .addActionRowComponents(
            components
        )
    ];

    // If this is an initial reply (no message yet), return components directly
    // If this is an update (message exists), use updateComponentsV2AfterSeparator
    if (!interaction.message) {
        return {components: newSection};
    } else {
        return {components: updateComponentsV2AfterSeparator(interaction, newSection)};
    }
}



/**
 * Handles language selection from the dropdown menu
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleLanguageSelection(interaction) {
    // Get user's language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract expected user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[2];

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check if user is an admin
        if (!adminData) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const selectedLanguage = interaction.values[0];

        // Update admin language in database
        adminQueries.updateAdminLanguage(selectedLanguage, interaction.user.id);

        const successContainer = new ContainerBuilder()
            .setAccentColor(0x57F287)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(lang.settings.language.content.title.changed)
            );

        // Update the message to show success
        await interaction.update({
            components: updateComponentsV2AfterSeparator(interaction, [successContainer]),
            flags: MessageFlags.IsComponentsV2
        });


        // Wait 3 seconds then show the appropriate embed
        setTimeout(async () => {
            try {
                // Get updated admin data to ensure we have the latest language setting
                const updatedAdminData = adminQueries.getAdmin(interaction.user.id);

                // Check if this was a first-time language selection (previous language was "NA")
                const isFirstTimeSelection = adminData.language === 'NA';

                const userLang = updatedAdminData.language || selectedLanguage;
                let baseLang = languages[userLang];

                // Fallback to English if language not found
                if (!baseLang) {
                    baseLang = languages['en'] || {};
                }

                // Wrap language with emoji processing
                const emojiMap = getEmojiMapForAdmin(interaction.user.id);
                const lang = wrapLangWithEmojis(baseLang, emojiMap);

                if (isFirstTimeSelection) {
                    // First-time admin - show main panel
                    const panel = require('../../commands/panel');
                    const { components } = panel.createPanelContainer(interaction, updatedAdminData, lang);

                    await interaction.editReply({
                        components: components,
                        flags: MessageFlags.IsComponentsV2
                    });

                } else {
                    // Regular admin - show settings
                    const { createSettingsComponents } = require('./settings');
                    const settingsContainer = createSettingsComponents(interaction, updatedAdminData, lang);

                    // Update the message to show the settings with new language
                    await interaction.editReply({
                        components: settingsContainer,
                        flags: MessageFlags.IsComponentsV2
                    });

                }

            } catch (error) {
                await sendError(interaction, lang, error, 'handleLanguageSelection', false);

                // Fallback error message
                try {
                    const errorContainer = [
                        new ContainerBuilder()
                            .setAccentColor(0xFF0000)
                            .addTextDisplayComponents(
                                new TextDisplayBuilder().setContent('An error occurred while loading settings. Please run `/panel` again.')
                            )
                    ];

                    await interaction.editReply({
                        components: errorContainer,
                        flags: MessageFlags.IsComponentsV2
                    });
                } catch (editError) {
                    // Silently fail - user can retry with /panel
                }
            }
        }, 1000); // 1 second delay

    } catch (error) {
        await sendError(interaction, lang, error, 'handleLanguageSelection');
    }
}

/**
 * Gets the current language for a user
 * @param {string} userId - Discord user ID
 * @returns {string} Language code (defaults to 'en')
 */
function getUserLanguage(userId) {
    try {
        const adminData = adminQueries.getAdmin(userId);
        return adminData?.language || 'en';
    } catch (error) {
        console.error('Error getting user language:', error);
        return 'en';
    }
}

/**
 * Gets available languages list
 * @param {string} userId - Discord user ID for emoji map
 * @returns {Array} Array of language options
 */
function getAvailableLanguages(userId) {
    const emojiMap = getEmojiMapForAdmin(userId);
    
    // Available language options
    const languageOptions = [
        {
            label: 'English',
            value: 'en',
            emoji: emojiMap['1047'] || '🇬🇧', // Use full emoji string for text display
            description: 'English'
        }
    ];
    return languageOptions;
}


module.exports = {
    createLanguageSelectMenu,
    createLanguageSelectionForm,
    handleLanguageSelection,
    createChangeLanguageButton,
    handleChangeLanguageButton,
    getUserLanguage,
    getAvailableLanguages
};
