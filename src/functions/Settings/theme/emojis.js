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
const { createBackToSettingsButton } = require('../backToSettings');
const { getAdminLang, assertUserMatches, sendError, hasPermission } = require('../../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../../utility/emojis');
const { createEmojiCreateButton } = require('./emojisCreate');
const { createEmojiEditButton } = require('./emojisEdit');
const { createEmojiViewButton } = require('./emojisView');
const { createEmojiTemplateButton } = require('./emojisTemplate');
const { createEmojiDeleteButton } = require('./emojisDelete');
const { createEmojiReloadButton } = require('./emojisReload');
const { createEmojiActivateButton } = require('./emojisActivate');
const { PERMISSIONS } = require('../admin/permissions');


/**
 * Creates the emoji theme button for settings
 * @param {string} userId
 * @param {Object} lang
 * @returns {ButtonBuilder}
 */
function createEmojiThemeButton(userId, lang = {}) {
	return new ButtonBuilder()
		.setCustomId(`emoji_theme_${userId}`)
		.setLabel(lang.settings.mainPage.buttons.theme)
		.setStyle(ButtonStyle.Secondary)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1039'));
}

/**
 * Creates the emoji theme container with all buttons and content
 * @param {string} userId
 * @param {Object} lang
 * @param {Object} adminData
 * @param {string} successMessage - Optional success message to display at top
 * @param {number} accentColor - Optional accent color (default: 0x8e44ad)
 * @returns {Array}
 */
function createEmojiThemeContainer(userId, lang, adminData) {
	const hasFullPermissions = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

	const EmojiCreateButton = createEmojiCreateButton(userId, lang);
	if (!hasFullPermissions) EmojiCreateButton.setDisabled(true);

	const EmojiEditButton = createEmojiEditButton(userId, lang);
	if (!hasFullPermissions) EmojiEditButton.setDisabled(true);

	const TemplateButton = createEmojiTemplateButton(userId, lang);
	if (!hasFullPermissions) TemplateButton.setDisabled(true);

	const DeleteButton = createEmojiDeleteButton(userId, lang);
	if (!hasFullPermissions) DeleteButton.setDisabled(true);

	const EmojiReloadButton = createEmojiReloadButton(userId, lang);
	if (!hasFullPermissions) EmojiReloadButton.setDisabled(true);

	const actionRow1 = new ActionRowBuilder().addComponents(
		EmojiCreateButton,
		EmojiEditButton,
		createEmojiViewButton(userId, lang),
		TemplateButton
	);

	const actionRow2 = new ActionRowBuilder().addComponents(
		DeleteButton,
		EmojiReloadButton,
		createEmojiActivateButton(userId, lang),
		createBackToSettingsButton(userId, lang)
	);

	return [
		new ContainerBuilder()
			.setAccentColor(0x8e44ad)
			.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(
					`${lang.settings.theme.mainPage.content.title}\n` +
					`${lang.settings.theme.mainPage.content.description}\n` +

					`${lang.settings.theme.mainPage.content.addPackField.name}\n` +
					`${lang.settings.theme.mainPage.content.addPackField.value}\n` +

					`${lang.settings.theme.mainPage.content.editPackField.name}\n` +
					`${lang.settings.theme.mainPage.content.editPackField.value}\n` +

					`${lang.settings.theme.mainPage.content.viewPackField.name}\n` +
					`${lang.settings.theme.mainPage.content.viewPackField.value}\n` +

					`${lang.settings.theme.mainPage.content.templateLibraryField.name}\n` +
					`${lang.settings.theme.mainPage.content.templateLibraryField.value}\n` +

					`${lang.settings.theme.mainPage.content.deletePackField.name}\n` +
					`${lang.settings.theme.mainPage.content.deletePackField.value}\n` +

					`${lang.settings.theme.mainPage.content.reloadDefaultsField.name}\n` +
					`${lang.settings.theme.mainPage.content.reloadDefaultsField.value}\n` +

					`${lang.settings.theme.mainPage.content.activatePackField.name}\n` +
					`${lang.settings.theme.mainPage.content.activatePackField.value}\n`
				)
			)
			.addSeparatorComponents(
				new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
			)
			.addActionRowComponents(actionRow1, actionRow2)
	];
}

/**
 * Handles emoji theme button
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleEmojiThemeButton(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const expectedUserId = interaction.customId.split('_')[2];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		if (!adminData) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		const components = createEmojiThemeContainer(interaction.user.id, lang, adminData);

		await interaction.update({
			components,
			flags: MessageFlags.IsComponentsV2
		});
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiThemeButton');
	}
}

module.exports = {
	createEmojiThemeButton,
	handleEmojiThemeButton,
	createEmojiThemeContainer
};
