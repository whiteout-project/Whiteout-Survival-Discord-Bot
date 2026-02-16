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
const { customEmojiQueries } = require('../../utility/database');
const { uploadEmojiPackFromJson, getAvailableEmojiSlots } = require('./emojisUploader');
const { getAdminLang, assertUserMatches, sendError, updateComponentsV2AfterSeparator, hasPermission } = require('../../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../../utility/emojis');
const { PERMISSIONS } = require('../admin/permissions');

/**
 * Creates emoji upload button
 * @param {string} userId
 * @param {Object} lang
 * @returns {ButtonBuilder}
 */
function createEmojiUploadButton(userId, lang = {}) {
	return new ButtonBuilder()
		.setCustomId(`emoji_theme_upload_${userId}`)
		.setLabel(lang.settings.theme.mainPage.buttons.uploadPack)
		.setStyle(ButtonStyle.Secondary)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1000'));
}

async function handleEmojiUploadButton(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const expectedUserId = interaction.customId.split('_')[3];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		const hasFullAccess = await hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

		if (!hasFullAccess) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		const modal = new ModalBuilder()
			.setCustomId(`emoji_upload_modal_${interaction.user.id}`)
			.setTitle(lang.settings.theme.importPack.modal.title.fileUpload);

		const fileUpload = new FileUploadBuilder()
			.setCustomId('emoji_pack_file')
			.setRequired(true)
			.setMinValues(1)
			.setMaxValues(1);

		const fileLabel = new LabelBuilder()
			.setLabel(lang.settings.theme.importPack.modal.fileInput.label)
			.setFileUploadComponent(fileUpload);

		modal.addLabelComponents(fileLabel);
		await interaction.showModal(modal);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiUploadButton');
	}
}

async function handleEmojiUploadModal(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const expectedUserId = interaction.customId.split('_')[3];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		const hasFullAccess = await hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

		if (!hasFullAccess) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		const uploadedFiles = interaction.fields.getUploadedFiles('emoji_pack_file');
		if (!uploadedFiles || uploadedFiles.size === 0) {
			return await interaction.reply({
				content: lang.settings.theme.importPack.errors.invalidFile,
				ephemeral: true
			});
		}

		const file = uploadedFiles.first();
		if (!file.name.endsWith('.json')) {
			return await interaction.reply({
				content: lang.settings.theme.importPack.errors.invalidFileType,
				ephemeral: true
			});
		}

		if (file.size && file.size > 5 * 1024 * 1024) {
			return await interaction.reply({
				content: lang.settings.theme.importPack.errors.fileTooLarge,
				ephemeral: true
			});
		}

		const tempDir = path.join(__dirname, '../../../temp');
		await fs.promises.mkdir(tempDir, { recursive: true });
		const tempId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const tempPath = path.join(tempDir, `${tempId}.json`);

		const fileBuffer = await downloadFileBuffer(file.url);
		await fs.promises.writeFile(tempPath, fileBuffer);

		const raw = await fs.promises.readFile(tempPath, 'utf8');
		const parsed = JSON.parse(raw);
		const name = String(parsed.name || '').trim();
		if (!name) {
			await fs.promises.unlink(tempPath);
			return await interaction.reply({
				content: lang.settings.theme.importPack.errors.missingInfo,
				ephemeral: true
			});
		}

		const existing = customEmojiQueries.getCustomEmojiSetByName(name);
		if (existing) {
			if (!global.pendingEmojiUploads) global.pendingEmojiUploads = new Map();
			global.pendingEmojiUploads.set(tempId, { path: tempPath, name });

			const renameButton = new ButtonBuilder()
				.setCustomId(`emoji_upload_rename_${tempId}_${interaction.user.id}`)
				.setLabel(lang.settings.theme.importPack.buttons.rename)
				.setStyle(ButtonStyle.Primary)
				.setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1008'));

			const container = [
				new ContainerBuilder()
					.setAccentColor(0xe67e22)
					.addTextDisplayComponents(
						new TextDisplayBuilder().setContent(
							`${lang.settings.theme.importPack.errors.nameExists}`
						)
					)
					.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
					.addActionRowComponents(new ActionRowBuilder().addComponents(renameButton))
			];

			const content = updateComponentsV2AfterSeparator(interaction, container);
			return await interaction.update({
				components: content,
				flags: MessageFlags.IsComponentsV2
			});
		}

		// Show processing message before upload
		const processingContainer = [
			new ContainerBuilder()
				.setAccentColor(0x3498db)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.theme.importPack.content.title.main}\n` +
						`⏳ ${lang.common.pleaseWait || 'Processing upload...'}`
					)
				)
		];
		const processingContent = updateComponentsV2AfterSeparator(interaction, processingContainer);
		await interaction.update({
			components: processingContent,
			flags: MessageFlags.IsComponentsV2
		});

		await finalizeEmojiUpload(interaction, tempPath, lang, true);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiUploadModal');
	}
}

function downloadFileBuffer(url) {
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

		https.get(parsed, (res) => {
			const chunks = [];
			res.on('data', chunk => chunks.push(chunk));
			res.on('end', () => resolve(Buffer.concat(chunks)));
		}).on('error', reject);
	});
}

async function handleEmojiUploadRenameButton(interaction) {
	const { lang } = getAdminLang(interaction.user.id);
	try {
		const parts = interaction.customId.split('_');
		const tempId = parts[3];
		const expectedUserId = parts[4];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		const modal = new ModalBuilder()
			.setCustomId(`emoji_upload_rename_modal_${tempId}_${interaction.user.id}`)
			.setTitle(lang.settings.theme.importPack.modal.title.rename);

		const nameInput = new TextInputBuilder()
			.setCustomId('emoji_set_name')
			.setStyle(TextInputStyle.Short)
			.setPlaceholder(lang.settings.theme.importPack.modal.nameInput.placeholder)
			.setRequired(true)
			.setMaxLength(32);

		const nameLabel = new LabelBuilder()
			.setLabel(lang.settings.theme.importPack.modal.nameInput.label)
			.setTextInputComponent(nameInput);

		modal.addLabelComponents(nameLabel);
		await interaction.showModal(modal);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiUploadRenameButton');
	}
}

async function handleEmojiUploadRenameModal(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const parts = interaction.customId.split('_');
		const tempId = parts[4];
		const expectedUserId = parts[5];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		const hasFullAccess = await hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

		if (!hasFullAccess) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		const pending = global.pendingEmojiUploads?.get(tempId);
		if (!pending) {
			return await interaction.reply({
				content: lang.settings.theme.importPack.errors.uploadExpired,
				ephemeral: true
			});
		}

		const newName = interaction.fields.getTextInputValue('emoji_set_name').trim();
		if (!newName) {
			return await interaction.reply({
				content: lang.settings.theme.importPack.errors.invalidName,
				ephemeral: true
			});
		}

		const existing = customEmojiQueries.getCustomEmojiSetByName(newName);
		if (existing) {
			return await interaction.reply({
				content: lang.settings.theme.importPack.errors.nameExists,
				ephemeral: true
			});
		}

		const raw = await fs.promises.readFile(pending.path, 'utf8');
		const parsed = JSON.parse(raw);
		parsed.name = newName;
		await fs.promises.writeFile(pending.path, JSON.stringify(parsed, null, 2));

		global.pendingEmojiUploads.delete(tempId);

		// Show processing message
		const processingContainer = [
			new ContainerBuilder()
				.setAccentColor(0x3498db)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.theme.importPack.content.title.main}\n` +
						`${lang.settings.theme.importPack.content.wait}`
					)
				)
		];
		const processingContent = updateComponentsV2AfterSeparator(interaction, processingContainer);
		await interaction.update({
			components: processingContent,
			flags: MessageFlags.IsComponentsV2
		});

		await finalizeEmojiUpload(interaction, pending.path, lang, true);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiUploadRenameModal');
	}
}

async function finalizeEmojiUpload(interaction, tempPath, lang, useEditReply = false) {
	try {
		const raw = await fs.promises.readFile(tempPath, 'utf8');
		const parsed = JSON.parse(raw);

		// Get default pack to use as base
		const defaultPack = customEmojiQueries.getCustomEmojiSetByName('wosland');
		if (!defaultPack || !defaultPack.data) {
			await fs.promises.unlink(tempPath).catch(() => { });
			return await interaction.reply({
				content: lang.settings.theme.importPack.errors.defaultPack,
				ephemeral: true
			});
		}

		const defaultData = JSON.parse(defaultPack.data);
		const baseEmojis = { ...(defaultData.emojis || {}) };

		// Count emojis to upload (only entries with data that differ from base)
		const entries = Object.entries(parsed).filter(([key]) => key !== 'name');
		const emojisToUpload = entries.filter(([, value]) => value && value.format && value.data);

		if (emojisToUpload.length === 0) {
			// No emojis to upload, just create pack with default emojis
			const packData = {
				name: parsed.name,
				emojis: baseEmojis
			};
			customEmojiQueries.addCustomEmojiSet(packData.name, JSON.stringify(packData), 0);
			await fs.promises.unlink(tempPath).catch(() => { });

			const container = [
				new ContainerBuilder()
					.setAccentColor(0x2ecc71)
					.addTextDisplayComponents(
						new TextDisplayBuilder().setContent(
							`${lang.settings.theme.importPack.content.title.success}\n` +
							`${lang.settings.theme.importPack.content.description.uploadSuccess}`
						)
					)
			];

			const content = updateComponentsV2AfterSeparator(interaction, container);
			if (useEditReply) {
				return await interaction.editReply({
					components: content,
					flags: MessageFlags.IsComponentsV2
				});
			} else {
				return await interaction.update({
					components: content,
					flags: MessageFlags.IsComponentsV2
				});
			}
		}

		await interaction.client.application.fetch();
		const appId = interaction.client.application.id;
		const availableSlots = await getAvailableEmojiSlots(interaction.client, appId);

		if (emojisToUpload.length > availableSlots) {
			await fs.promises.unlink(tempPath).catch(() => { });
			const errorMsg = lang.settings.theme.importPack.errors.slotsNotEnough
				.replace('{required}', emojisToUpload.length)
				.replace('{available}', availableSlots);
			return await interaction.reply({
				content: errorMsg,
				ephemeral: true
			});
		}

		const uploaded = await uploadEmojiPackFromJson(interaction.client, tempPath);

		// Merge uploaded emojis with base emojis
		const finalEmojis = { ...baseEmojis };
		for (const [key, value] of Object.entries(uploaded.emojis || {})) {
			finalEmojis[key] = value;
		}

		const packData = {
			name: uploaded.name,
			emojis: finalEmojis
		};

		customEmojiQueries.addCustomEmojiSet(packData.name, JSON.stringify(packData), 0);
		await fs.promises.unlink(tempPath).catch(() => { });

		const container = [
			new ContainerBuilder()
				.setAccentColor(0x2ecc71)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.theme.importPack.content.title.success}\n` +
						`${lang.settings.theme.importPack.content.description.uploadSuccess}`
					)
				)
		];

		const content = updateComponentsV2AfterSeparator(interaction, container);
		if (useEditReply) {
			await interaction.editReply({
				components: content,
				flags: MessageFlags.IsComponentsV2
			});
		} else {
			await interaction.update({
				components: content,
				flags: MessageFlags.IsComponentsV2
			});
		}
	} catch (error) {
		// Ensure temp file is cleaned up even on error
		await fs.promises.unlink(tempPath).catch(() => { });
		throw error;
	}
}

module.exports = {
	createEmojiUploadButton,
	handleEmojiUploadButton,
	handleEmojiUploadModal,
	handleEmojiUploadRenameButton,
	handleEmojiUploadRenameModal
};
