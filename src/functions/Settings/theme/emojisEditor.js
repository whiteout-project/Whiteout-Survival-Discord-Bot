const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ContainerBuilder,
	FileUploadBuilder,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	SectionBuilder,
	SeparatorBuilder,
	SeparatorSpacingSize,
	TextDisplayBuilder,
	TextInputBuilder,
	TextInputStyle
} = require('discord.js');
const https = require('https');
const { Routes } = require('discord.js');
const { customEmojiQueries } = require('../../utility/database');
const { EMOJI_DEFINITIONS } = require('../../utility/emojis');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../../Pagination/universalPagination');
const { getAdminLang, assertUserMatches, sendError, hasPermission } = require('../../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../../utility/emojis');
const { PERMISSIONS } = require('../admin/permissions');
const { getAvailableEmojiSlots } = require('./emojisUploader');

const ITEMS_PER_PAGE = 8;

function sanitizeEmojiName(name) {
	return name.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32);
}

function parseSetData(set) {
	if (!set?.data) return { name: set?.name || 'set', emojis: {} };
	try {
		const parsed = JSON.parse(set.data);
		return {
			name: parsed.name || set.name || 'set',
			emojis: parsed.emojis || {}
		};
	} catch {
		return { name: set.name || 'set', emojis: {} };
	}
}

function getEmojiDisplay(entry) {
	if (!entry) return 'Not set';
	if (entry.unicode) return entry.unicode;
	if (entry.id && entry.name) {
		// Check both animated field and format field (gif = animated)
		const isAnimated = entry.animated || entry.format === 'gif';
		const prefix = isAnimated ? 'a' : '';
		return `<${prefix}:${entry.name}:${entry.id}>`;
	}
	return 'Not set';
}

async function downloadToBuffer(url, lang) {
	return new Promise((resolve, reject) => {
		const allowedHosts = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
		const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);
		const MAX_SIZE = 300 * 1024; // 300KB

		let parsed;
		try {
			parsed = new URL(url);
		} catch (error) {
			return reject(new Error(lang.settings.theme.packEditor.errors.invalidUrl));
		}

		if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname)) {
			return reject(new Error(lang.settings.theme.packEditor.errors.disallowedHost));
		}

		https.get(parsed, (res) => {
			// Check content type
			const contentType = res.headers['content-type']?.toLowerCase().split(';')[0];
			if (!contentType || !allowedTypes.has(contentType)) {
				res.destroy();
				return reject(new Error(lang.settings.theme.packEditor.errors.invalidFileType.replace('{contentType}', contentType || 'unknown')));
			}

			// Check content length if provided
			const contentLength = parseInt(res.headers['content-length'], 10);
			if (contentLength && contentLength > MAX_SIZE) {
				res.destroy();
				return reject(new Error(lang.settings.theme.packEditor.errors.fileTooLarge.replace('{size}', (contentLength / 1024).toFixed(1))));
			}

			const chunks = [];
			let downloadedBytes = 0;

			res.on('data', (chunk) => {
				downloadedBytes += chunk.length;

				// Abort if exceeds max size during download
				if (downloadedBytes > MAX_SIZE) {
					res.destroy();
					return reject(new Error(lang.settings.theme.packEditor.errors.fileSizeExceeded.replace('{size}', (downloadedBytes / 1024).toFixed(1))));
				}

				chunks.push(chunk);
			});

			res.on('end', () => {
				if (downloadedBytes > MAX_SIZE) {
					return reject(new Error(lang.settings.theme.packEditor.errors.fileTooLarge.replace('{size}', (downloadedBytes / 1024).toFixed(1))));
				}
				resolve(Buffer.concat(chunks));
			});
		}).on('error', (error) => {
			reject(new Error(lang.settings.theme.packEditor.errors.downloadFailed.replace('{error}', error.message)));
		});
	});
}

async function uploadEmoji(client, name, buffer, mimeType) {
	await client.application.fetch();
	const appId = client.application.id;
	const image = `data:${mimeType};base64,${buffer.toString('base64')}`;
	return client.rest.post(Routes.applicationEmojis(appId), {
		body: { name, image }
	});
}

async function deleteEmojiIfExists(client, emojiId) {
	if (!emojiId) return;
	await client.application.fetch();
	const appId = client.application.id;
	try {
		await client.rest.delete(Routes.applicationEmoji(appId, emojiId));
	} catch {
		// ignore delete failures
	}
}

function getPageDefinitions(page) {
	const start = page * ITEMS_PER_PAGE;
	const end = start + ITEMS_PER_PAGE;
	return EMOJI_DEFINITIONS.slice(start, end);
}

async function showEmojiEditor(interaction, setId, page, lang) {
	const set = customEmojiQueries.getCustomEmojiSetById(setId);
	if (!set) {
		return await interaction.reply({
			content: lang.common.error,
			ephemeral: true
		});
	}

	const data = parseSetData(set);
	const totalPages = Math.ceil(EMOJI_DEFINITIONS.length / ITEMS_PER_PAGE);
	const pageDefs = getPageDefinitions(page);

	const container = new ContainerBuilder()
		.setAccentColor(0x8e44ad)
		.addTextDisplayComponents(
			new TextDisplayBuilder().setContent(
				`${lang.settings.theme.packEditor.content.title.replace("{packName}", set.name)}\n` +
				`${lang.pagination.text.pageInfo
					.replace('{current}', (page + 1).toString())
					.replace('{total}', totalPages.toString())}`
			)
		)
		.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

	// Add each emoji as a section with button accessory
	pageDefs.forEach((def, index) => {
		const key = String(def.key);
		const entry = data.emojis[key];
		const display = getEmojiDisplay(entry);

		const editButton = new ButtonBuilder()
			.setCustomId(`emoji_editor_open_${setId}_${key}_${page}_${interaction.user.id}`)
			.setLabel(lang.settings.theme.packEditor.buttons.editEmoji)
			.setStyle(ButtonStyle.Secondary)
			.setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1008'));


		const section = new SectionBuilder()
			.setButtonAccessory(editButton)
			.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(`# ${display}`)
			);

		container.addSectionComponents(section);

		// Add separator after each section except the last one
		if (index < pageDefs.length - 1) {
			container.addSeparatorComponents(
				new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
			);
		}
	});

	// Add final separator before pagination/save buttons
	container.addSeparatorComponents(
		new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
	);

	// Create save/back button
	const saveButton = new ButtonBuilder()
		.setCustomId(`emoji_theme_${interaction.user.id}`)
		.setLabel(lang.settings.theme.packEditor.buttons.savePack)
		.setStyle(ButtonStyle.Primary)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1037'));

	// Add pagination with save button in the same row
	const paginationRow = createUniversalPaginationButtons({
		feature: 'emoji_editor',
		userId: interaction.user.id,
		currentPage: page,
		totalPages,
		lang,
		contextData: [setId]
	});

	if (paginationRow) {
		// Add save button to pagination row
		paginationRow.addComponents(saveButton);
		container.addActionRowComponents(paginationRow);
	} else {
		// No pagination needed, just add save button
		const saveRow = new ActionRowBuilder().addComponents(saveButton);
		container.addActionRowComponents(saveRow);
	}

	await interaction.update({
		components: [container],
		flags: MessageFlags.IsComponentsV2
	});
}

async function handleEmojiEditorButton(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const parts = interaction.customId.split('_');
		const setId = parseInt(parts[3], 10);
		const emojiKey = parts[4];
		const page = parseInt(parts[5], 10);
		const expectedUserId = parts[6];

		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		const hasFullAccess = await hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
		if (!hasFullAccess) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		const modal = new ModalBuilder()
			.setCustomId(`emoji_editor_modal_${setId}_${emojiKey}_${page}_${interaction.user.id}`)
			.setTitle(lang.settings.theme.packEditor.modal.title);

		const emojiInput = new TextInputBuilder()
			.setCustomId('emoji_input')
			.setStyle(TextInputStyle.Short)
			.setPlaceholder(lang.settings.theme.packEditor.modal.emojiInput.placeholder)
			.setRequired(false);

		const emojiLabel = new LabelBuilder()
			.setLabel(lang.settings.theme.packEditor.modal.emojiInput.label)
			.setDescription(lang.settings.theme.packEditor.modal.emojiInput.description)
			.setTextInputComponent(emojiInput);

		const fileUpload = new FileUploadBuilder()
			.setCustomId('emoji_file')
			.setRequired(false)
			.setMinValues(0)
			.setMaxValues(1);

		const fileLabel = new LabelBuilder()
			.setLabel(lang.settings.theme.packEditor.modal.fileInput.label)
			.setDescription(lang.settings.theme.packEditor.modal.fileInput.description)
			.setFileUploadComponent(fileUpload);

		modal.addLabelComponents(emojiLabel, fileLabel);
		await interaction.showModal(modal);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiEditorButton');
	}
}

async function handleEmojiEditorModal(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const parts = interaction.customId.split('_');
		const setId = parseInt(parts[3], 10);
		const emojiKey = parts[4];
		const page = parseInt(parts[5], 10);
		const expectedUserId = parts[6];

		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		const hasFullAccess = await hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
		if (!hasFullAccess) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		const set = customEmojiQueries.getCustomEmojiSetById(setId);
		if (!set) {
			return await interaction.reply({
				content: lang.common.error,
				ephemeral: true
			});
		}

		const data = parseSetData(set);
		const emojiInput = interaction.fields.getTextInputValue('emoji_input').trim();
		const uploadedFiles = interaction.fields.getUploadedFiles?.('emoji_file');
		const fileData = uploadedFiles && uploadedFiles.size > 0 ? uploadedFiles.first() : null;

		if (!emojiInput && !fileData) {
			return await interaction.reply({
				content: lang.settings.theme.packEditor.errors.noEmojiProvided,
				ephemeral: true
			});
		}

		const currentEntry = data.emojis[emojiKey];
		const def = EMOJI_DEFINITIONS.find(d => String(d.key) === String(emojiKey));
		const baseName = `${data.name}_${emojiKey}`;
		const emojiName = sanitizeEmojiName(baseName);
		const packPrefix = sanitizeEmojiName(data.name);

		// Check if we're replacing an existing emoji from this pack or adding a new one
		const isReplacing = currentEntry?.id && currentEntry?.name?.startsWith(packPrefix);

		// If adding new emoji (not replacing), check available slots
		if (!isReplacing) {
			await interaction.client.application.fetch();
			const appId = interaction.client.application.id;
			const availableSlots = await getAvailableEmojiSlots(interaction.client, appId);
			if (availableSlots < 1) {
				const errorMsg = lang.settings.theme.packEditor.errors.slotsNotEnough
					.replace('{required}', '1')
					.replace('{available}', '0');
				return await interaction.reply({
					content: errorMsg,
					ephemeral: true
				});
			}
		}

		let newEntry = null;

		if (fileData) {
			try {
				const buffer = await downloadToBuffer(fileData.url, lang);
				const mimeType = fileData.contentType || 'image/png';
				// Only delete emoji if it belongs to THIS pack (check name prefix)
				if (isReplacing) {
					await deleteEmojiIfExists(interaction.client, currentEntry.id);
				}
				const uploaded = await uploadEmoji(interaction.client, emojiName, buffer, mimeType);
				newEntry = { id: uploaded.id, name: uploaded.name, animated: uploaded.animated || false };
			} catch (error) {
				return await interaction.reply({
					content: `${error.message}`,
					ephemeral: true
				});
			}
		} else if (emojiInput) {
			const customEmojiMatch = emojiInput.match(/^<a?:([^:]+):(\d+)>$/);
			if (customEmojiMatch) {
				const isAnimated = emojiInput.startsWith('<a:');
				const customId = customEmojiMatch[2];
				const ext = isAnimated ? 'gif' : 'png';
				const url = `https://cdn.discordapp.com/emojis/${customId}.${ext}`;
				try {
					const buffer = await downloadToBuffer(url, lang);
					// Only delete emoji if it belongs to THIS pack (check name prefix)
					if (isReplacing) {
						await deleteEmojiIfExists(interaction.client, currentEntry.id);
					}
					const uploaded = await uploadEmoji(interaction.client, emojiName, buffer, isAnimated ? 'image/gif' : 'image/png');
					newEntry = { id: uploaded.id, name: uploaded.name, animated: uploaded.animated || false };
				} catch (error) {
					return await interaction.reply({
						content: `${error.message}`,
						ephemeral: true
					});
				}
			} else {
				newEntry = { unicode: emojiInput, name: def?.name || emojiKey };
			}
		}

		data.emojis[emojiKey] = newEntry;
		customEmojiQueries.updateCustomEmojiSetData(JSON.stringify(data), setId);

		await showEmojiEditor(interaction, setId, page, lang);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiEditorModal');
	}
}

async function handleEmojiEditorPagination(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const { userId, newPage, contextData } = parsePaginationCustomId(interaction.customId, 1);
		if (!(await assertUserMatches(interaction, userId, lang))) return;
		const hasFullAccess = await hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
		if (!hasFullAccess) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}
		const setId = parseInt(contextData[0], 10);
		await showEmojiEditor(interaction, setId, newPage, lang);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiEditorPagination');
	}
}

module.exports = {
	showEmojiEditor,
	handleEmojiEditorButton,
	handleEmojiEditorModal,
	handleEmojiEditorPagination
};
