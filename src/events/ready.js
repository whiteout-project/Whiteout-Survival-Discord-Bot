const { Events, REST, Routes } = require('discord.js');
const { processRecovery } = require('../functions/Processes/processRecovery');
const { initializeAutoRefresh } = require('../functions/Alliance/refreshAlliance');
const { initializeGiftCodeAPI } = require('../functions/GiftCode/fetchGift');
const { initializeNotificationScheduler } = require('../functions/Notification/notificationScheduler');
const { initializeBackupScheduler } = require('../functions/Settings/backup/backupScheduler');
const { initializeIdChannelCache } = require('../functions/Players/idChannel');
const { initializeGiftCodeChannelCache } = require('../functions/GiftCode/giftCodeChannel');
const { initializeEmojiPacks } = require('../functions/Settings/theme/emojisUploader');
const { adminUsernameCache } = require('../functions/utility/adminUsernameCache');
const { processQueries } = require('../functions/utility/database');

module.exports = {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        // Register slash commands with Discord
        try {
            const commands = [];
            
            // Collect all command data
            for (const [name, command] of client.commands) {
                commands.push(command.data.toJSON());
            }
            
            // Register commands globally (available in all guilds)
            const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
            await rest.put(
                Routes.applicationCommands(client.user.id),
                { body: commands }
            );

        } catch (error) {
            console.error('Failed to register slash commands:', error);
        }

        // Initialize Gift Code API client
        try {
            await initializeGiftCodeAPI(client);
        } catch (error) {
            console.error('Failed to initialize Gift Code API:', error);
        }

        // Initialize auto-refresh system
        try {
            await initializeAutoRefresh(client);
        } catch (error) {
            console.error('Failed to initialize auto-refresh system:', error);
        }

        // Initialize notification scheduler
        try {
            await initializeNotificationScheduler(client);
        } catch (error) {
            console.error('Failed to initialize notification scheduler:', error);
        }

        // Initialize automated backup scheduler
        try {
            initializeBackupScheduler(client);
        } catch (error) {
            console.error('Failed to initialize backup scheduler:', error);
        }

        // Initialize process cleanup scheduler
        try {
            // Clean up completed/failed processes immediately
            processQueries.cleanupCompletedFailedProcesses();
            
            // Schedule cleanup every 24 hours
            client.processCleanupInterval = setInterval(() => {
                try {
                    const result = processQueries.cleanupCompletedFailedProcesses();
                    console.log(`Cleaned up ${result.changes} completed/failed processes`);
                } catch (error) {
                    console.error('Error during scheduled process cleanup:', error);
                }
            }, 24 * 60 * 60 * 1000);
        } catch (error) {
            console.error('Failed to initialize process cleanup scheduler:', error);
        }

        // Initialize ID channel cache
        try {
            await initializeIdChannelCache();
        } catch (error) {
            console.error('Failed to initialize ID channel cache:', error);
        }

        // Initialize gift code channel cache
        try {
            await initializeGiftCodeChannelCache();
        } catch (error) {
            console.error('Failed to initialize gift code channel cache:', error);
        }

        // Initialize process recovery system
        try {
            await processRecovery.initialize(client);
        } catch (error) {
            console.error('Failed to initialize process recovery:', error);
        }

        // Initialize default emoji packs
        try {
            await initializeEmojiPacks(client);
        } catch (error) {
            console.error('Failed to initialize emoji packs:', error);
        }

        // Initialize admin username cache
        try {
            await adminUsernameCache.initialize(client);
        } catch (error) {
            console.error('Failed to initialize admin username cache:', error);
        }


    },
};
