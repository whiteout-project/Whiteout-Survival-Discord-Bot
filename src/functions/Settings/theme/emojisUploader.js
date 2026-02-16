const fs = require('fs');
const path = require('path');
const { Routes } = require('discord.js');
const { customEmojiQueries } = require('../../utility/database');

const APP_EMOJI_LIMIT = 2000;
const EMOJI_BUFFER = 100; // Reserved slots for future default pack expansion

/**
 * Deletes all emojis matching a specific pack name prefix
 * @param {import('discord.js').Client} client
 * @param {string} packName - The pack name to match (e.g., "wosland")
 * @returns {Promise<number>} Number of emojis deleted
 */
async function deleteMatchingEmojis(client, packName) {
	await client.application.fetch();
	const appId = client.application.id;
	
	const discordEmojis = await client.rest.get(Routes.applicationEmojis(appId));
	const emojiList = Array.isArray(discordEmojis?.items) ? discordEmojis.items : (Array.isArray(discordEmojis) ? discordEmojis : []);
	
	const prefix = `${packName}_`;
	const matchingEmojis = emojiList.filter(emoji => emoji.name.startsWith(prefix));
	
	if (matchingEmojis.length > 0) {
		console.log(`[EMOJI] Found ${matchingEmojis.length} existing emojis with prefix "${prefix}", deleting...`);
		
		for (const emoji of matchingEmojis) {
			try {
				await client.rest.delete(Routes.applicationEmoji(appId, emoji.id));
			} catch (error) {
				console.error(`[EMOJI] Failed to delete emoji ${emoji.name}:`, error.message);
			}
		}
	}
	
	return matchingEmojis.length;
}

/**
 * Uploads a custom emoji pack from a JSON file
 * @param {import('discord.js').Client} client
 * @param {string} packJsonPath
 * @returns {Promise<Object>} uploaded pack data
 */
async function uploadEmojiPackFromJson(client, packJsonPath) {
	const raw = await fs.promises.readFile(packJsonPath, 'utf8');
	const parsed = JSON.parse(raw);
	const packName = String(parsed.name || 'pack').toLowerCase();

	const entries = Object.entries(parsed).filter(([key]) => key !== 'name');
	if (entries.length === 0) {
		throw new Error('Emoji pack has no entries');
	}

	await client.application.fetch();
	const appId = client.application.id;

	// Delete any existing emojis with matching names before uploading
	await deleteMatchingEmojis(client, packName);

	const availableSlots = await getAvailableEmojiSlots(client, appId);
	if (entries.length > availableSlots) {
		throw new Error('Not enough emoji slots available');
	}

	const uploaded = {};
	for (const [key, value] of entries) {
		if (!value || !value.format || !value.data) continue;
		const fileName = `${packName}_${key}`.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32);
		const mime = `image/${value.format}`;
		const image = `data:${mime};base64,${value.data}`;

		const emoji = await client.rest.post(
			Routes.applicationEmojis(appId),
			{ body: { name: fileName, image } }
		);

		uploaded[key] = {
			name: fileName,
			id: emoji.id,
			format: value.format,
			animated: emoji.animated || false
		};
	}

	return {
		name: packName,
		emojis: uploaded
	};
}

async function getAvailableEmojiSlots(client, appId) {
	const emojis = await client.rest.get(Routes.applicationEmojis(appId));
	const count = Array.isArray(emojis?.items) ? emojis.items.length : (emojis?.length || 0);
	const usableLimit = APP_EMOJI_LIMIT - EMOJI_BUFFER;
	return Math.max(usableLimit - count, 0);
}

/**
 * Initialize default emoji pack if missing
 * @param {import('discord.js').Client} client
 */
async function initializeEmojiPacks(client) {
	try {
		// Step 1: Check if "wosland" pack exists in database
		const woslandPack = customEmojiQueries.getCustomEmojiSetByName('wosland');

		if (woslandPack) {
			// wosland exists in database, data already synced - silent operation
			const activePack = customEmojiQueries.getActiveCustomEmojiSet();
			if (!activePack) {
				customEmojiQueries.setActiveCustomEmojiSet(woslandPack.id);
			}
			return;
		}

		// Step 2: wosland doesn't exist, look for local default pack file
		const defaultPackPath = path.resolve(__dirname, './default_pack.json');

		if (!fs.existsSync(defaultPackPath)) {
			return;
		}

		try {
			// Read pack to get emoji count for progress
			const rawPackData = JSON.parse(await fs.promises.readFile(defaultPackPath, 'utf8'));
			const emojiCount = Object.keys(rawPackData).filter(k => k !== 'name').length;

			console.log(`⏳ Please wait, installing ${emojiCount} emojis...`);

			// Step 3: Upload emojis to Discord from local file
			const uploaded = await uploadEmojiPackFromJson(client, defaultPackPath);

			// Step 4: Fetch the newly created emojis from Discord to get accurate IDs
			await client.application.fetch();
			const appId = client.application.id;
			const discordEmojis = await client.rest.get(Routes.applicationEmojis(appId));
			const emojiList = Array.isArray(discordEmojis?.items) ? discordEmojis.items : (Array.isArray(discordEmojis) ? discordEmojis : []);

			// Build emoji data from fetched Discord emojis (packname_emojikey format)
			const packEmojis = {};
			const packName = uploaded.name;

			for (const emoji of emojiList) {
				// Expected format: packname_emojikey (e.g., "wosland_1000", "wosland_shield")
				const match = emoji.name.match(/^([^_]+)_(.+)$/);
				if (match) {
					const [, prefix, emojiKey] = match;
					if (prefix === packName) {
						packEmojis[emojiKey] = {
							id: emoji.id,
							name: emoji.name,
							animated: emoji.animated || false
						};
					}
				}
			}

			// Step 5: Store in database with fetched IDs
			const packData = { emojis: packEmojis };
			customEmojiQueries.addCustomEmojiSet(packName, JSON.stringify(packData), 1); // Set as active

			// Step 6: Delete the local default pack file
			await fs.promises.unlink(defaultPackPath);

			console.log('Download completed.');
		} catch (uploadError) {
			console.error('Failed to install emojis:', uploadError.message);
		}
	} catch (error) {
		console.error('Error during emoji initialization:', error.message);
	}
}

module.exports = {
	uploadEmojiPackFromJson,
	getAvailableEmojiSlots,
	initializeEmojiPacks,
	deleteMatchingEmojis,
	APP_EMOJI_LIMIT,
	EMOJI_BUFFER
};
