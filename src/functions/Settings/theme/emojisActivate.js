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
const { customEmojiQueries, adminQueries } = require('../../utility/database');
const { PERMISSIONS } = require('../admin/permissions');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../../Pagination/universalPagination');
const { getAdminLang, assertUserMatches, sendError, hasPermission, updateComponentsV2AfterSeparator } = require('../../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../../utility/emojis');
const ITEMS_PER_PAGE = 24;

/**
 * Creates emoji activate button
 * @param {string} userId
 * @param {Object} lang
 * @returns {ButtonBuilder}
 */
function createEmojiActivateButton(userId, lang = {}) {
	return new ButtonBuilder()
		.setCustomId(`emoji_theme_activate_${userId}`)
		.setLabel(lang.settings.theme.mainPage.buttons.activatePack)
		.setStyle(ButtonStyle.Secondary)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1043'));
}

/**
 * Handle emoji set activation button
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleEmojiActivateButton(interaction) {
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

		await showEmojiSetSelection(interaction, 0, lang);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiActivateButton');
	}
}

/**
 * Show emoji set selection with pagination
 * @param {import('discord.js').ButtonInteraction|import('discord.js').StringSelectMenuInteraction} interaction
 * @param {number} page
 * @param {Object} lang
 */
async function showEmojiSetSelection(interaction, page, lang) {
	const allSets = customEmojiQueries.getAllCustomEmojiSets();
	if (!allSets || allSets.length === 0) {
		const container = [
			new ContainerBuilder()
				.setAccentColor(0xe74c3c)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.themee.activatePack.errors.noPacks}\n`
					)
				)
		];

		const content = updateComponentsV2AfterSeparator(interaction, container);
		return await interaction.update({
			components: content,
			flags: MessageFlags.IsComponentsV2
		});
	}

	const totalPages = Math.ceil(allSets.length / ITEMS_PER_PAGE);
	const startIndex = page * ITEMS_PER_PAGE;
	const endIndex = startIndex + ITEMS_PER_PAGE;
	const pageSets = allSets.slice(startIndex, endIndex);

	const selectMenu = new StringSelectMenuBuilder()
		.setCustomId(`emoji_activate_select_${interaction.user.id}_${page}`)
		.setPlaceholder(lang.settings.theme.activatePack.selectMenu.packSelect.placeholder)
		.setMinValues(1)
		.setMaxValues(1);

	pageSets.forEach(set => {
		const activeTag = set.active ? (lang.settings.theme.activatePack.content.activeTag) : null;
		const description = activeTag ? `(${activeTag})` : (lang.settings.theme.activatePack.content.inactiveTag);
		selectMenu.addOptions(
			new StringSelectMenuOptionBuilder()
				.setLabel(set.name)
				.setValue(String(set.id))
				.setDescription(description)
				.setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), set.active ? '1004' : '1039'))
		);
	});

	const selectRow = new ActionRowBuilder().addComponents(selectMenu);
	const paginationRow = createUniversalPaginationButtons({
		feature: 'emoji_activate',
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
					`${lang.settings.theme.activatePack.content.title.main}\n` +
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
 * Handle emoji set pagination
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleEmojiActivatePagination(interaction) {
	const { lang } = getAdminLang(interaction.user.id);
	try {
		const { userId, newPage } = parsePaginationCustomId(interaction.customId, 0);
		if (!(await assertUserMatches(interaction, userId, lang))) return;
		await showEmojiSetSelection(interaction, newPage, lang);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiActivatePagination');
	}
}

/**
 * Handle emoji set selection
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleEmojiActivateSelection(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const parts = interaction.customId.split('_');
		const expectedUserId = parts[3];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		const hasFullAccess = await hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

		if (!adminData) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		const setId = parseInt(interaction.values[0], 10);
		const set = customEmojiQueries.getCustomEmojiSetById(setId);
		if (!set) {
			return await interaction.reply({
				content: lang.common.error,
				ephemeral: true
			});
		}

		const globalButton = new ButtonBuilder()
			.setCustomId(`emoji_activate_global_${setId}_${interaction.user.id}`)
			.setLabel(lang.settings.theme.activatePack.buttons.global)
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(!hasFullAccess)
			.setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1027'));

		const personalButton = new ButtonBuilder()
			.setCustomId(`emoji_activate_personal_${setId}_${interaction.user.id}`)
			.setLabel(lang.settings.theme.activatePack.buttons.personal)
			.setStyle(ButtonStyle.Secondary)
			.setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1026'));

		const row = new ActionRowBuilder().addComponents(globalButton, personalButton);

		const container = [
			new ContainerBuilder()
				.setAccentColor(0x8e44ad)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.theme.activatePack.content.title.main}\n` +
						`${lang.settings.theme.activatePack.content.description.main}`.replace('{packName}', `**${set.name}**`)
					)
				)
				.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
				.addActionRowComponents(row)
		];

		const content = updateComponentsV2AfterSeparator(interaction, container);
		await interaction.update({
			components: content,
			flags: MessageFlags.IsComponentsV2
		});
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiActivateSelection');
	}
}

/**
 * Handle activation choice (global/personal)
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleEmojiActivateChoice(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const parts = interaction.customId.split('_');
		const scope = parts[2];
		const setId = parseInt(parts[3], 10);
		const expectedUserId = parts[4];

		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		if (!adminData) {
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

		if (scope === 'global') {
			const hasFullAccess = await hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
			if (!hasFullAccess) {
				return await interaction.reply({
					content: lang.common.noPermission,
					ephemeral: true
				});
			}

			customEmojiQueries.clearActiveCustomEmojiSet();
			customEmojiQueries.setActiveCustomEmojiSet(setId);
		} else if (scope === 'personal') {
			adminQueries.updateAdminCustomEmoji(setId, interaction.user.id);
		}

		// Refresh lang object to load new emoji pack's IDs
		const { lang: freshLang } = getAdminLang(interaction.user.id);

		const successText = scope === 'global'
			? (freshLang.settings.theme.activatePack.content.description.globalActivated).replace('{packName}', `**${set.name}**`)
			: (freshLang.settings.theme.activatePack.content.description.personalActivated).replace('{packName}', `**${set.name}**`);

		const container = [
			new ContainerBuilder()
				.setAccentColor(0x2ecc71)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${freshLang.settings.theme.activatePack.content.title.success}\n` +
						`${successText}`
					)
				)
		];

		const content = updateComponentsV2AfterSeparator(interaction, container);
		await interaction.update({
			components: content,
			flags: MessageFlags.IsComponentsV2
		});
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiActivateChoice');
	}
}

module.exports = {
	createEmojiActivateButton,
	handleEmojiActivateButton,
	handleEmojiActivatePagination,
	handleEmojiActivateSelection,
	handleEmojiActivateChoice
};
