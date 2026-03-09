const { Events, REST, Routes } = require('discord.js');
const { processRecovery } = require('../functions/Processes/processRecovery');
const { initializeAutoRefresh } = require('../functions/Alliance/refreshAlliance');
const { initializeGiftCodeAPI } = require('../functions/GiftCode/fetchGift');
const { playerApiManager } = require('../functions/utility/apiClient');
const { initializeNotificationScheduler } = require('../functions/Notification/notificationScheduler');
const { initializeBackupScheduler } = require('../functions/Settings/backup/backupScheduler');
const { initializeIdChannelCache } = require('../functions/Players/idChannel');
const { autoCleanScheduler } = require('../functions/Players/idChannelAutoClean');
const { initializeGiftCodeChannelCache } = require('../functions/GiftCode/giftCodeChannel');
const { initializeEmojiPacks } = require('../functions/Settings/theme/emojisUploader');
const { adminUsernameCache } = require('../functions/utility/adminUsernameCache');
const { processQueries } = require('../functions/utility/database');

module.exports = {
    name: Events.ClientReady,
    once: false,
    async execute(client) {
        // Register slash commands with Discord — only on first ready, not on reconnects
        if (!client._commandsRegistered) {
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

                client._commandsRegistered = true;
            } catch (error) {
                console.error('Failed to register slash commands:', error);
            }
        }

        // Probe both player APIs and enable dual-API mode if both are reachable
        try {
            await playerApiManager.checkAvailability();
        } catch (error) {
            console.error('Failed to check player API availability:', error);
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

            // Clear any existing interval before creating a new one (handles reconnects)
            if (client.processCleanupInterval) {
                clearInterval(client.processCleanupInterval);
            }

            // Schedule cleanup every 24 hours
            client.processCleanupInterval = setInterval(() => {
                try {
                    processQueries.cleanupCompletedFailedProcesses();
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

        // Initialize ID channel auto-clean scheduler
        try {
            autoCleanScheduler.initialize(client);
        } catch (error) {
            console.error('Failed to initialize auto-clean scheduler:', error);
        }

        // Initialize gift code channel cache
        try {
            await initializeGiftCodeChannelCache();
        } catch (error) {
            console.error('Failed to initialize gift code channel cache:', error);
        }

        // Initialize process recovery system — only on first ready to avoid duplicate recovery DMs
        if (!client._processRecoveryInitialized) {
            try {
                await processRecovery.initialize(client);
                client._processRecoveryInitialized = true;
            } catch (error) {
                console.error('Failed to initialize process recovery:', error);
            }
        } else {
            // On reconnect, update the client reference without re-running full recovery
            processRecovery.client = client;
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
