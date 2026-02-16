const {
	ButtonBuilder,
	ButtonStyle,
	ActionRowBuilder,
	ContainerBuilder,
	MessageFlags,
	TextDisplayBuilder
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Routes } = require('discord.js');
const { customEmojiQueries } = require('../../utility/database');
const { uploadEmojiPackFromJson } = require('./emojisUploader');
const { getAdminLang, assertUserMatches, sendError, updateComponentsV2AfterSeparator, hasPermission } = require('../../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../../utility/emojis');
const { PERMISSIONS } = require('../admin/permissions');
/**
 * Creates emoji reload button
 * @param {string} userId
 * @param {Object} lang
 * @returns {ButtonBuilder}
 */
function createEmojiReloadButton(userId, lang = {}) {
	return new ButtonBuilder()
		.setCustomId(`emoji_theme_reload_${userId}`)
		.setLabel(lang.settings.theme.mainPage.buttons.reloadDefaults)
		.setStyle(ButtonStyle.Secondary)
		.setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1033'));
}

/**
 * Handle emoji reload default button
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleEmojiReloadDefaultButton(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const expectedUserId = interaction.customId.split('_')[3];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

		if (!hasFullAccess) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		// Show confirmation message
		const confirmButton = new ButtonBuilder()
			.setCustomId(`emoji_theme_reload_confirm_${interaction.user.id}`)
			.setLabel(lang.settings.theme.reloadDefaults.buttons.confirm)
			.setStyle(ButtonStyle.Danger)
			.setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1004'));

		const cancelButton = new ButtonBuilder()
			.setCustomId(`emoji_theme_${interaction.user.id}`)
			.setLabel(lang.settings.theme.reloadDefaults.buttons.cancel)
			.setStyle(ButtonStyle.Secondary)
			.setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1051'));

		const buttonRow = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

		const container = [
			new ContainerBuilder()
				.setAccentColor(0xe74c3c)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.theme.reloadDefaults.content.title}\n` +
						`${lang.settings.theme.reloadDefaults.content.description}`
					)
				)
				.addActionRowComponents(
					buttonRow
				)
		];

		const content = updateComponentsV2AfterSeparator(interaction, container);
		await interaction.update({
			components: content,
			flags: MessageFlags.IsComponentsV2
		});
	} catch (error) {
		await sendError(interaction, lang, error, 'handleEmojiReloadDefaultButton');
	}
}

/**
 * Handle emoji reload confirmation button
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleEmojiReloadConfirmButton(interaction) {
	const { adminData, lang } = getAdminLang(interaction.user.id);
	try {
		const expectedUserId = interaction.customId.split('_')[4];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

		if (!hasFullAccess) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}


		// Show loading message
		const loadingContainer = [
			new ContainerBuilder()
				.setAccentColor(0xf39c12)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.theme.reloadDefaults.content.title}\n` +
						`${lang.settings.theme.reloadDefaults.content.reloading}`
					)
				)
		];

		const loadingContent = updateComponentsV2AfterSeparator(interaction, loadingContainer);
		await interaction.update({
			components: loadingContent,
			flags: MessageFlags.IsComponentsV2
		});

		// GitHub repository with default emoji pack JSON:
		const downloadUrl = 'https://raw.githubusercontent.com/whiteout-project/testemojis/main/default_pack.json';

		const tempDir = path.join(__dirname, '../../../temp');
		await fs.promises.mkdir(tempDir, { recursive: true });
		const tempPath = path.join(tempDir, `default_pack_${Date.now()}.json`);

		await downloadPublicFile(downloadUrl, tempPath);

		const existing = customEmojiQueries.getCustomEmojiSetByName('wosland');
		const wasActive = existing?.active;
		if (existing?.data) {
			const parsed = JSON.parse(existing.data);
			const emojis = parsed.emojis || {};
			await interaction.client.application.fetch();
			const appId = interaction.client.application.id;
			for (const value of Object.values(emojis)) {
				if (value?.id) {
					try {
						await interaction.client.rest.delete(Routes.applicationEmoji(appId, value.id));
					} catch {
						// ignore
					}
				}
			}
			customEmojiQueries.deleteCustomEmojiSet(existing.id);
		}

		const uploaded = await uploadEmojiPackFromJson(interaction.client, tempPath);
		customEmojiQueries.addCustomEmojiSet(uploaded.name, JSON.stringify(uploaded), wasActive ? 1 : 0);

		// Update all custom packs to use new wosland emoji IDs
		await updateCustomPacksWithNewWoslandIds(uploaded);

		await fs.promises.unlink(tempPath);

		// Refresh lang and adminData to load new emoji pack's IDs
		const { adminData: freshAdminData, lang: freshLang } = getAdminLang(interaction.user.id);

		// Success - rebuild entire emoji theme page with new emojis
		const { createEmojiThemeContainer } = require('./emojis');
		const components = createEmojiThemeContainer(interaction.user.id, freshLang, freshAdminData);

		await interaction.editReply({
			components,
			flags: MessageFlags.IsComponentsV2
		});
	} catch (error) {
		const { lang: freshLang } = getAdminLang(interaction.user.id);
		await sendError(interaction, freshLang, error, 'handleEmojiReloadConfirmButton');
	}
}

/**
 * Update all custom emoji packs to use new wosland emoji IDs
 * @param {Object} newWoslandPack - The newly uploaded wosland pack with fresh IDs
 */
async function updateCustomPacksWithNewWoslandIds(newWoslandPack) {
	// Get all custom emoji sets from database
	const allSets = customEmojiQueries.getAllCustomEmojiSets();

	// Filter out wosland itself - only update user-created packs
	const customPacks = allSets.filter(set => set.name.toLowerCase() !== 'wosland');

	// Map of emoji keys to new IDs from wosland
	const newWoslandEmojis = newWoslandPack.emojis || {};

	// Update each custom pack
	for (const pack of customPacks) {
		try {
			const packData = JSON.parse(pack.data);
			const packEmojis = packData.emojis || {};
			let needsUpdate = false;

			// Check each emoji in the custom pack
			for (const [key, emoji] of Object.entries(packEmojis)) {
				// If this emoji exists in new wosland pack with same name
				// (meaning it's inherited, not custom uploaded)
				const woslandEmoji = newWoslandEmojis[key];
				if (woslandEmoji && emoji.name === woslandEmoji.name) {
					// Check if the custom pack has a different ID (inherited from old wosland)
					// Update to use the new wosland ID
					if (emoji.id !== woslandEmoji.id) {
						packEmojis[key] = {
							...emoji,
							id: woslandEmoji.id,
							name: woslandEmoji.name
						};
						needsUpdate = true;
					}
				}
			}

			// Only update the database if changes were made
			if (needsUpdate) {
				packData.emojis = packEmojis;
				customEmojiQueries.updateCustomEmojiSetData(JSON.stringify(packData), pack.id);
			}
		} catch (error) {
			console.error(`Failed to update custom pack ${pack.name}:`, error);
			// Continue with other packs even if one fails
		}
	}
}

/**
 * Download public file helper
 * @param {string} url
 * @param {string} outputPath
 * @returns {Promise<void>}
 */
function downloadPublicFile(url, outputPath) {
	return new Promise((resolve, reject) => {
		https.get(url, (res) => {
			if (res.statusCode !== 200) {
				return reject(new Error(`Failed to download: ${res.statusCode}`));
			}
			const chunks = [];
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

module.exports = {
	createEmojiReloadButton,
	handleEmojiReloadDefaultButton,
	handleEmojiReloadConfirmButton
};
