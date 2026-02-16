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
const { getAdminLang, assertUserMatches, sendError } = require('../../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../../utility/emojis');
const { createBackupCreateButton } = require('./backupCreate');
const { createBackupViewButton } = require('./backupView');
const { createBackupRestoreButton } = require('./backupRestore');
const { createBackupResetOAuthButton } = require('./backup_reauth');
const { createBackToSettingsButton } = require('../backToSettings');
const { settingsQueries } = require('../../utility/database');

/**
 * Creates the backup management button for settings
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The backup management button
 */
function createBackupButton(userId, lang = {}) {
	return new ButtonBuilder()
		.setCustomId(`backup_${userId}`)
		.setLabel(lang.settings.mainPage.buttons.backup)
		.setStyle(ButtonStyle.Secondary)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1037'));
}

/**
 * Handle backup management button
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleBackupButton(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const expectedUserId = interaction.customId.split('_')[1];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		// Check if user is owner
		if (!adminData?.is_owner) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		// Create backup management container
		const { components } = createBackupContainer(interaction, lang, adminData);

		await interaction.update({
			components,
			flags: MessageFlags.IsComponentsV2
		});
	} catch (error) {
		await sendError(interaction, lang, error, 'handleBackupButton');
	}
}

/**
 * Creates the backup management container
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {Object} lang - Language object for localized text
 * @param {Object} adminData - Admin data from database to check permissions
 * @returns {Object} Object containing components array for the backup management container
 */
function createBackupContainer(interaction, lang, adminData) {
	const userId = interaction.user.id;

	// Check if Google Drive token exists AND is complete (has refreshToken, not just OAuth state)
	const tokenResult = settingsQueries.getGDriveToken.get();
	let hasCompleteToken = false;
	if (tokenResult && tokenResult.gdrive_token) {
		try {
			const tokenData = JSON.parse(tokenResult.gdrive_token);
			// Only consider it valid if it has a refreshToken (not just OAuth state with clientId/Secret)
			hasCompleteToken = !!tokenData.refreshToken;
		} catch (e) {
			hasCompleteToken = false;
		}
	}

	// Backup buttons
	const backupCreateBtn = createBackupCreateButton(userId, lang);
	const backupViewBtn = createBackupViewButton(userId, lang);
	const backupRestoreBtn = createBackupRestoreButton(userId, lang);
	const backupResetOAuthBtn = createBackupResetOAuthButton(userId, lang);
	const backToSettingsBtn = createBackToSettingsButton(userId, lang);

	// Disable buttons if not owner
	if (!adminData.is_owner) {
		backupCreateBtn.setDisabled(true);
		backupViewBtn.setDisabled(true);
		backupRestoreBtn.setDisabled(true);
		backupResetOAuthBtn.setDisabled(true);
	} else {
		// If owner, disable view/restore/reset buttons when no complete token exists
		if (!hasCompleteToken) {
			backupViewBtn.setDisabled(true);
			backupRestoreBtn.setDisabled(true);
			backupResetOAuthBtn.setDisabled(true);
		}
	}

	const actionRow = new ActionRowBuilder().addComponents(
		backupCreateBtn,
		backupViewBtn,
		backupRestoreBtn,
		backupResetOAuthBtn,
		backToSettingsBtn
	);

	const container = [
		new ContainerBuilder()
			.setAccentColor(0x3498db)
			.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(
					`${lang.settings.backup.mainPage.content.title}\n` +
					`${lang.settings.backup.mainPage.content.description}\n` +

					`${lang.settings.backup.mainPage.content.createBackupField.name}\n` +
					`${lang.settings.backup.mainPage.content.createBackupField.value}\n` +

					`${lang.settings.backup.mainPage.content.viewBackupsField.name}\n` +
					`${lang.settings.backup.mainPage.content.viewBackupsField.value}\n` +

					`${lang.settings.backup.mainPage.content.restoreBackupField.name}\n` +
					`${lang.settings.backup.mainPage.content.restoreBackupField.value}\n` +

					`${lang.settings.backup.mainPage.content.resetOAuthField.name}\n` +
					`${lang.settings.backup.mainPage.content.resetOAuthField.value}`
				)
			)
			.addSeparatorComponents(
				new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
			)
			.addActionRowComponents(actionRow)
	];

	return { components: container };
}

module.exports = {
	createBackupButton,
	handleBackupButton,
	createBackupContainer
};
