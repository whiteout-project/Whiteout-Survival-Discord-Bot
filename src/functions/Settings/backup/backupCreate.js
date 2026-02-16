const { ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MediaGalleryItemBuilder, ContainerBuilder, MessageFlags, MediaGalleryBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, LabelBuilder } = require('discord.js');
const { google } = require('googleapis');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { getAdminLang, assertUserMatches, sendError, updateComponentsV2AfterSeparator } = require('../../utility/commonFunctions');
const { getComponentEmoji, getEmojiMapForAdmin } = require('../../utility/emojis');
const { settingsQueries } = require('../../utility/database');

/**
 * Creates the create backup button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The create backup button
 */
function createBackupCreateButton(userId, lang = {}) {
	return new ButtonBuilder()
		.setCustomId(`db_backup_create_${userId}`)
		.setLabel(lang.settings.backup.mainPage.buttons.create)
		.setStyle(ButtonStyle.Secondary)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1000'));
}

/**
 * Handle create backup button
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleBackupCreateButton(interaction) {
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

		// Check if token is complete (has refreshToken) or incomplete (just OAuth state)
		let hasCompleteToken = false;
		if (tokenResult && tokenResult.gdrive_token) {
			try {
				const tokenData = JSON.parse(tokenResult.gdrive_token);
				// Only consider it valid if it has a refreshToken (not just OAuth state with clientId/Secret)
				hasCompleteToken = !!tokenData.refreshToken;
			} catch (e) {
				// Invalid JSON - reset it
				settingsQueries.clearGDriveToken.run();
			}
		}

		// If incomplete OAuth state exists, clear it and start fresh
		if (tokenResult && tokenResult.gdrive_token && !hasCompleteToken) {
			settingsQueries.clearGDriveToken.run();
		}

		if (!hasCompleteToken) {
			// No token - show OAuth setup guide
			return await showOAuthSetupGuide(interaction, lang);
		}

		// Token exists - proceed with backup creation
		await interaction.deferUpdate({});

		const container = [
			new ContainerBuilder()
				.setAccentColor(0x3498db)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.backup.backupCreate.content.description.wait}`
					)
				)
		];

		const content = updateComponentsV2AfterSeparator(interaction, container);

		await interaction.editReply({
			components: content,
			flags: MessageFlags.IsComponentsV2
		});

		try {
			const result = await createAndUploadBackup();

			if (result.success) {
				// Format file size
				const fileSizeMB = (result.fileSize / (1024 * 1024)).toFixed(2);

				// Format date
				const createdDate = new Date(result.createdTime);
				const dateStr = `${createdDate.getUTCDate()}/${createdDate.getUTCMonth() + 1}/${createdDate.getUTCFullYear()} ${String(createdDate.getUTCHours()).padStart(2, '0')}:${String(createdDate.getUTCMinutes()).padStart(2, '0')} UTC`;

				const container = [
					new ContainerBuilder()
						.setAccentColor(0x2ecc71)
						.addTextDisplayComponents(
							new TextDisplayBuilder().setContent(
								`${lang.settings.backup.backupCreate.content.title.created}\n` +
								`${lang.settings.backup.backupCreate.content.createdField.value.replace('{backupName}', result.fileName).replace('{createdAt}', dateStr).replace('{fileSize}', fileSizeMB).replace('{backupLink}', result.webViewLink)}\n`
							)
						)
				];

				const content = updateComponentsV2AfterSeparator(interaction, container);

				await interaction.editReply({
					components: content,
					flags: MessageFlags.IsComponentsV2
				});

			} else {
				await sendError(interaction, lang, new Error(result.error || 'Unknown error during backup creation'), 'handleBackupCreateButton');
			}
		} catch (error) {
			await sendError(interaction, lang, error, 'handleBackupCreateButton');
		}
	} catch (error) {
		await sendError(interaction, lang, error, 'handleBackupCreateButton');
	}
}

/**
 * Show OAuth setup guide with pagination (step-by-step guide)
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {Object} lang - Language object
 * @param {number} step - Current step number (1-13)
 */
async function showOAuthSetupGuideStep(interaction, lang, step = 1) {
	const userId = interaction.user.id;
	const totalSteps = 6; // Update this if you add more steps to the guide

	// Clamp step to valid range
	step = Math.max(1, Math.min(step, totalSteps));

	// Get step content from language system
	const stepData = lang.settings.backup.backupCreate.content?.[`step${step}`];

	// Create navigation buttons
	const buttons = [];

	// Back button (disabled on first step)
	const backButton = new ButtonBuilder()
		.setCustomId(`db_backup_oauth_guide_back_${step}_${userId}`)
		.setLabel(lang.settings.backup.backupCreate.buttons.back)
		.setStyle(ButtonStyle.Secondary)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1019'))
		.setDisabled(step === 1);

	// Next button
	const nextButton = new ButtonBuilder()
		.setCustomId(`db_backup_oauth_guide_next_${step}_${userId}`)
		.setLabel(lang.settings.backup.backupCreate.buttons.next)
		.setStyle(ButtonStyle.Primary)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1034'));

	buttons.push(backButton, nextButton);

	const actionRow = new ActionRowBuilder().addComponents(buttons);

	// Build container
	const container = [
		new ContainerBuilder()
			.setAccentColor(0x3498db)
			.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(
					`${stepData.title} (${step}/${totalSteps})\n${stepData.description}`
				)
			)
	];

	// Add image if provided
	if (stepData.imageUrl) {
		container[0].addMediaGalleryComponents(
			new MediaGalleryBuilder()
				.addItems(
					new MediaGalleryItemBuilder()
						.setURL(stepData.imageUrl),
				),
		);
	}

	container[0]
		.addSeparatorComponents(
			new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
		)
		.addActionRowComponents(actionRow);

	await interaction.update({
		components: updateComponentsV2AfterSeparator(interaction, container),
		flags: MessageFlags.IsComponentsV2
	});
}

/**
 * Show OAuth setup guide - entry point (starts at step 1)
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {Object} lang - Language object
 */
async function showOAuthSetupGuide(interaction, lang) {
	await showOAuthSetupGuideStep(interaction, lang, 1);
}

/**
 * Handle guide back button
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleOAuthGuideBackButton(interaction) {
	const { lang } = getAdminLang(interaction.user.id);
	try {
		const parts = interaction.customId.split('_');
		const currentStep = parseInt(parts[5]);
		const expectedUserId = parts[6];

		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		// Go to previous step
		await showOAuthSetupGuideStep(interaction, lang, currentStep - 1);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleOAuthGuideBackButton');
	}
}

/**
 * Handle guide next button
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleOAuthGuideNextButton(interaction) {
	const { lang } = getAdminLang(interaction.user.id);
	try {
		const parts = interaction.customId.split('_');
		const currentStep = parseInt(parts[5]);
		const expectedUserId = parts[6];

		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		const totalSteps = 6;

		// If on last step, show OAuth setup button instead of next page
		if (currentStep === totalSteps) {
			await showOAuthSetupPrompt(interaction, lang);
		} else {
			// Go to next step
			await showOAuthSetupGuideStep(interaction, lang, currentStep + 1);
		}
	} catch (error) {
		await sendError(interaction, lang, error, 'handleOAuthGuideNextButton');
	}
}

/**
 * Show OAuth setup prompt after guide completion
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {Object} lang - Language object
 */
async function showOAuthSetupPrompt(interaction, lang) {
	const userId = interaction.user.id;

	const setupButton = new ButtonBuilder()
		.setCustomId(`db_backup_oauth_setup_${userId}`)
		.setLabel(lang.settings.backup.backupCreate.buttons.submit)
		.setStyle(ButtonStyle.Success)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1018'));

	const backToGuideButton = new ButtonBuilder()
		.setCustomId(`db_backup_oauth_guide_back_7_${userId}`)
		.setLabel(lang.settings.backup.backupCreate.buttons.backToGuide)
		.setStyle(ButtonStyle.Secondary)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1002'));

	const actionRow = new ActionRowBuilder().addComponents(backToGuideButton, setupButton);

	const container = [
		new ContainerBuilder()
			.setAccentColor(0x2ecc71)
			.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(
					`${lang.settings.backup.backupCreate.content.title.base}\n` +
					`${lang.settings.backup.backupCreate.content.description.base}`
				)
			)
			.addSeparatorComponents(
				new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
			)
			.addActionRowComponents(actionRow)
	];

	await interaction.update({
		components: updateComponentsV2AfterSeparator(interaction, container),
		flags: MessageFlags.IsComponentsV2
	});
}

/**
 * Handle OAuth setup button - shows modal to enter credentials
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleOAuthSetupButton(interaction) {
	const { lang } = getAdminLang(interaction.user.id);
	try {
		const expectedUserId = interaction.customId.split('_')[4];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		const modal = new ModalBuilder()
			.setCustomId(`db_backup_oauth_modal_${interaction.user.id}`)
			.setTitle(lang.settings.backup.backupCreate.modal.title.base);

		const clientIdInput = new TextInputBuilder()
			.setCustomId('client_id')
			.setStyle(TextInputStyle.Short)
			.setRequired(true);

		const clientIdLabel = new LabelBuilder()
			.setLabel(lang.settings.backup.backupCreate.modal.clientId.label)
			.setTextInputComponent(clientIdInput);

		const clientSecretInput = new TextInputBuilder()
			.setCustomId('client_secret')
			.setStyle(TextInputStyle.Short)
			.setRequired(true);

		const clientSecretLabel = new LabelBuilder()
			.setLabel(lang.settings.backup.backupCreate.modal.clientSecret.label)
			.setTextInputComponent(clientSecretInput);

		modal.addLabelComponents(clientIdLabel, clientSecretLabel);

		await interaction.showModal(modal);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleOAuthSetupButton');
	}
}

/**
 * Handle OAuth setup modal submission - shows auth URL and code submission button
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleOAuthModal(interaction) {
	const { lang } = getAdminLang(interaction.user.id);
	try {
		const expectedUserId = interaction.customId.split('_')[4];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		const clientId = interaction.fields.getTextInputValue('client_id');
		const clientSecret = interaction.fields.getTextInputValue('client_secret');
		const OOB_REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

		// Create OAuth2 client with OOB (Out-of-Band) redirect URI
		const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, OOB_REDIRECT_URI);

		// Generate auth URL
		const authUrl = oauth2Client.generateAuthUrl({
			access_type: 'offline',
			scope: ['https://www.googleapis.com/auth/drive']
		});

		// Store OAuth credentials temporarily (will be replaced with refresh token after authorization)
		const oauthState = JSON.stringify({
			clientId,
			clientSecret,
			timestamp: Date.now()
		});

		// Save temporary OAuth state to settings (we'll update with refresh token after auth)
		settingsQueries.setGDriveToken.run(oauthState);

		// Show container with auth URL and button to submit code
		await showAuthorizationStep(interaction, lang, authUrl);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleOAuthModal');
	}
}

/**
 * Show authorization step with auth URL and code submission button
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {Object} lang - Language object
 * @param {string} authUrl - Google OAuth authorization URL
 */
async function showAuthorizationStep(interaction, lang, authUrl) {
	const userId = interaction.user.id;

	const backToGuideButton = new ButtonBuilder()
		.setCustomId(`db_backup_oauth_guide_back_8_${userId}`)
		.setLabel(lang.settings.backup.backupCreate.buttons.backToGuide)
		.setStyle(ButtonStyle.Secondary)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1002'));

	// Create "Submit Code" button
	const submitCodeButton = new ButtonBuilder()
		.setCustomId(`db_backup_oauth_code_${userId}`)
		.setLabel(lang.settings.backup.backupCreate.buttons.authorize)
		.setStyle(ButtonStyle.Success)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1004'));

	const actionRow = new ActionRowBuilder().addComponents(backToGuideButton, submitCodeButton);

	const container = [
		new ContainerBuilder()
			.setAccentColor(0x2ecc71)
			.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(
					`${lang.settings.backup.backupCreate.content.title.auth}\n` +
					`${lang.settings.backup.backupCreate.content.description.auth.replace('{authUrl}', authUrl)}`
				)
			)
			.addSeparatorComponents(
				new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
			)
			.addActionRowComponents(actionRow)
	];

	await interaction.update({
		components: updateComponentsV2AfterSeparator(interaction, container),
		flags: MessageFlags.IsComponentsV2
	});
}

/**
 * Handle code submission button - shows modal to enter auth code
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleOAuthCodeSubmitButton(interaction) {
	const { lang } = getAdminLang(interaction.user.id);
	try {
		const expectedUserId = interaction.customId.split('_')[4];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		const modal = new ModalBuilder()
			.setCustomId(`db_backup_oauth_code_modal_${interaction.user.id}`)
			.setTitle(lang.settings.backup.backupCreate.modal.title.auth);

		const codeInput = new TextInputBuilder()
			.setCustomId('auth_code')
			.setStyle(TextInputStyle.Short)
			.setRequired(true);

		const codeLabel = new LabelBuilder()
			.setLabel(lang.settings.backup.backupCreate.modal.authCode.label)
			.setDescription(lang.settings.backup.backupCreate.modal.authCode.description)
			.setTextInputComponent(codeInput);

		modal.addLabelComponents(codeLabel);

		await interaction.showModal(modal);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleOAuthCodeSubmitButton');
	}
}

/**
 * Handle authorization code modal submission - exchanges code for refresh token
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleOAuthCodeModal(interaction) {
	const { lang, adminData } = getAdminLang(interaction.user.id);
	try {
		const expectedUserId = interaction.customId.split('_')[5];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		// Defer reply to prevent timeout during token exchange
		await interaction.deferUpdate({});

		const authCode = interaction.fields.getTextInputValue('auth_code').trim();

		// Validate code format (should be alphanumeric with some special chars)
		if (!authCode || authCode.length < 10) {
			return await interaction.editReply({
				content: lang.settings.backup.backupCreate.errors.invalidCode
			});
		}

		// Get stored OAuth state
		const tokenResult = settingsQueries.getGDriveToken.get();
		if (!tokenResult || !tokenResult.gdrive_token) {
			return await interaction.editReply({
				content: lang.settings.backup.backupCreate.errors.stateNotFound,
				ephemeral: true
			});
		}

		try {
			const oauthState = JSON.parse(tokenResult.gdrive_token);
			const OOB_REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

			// Validate we have all required OAuth credentials
			if (!oauthState.clientId || !oauthState.clientSecret) {
				return await interaction.editReply({
					content: lang.settings.backup.backupCreate.errors.stateNotFound,
					ephemeral: true
				});
			}

			// Check if code was stored too long ago (auth codes expire after ~10 minutes)
			const codeAge = Date.now() - oauthState.timestamp;
			if (codeAge > 15 * 60 * 1000) { // 15 minutes
				console.warn(`[OAuth] Authorization code may have expired (age: ${(codeAge / 1000 / 60).toFixed(1)} minutes)`);
			}

			// Create OAuth2 client with explicit redirect URI
			const oauth2Client = new google.auth.OAuth2(
				oauthState.clientId,
				oauthState.clientSecret,
				OOB_REDIRECT_URI
			);

			// Exchange authorization code for tokens
			let credentials;
			try {
				// Note: DO NOT pass redirect_uri here - it's already set in the constructor
				const tokenResponse = await oauth2Client.getToken(authCode);
				// Google API returns 'tokens' not 'credentials'
				credentials = tokenResponse.tokens;
			} catch (tokenError) {
				if (tokenError.message.includes('invalid_grant')) {
					return await interaction.editReply({
						content: lang.settings.backup.backupCreate.errors.authFailed,
						ephemeral: true
					});
				}
				throw new Error(`Token exchange failed: ${tokenError.message}`);
			}

			// Check if refresh token was obtained
			if (!credentials.refresh_token) {
				return await interaction.editReply({
					content: lang.settings.backup.backupCreate.errors.noRefreshToken,
					ephemeral: true
				});
			}

			// Store refresh token for future use
			const tokenData = JSON.stringify({
				clientId: oauthState.clientId,
				clientSecret: oauthState.clientSecret,
				refreshToken: credentials.refresh_token,
				timestamp: Date.now()
			});

			settingsQueries.setGDriveToken.run(tokenData);

			const { createBackupContainer } = require('./backup');
			const { components } = createBackupContainer(interaction, lang, adminData);

			const container = [
				new ContainerBuilder()
					.setAccentColor(0x2ecc71) // Green
					.addTextDisplayComponents(
						new TextDisplayBuilder().setContent(
							`${lang.settings.backup.backupCreate.content.title.success}\n` +
							`${lang.settings.backup.backupCreate.content.description.success}`
						)
					)
			];

			const content = [...components, ...container];

			// Show success message (use editReply since we deferred at the start)
			await interaction.editReply({
				components: content,
				flags: MessageFlags.IsComponentsV2
			});
			// TODO: Add admin log entry
		} catch (outerError) {
			// Only catch unexpected errors here (e.g., database errors)
			await sendError(interaction, lang, outerError, 'handleOAuthCodeModal');
		}
	} catch (error) {
		await sendError(interaction, lang, error, 'handleOAuthCodeModal');
	}
}

/**
 * Get authenticated Google Drive client using stored token
 * @returns {google.drive_v3.Drive} Authenticated Drive client
 * @throws {Error} If no valid token is stored
 */
function getAuthenticatedDriveClient() {
	const OOB_REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';
	const tokenResult = settingsQueries.getGDriveToken.get();

	if (!tokenResult || !tokenResult.gdrive_token) {
		throw new Error('Google Drive token not configured. Please set up OAuth first.');
	}

	try {
		const tokenData = JSON.parse(tokenResult.gdrive_token);

		// Check if it's OAuth state (temporary) or refresh token (permanent)
		if (tokenData.refreshToken) {
			// It's a refresh token
			const oauth2Client = new google.auth.OAuth2(tokenData.clientId, tokenData.clientSecret, OOB_REDIRECT_URI);
			oauth2Client.setCredentials({ refresh_token: tokenData.refreshToken });
			return google.drive({ version: 'v3', auth: oauth2Client });
		} else {
			// It's OAuth state - user hasn't completed authorization yet
			throw new Error('OAuth setup incomplete. Please complete the authorization process first.');
		}
	} catch (error) {
		if (error.message.includes('OAuth setup incomplete')) {
			throw error;
		}
		throw new Error('Invalid Google Drive token configuration: ' + error.message);
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
 * Maximum number of backups to retain
 */
const MAX_BACKUPS = 5;

/**
 * Delete old backups to maintain MAX_BACKUPS limit
 * @param {google.drive_v3.Drive} drive - Authenticated Drive client
 * @param {string} folderId - Backup folder ID
 */
async function cleanupOldBackups(drive, folderId) {
	try {
		// List all backups sorted by creation time (newest first)
		const response = await drive.files.list({
			q: `'${folderId}' in parents and trashed = false`,
			fields: 'files(id, name, createdTime)',
			orderBy: 'createdTime desc'
		});

		const backups = response.data.files;

		if (backups.length <= MAX_BACKUPS) {
			return;
		}

		// Delete oldest backups (keep only MAX_BACKUPS)
		const backupsToDelete = backups.slice(MAX_BACKUPS);

		for (const backup of backupsToDelete) {
			try {
				await drive.files.delete({ fileId: backup.id });
			} catch (error) {
				await sendError(null, null, new Error(`Failed to delete old backup "${backup.name}": ${error.message}`), 'cleanupOldBackups', false);
			}
		}

	} catch (error) {
		await sendError(null, null, new Error(`Backup cleanup error: ${error.message}`), 'cleanupOldBackups', false);
		// Don't throw - cleanup failure shouldn't fail the backup creation
	}
}

/**
 * Create and upload backup to Google Drive
 * @returns {Promise<Object>} Result object with success status and file details
 */
async function createAndUploadBackup() {
	try {
		const stream = require('stream');

		// Get database path (from src/functions/Settings/backup to src/database)
		const dbPath = path.join(__dirname, '../../../database/Database.db');

		// Check if database file exists
		if (!fs.existsSync(dbPath)) {
			throw new Error('Database file not found');
		}

		// Check database file size
		const stats = fs.statSync(dbPath);
		if (stats.size === 0) {
			throw new Error('Database file is empty');
		}

		// Validate database integrity
		try {
			const db = new Database(dbPath, { readonly: true });
			const integrityResult = db.pragma('integrity_check');
			db.close();

			// integrity_check returns array of objects with 'integrity_check' property
			// If OK, returns [{ integrity_check: 'ok' }]
			if (!integrityResult || integrityResult.length === 0) {
				throw new Error('Database integrity check returned no results');
			}

			const firstResult = integrityResult[0];
			const checkValue = typeof firstResult === 'object' ? firstResult.integrity_check : firstResult;

			if (checkValue !== 'ok') {
				// Log full error details for debugging
				console.error('[Backup] Integrity check failed:', JSON.stringify(integrityResult));
				throw new Error(`Database integrity check failed: ${JSON.stringify(integrityResult.slice(0, 3))}`);
			}
		} catch (error) {
			// If the error is from our throw statements, pass it through
			if (error.message.includes('integrity check')) {
				throw error;
			}
			throw new Error(`Database validation failed: ${error.message}`);
		}

		// Create backup filename with timestamp
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').split('.')[0];
		const backupFilename = `WOS_Backup_${timestamp}.db`;

		// Create temporary backup path
		const tempDir = path.join(__dirname, '../../../temp');
		if (!fs.existsSync(tempDir)) {
			fs.mkdirSync(tempDir, { recursive: true });
		}
		const tempBackupPath = path.join(tempDir, backupFilename);

		// Use SQLite's backup API to create a consistent snapshot (handles WAL correctly)
		// This ensures we get a transactionally-consistent copy even while the database is in use
		const sourceDb = new Database(dbPath, { readonly: true });
		const backupDb = new Database(tempBackupPath);

		try {
			await new Promise((resolve, reject) => {
				try {
					sourceDb.backup(tempBackupPath)
						.then(() => {
							sourceDb.close();
							backupDb.close();
							resolve();
						})
						.catch(reject);
				} catch (error) {
					reject(error);
				}
			});
		} catch (backupError) {
			// Clean up source connection on error
			try { sourceDb.close(); } catch (e) { }
			try { backupDb.close(); } catch (e) { }
			throw new Error(`SQLite backup failed: ${backupError.message}`);
		}

		// Read the completed backup file
		const dbBuffer = fs.readFileSync(tempBackupPath);

		// Clean up temporary backup file
		fs.unlinkSync(tempBackupPath);

		// Get authenticated Drive client
		const drive = getAuthenticatedDriveClient();

		// Find or create backup folder
		const folderId = await findOrCreateBackupFolder(drive);

		// Upload to Google Drive in the wosland_backups folder
		const fileMetadata = {
			name: backupFilename,
			mimeType: 'application/x-sqlite3',
			parents: [folderId]
		};

		const media = {
			mimeType: 'application/x-sqlite3',
			body: stream.Readable.from(dbBuffer)
		};

		const file = await drive.files.create({
			resource: fileMetadata,
			media: media,
			fields: 'id, name, size, createdTime, webViewLink'
		});

		// Clean up old backups to maintain MAX_BACKUPS limit
		await cleanupOldBackups(drive, folderId);

		return {
			success: true,
			fileId: file.data.id,
			fileName: file.data.name,
			fileSize: parseInt(file.data.size),
			createdTime: file.data.createdTime,
			webViewLink: file.data.webViewLink
		};
	} catch (error) {
		await sendError(null, null, new Error(`Backup creation error: ${error.message}`), 'createAndUploadBackup', false);
		return {
			success: false,
			error: error.message
		};
	}
}

module.exports = {
	createBackupCreateButton,
	handleBackupCreateButton,
	showOAuthSetupGuide,
	showOAuthSetupGuideStep,
	handleOAuthGuideBackButton,
	handleOAuthGuideNextButton,
	showOAuthSetupPrompt,
	handleOAuthSetupButton,
	handleOAuthModal,
	showAuthorizationStep,
	handleOAuthCodeSubmitButton,
	handleOAuthCodeModal,
	getAuthenticatedDriveClient,
	createAndUploadBackup
};
