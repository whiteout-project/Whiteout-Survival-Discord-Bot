const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	LabelBuilder,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle
} = require('discord.js');
const { customEmojiQueries } = require('../../utility/database');
const { EMOJI_DEFINITIONS } = require('../../utility/emojis');
const { getAdminLang, assertUserMatches, sendError, hasPermission } = require('../../utility/commonFunctions');
const { showEmojiEditor } = require('./emojisEditor');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../../utility/emojis');
const { PERMISSIONS } = require('../admin/permissions');

/**
 * Creates emoji create button
 * @param {string} userId
 * @param {Object} lang
 * @returns {ButtonBuilder}
 */
function createEmojiCreateButton(userId, lang = {}) {
	return new ButtonBuilder()
		.setCustomId(`emoji_theme_create_${userId}`)
		.setLabel(lang.settings.theme.mainPage.buttons.createPack)
		.setStyle(ButtonStyle.Secondary)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1000'));
}

/**
 * Handle create emoji set button
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleEmojiCreateButton(interaction) {
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
			.setCustomId(`emoji_create_modal_${interaction.user.id}`)
			.setTitle(lang.settings.theme.createPack.modal.title);

		const nameInput = new TextInputBuilder()
			.setCustomId('emoji_set_name')
			.setStyle(TextInputStyle.Short)
			.setPlaceholder(lang.settings.theme.createPack.modal.nameInput.placeholder)
			.setRequired(true)
			.setMaxLength(32);

		const nameLabel = new LabelBuilder()
			.setLabel(lang.settings.theme.createPack.modal.nameInput.label)
			.setTextInputComponent(nameInput);

		modal.addLabelComponents(nameLabel);
		await interaction.showModal(modal);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiCreateButton');
	}
}

/**
 * Handle create emoji set modal
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleEmojiCreateModal(interaction) {
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

		const name = interaction.fields.getTextInputValue('emoji_set_name').trim();
		if (!name) {
			return await interaction.reply({
				content: lang.settings.theme.createPack.errors.invalidName,
				ephemeral: true
			});
		}

		const existing = customEmojiQueries.getCustomEmojiSetByName(name);
		if (existing) {
			return await interaction.reply({
				content: lang.settings.theme.createPack.errors.nameExists,
				ephemeral: true
			});
		}

		const active = customEmojiQueries.getActiveCustomEmojiSet();
		let data;
		if (active?.data) {
			const parsed = JSON.parse(active.data);
			data = {
				...parsed,
				name,
				emojis: parsed.emojis || {}
			};
		} else {
			const emojis = {};
			EMOJI_DEFINITIONS.forEach(def => {
				emojis[String(def.key)] = null;
			});
			data = { name, emojis };
		}

		const result = customEmojiQueries.addCustomEmojiSet(name, JSON.stringify(data), 0);
		const setId = result.lastInsertRowid;

		await showEmojiEditor(interaction, setId, 0, lang);
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiCreateModal');
	}
}

module.exports = {
	createEmojiCreateButton,
	handleEmojiCreateButton,
	handleEmojiCreateModal
};
