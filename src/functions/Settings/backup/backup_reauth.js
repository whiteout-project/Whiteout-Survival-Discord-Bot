const { ButtonBuilder, ButtonStyle, TextDisplayBuilder, SeparatorSpacingSize, SeparatorBuilder, ContainerBuilder, MessageFlags, ActionRowBuilder } = require('discord.js');
const { getAdminLang, assertUserMatches, sendError, updateComponentsV2AfterSeparator } = require('../../utility/commonFunctions');
const { getComponentEmoji, getEmojiMapForAdmin } = require('../../utility/emojis');
const { settingsQueries } = require('../../utility/database');

/**
 * Creates the reset OAuth button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The reset OAuth button
 */
function createBackupResetOAuthButton(userId, lang = {}) {
	return new ButtonBuilder()
		.setCustomId(`db_backup_reset_oauth_${userId}`)
		.setLabel(lang.settings.backup.mainPage.buttons.resetOAuth)
		.setStyle(ButtonStyle.Secondary)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1046'));
}

/**
 * Handle reset OAuth button - Shows confirmation dialog
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleResetOAuthButton(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const expectedUserId = interaction.customId.split('_')[4]; // db_backup_reset_oauth_userId
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		if (!adminData?.is_owner) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		// Show confirmation dialog
		const confirmButton = new ButtonBuilder()
			.setCustomId(`db_backup_reset_oauth_confirm_${interaction.user.id}`)
			.setLabel(lang.settings.backup.resetOAuth.buttons.confirm)
			.setStyle(ButtonStyle.Danger)
			.setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1004'));

		const cancelButton = new ButtonBuilder()
			.setCustomId(`db_backup_reset_oauth_cancel_${interaction.user.id}`)
			.setLabel(lang.settings.backup.resetOAuth.buttons.cancel)
			.setStyle(ButtonStyle.Secondary)
			.setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1051'));

		const buttonRow = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

		const container = [
			new ContainerBuilder()
				.setAccentColor(15548997) // red
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.backup.resetOAuth.content.title.base}\n` +
						`${lang.settings.backup.resetOAuth.content.description}`
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
		await sendError(interaction, lang, error, 'handleResetOAuthButton');
	}
}

/**
 * Handle reset OAuth confirmation - Actually clears the Google Drive token
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleResetOAuthConfirm(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const expectedUserId = interaction.customId.split('_')[5]; // db_backup_reset_oauth_confirm_userId
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		if (!adminData?.is_owner) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		// Clear the Google Drive token
		settingsQueries.clearGDriveToken.run();

		const { createBackupContainer } = require('./backup');
		const { components } = createBackupContainer(interaction, lang, adminData);

		const container = [
			new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
			new ContainerBuilder()
				.setAccentColor(0x00FF00) // Green
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.backup.resetOAuth.content.title.success}\n` +
						`${lang.settings.backup.resetOAuth.content.success}`
					)
				)
		];

		const content = [...components, ...container];


		await interaction.update({
			components: content,
			flags: MessageFlags.IsComponentsV2
		});
	} catch (error) {
		await sendError(interaction, lang, error, 'handleResetOAuthConfirm');
	}
}

/**
 * Handle reset OAuth cancellation
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleResetOAuthCancel(interaction) {
	const { lang } = getAdminLang(interaction.user.id);
	try {
		const expectedUserId = interaction.customId.split('_')[5]; // db_backup_reset_oauth_cancel_userId
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		const container = [
			new ContainerBuilder()
				.setAccentColor(10070709) // gray
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						lang.settings.backup.resetOAuth.content.cancelled
					)
				)
		];

		const content = updateComponentsV2AfterSeparator(interaction, container);

		await interaction.update({
			components: content,
			flags: MessageFlags.IsComponentsV2
		});
	} catch (error) {
		await sendError(interaction, lang, error, 'handleResetOAuthCancel');
	}
}

module.exports = {
	createBackupResetOAuthButton,
	handleResetOAuthButton,
	handleResetOAuthConfirm,
	handleResetOAuthCancel
};
