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
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../../Pagination/universalPagination');
const { getAdminLang, assertUserMatches, sendError, updateComponentsV2AfterSeparator, hasPermission } = require('../../utility/commonFunctions');
const { showEmojiEditor } = require('./emojisEditor');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../../utility/emojis');
const { PERMISSIONS } = require('../admin/permissions');
const ITEMS_PER_PAGE = 24;

/**
 * Creates emoji edit button
 * @param {string} userId
 * @param {Object} lang
 * @returns {ButtonBuilder}
 */
function createEmojiEditButton(userId, lang = {}) {
	return new ButtonBuilder()
		.setCustomId(`emoji_theme_edit_${userId}`)
		.setLabel(lang.settings.theme.mainPage.buttons.editPack)
		.setStyle(ButtonStyle.Secondary)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1008'));
}

/**
 * Handle edit emoji set button
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleEmojiEditButton(interaction) {
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

		await showEmojiEditSelection(interaction, 0, lang);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiEditButton');
	}
}

/**
 * Show emoji set selection for editing
 * @param {import('discord.js').ButtonInteraction|import('discord.js').StringSelectMenuInteraction} interaction
 * @param {number} page
 * @param {Object} lang
 */
async function showEmojiEditSelection(interaction, page, lang) {
	const allSets = customEmojiQueries.getAllCustomEmojiSets();
	// Filter out the default pack (wosland)
	const sets = allSets ? allSets.filter(set => set.name.toLowerCase() !== 'wosland') : [];

	if (!sets || sets.length === 0) {
		const container = [
			new ContainerBuilder()
				.setAccentColor(0xe74c3c)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.theme.editPack.errors.noPacks}`
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
		.setCustomId(`emoji_edit_select_${interaction.user.id}_${page}`)
		.setPlaceholder(lang.settings.theme.editPack.selectMenu.packSelect.placeholder)
		.setMinValues(1)
		.setMaxValues(1);

	pageSets.forEach(set => {
		const isActive = set.active === 1;
		selectMenu.addOptions(
			new StringSelectMenuOptionBuilder()
				.setLabel(set.name)
				.setValue(String(set.id))
				.setDescription(isActive ? lang.settings.theme.editPack.selectMenu.description.active : lang.settings.theme.editPack.selectMenu.packSelect.description.inactive)
				.setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), isActive ? '1004' : '1039'))
		);
	});

	const selectRow = new ActionRowBuilder().addComponents(selectMenu);
	const paginationRow = createUniversalPaginationButtons({
		feature: 'emoji_edit',
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
					`${lang.settings.theme.editPack.content.title}\n` +
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
 * Handle edit selection pagination
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleEmojiEditPagination(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const { userId, newPage } = parsePaginationCustomId(interaction.customId, 0);
		if (!(await assertUserMatches(interaction, userId, lang))) return;
		const hasFullAccess = await hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
		if (!hasFullAccess) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}
		await showEmojiEditSelection(interaction, newPage, lang);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiEditPagination');
	}
}

/**
 * Handle emoji set selection for editing
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleEmojiEditSelection(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const parts = interaction.customId.split('_');
		const expectedUserId = parts[3];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		const hasFullAccess = await hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
		if (!hasFullAccess) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		const setId = parseInt(interaction.values[0], 10);
		await showEmojiEditor(interaction, setId, 0, lang);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiEditSelection');
	}
}

module.exports = {
	createEmojiEditButton,
	handleEmojiEditButton,
	handleEmojiEditPagination,
	handleEmojiEditSelection
};
