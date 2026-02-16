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
const { Routes } = require('discord.js');
const { customEmojiQueries, adminQueries } = require('../../utility/database');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../../Pagination/universalPagination');
const { getAdminLang, assertUserMatches, sendError, updateComponentsV2AfterSeparator, hasPermission } = require('../../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../../utility/emojis');
const { PERMISSIONS } = require('../admin/permissions');
const ITEMS_PER_PAGE = 24;

/**
 * Creates emoji delete button
 * @param {string} userId
 * @param {Object} lang
 * @returns {ButtonBuilder}
 */
function createEmojiDeleteButton(userId, lang = {}) {
	return new ButtonBuilder()
		.setCustomId(`emoji_theme_delete_${userId}`)
		.setLabel(lang.settings.theme.mainPage.buttons.deletePack)
		.setStyle(ButtonStyle.Secondary)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1046'));
}

async function handleEmojiDeleteButton(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const expectedUserId = interaction.customId.split('_')[3];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		const hasFullPermissions = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

		if (!hasFullPermissions) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		await showEmojiDeleteSelection(interaction, 0, lang);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiDeleteButton');
	}
}

async function showEmojiDeleteSelection(interaction, page, lang) {
	const allSets = customEmojiQueries.getAllCustomEmojiSets();
	// Filter out the default pack (wosland)
	const sets = allSets ? allSets.filter(set => set.name.toLowerCase() !== 'wosland') : [];

	if (!sets || sets.length === 0) {
		const container = [
			new ContainerBuilder()
				.setAccentColor(0xe74c3c)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.theme.deletePack.errors.noPacks}`
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
		.setCustomId(`emoji_delete_select_${interaction.user.id}_${page}`)
		.setPlaceholder(lang.settings.theme.deletePack.selectMenu.packSelect.placeholder)
		.setMinValues(1)
		.setMaxValues(1);

	pageSets.forEach(set => {
		const isActive = set.active === 1;
		selectMenu.addOptions(
			new StringSelectMenuOptionBuilder()
				.setLabel(set.name)
				.setValue(String(set.id))
				.setDescription(isActive ? lang.settings.theme.deletePack.selectMenu.packSelect.description.active : lang.settings.theme.deletePack.selectMenu.packSelect.description.inactive)
				.setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), isActive ? '1004' : '1039'))
		);
	});

	const selectRow = new ActionRowBuilder().addComponents(selectMenu);
	const paginationRow = createUniversalPaginationButtons({
		feature: 'emoji_delete',
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
			.setAccentColor(0xe74c3c)
			.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(
					`${lang.settings.theme.deletePack.content.title.main}\n` +
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

async function handleEmojiDeletePagination(interaction) {
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
		await showEmojiDeleteSelection(interaction, newPage, lang);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiDeletePagination');
	}
}

async function handleEmojiDeleteSelection(interaction) {
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
		const set = customEmojiQueries.getCustomEmojiSetById(setId);
		if (!set) {
			return await interaction.reply({
				content: lang.common.error,
				ephemeral: true
			});
		}

		const confirmButton = new ButtonBuilder()
			.setCustomId(`emoji_delete_confirm_${setId}_${interaction.user.id}`)
			.setLabel(lang.settings.theme.deletePack.buttons.confirm)
			.setStyle(ButtonStyle.Danger);

		const cancelButton = new ButtonBuilder()
			.setCustomId(`emoji_delete_cancel_${interaction.user.id}`)
			.setLabel(lang.settings.theme.deletePack.buttons.cancel)
			.setStyle(ButtonStyle.Secondary);

		const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

		const container = [
			new ContainerBuilder()
				.setAccentColor(0xe74c3c)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.theme.deletePack.content.title.main}\n` +
						`${lang.settings.theme.deletePack.content.description.confirm}\n`.replace('{packName}', set.name)
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
		await sendError(interaction, lang, error, 'handleEmojiDeleteSelection');
	}
}

async function handleEmojiDeleteConfirm(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const parts = interaction.customId.split('_');
		const setId = parseInt(parts[3], 10);
		const expectedUserId = parts[4];
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

		// Show loading message
		const loadingContainer = [
			new ContainerBuilder()
				.setAccentColor(0xe74c3c)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.theme.deletePack.content.title.main}\n` +
						`${lang.settings.theme.deletePack.content.wait}`
					)
				)
		];
		const loadingContent = updateComponentsV2AfterSeparator(interaction, loadingContainer);
		await interaction.update({
			components: loadingContent,
			flags: MessageFlags.IsComponentsV2
		});

		const defaultSet = customEmojiQueries.getCustomEmojiSetByName('wosland') || customEmojiQueries.getActiveCustomEmojiSet();
		if (set.active) {
			customEmojiQueries.clearActiveCustomEmojiSet();
			if (defaultSet?.id) customEmojiQueries.setActiveCustomEmojiSet(defaultSet.id);
		}

		// Reset all admins using this pack to null (will use default pack)
		const admins = adminQueries.getAdminsByCustomEmoji(setId);
		admins.forEach(row => {
			adminQueries.updateAdminCustomEmoji(null, row.user_id);
		});

		if (set.data) {
			const parsed = JSON.parse(set.data);
			const packName = (parsed.name || set.name).toLowerCase();
			const emojis = parsed.emojis || {};
			await interaction.client.application.fetch();
			const appId = interaction.client.application.id;

			// Only delete emojis that belong to this pack (not inherited from wosland)
			for (const value of Object.values(emojis)) {
				if (value?.id && value?.name) {
					const emojiNameLower = value.name.toLowerCase();
					const isFromCurrentPack = emojiNameLower.startsWith(`${packName}_`);

					// Only delete if emoji is from current pack, not inherited from wosland
					if (isFromCurrentPack) {
						try {
							await interaction.client.rest.delete(Routes.applicationEmoji(appId, value.id));
						} catch {
							// ignore delete failures
						}
					}
				}
			}
		}

		customEmojiQueries.deleteCustomEmojiSet(setId);

		const container = [
			new ContainerBuilder()
				.setAccentColor(0x2ecc71)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.theme.deletePack.content.title.deleted}\n` +
						`${lang.settings.theme.deletePack.content.description.deleted}`
					)
				)
		];

		const content = updateComponentsV2AfterSeparator(interaction, container);
		await interaction.editReply({
			components: content,
			flags: MessageFlags.IsComponentsV2
		});
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiDeleteConfirm');
	}
}

async function handleEmojiDeleteCancel(interaction) {
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

		await showEmojiDeleteSelection(interaction, 0, lang);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiDeleteCancel');
	}
}

module.exports = {
	createEmojiDeleteButton,
	handleEmojiDeleteButton,
	handleEmojiDeletePagination,
	handleEmojiDeleteSelection,
	handleEmojiDeleteConfirm,
	handleEmojiDeleteCancel
};
