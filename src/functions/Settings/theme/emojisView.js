const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ContainerBuilder,
	MessageFlags,
	SeparatorBuilder,
	SeparatorSpacingSize,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
	TextDisplayBuilder
} = require('discord.js');
const { customEmojiQueries } = require('../../utility/database');
const { EMOJI_DEFINITIONS } = require('../../utility/emojis');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../../Pagination/universalPagination');
const { getAdminLang, assertUserMatches, sendError, updateComponentsV2AfterSeparator } = require('../../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../../utility/emojis');

const ITEMS_PER_PAGE = 24;

/**
 * Creates emoji view button
 * @param {string} userId
 * @param {Object} lang
 * @returns {ButtonBuilder}
 */
function createEmojiViewButton(userId, lang = {}) {
	return new ButtonBuilder()
		.setCustomId(`emoji_theme_view_${userId}`)
		.setLabel(lang.settings.theme.mainPage.buttons.viewPack)
		.setStyle(ButtonStyle.Secondary)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1049'));
}

/**
 * Parse set data from database
 */
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

/**
 * Get emoji display string
 */
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

/**
 * Handle view emoji pack button
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleEmojiViewButton(interaction) {
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

		await showEmojiPackSelection(interaction, 0, lang);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiViewButton');
	}
}

/**
 * Show emoji pack selection
 * @param {import('discord.js').ButtonInteraction|import('discord.js').StringSelectMenuInteraction} interaction
 * @param {number} page
 * @param {Object} lang
 */
async function showEmojiPackSelection(interaction, page, lang) {
	const sets = customEmojiQueries.getAllCustomEmojiSets();
	// Don't filter out wosland - show all packs

	if (!sets || sets.length === 0) {
		const container = [
			new ContainerBuilder()
				.setAccentColor(0x8e44ad)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.theme.viewPack.content.title}\n` +
						`${lang.settings.theme.viewPack.content.noPacks}`
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
		.setCustomId(`emoji_view_select_${interaction.user.id}_${page}`)
		.setPlaceholder(lang.settings.theme.viewPack.selectMenu.placeholder)
		.setMinValues(1)
		.setMaxValues(1);

	pageSets.forEach(set => {
		const isActive = set.active === 1;
		selectMenu.addOptions(
			new StringSelectMenuOptionBuilder()
				.setLabel(set.name)
				.setValue(String(set.id))
				.setDescription(isActive ? lang.settings.theme.viewPack.selectMenu.description.active : lang.settings.theme.viewPack.selectMenu.description.inactive)
				.setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), isActive ? '1004' : '1039'))
		);
	});

	const selectRow = new ActionRowBuilder().addComponents(selectMenu);
	const paginationRow = createUniversalPaginationButtons({
		feature: 'emoji_view',
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
					`${lang.settings.theme.viewPack.content.title}\n` +
					`${lang.settings.theme.viewPack.content.description}\n` +
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

/**
 * Handle emoji view pagination
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleEmojiViewPagination(interaction) {
	const { lang } = getAdminLang(interaction.user.id);
	try {
		const { userId, newPage } = parsePaginationCustomId(interaction.customId, 0);
		if (!(await assertUserMatches(interaction, userId, lang))) return;
		await showEmojiPackSelection(interaction, newPage, lang);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiViewPagination');
	}
}

/**
 * Handle emoji pack selection for viewing
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleEmojiViewSelection(interaction) {
	const { lang } = getAdminLang(interaction.user.id);
	try {
		const parts = interaction.customId.split('_');
		const expectedUserId = parts[3];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		const setId = parseInt(interaction.values[0], 10);
		await showEmojiPackDetails(interaction, setId, lang);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiViewSelection');
	}
}

/**
 * Show emoji pack details with all emojis
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 * @param {number} setId
 * @param {Object} lang
 */
async function showEmojiPackDetails(interaction, setId, lang) {
	const set = customEmojiQueries.getCustomEmojiSetById(setId);
	if (!set) {
		return await interaction.update({
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

	const data = parseSetData(set);
	const isActive = set.active === 1;

	// Build emoji display - 7 emojis per line
	const emojiLines = [];
	let currentLine = [];

	EMOJI_DEFINITIONS.forEach((def, index) => {
		const key = String(def.key);
		const entry = data.emojis[key];
		const display = getEmojiDisplay(entry);
		currentLine.push(display);

		// After every 7 emojis or at the end, create a new line
		if (currentLine.length === 7 || index === EMOJI_DEFINITIONS.length - 1) {
			emojiLines.push(`# ${currentLine.join('')}`);
			currentLine = [];
		}
	});

	// Split emoji lines into chunks if too long
	const maxLength = 4000;
	const chunks = [];
	let currentChunk = '';

	for (const line of emojiLines) {
		if ((currentChunk + line + '\n').length > maxLength) {
			chunks.push(currentChunk);
			currentChunk = line + '\n';
		} else {
			currentChunk += line + '\n';
		}
	}
	if (currentChunk) chunks.push(currentChunk);

	const container = [
		new ContainerBuilder()
			.setAccentColor(isActive ? 0x2ecc71 : 0x8e44ad)
			.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(
					`${lang.settings.theme.viewPack.content.packDetailsTitle.replace('{packName}', data.name)}\n` +
					(isActive ? `${lang.settings.theme.viewPack.content.activePackIndicator}\n` : '') +
					`${lang.settings.theme.viewPack.content.totalEmojis.replace('{count}', EMOJI_DEFINITIONS.length.toString())}`
				)
			)
			.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
	];

	// Add emoji chunks as separate text displays
	chunks.forEach(chunk => {
		container[0].addTextDisplayComponents(
			new TextDisplayBuilder().setContent(chunk.trim())
		);
		if (chunks.indexOf(chunk) < chunks.length - 1) {
			container[0].addSeparatorComponents(
				new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false)
			);
		}
	});

	const content = updateComponentsV2AfterSeparator(interaction, container);
	await interaction.update({
		components: content,
		flags: MessageFlags.IsComponentsV2
	});
}

module.exports = {
	createEmojiViewButton,
	handleEmojiViewButton,
	handleEmojiViewPagination,
	handleEmojiViewSelection
};
