const { EmbedBuilder } = require('discord.js');
const { getProcessById, updateProcessStatus, updateProcessProgress, createProcess } = require('../Processes/createProcesses');
const { queueManager } = require('../Processes/queueManager');
const { allianceQueries, playerQueries, systemLogQueries, furnaceChangeQueries, nicknameChangeQueries, settingsQueries } = require('../utility/database');
const languages = require('../../i18n');
const { getFurnaceReadable } = require('../Players/furnaceReadable');
const { sendError, getRefreshTimeout, formatRefreshInterval } = require('../utility/commonFunctions');
const { replaceEmojiPlaceholders, getGlobalEmojiMap } = require('./../utility/emojis');
const { API_CONFIG } = require('../utility/apiConfig');
const { fetchPlayerData: fetchPlayerFromAPIShared } = require('../utility/apiClient');

/**
 * Auto-refresh system for alliance data monitoring
 */
class AutoRefreshManager {
    constructor() {
        this.activeRefreshes = new Map(); // Track active refresh processes per alliance
        this.client = null;
        this.scheduledRefreshes = new Map(); // Track scheduled timeouts per alliance
    }

    /**
     * Initialize auto-refresh system on bot startup
     * @param {import('discord.js').Client} client - Discord client instance
     * @returns {Promise<void>}
     */
    async initialize(client) {
        try {
            this.client = client;

            // Get all alliances that have refresh intervals set
            const alliances = allianceQueries.getAllAlliances();
            const refreshableAlliances = alliances.filter(alliance => {
                const interval = alliance.interval;
                // Support both minute-based (number > 0) and time-based (@HH:MM) formats
                return interval && (
                    (typeof interval === 'number' && interval > 0) ||
                    (typeof interval === 'string' && interval.startsWith('@'))
                ) && alliance.channel_id;
            });

            if (refreshableAlliances.length === 0) {
                return;
            }

            // Get all queued and active auto-refresh processes from recovery
            const { getProcessesByStatus } = require('../Processes/createProcesses');
            const queuedProcesses = await getProcessesByStatus('queued');
            const activeProcesses = await getProcessesByStatus('active');
            const allProcesses = [...queuedProcesses, ...activeProcesses];

            // Filter to only auto-refresh processes and get their alliance IDs
            // Convert target to number since alliance.id is a number but p.target is stored as TEXT
            const alliancesWithRecoveredProcesses = new Set(
                allProcesses
                    .filter(p => p.action === 'auto_refresh')
                    .map(p => parseInt(p.target, 10))
            );

            // Start auto-refresh for each alliance that doesn't have a recovered process
            for (const alliance of refreshableAlliances) {
                if (alliancesWithRecoveredProcesses.has(alliance.id) || this.activeRefreshes.has(alliance.id)) {
                    // Only schedule the next refresh, don't create a new process
                    this.scheduleNextRefresh(alliance);
                } else {
                    await this.startAutoRefresh(alliance);
                }
            }

            // After client is set and schedules are configured, start any queued auto-refresh processes
            if (queuedProcesses.filter(p => p.action === 'auto_refresh').length > 0) {
                await queueManager.startNextProcess();
            }

        } catch (error) {
            await sendError(null, null, error, 'initializeAutoRefresh', false);
        }
    }

    /**
     * Start auto-refresh process for a specific alliance
     * @param {Object} alliance - Alliance data
     * @returns {Promise<void>}
     */
    async startAutoRefresh(alliance) {
        try {
            const { id: allianceId, name: allianceName, interval, channel_id } = alliance;

            // Clear any existing scheduled refresh for this alliance
            if (this.scheduledRefreshes.has(allianceId)) {
                clearTimeout(this.scheduledRefreshes.get(allianceId));
                this.scheduledRefreshes.delete(allianceId);
            }

            // Check if alliance has any players to refresh
            const players = playerQueries.getPlayersByAlliance(allianceId);
            if (players.length === 0) {
                return;
            }

            // Create initial refresh process
            await this.createRefreshProcess(alliance);

        } catch (error) {
            await sendError(null, null, error, 'startAutoRefresh', false);
        }
    }

    /**
     * Schedule the next refresh for an alliance
     * @param {Object} alliance - Alliance data
     * @returns {void}
     */
    scheduleNextRefresh(alliance) {
        const { id: allianceId, interval } = alliance;
        const intervalMs = getRefreshTimeout(interval); // Handles both minute-based and time-based (@HH:MM)

        const timeoutId = setTimeout(async () => {
            try {
                // to-do: implement debug mode check
                if (!this.activeRefreshes.has(allianceId)) {
                    await this.createRefreshProcess(alliance);
                }

                // For time-based schedules, we need to recalculate the next occurrence
                // Get fresh alliance data in case interval was changed
                const freshAlliance = allianceQueries.getAllianceById(allianceId);
                if (freshAlliance) {
                    this.scheduleNextRefresh(freshAlliance);
                } else {
                    // Alliance was deleted, clean up
                    this.scheduledRefreshes.delete(allianceId);
                }

            } catch (error) {
                await sendError(null, null, error, 'scheduleNextRefresh', false);
                // Retry scheduling after 5 minutes on error
                setTimeout(() => this.scheduleNextRefresh(alliance), 5 * 60 * 1000);
            }
        }, intervalMs);

        this.scheduledRefreshes.set(allianceId, timeoutId);
    }

    /**
     * Create a refresh process for an alliance
     * @param {Object} alliance - Alliance data
     * @returns {Promise<void>}
     */
    async createRefreshProcess(alliance) {
        try {
            const { id: allianceId, name: allianceName } = alliance;

            // Check if there's already an active refresh for this alliance
            if (this.activeRefreshes.has(allianceId)) {
                return;
            }

            // Get all players for this alliance
            const players = playerQueries.getPlayersByAlliance(allianceId);
            if (players.length === 0) {
                return;
            }

            // Create player IDs string
            const playerIds = players.map(player => player.fid).join(',');

            // Create refresh process using the process system
            const processResult = await createProcess({
                admin_id: 'AUTO_REFRESH', // Special identifier for auto-refresh
                alliance_id: allianceId,
                player_ids: playerIds,
                action: 'auto_refresh'
            });

            // Mark as active
            this.activeRefreshes.set(allianceId, {
                processId: processResult.process_id,
                startTime: Date.now(),
                allianceName
            });

            // Queue the process for execution
            await queueManager.manageQueue(processResult);

        } catch (error) {
            await sendError(null, null, error, 'createRefreshProcess', false);
        }
    }

    /**
     * Execute auto-refresh process for an alliance
     * @param {number} processId - Process ID to execute
     * @returns {Promise<void>}
     */
    async executeAutoRefresh(processId) {
        try {

            const processData = await getProcessById(processId);
            if (!processData) {
                throw new Error(`Process ${processId} not found`);
            }

            // Get fresh alliance data to ensure we have the latest channel_id
            const alliance = allianceQueries.getAllianceById(processData.target);
            if (!alliance) {
                throw new Error(`Alliance ${processData.target} not found`);
            }

            // Fetch channel dynamically (even if it changed since process creation)
            if (!this.client) {
                await sendError(null, null, new Error('Discord client not initialized'), 'executeAutoRefresh', false);
                // Clean up active refresh tracking - process will be marked as failed by executeProcesses.js
                this.activeRefreshes.delete(alliance.id);
                return;
            }

            // Fetch from API instead of cache to get the latest channel
            const channel = await this.client.channels.fetch(alliance.channel_id).catch(() => null);
            if (!channel) {
                await sendError(null, null, new Error(`Channel ${alliance.channel_id} not found for alliance ${alliance.name}`), 'executeAutoRefresh', false);
                // Clean up active refresh tracking - process will be marked as failed by executeProcesses.js
                this.activeRefreshes.delete(alliance.id);
                return;
            }

            const lang = languages['en'] || {}; // Use default language for auto-refresh

            // Start the refresh process
            await this.refreshAllianceData(processId, processData, alliance, channel, lang);

        } catch (error) {
            await sendError(null, null, error, 'executeAutoRefresh', false);
            // Mark process as failed and clean up
            try {
                await updateProcessStatus(processId, 'failed');
                const processData = await getProcessById(processId);
                if (processData) {
                    const alliance = allianceQueries.getAllianceById(processData.target);
                    if (alliance) {
                        this.activeRefreshes.delete(alliance.id);
                    }
                }
            } catch (cleanupError) {
                await sendError(null, null, cleanupError, 'executeAutoRefresh_cleanup', false);
            }
        }
    }

    /**
     * Refresh alliance data and compare for changes
     * @param {number} processId - Process ID
     * @param {Object} processData - Process data
     * @param {Object} alliance - Alliance data
     * @param {Object} channel - Discord channel
     * @param {Object} lang - Language object
     * @returns {Promise<void>}
     */
    async refreshAllianceData(processId, processData, alliance, channel, lang) {
        try {
            const progress = processData.progress || { pending: [], done: [], failed: [], changed: [], unchanged: [], detectedChanges: [] };
            const playerIds = progress.pending;

            if (playerIds.length === 0) {
                // Clean up active refresh tracking - process completion handled by executeProcesses.js
                this.activeRefreshes.delete(alliance.id);
                return; // Process will be completed by executeProcesses.js
            }

            // Restore previously detected changes from progress (in case of resumption after preemption)
            const changes = progress.detectedChanges || [];
            let processed = 0;
            let failed = 0;
            let unchanged = 0;
            let wasPreempted = false;

            // Get auto_delete setting once outside the loop
            const settings = settingsQueries.getSettings.get();
            const autoDelete = settings?.auto_delete ?? 1; // Default to true

            // Process each player
            for (let i = 0; i < playerIds.length; i++) {
                const playerId = playerIds[i];

                // Check if process is still active (could be preempted or completed externally)
                // This check happens OUTSIDE the try-catch to avoid marking players as failed
                const currentProcess = await getProcessById(processId);
                if (currentProcess.status === 'completed') {
                    // Process was completed externally - clean up and exit
                    this.activeRefreshes.delete(alliance.id);
                    return; // Exit without trying to complete again
                } else if (currentProcess.status !== 'active') {
                    // Process was preempted - break out of loop without error
                    // Remaining players stay in 'pending' status and will be processed when resumed
                    wasPreempted = true;
                    break;
                }

                try {

                    // Get current player data from database
                    const currentPlayer = playerQueries.getPlayer(playerId);
                    if (!currentPlayer) {
                        // console.warn(`Player ${playerId} not found in database during refresh. This may indicate a race condition (player removed after process creation). Skipping this player.`);
                        await this.movePlayerToStatus(processId, playerId, 'pending', 'failed');
                        failed++;
                        processed++;
                        continue;
                    }

                    // Fetch latest data from API
                    const apiData = await this.fetchPlayerFromAPI(playerId);

                    // Handle player not exist error (increment exist counter)
                    if (apiData && apiData.error === 'ROLE NOT EXIST' && apiData.playerNotExist === true) {
                        try {
                            playerQueries.incrementPlayerExist(playerId);

                            // Check if player reached 3 exist count
                            const playerData = playerQueries.getPlayer(playerId);
                            if (playerData && playerData.exist >= 3) {
                                if (autoDelete) {
                                    // Delete player if auto_delete is enabled
                                    // console.log(`Player ${playerId} does not exist (exist count: ${playerData.exist}), auto-deleting from database...`);
                                    playerQueries.deletePlayer(playerId);
                                } else {
                                    // console.log(`Player ${playerId} does not exist (exist count: ${playerData.exist}), keeping in database (auto_delete disabled)`);
                                }
                            } else {
                                // console.log(`Player ${playerId} does not exist (exist count: ${playerData?.exist || 0}/3), keeping in database`);
                            }
                        } catch (dbError) {
                            await sendError(null, null, dbError, 'executeAutoRefresh', false);
                        }

                        await this.movePlayerToStatus(processId, playerId, 'pending', 'done');
                        unchanged++; // Count as processed but unchanged
                        processed++;
                        // Add 2 second delay after player check (30 requests/min limit)
                        await this.delay(2000);
                        continue;
                    }

                    // Handle other errors
                    if (!apiData || apiData.error) {
                        await sendError(null, null, new Error(`Failed to fetch data for player ${playerId}: ${apiData?.error || 'Unknown error'}`), 'executeAutoRefresh', false);
                        await this.movePlayerToStatus(processId, playerId, 'pending', 'failed');
                        failed++;
                        processed++;
                        // Add 2 second delay after failed fetch before moving to next player (30 requests/min limit)
                        await this.delay(2000);
                        continue;
                    }

                    // Reset exist counter if player returned valid data (false positive detection)
                    if (currentPlayer.exist > 0) {
                        try {
                            playerQueries.resetPlayerExist(playerId);
                        } catch (dbError) {
                            await sendError(null, null, dbError, 'executeAutoRefresh', false);
                        }
                    }

                    // Compare data for changes
                    const playerChanges = this.comparePlayerData(currentPlayer, apiData, lang);

                    if (playerChanges.length > 0) {
                        // Update player data in database and save change history
                        await this.updatePlayerData(playerId, apiData, alliance.id, playerChanges);

                        // Track changes in memory
                        const changeEntry = {
                            player: currentPlayer,
                            changes: playerChanges,
                            newData: apiData
                        };
                        changes.push(changeEntry);

                        // Save changes to process progress immediately (persist across preemption)
                        await this.saveChangesToProgress(processId, changeEntry);

                        await this.movePlayerToStatus(processId, playerId, 'pending', 'changed');
                    } else {
                        await this.movePlayerToStatus(processId, playerId, 'pending', 'unchanged');
                        unchanged++;
                    }

                    processed++;

                    // Small delay between API calls (2s = 30 requests/min max)
                    await this.delay(2000);
                } catch (error) {
                    if (error.message === 'RATE_LIMIT') {
                        await this.delay(API_CONFIG.RATE_LIMIT_DELAY);

                        // Decrement i to retry the same player on next iteration
                        i--;
                        continue;
                    } else {
                        await sendError(null, null, error, 'executeAutoRefresh_processPlayer', false);
                        await this.movePlayerToStatus(processId, playerId, 'pending', 'failed');
                        failed++;
                        processed++;
                        // Add 2 second delay after general error (30 requests/min limit)
                        await this.delay(2000);
                    }
                }
            }

            // If process was preempted, don't complete it - just return
            // Process will remain in 'queued' status and will be resumed later
            if (wasPreempted) {
                return;
            }

            // Send change notifications only if changes were found
            if (changes.length > 0) {
                await this.sendChangeNotifications(channel, alliance, changes, lang);

                // Clear detectedChanges from progress after successful notification
                const processData = await getProcessById(processId);
                if (processData) {
                    const progress = processData.progress;
                    progress.detectedChanges = [];
                    await updateProcessProgress(processId, progress);
                }
            }

            // Clean up active refresh tracking
            // NOTE: Process completion is handled by executeProcesses.js automatically
            // Do NOT call completeProcess here to avoid duplicate completion
            this.activeRefreshes.delete(alliance.id);

            // Schedule next auto-refresh if this was an auto-refresh process
            if (processData.action === 'auto_refresh') {
                this.scheduleNextRefresh(alliance);
            }

            // If this was a manual refresh (not auto-refresh), reschedule auto-refresh if enabled
            if (processData.action === 'refresh') {
                const freshAlliance = allianceQueries.getAllianceById(alliance.id);
                if (freshAlliance && freshAlliance.interval > 0 && freshAlliance.channel_id) {
                    this.scheduleNextRefresh(freshAlliance);
                }
            }

        } catch (error) {
            await sendError(null, null, error, 'executeAutoRefresh', false);
            throw error;
        }
    }

    /**
     * Save furnace level change to database
     * @param {string} playerId - Player ID
     * @param {number} oldLevel - Previous furnace level
     * @param {number} newLevel - New furnace level
     * @returns {Promise<void>}
     */
    async saveFurnaceChange(playerId, oldLevel, newLevel) {
        try {
            furnaceChangeQueries.addFurnaceChange(
                playerId,
                oldLevel,
                newLevel,
                new Date().toISOString()
            );
        } catch (error) {
            await sendError(null, null, error, 'saveFurnaceChange', false);
        }
    }

    /**
     * Save nickname change to database
     * @param {string} playerId - Player ID
     * @param {string} oldNickname - Previous nickname
     * @param {string} newNickname - New nickname
     * @returns {Promise<void>}
     */
    async saveNicknameChange(playerId, oldNickname, newNickname) {
        try {
            nicknameChangeQueries.addNicknameChange(
                playerId,
                oldNickname,
                newNickname,
                new Date().toISOString()
            );
        } catch (error) {
            await sendError(null, null, error, 'saveNicknameChange', false);
        }
    }

    /**
     * Compare player data for changes
     * @param {Object} currentPlayer - Current player data from database
     * @param {Object} apiData - New player data from API
     * @param {Object} lang - Language object for i18n (optional, defaults to null for English)
     * @returns {Array} Array of changes detected
     */
    comparePlayerData(currentPlayer, apiData, lang = null) {
        const changes = [];

        // Check nickname change
        if (currentPlayer.nickname !== (apiData.nickname || 'Unknown')) {
            changes.push({
                field: 'nickname',
                oldValue: currentPlayer.nickname,
                newValue: apiData.nickname || 'Unknown',
                formattedOldValue: currentPlayer.nickname,
                formattedNewValue: apiData.nickname || 'Unknown'
            });
        }

        // Check furnace level change
        if (currentPlayer.furnace_level !== (apiData.stove_lv || 0)) {
            const oldLevel = currentPlayer.furnace_level;
            const newLevel = apiData.stove_lv || 0;
            changes.push({
                field: 'furnace_level',
                oldValue: oldLevel,
                newValue: newLevel,
                formattedOldValue: getFurnaceReadable(oldLevel, lang),
                formattedNewValue: getFurnaceReadable(newLevel, lang)
            });
        }

        // Check state change (kid)
        if (currentPlayer.state !== (apiData.kid || 0)) {
            changes.push({
                field: 'state',
                oldValue: currentPlayer.state,
                newValue: apiData.kid || 0,
                formattedOldValue: currentPlayer.state,
                formattedNewValue: apiData.kid || 0
            });
        }

        return changes;
    }

    /**
     * Update player data in database and save change history
     * @param {string} playerId - Player ID
     * @param {Object} apiData - New player data from API
     * @param {number} allianceId - Alliance ID
     * @param {Array} changes - Array of detected changes
     * @returns {Promise<void>}
     */
    async updatePlayerData(playerId, apiData, allianceId, changes) {
        try {
            // Save change history to database first
            for (const change of changes) {
                switch (change.field) {
                    case 'nickname':
                        await this.saveNicknameChange(playerId, change.oldValue, change.newValue);
                        break;
                    case 'furnace_level':
                        await this.saveFurnaceChange(playerId, change.oldValue, change.newValue);
                        break;
                    // State changes don't have a dedicated table yet, but we could add one if needed
                }
            }

            // Update player data in database
            await playerQueries.updatePlayer(
                null,                                       // user_id (keep existing)
                apiData.nickname || 'Unknown',              // nickname
                apiData.stove_lv || 0,                      // furnace_level
                apiData.kid || 0,                           // state
                apiData.avatar_image || '',                 // image_url (update from API, no notification)
                allianceId,                                 // alliance_id
                playerId                                    // fid (WHERE clause)
            );


        } catch (error) {
            await sendError(null, null, error, 'updatePlayerData', false);
            throw error;
        }
    }

    /**
     * Send change notifications to Discord channel
     * @param {Object} channel - Discord channel
     * @param {Object} alliance - Alliance data
     * @param {Array} changes - Array of player changes
     * @param {Object} lang - Language object
     * @returns {Promise<void>}
     */
    async sendChangeNotifications(channel, alliance, changes, lang) {
        try {
            // Re-fetch channel from global client to ensure proper token (fixes "Expected token to be set" error)
            const { client } = require('../../index');
            const freshChannel = await client.channels.fetch(channel.id);

            if (!freshChannel) {
                await sendError(null, null, new Error(`Could not fetch channel ${channel.id} for notifications`), 'sendChangeNotifications', false);
                return;
            }

            // Group changes by type
            const changesByType = {
                nickname: [],
                furnace_level: [],
                state: []
            };

            // Organize changes by type
            for (const change of changes) {
                for (const playerChange of change.changes) {
                    changesByType[playerChange.field].push({
                        player: change.player,
                        change: playerChange
                    });
                }
            }

            const embeds = [];
            const maxDescriptionLength = 4096; // Discord embed description limit
            const globalEmojiMap = getGlobalEmojiMap();

            // Create embeds for each change type
            if (changesByType.nickname.length > 0) {
                const nicknameEmbeds = this.createChangeEmbeds(
                    replaceEmojiPlaceholders('️{emoji.1008} Nickname Changes', globalEmojiMap),
                    changesByType.nickname,
                    (item) => `\u200E**${item.change.oldValue}** → **${item.change.newValue}**`,
                    0x3498db,
                    maxDescriptionLength
                );
                embeds.push(...nicknameEmbeds);
            }

            if (changesByType.furnace_level.length > 0) {
                const furnaceEmbeds = this.createChangeEmbeds(
                    replaceEmojiPlaceholders('{emoji.1012} Furnace Level Changes', globalEmojiMap),
                    changesByType.furnace_level,
                    (item) => `\u200E**${item.player.nickname}:** ${item.change.formattedOldValue} → **${item.change.formattedNewValue}**`,
                    0xe74c3c,
                    maxDescriptionLength
                );
                embeds.push(...furnaceEmbeds);
            }

            if (changesByType.state.length > 0) {
                const stateEmbeds = this.createChangeEmbeds(
                    replaceEmojiPlaceholders('{emoji.1040} State Changes', globalEmojiMap),
                    changesByType.state,
                    (item) => `\u200E**${item.player.nickname}:** State ${item.change.oldValue} → **${item.change.newValue}**`,
                    0x9b59b6,
                    maxDescriptionLength
                );
                embeds.push(...stateEmbeds);
            }

            // Add header embed with summary
            /*
            const totalChangesCount = Object.values(changesByType).reduce((sum, arr) => sum + arr.length, 0);
            const summaryEmbed = new EmbedBuilder()
                .setTitle(replaceEmojiPlaceholders('{emoji.1033} Changes Detected', globalEmojiMap))
                .setDescription(`**Alliance:** ${alliance.name}`)
                .addFields([
                    {
                        name: replaceEmojiPlaceholders('{emoji.1041} Summary', globalEmojiMap),
                        value: [
                            `**Total Changes:** ${totalChangesCount}`,
                            `**Nickname Changes:** ${changesByType.nickname.length}`,
                            `**Furnace Level Changes:** ${changesByType.furnace_level.length}`,
                            `**State Changes:** ${changesByType.state.length}`
                        ].join('\n'),
                         
                    }
                ])
                .setColor(0xffa500)
                .setTimestamp();
            */

            // Send summary first, then detailed changes
            const allEmbeds = [...embeds];

            // Send embeds in batches (Discord limit: 10 embeds per message)
            const embedBatchSize = 10;
            for (let i = 0; i < allEmbeds.length; i += embedBatchSize) {
                const embedBatch = allEmbeds.slice(i, i + embedBatchSize);
                await freshChannel.send({ embeds: embedBatch });

                // Small delay between messages to avoid rate limits (2s for API consistency)
                if (i + embedBatchSize < allEmbeds.length) {
                    await this.delay(2000);
                }
            }

        } catch (error) {
            await sendError(null, null, error, 'sendChangeNotifications', false);
        }
    }

    /**
     * Create embeds for a specific change type, splitting if needed
     * @param {string} title - Embed title
     * @param {Array} items - Array of change items
     * @param {Function} formatter - Function to format each item
     * @param {number} color - Embed color
     * @param {number} maxDescriptionLength - Maximum description length (default 4096)
     * @returns {Array} Array of embeds
     */
    createChangeEmbeds(title, items, formatter, color, maxDescriptionLength = 4096) {
        const embeds = [];
        let currentBatch = [];
        let currentLength = 0;
        let embedCount = 0;

        for (let i = 0; i < items.length; i++) {
            const formattedItem = formatter(items[i]);
            const itemLength = formattedItem.length + 1; // +1 for newline

            // Check if adding this item would exceed the limit
            if (currentLength + itemLength > maxDescriptionLength && currentBatch.length > 0) {
                // Create embed with current batch
                embedCount++;
                const embedTitle = items.length > 1
                    ? `${title} (${embedCount})`
                    : title;

                const embed = new EmbedBuilder()
                    .setTitle(embedTitle)
                    .setDescription(currentBatch.join('\n'))
                    .setColor(color);

                embeds.push(embed);

                // Reset for next batch
                currentBatch = [formattedItem];
                currentLength = itemLength;
            } else {
                currentBatch.push(formattedItem);
                currentLength += itemLength;
            }
        }

        // Add remaining items
        if (currentBatch.length > 0) {
            embedCount++;
            const embedTitle = embedCount > 1 || items.length > currentBatch.length
                ? `${title} (${embedCount})`
                : title;

            const embed = new EmbedBuilder()
                .setTitle(embedTitle)
                .setDescription(currentBatch.join('\n'))
                .setColor(color);

            embeds.push(embed);
        }

        return embeds;
    }

    /**
     * Save detected changes to process progress (persist across preemption)
     * @param {number} processId - Process ID
     * @param {Object} changeEntry - Change entry to save
     * @returns {Promise<void>}
     */
    async saveChangesToProgress(processId, changeEntry) {
        try {
            const processData = await getProcessById(processId);
            if (!processData) return;

            const progress = processData.progress;

            // Initialize detectedChanges array if it doesn't exist
            if (!progress.detectedChanges) {
                progress.detectedChanges = [];
            }

            // Add the change entry
            progress.detectedChanges.push(changeEntry);

            // Update database
            await updateProcessProgress(processId, progress);

        } catch (error) {
            await sendError(null, null, error, 'saveChangesToProgress', false);
        }
    }

    /**
     * Move player from one status to another in process progress
     * @param {number} processId - Process ID
     * @param {string} playerId - Player ID
     * @param {string} fromStatus - Current status
     * @param {string} toStatus - Target status
     * @returns {Promise<void>}
     */
    async movePlayerToStatus(processId, playerId, fromStatus, toStatus) {
        try {
            const processData = await getProcessById(processId);
            if (!processData) return;

            const progress = processData.progress;

            // Remove from source status
            const fromIndex = progress[fromStatus].indexOf(playerId);
            if (fromIndex !== -1) {
                progress[fromStatus].splice(fromIndex, 1);
            }

            // Add to target status
            if (!progress[toStatus]) {
                progress[toStatus] = [];
            }
            if (!progress[toStatus].includes(playerId)) {
                progress[toStatus].push(playerId);
            }

            // Update database
            await updateProcessProgress(processId, progress);

        } catch (error) {
            await sendError(null, null, error, 'movePlayerToStatus', false);
        }
    }

    /**
     * Fetch player data from API with retry logic
     * @param {string} playerId - Player ID to fetch
     * @returns {Promise<Object>} Player data object or error object { error: string, playerNotExist: boolean }
     */
    async fetchPlayerFromAPI(playerId) {
        return fetchPlayerFromAPIShared(playerId, {
            onError: (error, context) => sendError(null, null, error, context, false),
            delay: (ms) => this.delay(ms),
            returnErrorObject: true
        });
    }

    /**
     * Stop auto-refresh for a specific alliance
     * @param {number} allianceId - Alliance ID
     * @returns {Promise<void>}
     */
    async stopAutoRefresh(allianceId) {
        try {
            // Clear scheduled timeout
            if (this.scheduledRefreshes.has(allianceId)) {
                clearTimeout(this.scheduledRefreshes.get(allianceId));
                this.scheduledRefreshes.delete(allianceId);
            }

            // Stop active refresh if running
            if (this.activeRefreshes.has(allianceId)) {
                const activeRefresh = this.activeRefreshes.get(allianceId);
                try {
                    await updateProcessStatus(activeRefresh.processId, 'completed');
                } catch (error) {
                    await sendError(null, null, error, 'stopAutoRefresh', false);
                }
                this.activeRefreshes.delete(allianceId);
            }

        } catch (error) {
            await sendError(null, null, error, 'stopAutoRefresh', false);
        }
    }

    /**
     * Restart auto-refresh for a specific alliance (useful when settings change)
     * @param {number} allianceId - Alliance ID
     * @returns {Promise<void>}
     */
    async restartAutoRefresh(allianceId) {
        try {
            const alliance = allianceQueries.getAllianceById(allianceId);
            if (!alliance) {
                await sendError(null, null, new Error(`Alliance ${allianceId} not found for restart`), 'restartAutoRefresh', false);
                return;
            }

            // Stop existing refresh
            await this.stopAutoRefresh(allianceId);

            // Start new refresh if configured
            if (alliance.interval > 0 && alliance.channel_id) {
                await this.startAutoRefresh(alliance);
            }

        } catch (error) {
            await sendError(null, null, error, 'restartAutoRefresh', false);
        }
    }

    /**
     * Enable auto-refresh for alliance after adding players (only schedules, doesn't create process)
     * @param {number} allianceId - Alliance ID
     * @returns {Promise<void>}
     */
    async enableAutoRefreshAfterAddingPlayers(allianceId) {
        try {
            const alliance = allianceQueries.getAllianceById(allianceId);
            if (!alliance) {
                return;
            }

            // Check if alliance has refresh configured
            if (!alliance.interval || alliance.interval <= 0 || !alliance.channel_id) {
                return;
            }

            // Check if alliance now has players
            const players = playerQueries.getPlayersByAlliance(allianceId);
            if (players.length === 0) {
                return;
            }

            // Check if auto-refresh is already active
            if (this.activeRefreshes.has(allianceId) || this.scheduledRefreshes.has(allianceId)) {
                return;
            }

            // Only schedule the next refresh, don't create a process now (players are already fresh)
            this.scheduleNextRefresh(alliance);

            systemLogQueries.addLog(
                'auto_refresh_scheduled',
                `Auto-refresh scheduled for alliance ${alliance.name} after adding players`,
                JSON.stringify({
                    allianceId,
                    allianceName: alliance.name,
                    playerCount: players.length,
                    interval: alliance.interval,
                    nextRefreshIn: `${alliance.interval} minutes`,
                    function: 'enableAutoRefreshAfterAddingPlayers'
                })
            );

        } catch (error) {
            await sendError(null, null, error, 'enableAutoRefreshAfterAddingPlayers', false);
        }
    }

    /**
     * Get status of all active auto-refreshes
     * @returns {Object} Status information
     */
    getRefreshStatus() {
        const status = {
            activeRefreshes: this.activeRefreshes.size,
            scheduledRefreshes: this.scheduledRefreshes.size,
            refreshes: []
        };

        for (const [allianceId, refreshInfo] of this.activeRefreshes) {
            status.refreshes.push({
                allianceId,
                allianceName: refreshInfo.allianceName,
                processId: refreshInfo.processId,
                startTime: refreshInfo.startTime,
                duration: Date.now() - refreshInfo.startTime
            });
        }

        return status;
    }

    /**
     * Utility delay function
     * @param {number} ms - Milliseconds to delay
     * @returns {Promise<void>}
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Create singleton instance immediately after class definition for clarity
const autoRefreshManager = new AutoRefreshManager();

/**
 * Main function to execute auto-refresh process (called from executeProcesses)
 * @param {number} processId - Process ID to execute
 * @returns {Promise<void>}
 */
async function executeAutoRefresh(processId) {
    return await autoRefreshManager.executeAutoRefresh(processId);
}

/**
 * Initialize auto-refresh system (called from ready.js)
 * @param {import('discord.js').Client} client - Discord client instance
 * @returns {Promise<void>}
 */
async function initializeAutoRefresh(client) {
    return await autoRefreshManager.initialize(client);
}

/**
 * Stop auto-refresh for an alliance
 * @param {number} allianceId - Alliance ID
 * @returns {Promise<void>}
 */
async function stopAutoRefresh(allianceId) {
    return await autoRefreshManager.stopAutoRefresh(allianceId);
}

/**
 * Restart auto-refresh for an alliance
 * @param {number} allianceId - Alliance ID
 * @returns {Promise<void>}
 */
async function restartAutoRefresh(allianceId) {
    return await autoRefreshManager.restartAutoRefresh(allianceId);
}

/**
 * Get auto-refresh status
 * @returns {Object} Status information
 */
function getAutoRefreshStatus() {
    return autoRefreshManager.getRefreshStatus();
}

module.exports = {
    executeAutoRefresh,
    initializeAutoRefresh,
    stopAutoRefresh,
    restartAutoRefresh,
    getAutoRefreshStatus,
    autoRefreshManager
};

