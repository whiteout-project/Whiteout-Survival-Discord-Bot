const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ContainerBuilder,
	FileUploadBuilder,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	SeparatorBuilder,
	SeparatorSpacingSize,
	TextDisplayBuilder,
	TextInputBuilder,
	TextInputStyle
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const https = require('https');
const AdmZip = require('adm-zip');
const Seven = require('node-7z');
const { acquire7z } = require('../utility/ensure7zip');
const Database = require('better-sqlite3');
const { getAdminLang, assertUserMatches, sendError, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../utility/emojis');
const {
	adminQueries,
	allianceQueries,
	playerQueries,
	idChannelQueries,
	furnaceChangeQueries,
	nicknameChangeQueries,
	migrationQueries
} = require('../utility/database');

/**
 * Creates database migration button
 * @param {string} userId
 * @param {Object} lang
 * @returns {ButtonBuilder}
 */
function createDBMigrationButton(userId, lang = {}) {
	return new ButtonBuilder()
		.setCustomId(`db_migration_button_${userId}`)
		.setLabel(lang.settings.mainPage.buttons.merge)
		.setStyle(ButtonStyle.Secondary)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1035'));
}

/**
 * Handle database migration button click
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleDBMigrationButton(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const expectedUserId = interaction.customId.split('_')[3];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		// Check if user is owner
		if (!adminData?.is_owner) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		// Create modal with file upload and password input
		const modal = new ModalBuilder()
			.setCustomId(`db_migration_modal_${interaction.user.id}`)
			.setTitle(lang.settings.migration.modal.title);

		// File upload for zip file
		const fileUpload = new FileUploadBuilder()
			.setCustomId('db_zip_file')
			.setRequired(true)
			.setMinValues(1)
			.setMaxValues(1);

		const fileLabel = new LabelBuilder()
			.setLabel(lang.settings.migration.modal.fileInput.label)
			.setFileUploadComponent(fileUpload);

		// Password input
		const passwordInput = new TextInputBuilder()
			.setCustomId('zip_password')
			.setStyle(TextInputStyle.Short)
			.setPlaceholder(lang.settings.migration.modal.passwordInput.placeholder)
			.setRequired(false)
			.setMaxLength(128);

		const passwordLabel = new LabelBuilder()
			.setLabel(lang.settings.migration.modal.passwordInput.label)
			.setTextInputComponent(passwordInput);

		modal.addLabelComponents(fileLabel, passwordLabel);
		await interaction.showModal(modal);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleDBMigrationButton');
	}
}

/**
 * Handle database migration modal submission
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleDBMigrationModal(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const expectedUserId = interaction.customId.split('_')[3];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		// Check if user is owner
		if (!adminData?.is_owner) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		// Get uploaded file and password
		const uploadedFiles = interaction.fields.getUploadedFiles('db_zip_file');
		if (!uploadedFiles || uploadedFiles.size === 0) {
			return await interaction.reply({
				content: lang.settings.migration.errors.noFile,
				ephemeral: true
			});
		}

		const file = uploadedFiles.first();
		if (!file.name.endsWith('.zip')) {
			return await interaction.reply({
				content: lang.settings.migration.errors.invalidFileType,
				ephemeral: true
			});
		}

		if (file.size && file.size > 50 * 1024 * 1024) {
			return await interaction.reply({
				content: lang.settings.migration.errors.fileTooLarge,
				ephemeral: true
			});
		}

		const password = interaction.fields.getTextInputValue('zip_password')?.trim() || '';


		// Before showing confirm/cancel, validate the uploaded zip (download + attempt extraction)
		const tempDir = path.join(__dirname, '../../../temp');
		await fs.promises.mkdir(tempDir, { recursive: true });
		const tempZipPath = path.join(tempDir, `migration_test_${Date.now()}_${Math.random().toString(36).slice(2,8)}.zip`);

		try {
			await downloadFile(file.url, tempZipPath);

			const testExtractPath = path.join(tempDir, `migration_test_${Date.now()}_${Math.random().toString(36).slice(2,8)}`);
			await fs.promises.mkdir(testExtractPath, { recursive: true });

			// Try to extract using 7-Zip (preferred) or AdmZip fallback
			let extractionError = null;
			try {
				const { binPath, cleanupPath } = await acquire7z(tempDir);
				if (!binPath) throw new Error('7z-not-available');

				const sevenStream = Seven.extractFull(tempZipPath, testExtractPath, {
					$bin: binPath,
					password: password || undefined,
					recursive: true
				});

				await new Promise((resolve, reject) => {
					sevenStream.on('end', resolve);
					sevenStream.on('error', (err) => reject(err));
				});

				if (cleanupPath) await fs.promises.unlink(cleanupPath).catch(() => {});
			} catch (err) {
				extractionError = err;
			}

			// If 7-Zip failed, try AdmZip when not encrypted (AdmZip cannot handle encrypted zips)
			if (extractionError) {
				try {
					const adm = new AdmZip(tempZipPath);
					adm.extractAllTo(testExtractPath, true);
					extractionError = null;
				} catch (admErr) {
					// keep extractionError
				}
			}

			// List extracted files and look for DB files
			const extracted = await listFilesRecursive(testExtractPath).catch(() => []);
			const foundDbFiles = extracted.filter(n => n.endsWith('.db') || n.endsWith('.sqlite'));

			// If extraction failed or no DB files found, treat as wrong password / corrupted archive
			if (extractionError || foundDbFiles.length === 0) {
				await fs.promises.unlink(tempZipPath).catch(() => {});
				await fs.promises.rm(testExtractPath, { recursive: true, force: true }).catch(() => {});

				const errorContainer = [
					new ContainerBuilder()
						.setAccentColor(0xe74c3c)
						.addTextDisplayComponents(
							new TextDisplayBuilder().setContent(
								`${lang.settings.migration.content.title.error}\n` +
								`${lang.settings.migration.errors.wrongPassword}`
							)
						)
				];
				const errorContent = updateComponentsV2AfterSeparator(interaction, errorContainer);
				return await interaction.update({ components: errorContent, flags: MessageFlags.IsComponentsV2 });
			}

			// Validation passed - remove test artifacts and proceed to show confirmation
			await fs.promises.unlink(tempZipPath).catch(() => {});
			await fs.promises.rm(testExtractPath, { recursive: true, force: true }).catch(() => {});

			// Show warning confirmation
			const confirmButton = new ButtonBuilder()
				.setCustomId(`db_migration_confirm_${interaction.user.id}`)
				.setLabel(lang.settings.migration.buttons.confirm)
				.setStyle(ButtonStyle.Danger)
				.setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1050'));

			const cancelButton = new ButtonBuilder()
				.setCustomId(`db_migration_cancel_${interaction.user.id}`)
				.setLabel(lang.settings.migration.buttons.cancel)
				.setStyle(ButtonStyle.Secondary)
				.setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1051'));

			const buttonRow = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

			// Store file URL and password temporarily
			const tempId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			if (!global.pendingDBMigrations) global.pendingDBMigrations = new Map();
			global.pendingDBMigrations.set(tempId, {
				fileUrl: file.url,
				password: password,
				userId: interaction.user.id,
				expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes
			});

			// Store tempId for confirmation
			confirmButton.setCustomId(`db_migration_confirm_${tempId}_${interaction.user.id}`);

			const container = [
				new ContainerBuilder()
					.setAccentColor(0xe74c3c)
					.addTextDisplayComponents(
						new TextDisplayBuilder().setContent(
							`${lang.settings.migration.content.title.base}\n` +
							`${lang.settings.migration.content.description.base}`
						)
					)
					.addSeparatorComponents(
						new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
					)
					.addActionRowComponents(buttonRow)
			];

			const content = updateComponentsV2AfterSeparator(interaction, container);
			return await interaction.update({
				components: content,
				flags: MessageFlags.IsComponentsV2
			});
		} catch (err) {
			// Download or validation failed
			await fs.promises.unlink(tempZipPath).catch(() => {});
			const errorContainer = [
				new ContainerBuilder()
					.setAccentColor(0xe74c3c)
					.addTextDisplayComponents(
						new TextDisplayBuilder().setContent(
							`${lang.settings.migration.content.title.error}\n` +
							`${lang.settings.migration.errors.corruptedFile}`
						)
					)
			];
			const errorContent = updateComponentsV2AfterSeparator(interaction, errorContainer);
			return await interaction.update({ components: errorContent, flags: MessageFlags.IsComponentsV2 });
		}
	} catch (error) {
		await sendError(interaction, lang, error, 'handleDBMigrationModal');
	}
}

async function handleDBMigrationCancel(interaction) {
	const { lang } = getAdminLang(interaction.user.id);
	try {
		const parts = interaction.customId.split('_');
		const expectedUserId = parts[3];

		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		const container = [
			new ContainerBuilder()
				.setAccentColor(0x95a5a6)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.migration.content.cancelled}`
					)
				)
		];

		const content = updateComponentsV2AfterSeparator(interaction, container);

		await interaction.update({
			components: content,
			flags: MessageFlags.IsComponentsV2
		});
	} catch (error) {
		await sendError(interaction, lang, error, 'handleDBMigrationCancel');
	}
}

/**
 * Handle database migration confirmation
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleDBMigrationConfirm(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const parts = interaction.customId.split('_');
		const tempId = parts[3];
		const expectedUserId = parts[4];

		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		// Check if user is owner
		if (!adminData?.is_owner) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		// Get pending migration data
		const pending = global.pendingDBMigrations?.get(tempId);
		if (!pending || pending.expiresAt < Date.now()) {
			global.pendingDBMigrations?.delete(tempId);
			return await interaction.reply({
				content: lang.settings.migration.errors.uploadExpired,
				ephemeral: true
			});
		}

		// Show processing message
		const processingContainer = [
			new ContainerBuilder()
				.setAccentColor(0xf39c12)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.migration.content.title.processing}\n` +
						`${lang.settings.migration.content.description.processing}`
					)
				)
		];
		const processingContent = updateComponentsV2AfterSeparator(interaction, processingContainer);
		await interaction.update({
			components: processingContent,
			flags: MessageFlags.IsComponentsV2
		});

		// Download and process the zip file
		const tempDir = path.join(__dirname, '../../../temp');
		await fs.promises.mkdir(tempDir, { recursive: true });
		const tempZipPath = path.join(tempDir, `migration_${tempId}.zip`);

		try {
			// Download file
			// console.log(`[MIGRATION] Starting download for tempId=${tempId} from ${pending.fileUrl}`);
			await downloadFile(pending.fileUrl, tempZipPath);
			try {
				const stats = await fs.promises.stat(tempZipPath);
				// console.log(`[MIGRATION] Download complete: ${tempZipPath} (${stats.size} bytes)`);
			} catch (e) {
				console.log(`[MIGRATION] Warning: downloaded file not found at ${tempZipPath}`);
			}

			// Extract zip with or without password
			const extractPath = path.join(tempDir, `migration_${tempId}`);

			try {
				// Check if zip is encrypted using adm-zip (for validation only)
				const zip = new AdmZip(tempZipPath);
				const entries = zip.getEntries();
				// console.log(`[MIGRATION] ZIP entries count: ${entries.length}`);
				try {
					const entryNames = entries.slice(0, 50).map(e => e.entryName);
					// console.log('[MIGRATION] ZIP sample entries:', entryNames);
				} catch (e) {
					console.log('[MIGRATION] Failed to list zip entry names:', e.message);
				}
				const isEncrypted = entries.some(entry => entry.header && entry.header.encrypted);

				if (isEncrypted && (!pending.password || pending.password.length === 0)) {
					// Encrypted but no password provided
					await fs.promises.unlink(tempZipPath).catch(() => { });
					global.pendingDBMigrations.delete(tempId);

					const errorContainer = [
						new ContainerBuilder()
							.setAccentColor(0xe74c3c)
							.addTextDisplayComponents(
								new TextDisplayBuilder().setContent(
									`${lang.settings.migration.content.error.title}\n` +
									`${lang.settings.migration.errors.passwordRequired || lang.settings.migration.errors.noPassword}`
								)
							)
					];
					const errorContent = updateComponentsV2AfterSeparator(interaction, errorContainer);
					return await interaction.editReply({
						components: errorContent,
						flags: MessageFlags.IsComponentsV2
					});
				}

				// Use 7zip for extraction (supports all encryption methods)
				// console.log(`[MIGRATION] Extracting zip to: ${extractPath} (password provided: ${pending.password ? 'YES' : 'NO'})`);
				await fs.promises.mkdir(extractPath, { recursive: true });

				// Try 7-Zip first (use shared helper; helper may return a temporary copy path to clean up)
				let sevenError = null;
				try {
					const { binPath, cleanupPath } = await acquire7z(tempDir);
					if (!binPath) {
						sevenError = new Error('7-Zip binary not available or not executable');
						throw sevenError;
					}

					const sevenStream = Seven.extractFull(tempZipPath, extractPath, {
						$bin: binPath,
						password: pending.password || undefined,
						recursive: true
					});

					await new Promise((resolve, reject) => {
						sevenStream.on('end', resolve);
						sevenStream.on('error', (err) => reject(err));
					});

					// cleanup copied binary (if helper created one)
					if (cleanupPath) {
						fs.promises.unlink(cleanupPath).catch(() => { });
					}
				} catch (err) {
					if (!sevenError) sevenError = err;
					console.error('[MIGRATION] 7-Zip extraction failed:', err && err.message ? err.message : err);
				}

				// If 7-Zip failed and archive is NOT encrypted, try AdmZip as a fallback
				if (sevenError && !isEncrypted) {
					try {
						// console.log('[MIGRATION] Attempting fallback extraction with AdmZip');
						const adm = new AdmZip(tempZipPath);
						adm.extractAllTo(extractPath, true);
						// console.log('[MIGRATION] Extraction completed with AdmZip fallback');
						sevenError = null; // consider succeeded
					} catch (admErr) {
						console.error('[MIGRATION] AdmZip fallback extraction failed:', admErr && admErr.message ? admErr.message : admErr);
					}
				}
			} catch (extractError) {

				// If extraction fails, likely wrong password or corrupted file
				await fs.promises.unlink(tempZipPath).catch(() => { });
				global.pendingDBMigrations.delete(tempId);

				// Check if it's a password error
				const isPasswordError = extractError.message &&
					(extractError.message.includes('Wrong Password') ||
						extractError.message.includes('password') ||
						extractError.message.includes('encrypted'));

				const errorContainer = [
					new ContainerBuilder()
						.setAccentColor(0xe74c3c)
						.addTextDisplayComponents(
							new TextDisplayBuilder().setContent(
								`${lang.settings.migration.content.title.error}\n` +
								`${isPasswordError ? lang.settings.migration.errors.wrongPassword : lang.settings.migration.errors.corruptedFile}\n`
							)
						)
				];
				const errorContent = updateComponentsV2AfterSeparator(interaction, errorContainer);
				return await interaction.editReply({
					components: errorContent,
					flags: MessageFlags.IsComponentsV2
				});
			}

			// Get list of extracted files from the directory (recursive)
			let extractedFiles = [];
			try {
				extractedFiles = await listFilesRecursive(extractPath);
				// console.log(`[MIGRATION] Found ${extractedFiles.length} extracted files under ${extractPath}`);
				// if (extractedFiles.length > 0) console.log('[MIGRATION] Sample extracted files:', extractedFiles.slice(0, 50));
			} catch (e) {
				console.error('[MIGRATION] Failed to list extracted files:', e.stack || e.message);
			}
			const dbFiles = extractedFiles
				.filter(fileName => fileName.endsWith('.db') || fileName.endsWith('.sqlite'))
				.filter(fileName => {
					const name = path.basename(fileName);
					// Exclude specific databases
					const excluded = ['beartime.sqlite', 'attendance.sqlite', 'backup.sqlite', 'svs.sqlite'];
					const include = !excluded.includes(name);
					// if (!include) console.log(`[MIGRATION] Excluding file by name: ${name}`);
					return include;
				})
				.map(fileName => ({
					name: path.basename(fileName),
					path: path.join(extractPath, fileName)
				}));

			// console.log(`[MIGRATION] DB candidates after filter: ${dbFiles.map(d => d.name).join(', ')}`);

			if (dbFiles.length === 0) {
				await fs.promises.unlink(tempZipPath).catch(() => { });
				await fs.promises.rm(extractPath, { recursive: true, force: true }).catch(() => { });
				global.pendingDBMigrations.delete(tempId);

				const errorContainer = [
					new ContainerBuilder()
						.setAccentColor(0xe74c3c)
						.addTextDisplayComponents(
							new TextDisplayBuilder().setContent(
								`${lang.settings.migration.content.error.title}\n` +
								`${lang.settings.migration.errors.noDbFiles}`
							)
						)
				];
				const errorContent = updateComponentsV2AfterSeparator(interaction, errorContainer);
				return await interaction.editReply({
					components: errorContent,
					flags: MessageFlags.IsComponentsV2
				});
			}

			// Validate extracted DBs: ensure they contain at least one table
			try {
				let allEmpty = true;
				for (const f of dbFiles) {
					try {
						const testDb = new Database(f.path, { readonly: true });
						const tables = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
						testDb.close();
						if (tables && tables.length > 0) {
							allEmpty = false;
							break;
						}
					} catch (e) {
						// invalid sqlite or cannot open => treat as empty
					}
				}

				if (allEmpty) {
					// Likely wrong password or corrupted archive
					await fs.promises.unlink(tempZipPath).catch(() => {});
					await fs.promises.rm(extractPath, { recursive: true, force: true }).catch(() => {});
					global.pendingDBMigrations.delete(tempId);

					const errorContainer = [
						new ContainerBuilder()
							.setAccentColor(0xe74c3c)
							.addTextDisplayComponents(
								new TextDisplayBuilder().setContent(
									`${lang.settings.migration.content.title.error}\n` +
									`${lang.settings.migration.errors.wrongPassword}`
								)
							)
					];
					const errorContent = updateComponentsV2AfterSeparator(interaction, errorContainer);
					return await interaction.editReply({
						components: errorContent,
						flags: MessageFlags.IsComponentsV2
					});
				}
			} catch (e) {
				// If validation itself fails, log and continue to let later logic handle it
				console.error('[MIGRATION] DB validation check failed:', e && e.message ? e.message : e);
			}

			// Perform migration
			const migrationResult = await performMigration(dbFiles, extractPath, interaction.user.id);

			// Clean up
			await fs.promises.unlink(tempZipPath).catch(() => { });
			await fs.promises.rm(extractPath, { recursive: true, force: true }).catch(() => { });
			global.pendingDBMigrations.delete(tempId);

			if (migrationResult.success) {
				const successContainer = [
					new ContainerBuilder()
						.setAccentColor(0x2ecc71)
						.addTextDisplayComponents(
							new TextDisplayBuilder().setContent(
								`${lang.settings.migration.content.title.success}\n` +

								`${lang.settings.migration.content.migratedDataField.name}\n` +
								`${lang.settings.migration.content.migratedDataField.value
									.replace('{alliancesCount}', migrationResult.stats.alliances)
									.replace('{playersCount}', migrationResult.stats.players)
									.replace('{adminsCount}', migrationResult.stats.admins)
									.replace('{idChannelsCount}', migrationResult.stats.idChannels)
									.replace('{furnaceChangesCount}', migrationResult.stats.furnaceChanges)
									.replace('{nicknameChangesCount}', migrationResult.stats.nicknameChanges)}`
							)
						)
				];

				const successContent = updateComponentsV2AfterSeparator(interaction, successContainer);
				await interaction.editReply({
					components: successContent,
					flags: MessageFlags.IsComponentsV2
				});
			} else {
				const errorContainer = [
					new ContainerBuilder()
						.setAccentColor(0xe74c3c)
						.addTextDisplayComponents(
							new TextDisplayBuilder().setContent(
								`${lang.settings.migration.content.title.error}\n` +
								`${migrationResult.error}`
							)
						)
				];
				const errorContent = updateComponentsV2AfterSeparator(interaction, errorContainer);
				await interaction.editReply({
					components: errorContent,
					flags: MessageFlags.IsComponentsV2
				});
			}

		} catch (error) {
			// Clean up on error
			await fs.promises.unlink(tempZipPath).catch(() => { });
			await fs.promises.rm(path.join(tempDir, `migration_${tempId}`), { recursive: true, force: true }).catch(() => { });
			global.pendingDBMigrations.delete(tempId);
			throw error;
		}

	} catch (error) {
		await sendError(interaction, lang, error, 'handleDBMigrationConfirm');
	}
}

/**
 * Download file from URL
 * @param {string} url
 * @param {string} outputPath
 * @returns {Promise<void>}
 */
function downloadFile(url, outputPath) {
	return new Promise((resolve, reject) => {
		let parsed;
		try {
			parsed = new URL(url);
		} catch (error) {
			return reject(error);
		}

		const allowedHosts = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
		if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname)) {
			return reject(new Error('Invalid or disallowed URL'));
		}

		const chunks = [];
		https.get(parsed, (res) => {
			res.on('data', chunk => chunks.push(chunk));
			res.on('end', async () => {
				try {
					await fs.promises.writeFile(outputPath, Buffer.concat(chunks));
					resolve();
				} catch (error) {
					reject(error);
				}
			});
		}).on('error', reject);
	});
}

/**
 * Recursively list all files under `dir` and return paths relative to `dir`.
 * Returns POSIX-style separators for consistency across platforms.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listFilesRecursive(dir) {
	const results = [];

	async function walk(current, base) {
		const entries = await fs.promises.readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			const rel = path.relative(base, fullPath).replace(/\\/g, '/');
			if (entry.isDirectory()) {
				await walk(fullPath, base);
			} else if (entry.isFile()) {
				results.push(rel);
			}
		}
	}

	await walk(dir, dir);
	return results;
}

/**
 * Convert old date format to ISO 8601 format
 * @param {string} oldDate - Date in old format
 * @returns {string} Date in ISO 8601 format
 */
function convertOldDateToISO(oldDate) {
	if (!oldDate) return new Date().toISOString();

	try {
		// Replace space with 'T' and append '.000Z' for milliseconds and UTC
		const isoDate = oldDate.replace(' ', 'T') + '.000Z';

		// Validate by creating a Date object
		const date = new Date(isoDate);
		if (isNaN(date.getTime())) {
			// Invalid date, return current timestamp
			return new Date().toISOString();
		}

		return isoDate;
	} catch (error) {
		// If conversion fails, return current timestamp
		return new Date().toISOString();
	}
}

/**
 * Perform complete database migration
 * @param {Array} dbFiles - Array of {name, path} objects
 * @param {string} extractPath - Path to extracted files
 * @param {string} ownerId - Owner user ID
 * @returns {Promise<Object>}
 */
async function performMigration(dbFiles, extractPath, ownerId) {
	const stats = {
		alliances: 0,
		players: 0,
		admins: 0,
		idChannels: 0,
		furnaceChanges: 0,
		nicknameChanges: 0
	};

	try {
		const dbMap = {};
		dbFiles.forEach(file => {
			dbMap[file.name] = file.path;
		});

		// Clear existing data before migration
		await clearExistingData();

		// Map to store old alliance ID -> new alliance ID
		const allianceIdMap = new Map();

		// Step 1: Migrate alliances first (needed for foreign keys)
		if (dbMap['alliance.sqlite']) {
			const result = await migrateAlliances(dbMap['alliance.sqlite'], dbMap['giftcode.sqlite'], ownerId, allianceIdMap);
			stats.alliances = result;
		}

		// Step 2: Migrate admins
		if (dbMap['settings.sqlite']) {
			const result = await migrateAdmins(dbMap['settings.sqlite'], allianceIdMap);
			stats.admins = result;
		}

		// Step 3: Migrate players (requires alliances to exist)
		if (dbMap['users.sqlite']) {
			const result = await migratePlayers(dbMap['users.sqlite'], allianceIdMap, ownerId);
			stats.players = result;
		}

		// Step 4: Migrate ID channels
		if (dbMap['id_channel.sqlite']) {
			const result = await migrateIdChannels(dbMap['id_channel.sqlite'], allianceIdMap);
			stats.idChannels = result;
		}

		// Step 5: Migrate changes
		if (dbMap['changes.sqlite']) {
			const result = await migrateChanges(dbMap['changes.sqlite']);
			stats.furnaceChanges = result.furnace;
			stats.nicknameChanges = result.nickname;
		}

		return { success: true, stats };
	} catch (error) {
		console.error('Migration error:', error);
		return { success: false, error: error.message };
	}
}

/**
 * Clear existing data from all tables (except settings and custom_emojis)
 * @returns {Promise<void>}
 */
async function clearExistingData() {
	migrationQueries.clearAllData();
}

/**
 * Migrate alliance data
 * @param {string} alliancePath - Path to alliance.sqlite
 * @param {string} giftcodePath - Path to giftcode.sqlite (optional)
 * @param {string} ownerId - Owner user ID
 * @param {Map} allianceIdMap - Map to store old->new alliance ID mappings
 * @returns {Promise<number>}
 */
async function migrateAlliances(alliancePath, giftcodePath, ownerId, allianceIdMap) {
	const oldDb = new Database(alliancePath, { readonly: true });
	let giftcodeDb = null;

	try {
		if (giftcodePath && fs.existsSync(giftcodePath)) {
			giftcodeDb = new Database(giftcodePath, { readonly: true });
		}

		// Get all alliance data (cast Discord IDs to TEXT to prevent precision loss)
		const allianceList = oldDb.prepare('SELECT alliance_id, name, CAST(discord_server_id AS TEXT) as discord_server_id FROM alliance_list ORDER BY alliance_id').all();
		const allianceSettings = oldDb.prepare('SELECT alliance_id, CAST(channel_id AS TEXT) as channel_id, interval FROM alliancesettings').all();

		// Get auto-redeem settings if available
		let autoRedeemMap = new Map();
		if (giftcodeDb) {
			try {
				const autoRedeemData = giftcodeDb.prepare('SELECT alliance_id, status FROM giftcodecontrol').all();
				autoRedeemData.forEach(row => {
					autoRedeemMap.set(row.alliance_id, row.status);
				});
			} catch (e) {
				// Table might not exist, ignore
			}
		}

		// Create settings map for quick lookup
		const settingsMap = new Map();
		allianceSettings.forEach(s => {
			settingsMap.set(s.alliance_id, s);
		});

		let count = 0;
		let priority = 1;

		// Migrate each alliance with sequential priority
		for (const old of allianceList) {
			const settings = settingsMap.get(old.alliance_id);
			const autoRedeem = autoRedeemMap.get(old.alliance_id) ?? 0;

			const result = allianceQueries.addAlliance(
				priority,                                      // priority (sequential)
				old.name,                                      // name
				old.discord_server_id || null,                 // guide_id (already TEXT from query)
				settings?.channel_id || null,                   // channel_id (already TEXT from query)
				settings?.interval?.toString() || null,        // interval
				autoRedeem,                                     // auto_redeem from giftcodecontrol
				ownerId                                         // created_by (owner)
			);

			// Store mapping: old alliance_id -> new alliance id
			allianceIdMap.set(old.alliance_id, result.lastInsertRowid);
			priority++;
			count++;
		}

		return count;
	} finally {
		oldDb.close();
		if (giftcodeDb) giftcodeDb.close();
	}
}

/**
 * Migrate player data
 * @param {string} usersPath - Path to users.sqlite
 * @param {Map} allianceIdMap - Map of old->new alliance IDs
 * @param {string} ownerId - Owner user ID
 * @returns {Promise<number>}
 */
async function migratePlayers(usersPath, allianceIdMap, ownerId) {
	const oldDb = new Database(usersPath, { readonly: true });

	try {
		const users = oldDb.prepare('SELECT * FROM users').all();
		let count = 0;

		for (const old of users) {
			// Parse alliance ID (stored as string in old DB)
			const oldAllianceId = parseInt(old.alliance);
			const newAllianceId = allianceIdMap.get(oldAllianceId);

			// Skip if alliance doesn't exist in new DB
			if (!newAllianceId) {
				// console.warn(`Skipping player ${old.fid}: Alliance ${oldAllianceId} not found`);
				continue;
			}

			try {
				playerQueries.addPlayer(
					old.fid,                    // fid
					null,                       // user_id (set to null)
					old.nickname,               // nickname
					old.furnace_lv,             // furnace_level
					old.kid,                    // state (using old.kid)
					null,                       // image_url (set to null)
					newAllianceId,              // alliance_id (mapped to new ID)
					ownerId                     // added_by (owner)
				);
				count++;
			} catch (e) {
				// Player might already exist, skip
				console.warn(`Skipping duplicate player ${old.fid}`);
			}
		}

		return count;
	} finally {
		oldDb.close();
	}
}

/**
 * Migrate admin data
 * @param {string} settingsPath - Path to settings.sqlite
 * @param {Map} allianceIdMap - Map of old->new alliance IDs
 * @returns {Promise<number>}
 */
async function migrateAdmins(settingsPath, allianceIdMap) {
	const oldDb = new Database(settingsPath, { readonly: true });

	try {
		// Cast id to TEXT to prevent precision loss with large Discord IDs
		const admins = oldDb.prepare('SELECT CAST(id AS TEXT) as id, is_initial FROM admin').all();
		const adminServer = oldDb.prepare('SELECT CAST(admin AS TEXT) as admin, alliances_id FROM adminserver').all();

		// Build admin->alliances mapping
		const adminAlliancesMap = new Map();
		adminServer.forEach(row => {
			const adminId = row.admin; // Already TEXT from CAST
			const oldAllianceId = row.alliances_id;
			const newAllianceId = allianceIdMap.get(oldAllianceId);

			if (newAllianceId) {
				if (!adminAlliancesMap.has(adminId)) {
					adminAlliancesMap.set(adminId, []);
				}
				adminAlliancesMap.get(adminId).push(newAllianceId);
			}
		});

		let count = 0;

		for (const old of admins) {
			const userId = old.id; // Already TEXT from CAST
			const alliances = adminAlliancesMap.get(userId) || [];

			try {
				adminQueries.addAdmin(
					userId,                                // user_id
					'migration',                           // added_by
					0,                                     // permissions (default)
					JSON.stringify(alliances),             // alliances (mapped to new IDs)
					old.is_initial ? 1 : 0,                // is_owner
					'NA'                                   // language (NA to prompt selection)
				);
				count++;
			} catch (e) {
				// Admin might already exist, skip
				console.warn(`Skipping duplicate admin ${userId}`);
			}
		}

		return count;
	} finally {
		oldDb.close();
	}
}

/**
 * Migrate ID channels data
 * @param {string} idChannelPath - Path to id_channel.sqlite
 * @param {Map} allianceIdMap - Map of old->new alliance IDs
 * @returns {Promise<number>}
 */
async function migrateIdChannels(idChannelPath, allianceIdMap) {
	const oldDb = new Database(idChannelPath, { readonly: true });

	try {
		// Cast Discord IDs to TEXT to prevent precision loss (old database uses 'guild_id', new uses 'guide_id')
		const channels = oldDb.prepare('SELECT CAST(guild_id AS TEXT) as guild_id, alliance_id, CAST(channel_id AS TEXT) as channel_id, CAST(created_by AS TEXT) as created_by FROM id_channels').all();
		let count = 0;

		for (const old of channels) {
			const newAllianceId = allianceIdMap.get(old.alliance_id);

			// Skip if alliance doesn't exist
			if (!newAllianceId) {
				console.warn(`Skipping ID channel: Alliance ${old.alliance_id} not found`);
				continue;
			}

			try {
				idChannelQueries.addIdChannel(
					old.guild_id || null,                  // guide_id (mapped from guild_id, already TEXT from query)
					newAllianceId,                         // alliance_id (mapped to new ID)
					old.channel_id || null,                // channel_id (already TEXT from query)
					old.created_by || null                 // linked_by (already TEXT from query)
				);
				count++;
			} catch (e) {
				// Channel might already exist, skip
				console.warn(`Skipping duplicate ID channel ${old.channel_id}`);
			}
		}

		return count;
	} finally {
		oldDb.close();
	}
}

/**
 * Migrate furnace and nickname changes
 * @param {string} changesPath - Path to changes.sqlite
 * @returns {Promise<Object>}
 */
async function migrateChanges(changesPath) {
	const oldDb = new Database(changesPath, { readonly: true });

	try {
		const furnaceChanges = oldDb.prepare('SELECT * FROM furnace_changes').all();
		const nicknameChanges = oldDb.prepare('SELECT * FROM nickname_changes').all();

		let furnaceCount = 0;
		let nicknameCount = 0;

		// Migrate furnace changes in reverse order (newest first when queried)
		// Reverse the array so older changes get lower IDs (displayed at bottom)
		for (const old of furnaceChanges.reverse()) {
			try {
				furnaceChangeQueries.rawInsert.run(
					old.fid,
					old.old_furnace_lv,
					old.new_furnace_lv,
					convertOldDateToISO(old.change_date)
				);
				furnaceCount++;
			} catch (e) {
				// Skip duplicates
			}
		}

		// Migrate nickname changes in reverse order (newest first when queried)
		// Reverse the array so older changes get lower IDs (displayed at bottom)
		for (const old of nicknameChanges.reverse()) {
			try {
				nicknameChangeQueries.rawInsert.run(
					old.fid,
					old.old_nickname,
					old.new_nickname,
					convertOldDateToISO(old.change_date)
				);
				nicknameCount++;
			} catch (e) {
				// Skip duplicates
			}
		}

		return { furnace: furnaceCount, nickname: nicknameCount };
	} finally {
		oldDb.close();
	}
}

module.exports = {
	createDBMigrationButton,
	handleDBMigrationButton,
	handleDBMigrationModal,
	handleDBMigrationConfirm,
	handleDBMigrationCancel
};
