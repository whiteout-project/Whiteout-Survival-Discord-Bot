const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ContainerBuilder,
	FileBuilder,
	MessageFlags,
	SeparatorBuilder,
	SeparatorSpacingSize,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
	TextDisplayBuilder
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { customEmojiQueries } = require('../../utility/database');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../../Pagination/universalPagination');
const { getAdminLang, assertUserMatches, sendError, updateComponentsV2AfterSeparator } = require('../../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../../utility/emojis');

const ITEMS_PER_PAGE = 24;

/**
 * Creates emoji share button
 * @param {string} userId
 * @param {Object} lang
 * @returns {ButtonBuilder}
 */
function createEmojiShareButton(userId, lang = {}) {
	return new ButtonBuilder()
		.setCustomId(`emoji_theme_share_${userId}`)
		.setLabel(lang.settings.theme.mainPage.buttons.sharePack)
		.setStyle(ButtonStyle.Secondary)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1018'));
}

function downloadEmojiBuffer(url) {
	return new Promise((resolve, reject) => {
		https.get(url, (res) => {
			const chunks = [];
			res.on('data', chunk => chunks.push(chunk));
			res.on('end', () => resolve(Buffer.concat(chunks)));
		}).on('error', reject);
	});
}

async function handleEmojiExportButton(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const expectedUserId = interaction.customId.split('_')[3];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		if (!adminData) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		await showEmojiExportSelection(interaction, 0, lang);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiExportButton');
	}
}

async function showEmojiExportSelection(interaction, page, lang) {
	const allSets = customEmojiQueries.getAllCustomEmojiSets();
	// Filter out the default pack (wosland)
	const sets = allSets ? allSets.filter(set => set.name.toLowerCase() !== 'wosland') : [];

	if (!sets || sets.length === 0) {
		const container = [
			new ContainerBuilder()
				.setAccentColor(0xe74c3c)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings?.theme.exportPack.errors.noPacks}`
					)
				)
		];
		const content = updateComponentsV2AfterSeparator(interaction, container);
		return await interaction.update({
			components: content,
			flags: MessageFlags.IsComponentsV2
		});
	}

	const totalPages = Math.ceil(sets.length / ITEMS_PER_PAGE);
	const startIndex = page * ITEMS_PER_PAGE;
	const endIndex = startIndex + ITEMS_PER_PAGE;
	const pageSets = sets.slice(startIndex, endIndex);

	const selectMenu = new StringSelectMenuBuilder()
		.setCustomId(`emoji_export_select_${interaction.user.id}_${page}`)
		.setPlaceholder(lang.settings.theme.exportPack.selectMenu.packSelect.placeholder)
		.setMinValues(1)
		.setMaxValues(1);

	pageSets.forEach(set => {
		const isActive = set.active === 1;
		selectMenu.addOptions(
			new StringSelectMenuOptionBuilder()
				.setLabel(set.name)
				.setValue(String(set.id))
				.setDescription(isActive ? lang.settings.theme.exportPack.selectMenu.description.active : lang.settings.theme.exportPack.selectMenu.packSelect.description.inactive)
				.setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), isActive ? '1004' : '1039'))
		);
	});

	const selectRow = new ActionRowBuilder().addComponents(selectMenu);
	const paginationRow = createUniversalPaginationButtons({
		feature: 'emoji_export',
		userId: interaction.user.id,
		currentPage: page,
		totalPages,
		lang
	});

	const components = [];
	if (paginationRow) components.push(paginationRow);
	components.push(selectRow);

	const container = [
		new ContainerBuilder()
			.setAccentColor(0x8e44ad)
			.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(
					`${lang.settings.theme.exportPack.content.title}\n` +
					`${lang.settings.theme.exportPack.content.description}\n` +
					`${lang.pagination.text.pageInfo
						.replace('{current}', (page + 1).toString())
						.replace('{total}', totalPages.toString())}`
				)
			)
			.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
			.addActionRowComponents(...components)
	];

	const content = updateComponentsV2AfterSeparator(interaction, container);
	await interaction.update({
		components: content,
		flags: MessageFlags.IsComponentsV2
	});
}

async function handleEmojiExportPagination(interaction) {
	const { lang } = getAdminLang(interaction.user.id);
	try {
		const { userId, newPage } = parsePaginationCustomId(interaction.customId, 0);
		if (!(await assertUserMatches(interaction, userId, lang))) return;
		await showEmojiExportSelection(interaction, newPage, lang);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiExportPagination');
	}
}

async function handleEmojiExportSelection(interaction) {
	const { lang } = getAdminLang(interaction.user.id);
	try {
		const parts = interaction.customId.split('_');
		const expectedUserId = parts[3];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		// Show loading message
		const loadingContainer = [
			new ContainerBuilder()
				.setAccentColor(0x8e44ad)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.theme.exportPack.content.title}\n` +
						`${lang.settings.theme.exportPack.content.generatingFile}`
					)
				)
		];
		const loadingContent = updateComponentsV2AfterSeparator(interaction, loadingContainer);
		await interaction.update({
			components: loadingContent,
			flags: MessageFlags.IsComponentsV2
		});

		const setId = parseInt(interaction.values[0], 10);
		const set = customEmojiQueries.getCustomEmojiSetById(setId);
		if (!set) {
			return await interaction.editReply({
				components: updateComponentsV2AfterSeparator(interaction, [
					new ContainerBuilder()
						.setAccentColor(0xe74c3c)
						.addTextDisplayComponents(
							new TextDisplayBuilder().setContent(lang.common.error)
						)
				]),
				flags: MessageFlags.IsComponentsV2
			});
		}

		const parsed = set.data ? JSON.parse(set.data) : { name: set.name, emojis: {} };
		const packName = (parsed.name || set.name).toLowerCase();
		// Sanitize pack name the same way emojis are named (lowercase, replace non-alphanumeric with _)
		const sanitizedPackName = packName.replace(/[^a-z0-9_]/g, '_');
		const exportData = { name: parsed.name || set.name };

		const emojis = parsed.emojis || {};
		for (const [key, value] of Object.entries(emojis)) {
			if (!value) continue;

			// Determine source pack from emoji name (format: {pack}_{key})
			const emojiNameLower = value.name?.toLowerCase() || '';
			const isFromCurrentPack = emojiNameLower.startsWith(`${sanitizedPackName}_`);
			const sourcePack = isFromCurrentPack ? packName : 'wosland';

			// Handle unicode emojis
			if (value.unicode) {
				exportData[key] = {
					pack: sourcePack,
					unicode: value.unicode
				};
				continue;
			}

			// Handle custom emojis with ID
			if (value.id && value.name) {
				const ext = value.animated ? 'gif' : 'png';

				// Only download and include data if emoji is from current pack
				if (isFromCurrentPack) {
					const url = `https://cdn.discordapp.com/emojis/${value.id}.${ext}`;
					const buffer = await downloadEmojiBuffer(url);
					exportData[key] = {
						pack: sourcePack,
						format: ext,
						data: buffer.toString('base64')
					};
				} else {
					// Just mark as inherited from source pack
					exportData[key] = {
						pack: sourcePack,
						format: ext
					};
				}
			}
		}

		const tempDir = path.join(__dirname, '../../../temp');
		await fs.promises.mkdir(tempDir, { recursive: true });
		const fileName = `${(parsed.name || set.name).replace(/[^a-z0-9]/gi, '_')}_emoji_pack.json`;
		const filePath = path.join(tempDir, fileName);
		await fs.promises.writeFile(filePath, JSON.stringify(exportData, null, 2));
		const fileBuffer = await fs.promises.readFile(filePath);

		const container = [
			new ContainerBuilder()
				.setAccentColor(0x8e44ad)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.theme.exportPack.content.title}\n` +
						`${lang.settings.theme.exportPack.content.exportSuccess}`
					)
				)
				.addSeparatorComponents(
					new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
				)
				.addFileComponents(
					new FileBuilder().setURL(`attachment://${fileName}`)
				)
		];

		const content = updateComponentsV2AfterSeparator(interaction, container);
		await interaction.editReply({
			components: content,
			files: [{ attachment: fileBuffer, name: fileName }],
			flags: MessageFlags.IsComponentsV2
		});

		setTimeout(async () => {
			try {
				await fs.promises.unlink(filePath);
			} catch {
				// ignore cleanup errors
			}
		}, 5000);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiExportSelection');
	}
}

module.exports = {
	createEmojiShareButton,
	handleEmojiExportButton,
	handleEmojiExportPagination,
	handleEmojiExportSelection
};
