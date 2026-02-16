const { ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
const { getAdminLang, assertUserMatches, sendError, updateComponentsV2AfterSeparator } = require('../../utility/commonFunctions');
const { getComponentEmoji, getEmojiMapForAdmin } = require('../../utility/emojis');
const { settingsQueries } = require('../../utility/database');
const { getAuthenticatedDriveClient } = require('./backupCreate');

/**
 * Creates the view backups button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The view backups button
 */
function createBackupViewButton(userId, lang = {}) {
	return new ButtonBuilder()
		.setCustomId(`db_backup_view_${userId}`)
		.setLabel(lang.settings?.database?.backup?.buttons?.view || 'View Backups')
		.setStyle(ButtonStyle.Secondary)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1049'));
}

/**
 * Handle view backups button
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleBackupViewButton(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const expectedUserId = interaction.customId.split('_')[3];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		if (!adminData?.is_owner) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		// Check if Google Drive token exists
		const tokenResult = settingsQueries.getGDriveToken.get();

		if (!tokenResult || !tokenResult.gdrive_token) {
			return await interaction.reply({
				content: lang.settings.backup.backupView.errors.noToken,
				ephemeral: true
			});
		}

		// Defer update since we'll be making API calls
		await interaction.deferUpdate();

		const container = [
			new ContainerBuilder()
				.setAccentColor(0x3498db)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.backup.backupView.content.description.wait}`
					)
				)
		];

		const content = updateComponentsV2AfterSeparator(interaction, container);

		await interaction.editReply({
			components: content,
			flags: MessageFlags.IsComponentsV2
		});

		try {
			const drive = getAuthenticatedDriveClient();

			// Find or create wosland_backups folder
			const folderId = await findOrCreateBackupFolder(drive);

			// List all backup files in the folder
			const backups = await listBackupFiles(drive, folderId);

			if (backups.length === 0) {
				// No backups found
				await showNoBackupsMessage(interaction, lang);
			} else {
				// Display backup list
				await showBackupList(interaction, lang, backups);
			}
		} catch (error) {
			if (error.message.includes('OAuth setup incomplete')) {
				return await interaction.reply({
					content: lang.settings.backup.backupView.errors.setupIncomplete,
					ephemeral: true
				});
			}
			throw error;
		}
	} catch (error) {
		await sendError(interaction, lang, error, 'handleBackupViewButton');
	}
}

/**
 * Find or create the wosland_backups folder in Google Drive
 * @param {google.drive_v3.Drive} drive - Authenticated Drive client
 * @returns {Promise<string>} Folder ID
 */
async function findOrCreateBackupFolder(drive) {
	// Search for existing folder
	const response = await drive.files.list({
		q: "name='wosland_backups' and mimeType='application/vnd.google-apps.folder' and trashed=false",
		fields: 'files(id, name)',
		spaces: 'drive'
	});

	if (response.data.files.length > 0) {
		return response.data.files[0].id;
	}

	// Create folder if it doesn't exist
	const folderMetadata = {
		name: 'wosland_backups',
		mimeType: 'application/vnd.google-apps.folder'
	};

	const folder = await drive.files.create({
		resource: folderMetadata,
		fields: 'id'
	});

	return folder.data.id;
}

/**
 * List all backup files in the folder
 * @param {google.drive_v3.Drive} drive - Authenticated Drive client
 * @param {string} folderId - Backup folder ID
 * @returns {Promise<Array>} Array of backup file objects
 */
async function listBackupFiles(drive, folderId) {
	const response = await drive.files.list({
		q: `'${folderId}' in parents and trashed=false`,
		fields: 'files(id, name, size, createdTime, webViewLink, webContentLink)',
		orderBy: 'createdTime desc',
		pageSize: 100
	});

	return response.data.files || [];
}

/**
 * Show message when no backups are found
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {Object} lang - Language object
 */
async function showNoBackupsMessage(interaction, lang) {
	const container = [
		new ContainerBuilder()
			.setAccentColor(0xe67e22)
			.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(
					`${lang.settings.backup.backupView.noBackups.title.noBackups}\n` +
					`${lang.settings.backup.backupView.noBackups.description.noBackups}`
				)
			)
	];

	await interaction.editReply({
		components: updateComponentsV2AfterSeparator(interaction, container),
		flags: MessageFlags.IsComponentsV2
	});
}

/**
 * Show list of backups
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {Object} lang - Language object
 * @param {Array} backups - Array of backup file objects
 */
async function showBackupList(interaction, lang, backups) {
	let backupListText = `${lang.settings.backup.backupView.content.title.base}\n` +
		`${lang.settings.backup.backupView.content.description.base}\n`;

	backups.forEach((backup, index) => {
		const date = new Date(backup.createdTime);
		const formattedDate = date.toUTCString();
		const sizeInMB = (parseInt(backup.size) / (1024 * 1024)).toFixed(2);

		backupListText += `${lang.settings.backup.backupView.content.backupField.name.replace('{index}', index + 1).replace('{backupName}', backup.name)}\n`;
		backupListText += `${lang.settings.backup.backupView.content.backupField.value
			.replace('{createdAt}', formattedDate)
			.replace('{fileSize}', sizeInMB)
			.replace('{backupLink}', backup.webContentLink || backup.webViewLink)}\n`;
	});

	backupListText += `${lang.settings.backup.backupView.content.footer.replace('{totalBackups}', backups.length)}`;

	const container = [
		new ContainerBuilder()
			.setAccentColor(0x3498db)
			.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(backupListText)
			)
	];

	await interaction.editReply({
		components: updateComponentsV2AfterSeparator(interaction, container),
		flags: MessageFlags.IsComponentsV2
	});
}

module.exports = {
	createBackupViewButton,
	handleBackupViewButton,
	findOrCreateBackupFolder,
	listBackupFiles
};
