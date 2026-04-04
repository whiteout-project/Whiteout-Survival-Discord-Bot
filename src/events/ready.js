const { Events, REST, Routes } = require('discord.js');
const { processRecovery } = require('../functions/Processes/processRecovery');
const { initializeAutoRefresh } = require('../functions/Alliance/refreshAlliance');
const { initializeGiftCodeAPI } = require('../functions/GiftCode/fetchGift');
const { playerApiManager } = require('../functions/utility/apiClient');
const { initializeNotificationScheduler } = require('../functions/Notification/notificationScheduler');
const { initializeBackupScheduler } = require('../functions/Settings/backup/backupScheduler');
const { initializeIdChannelCache } = require('../functions/Players/idChannel');
const { autoCleanScheduler } = require('../functions/Players/idChannelAutoClean');
const { startAutoCleanScheduler: startNotifAutoClean } = require('../functions/Notification/autoClean');
const { initializeGiftCodeChannelCache } = require('../functions/GiftCode/giftCodeChannel');
const { initializeEmojiPacks } = require('../functions/Settings/theme/emojisUploader');
const { adminUsernameCache } = require('../functions/utility/adminUsernameCache');
const { processQueries, systemLogQueries } = require('../functions/utility/database');
const { handlePostUpdateRestart, startAutoUpdateScheduler } = require('../functions/Settings/autoUpdate');

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
                const registered = await rest.put(
                    Routes.applicationCommands(client.user.id),
                    { body: commands }
                );

                // Store command IDs for slash command mentions (</name:id>)
                client.commandIds = new Map(registered.map(cmd => [cmd.name, cmd.id]));

                client._commandsRegistered = true;
            } catch (error) {
                console.error('Failed to register slash commands:', error);
            }
        }

        // Synchronous initializations (fast, no network I/O)
        try {
            initializeBackupScheduler(client);
        } catch (error) {
            console.error('Failed to initialize backup scheduler:', error);
        }

        try {
            initializeGiftCodeAPI(client);
        } catch (error) {
            console.error('Failed to initialize Gift Code API:', error);
        }

        // Process cleanup scheduler
        try {
            processQueries.cleanupCompletedFailedProcesses();

            if (client.processCleanupInterval) {
                clearInterval(client.processCleanupInterval);
            }

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

        // System log cleanup — delete logs older than 7 days
        try {
            const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
            const cutoff = new Date(Date.now() - ONE_WEEK_MS).toISOString();
            const { changes } = systemLogQueries.deleteLogsOlderThan(cutoff);
            if (changes > 0) {
                console.log(`System logs cleanup: deleted ${changes} entries older than 7 days`);
            }

            if (client.systemLogCleanupInterval) {
                clearInterval(client.systemLogCleanupInterval);
            }

            client.systemLogCleanupInterval = setInterval(() => {
                try {
                    const cutoff = new Date(Date.now() - ONE_WEEK_MS).toISOString();
                    const { changes } = systemLogQueries.deleteLogsOlderThan(cutoff);
                    if (changes > 0) {
                        console.log(`System logs cleanup: deleted ${changes} entries older than 7 days`);
                    }
                } catch (error) {
                    console.error('Error during system log cleanup:', error);
                }
            }, 24 * 60 * 60 * 1000);
        } catch (error) {
            console.error('Failed to initialize system log cleanup:', error);
        }

        try {
            autoCleanScheduler.initialize(client);
        } catch (error) {
            console.error('Failed to initialize auto-clean scheduler:', error);
        }

        try {
            startNotifAutoClean(client);
        } catch (error) {
            console.error('Failed to initialize notification auto-clean scheduler:', error);
        }

        try {
            startAutoUpdateScheduler(client);
        } catch (error) {
            console.error('Failed to initialize auto-update scheduler:', error);
        }

        // Parallel async initializations (network/DB bound, independent of each other)
        const parallelTasks = [
            playerApiManager.checkAvailability()
                .catch(error => console.error('Failed to check player API availability:', error)),
            initializeAutoRefresh(client)
                .catch(error => console.error('Failed to initialize auto-refresh system:', error)),
            initializeNotificationScheduler(client)
                .catch(error => console.error('Failed to initialize notification scheduler:', error)),
            initializeIdChannelCache()
                .catch(error => console.error('Failed to initialize ID channel cache:', error)),
            initializeGiftCodeChannelCache()
                .catch(error => console.error('Failed to initialize gift code channel cache:', error)),
            initializeEmojiPacks(client)
                .catch(error => console.error('Failed to initialize emoji packs:', error)),
            adminUsernameCache.initialize(client)
                .catch(error => console.error('Failed to initialize admin username cache:', error))
        ];

        await Promise.allSettled(parallelTasks);

        // Update the "Restarting..." message if this is a post-update restart
        await handlePostUpdateRestart(client).catch(error =>
            console.error('Failed to handle post-update restart message:', error.message)
        );

        // Process recovery — runs after other systems are ready
        if (!client._processRecoveryInitialized) {
            try {
                await processRecovery.initialize(client);
                client._processRecoveryInitialized = true;
            } catch (error) {
                console.error('Failed to initialize process recovery:', error);
            }
        } else {
            processRecovery.client = client;
        }

    },
};
