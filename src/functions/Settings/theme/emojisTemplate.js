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
const { getAdminLang, assertUserMatches, sendError, hasPermission, updateComponentsV2AfterSeparator } = require('../../utility/commonFunctions');
const { PERMISSIONS } = require('../admin/permissions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../../utility/emojis');
const { createEmojiShareButton } = require('./emojisExport');
const { createEmojiUploadButton } = require('./emojisImport');

/**
 * Create Template Library button
 */
function createEmojiTemplateButton(userId, lang) {
	return new ButtonBuilder()
		.setCustomId(`emoji_template_${userId}`)
		.setLabel(lang.settings.theme.mainPage.buttons.templateLibrary)
		.setStyle(ButtonStyle.Secondary)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1044'));
}

/**
 * Handle Template Library button - shows share/upload options
 */
async function handleEmojiTemplateButton(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);

	try {
		const expectedUserId = interaction.customId.split('_')[2];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		// Check permissions
		const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

		if (!hasAccess) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		// Show share and upload buttons
		const shareButton = createEmojiShareButton(interaction.user.id, lang);
		const uploadButton = createEmojiUploadButton(interaction.user.id, lang);

		const buttonRow = new ActionRowBuilder().addComponents(shareButton, uploadButton);

		const container = [
			new ContainerBuilder()
				.setAccentColor(0x8e44ad) // purple
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.theme.templateLibrary.content.title}\n` +
						`${lang.settings.theme.templateLibrary.content.shareField.name}\n` +
						`${lang.settings.theme.templateLibrary.content.shareField.value}\n` +
						`${lang.settings.theme.templateLibrary.content.uploadField.name}\n` +
						`${lang.settings.theme.templateLibrary.content.uploadField.value}`
					)
				)
				.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
				.addActionRowComponents(buttonRow)
		];

		const content = updateComponentsV2AfterSeparator(interaction, container);

		await interaction.update({
			components: content,
			flags: MessageFlags.IsComponentsV2
		});

	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiTemplateButton');
	}
}

module.exports = {
	createEmojiTemplateButton,
	handleEmojiTemplateButton
};
