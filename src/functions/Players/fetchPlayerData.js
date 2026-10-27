const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { getProcessById, updateProcessStatus, updateProcessProgress } = require('../Processes/createProcesses');
const { allianceQueries, playerQueries } = require('../utility/database');
const languages = require('../../i18n');
const { handleError, getUserInfo } = require('../utility/commonFunctions');
const { getComponentEmoji, getGlobalEmojiMap } = require('../utility/emojis');
const { formatPlayerWithId, getEffectivePlayerState } = require('./playerDisplay');

const PROGRESS_UPDATE_INTERVAL = 10;

/**
 * Player data fetching and processing
 */
class PlayerDataProcessor {
    constructor() {
        this.processing = new Map(); // Track processing states
    }

    resolveProcessGameType(processData, alliance = null) {
        return processData?.details?.game_type || alliance?.game_type || 'wos';
    }

    /**
     * Main function to process player data for a given process
     * @param {number} processId - Process ID to execute
     * @returns {Promise<void>}
     */
    async processPlayerData(processId) {
        // Get process data
        const processData = await getProcessById(processId);
        if (!processData) {
            throw new Error(`Process ${processId} not found`);
        }

        // Get alliance data
        const alliance = allianceQueries.getAllianceByIdAny(processData.target);
        if (!alliance) {
            throw new Error(`Alliance ${processData.target} not found`);
        }
        if (!Number.isSafeInteger(alliance.state) || alliance.state <= 0) {
            throw new Error(`Alliance ${alliance.name} does not have a valid state configured`);
        }

        // Get admin language for messages
        const { lang } = getUserInfo(processData.created_by);
        try {
            // Get bot client for sending messages
            const { client } = require('../../index'); // Get client from main file
            let channel = null;
            let embedMessage = null;
            let guildId = null;
            let shouldSendProgressEmbeds = false;

            // Check if we should send progress embeds
            // This happens when: 
            // 1. Process was created from Add Player button (has message_id in progress)
            // 2. Process is being recovered from crash (has message_id in progress)
            // ID channel processes do NOT have message_id in progress initially
            if (processData.progress && processData.progress.message_id) {
                shouldSendProgressEmbeds = true;
                guildId = processData.progress.guild_id;
                try {
                    // Fetch channel from guild
                    const guild = await client.guilds.fetch(guildId);
                    channel = await guild.channels.fetch(processData.progress.channel_id);
                } catch (err) {
                    // Fallback to direct channel fetch if guild fetch fails
                    try {
                        channel = await client.channels.fetch(processData.progress.channel_id);
                    } catch (channelErr) {
                        console.warn(`Could not fetch channel for process ${processId}, skipping embed updates`);
                        channel = null;
                        shouldSendProgressEmbeds = false;
                    }
                }

                if (channel) {
                    try {
                        embedMessage = await channel.messages.fetch(processData.progress.message_id);
                    } catch (err) {
                        console.warn(`Could not fetch message for process ${processId}, will skip embed updates`);
                        embedMessage = null;
                        shouldSendProgressEmbeds = false;
                    }
                }
            } else {
            }

            // Initialize or restore processing state
            let existingState = this.processing.get(processId);
            if (!existingState) {
                // Calculate total from progress data
                const totalPlayers = (processData.progress.pending || []).length +
                    (processData.progress.done || []).length +
                    (processData.progress.failed || []).length +
                    (processData.progress.existing || []).length;

                this.processing.set(processId, {
                    totalPlayers: totalPlayers,
                    processed: (processData.progress.done || []).length +
                        (processData.progress.failed || []).length +
                        (processData.progress.existing || []).length,
                    added: (processData.progress.done || []).length,
                    failed: (processData.progress.failed || []).length,
                    existing: (processData.progress.existing || []).length,
                    lastUpdate: Date.now(),
                    profileDeferred: processData.progress.profile_deferred?.length || 0,
                    embedMessage: null
                });
            }

            // Create or update embed based on shouldSendProgressEmbeds flag
            const processingState = this.processing.get(processId);

            if (shouldSendProgressEmbeds && embedMessage && channel) {
                // This process should have progress embeds (Add Player button or crash recovery)
                const initialEmbed = this.createProgressEmbed(
                    processData,
                    alliance,
                    lang,
                    {
                        totalPlayers: processingState.totalPlayers,
                        processed: processingState.processed,
                        added: processingState.added,
                        failed: processingState.failed,
                        existing: processingState.existing,
                        status: lang.players.addPlayer.content.status.processing
                    },
                    processData,
                    { status: processData.status }
                );

                await embedMessage.edit({ embeds: [initialEmbed] });
                processingState.embedMessage = embedMessage;
            } else {
                // ID channel process - NO progress embeds, only final result
                processingState.embedMessage = null;
            }

            // Process remaining players
            await this.fetchAndProcessPlayers(processId, processData, alliance, lang);

            // Complete the process
            await this.completeProcess(processId, processData, alliance, lang);

        } catch (error) {
            await handleError(null, lang, error, 'processPlayerData', false);

            await updateProcessStatus(processId, 'failed');
            this.processing.delete(processId);

            throw error;
        }
    }

    /**
     * Filters out existing players from the process
     * @param {number} processId - Process ID
     * @param {Object} processData - Process data
     * @returns {Promise<void>}
     */
    async filterExistingPlayers(processId, processData) {
        try {
            const playerIds = processData.progress.pending;
            const gameType = this.resolveProcessGameType(processData);
            const existingPlayers = [];
            const newPlayers = [];

            // Check each player ID against database
            for (const playerId of playerIds) {
                const existingPlayer = playerQueries.getPlayer(playerId, gameType);
                if (existingPlayer) {
                    existingPlayers.push(playerId);
                } else {
                    newPlayers.push(playerId);
                }
            }

            // Update progress
            const updatedProgress = {
                pending: newPlayers,
                done: processData.progress.done,
                failed: processData.progress.failed,
                existing: existingPlayers
            };

            await updateProcessProgress(processId, updatedProgress);

            // Update processing state
            const processingState = this.processing.get(processId);
            if (processingState) {
                processingState.existing = existingPlayers.length;
                processingState.processed = existingPlayers.length;
            }


        } catch (error) {
            await handleError(null, null, error, 'filterExistingPlayers', false);
            throw error;
        }
    }

    /**
     * Fetches and processes player data from API
     * @param {number} processId - Process ID
     * @param {Object} processData - Process data
     * @param {Object} alliance - Alliance data
     * @param {Object} lang - Language object
     * @returns {Promise<void>}
     */
    async fetchAndProcessPlayers(processId, processData, alliance, lang) {
        try {
            let currentProgress = await getProcessById(processId);
            const processingState = this.processing.get(processId);
            const gameType = this.resolveProcessGameType(processData, alliance);

            // First, check for players that are already in the database
            const pendingPlayers = [...currentProgress.progress.pending];
            const alreadyAdded = [];


            for (const playerId of pendingPlayers) {
                const existingPlayer = playerQueries.getPlayer(playerId, gameType);
                if (existingPlayer) {
                    // Player already exists, move to existing
                    await this.movePlayerToStatus(processId, playerId, 'pending', 'existing');
                    alreadyAdded.push(playerId);
                    processingState.existing++;
                    processingState.processed++;
                }
            }

            if (alreadyAdded.length > 0) {

                // Update the embed to show recovery progress (ONLY if embed exists)
                if (processingState.embedMessage) {
                    const recoveryEmbed = this.createProgressEmbed(
                        processData,
                        alliance,
                        lang,
                        {
                            totalPlayers: processingState.totalPlayers,
                            processed: processingState.processed,
                            added: processingState.added,
                            failed: processingState.failed,
                            existing: processingState.existing,
                            status: lang.players.addPlayer.content.status.progressUpdate
                                .replace('{processed}', processingState.processed)
                                .replace('{total}', processingState.totalPlayers)
                        },
                        processData,
                        { status: processData.status }
                    );

                    await processingState.embedMessage.edit({ embeds: [recoveryEmbed] });
                }
            }

            // Get updated progress after checking database
            currentProgress = await getProcessById(processId);

            // Player profile lookup was removed by both games. Add the IDs with
            // neutral profile values and inherit the alliance's state.
            for (let i = 0; i < currentProgress.progress.pending.length; i++) {
                const playerId = currentProgress.progress.pending[i];
                try {
                    // Check if process is still active
                    const processCheck = await getProcessById(processId);
                    if (processCheck.status !== 'active') {
                        break;
                    }

                    const existingPlayer = playerQueries.getPlayer(playerId, gameType);
                    if (existingPlayer) {
                        await this.movePlayerToStatus(processId, playerId, 'pending', 'existing');
                        processingState.existing++;
                    } else {
                        const enrichment = await this.addPlayerToDatabase(
                            playerId,
                            alliance.id,
                            alliance.state,
                            processData.created_by,
                            gameType
                        );
                        if (enrichment?.deferred) {
                            const latest = await getProcessById(processId);
                            latest.progress.profile_deferred = [...(latest.progress.profile_deferred || []), String(playerId)];
                            processingState.profileDeferred = latest.progress.profile_deferred.length;
                            await updateProcessProgress(processId, latest.progress);
                        }
                        await this.movePlayerToStatus(processId, playerId, 'pending', 'done');
                        processingState.added++;
                    }
                    processingState.processed++;

                    // Update embed every 10 players or if it's the last one (ONLY if embed exists)
                    if (processingState.embedMessage &&
                        (processingState.processed % PROGRESS_UPDATE_INTERVAL === 0 ||
                            processingState.processed === processingState.totalPlayers)) {
                        await this.updateProgressEmbed(processId, processData, alliance, lang);
                    }

                } catch (error) {
                    await handleError(null, lang, error, 'fetchAndProcessPlayers', false);

                    await this.movePlayerToStatus(processId, playerId, 'pending', 'failed');
                    processingState.failed++;
                    processingState.processed++;
                }
            }

            return 'COMPLETED'; // Return completion status

        } catch (error) {
            await handleError(null, lang, error, 'fetchAndProcessPlayers', false);
            throw error;
        }
    }

    /**
     * Adds player to database
     * @param {string} playerId - Player ID
     * @param {number} allianceId - Alliance ID
     * @param {string} addedBy - Admin ID who added the player
     * @returns {Promise<void>}
     */
    async addPlayerToDatabase(playerId, allianceId, state, addedBy, gameType) {
        try {
            playerQueries.addPlayer(
                playerId,
                state,
                allianceId,
                String(addedBy),
                gameType
            );
            const integration = require('./playerSyncIntegration').getPlayerSyncIntegration();
            if (integration) {
                try { return await integration.enrichPlayer({ fid: String(playerId), gameType, allianceId }); }
                catch { return { deferred: true }; }
            }
        } catch (error) {
            await handleError(null, null, error, 'addPlayerToDatabase', false);
            throw error;
        }
    }

    /**
     * Moves player from one status to another in process progress
     * @param {number} processId - Process ID
     * @param {string} playerId - Player ID
     * @param {string} fromStatus - Current status
     * @param {string} toStatus - Target status
     * @returns {Promise<void>}
     */
    async movePlayerToStatus(processId, playerId, fromStatus, toStatus) {
        try {
            const processData = await getProcessById(processId);
            const progress = processData.progress;

            // Remove from current status
            const fromIndex = progress[fromStatus].indexOf(playerId);
            if (fromIndex > -1) {
                progress[fromStatus].splice(fromIndex, 1);
            }

            // Add to new status
            if (!progress[toStatus]) {
                progress[toStatus] = [];
            }
            progress[toStatus].push(playerId);

            // Update progress in Redis
            await updateProcessProgress(processId, progress);

        } catch (error) {
            await handleError(null, null, error, 'movePlayerToStatus', false);
            throw error;
        }
    }

    /**
     * Completes the process and updates final embed
     * @param {number} processId - Process ID
     * @param {Object} processData - Process data
     * @param {Object} alliance - Alliance data
     * @param {Object} lang - Language object
     * @returns {Promise<void>}
     */
    async completeProcess(processId, processData, alliance, lang) {
        try {
            const processingState = this.processing.get(processId);
            const finalProgress = await getProcessById(processId);

            // Only send final embed if embedMessage exists (crash recovery scenario)
            if (processingState.embedMessage) {
                // Create final embed
                const finalEmbed = this.createProgressEmbed(
                    processData,
                    alliance,
                    lang,
                    {
                        totalPlayers: processingState.totalPlayers,
                        processed: processingState.processed,
                        added: processingState.added,
                        failed: processingState.failed,
                        existing: processingState.existing,
                        status: lang.players.addPlayer.content.status.completed
                    },
                    processData,
                    { status: processData.status }
                );

                // Add button to view failed IDs if any exist
                const components = [];
                const globalEmojiMap = getGlobalEmojiMap();
                if (finalProgress.progress.failed && finalProgress.progress.failed.length > 0) {
                    const failedButton = new ButtonBuilder()
                        .setCustomId(`view_failed_players_${processId}`)
                        .setLabel(lang.players.addPlayer.buttons.viewFailedPlayers)
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji(getComponentEmoji(globalEmojiMap, '1050'));

                    components.push(new ActionRowBuilder().addComponents(failedButton));
                }

                // Update final embed
                await processingState.embedMessage.edit({
                    embeds: [finalEmbed],
                    components
                });
            } else {
                // Silent completion (ID channel process) - but send results embed to ID channel

                // Check if this is from ID channel (has id_channel_message_id)
                if (processData.details && processData.details.id_channel_message_id && processData.details.id_channel_channel_id) {
                    await this.sendIdChannelResultEmbed(processId, processData, finalProgress, alliance, lang);
                }
            }

            // Clean up processing state - completion is handled by executeProcesses.js
            this.processing.delete(processId);

        } catch (error) {
            await handleError(null, lang, error, 'completeProcess', false);
            throw error;
        }
    }

    /**
     * Sends result embed to ID channel after completion
     * @param {number} processId - Process ID
     * @param {Object} processData - Process data
     * @param {Object} finalProgress - Final progress data
     * @param {Object} alliance - Alliance data
     * @param {Object} lang - Language object
     * @returns {Promise<void>}
     */
    async sendIdChannelResultEmbed(processId, processData, finalProgress, alliance, lang) {
        try {
            const { client } = require('../../index');

            // Fetch the ID channel and original message
            const channel = await client.channels.fetch(processData.details.id_channel_channel_id);
            if (!channel) return;

            const originalMessage = await channel.messages.fetch(processData.details.id_channel_message_id);
            if (!originalMessage) return;

            // Build results from progress data
            const added = [];
            const existing = [];
            const failed = finalProgress.progress.failed || [];

            // Get player details for added and existing players
            for (const playerId of (finalProgress.progress.done || [])) {
                const player = playerQueries.getPlayer(playerId, alliance.game_type);
                if (player) {
                    added.push({
                        fid: playerId,
                        nickname: player.nickname,
                        state: player.state,
                        state_override: player.state_override,
                        game_type: player.game_type || alliance.game_type
                    });
                }
            }

            for (const playerId of (finalProgress.progress.existing || [])) {
                const player = playerQueries.getPlayer(playerId, alliance.game_type);
                if (player) {
                    existing.push({
                        fid: playerId,
                        nickname: player.nickname,
                        state: player.state,
                        state_override: player.state_override,
                        game_type: player.game_type || alliance.game_type
                    });
                }
            }

            // Create result embed
            const embed = new EmbedBuilder()
                .setTitle(lang.players.addPlayer.content.title.results)
                .setDescription((lang.players.addPlayer.content.description.results).replace('{alliance}', alliance.name))
                .setColor(failed.length === 0 ? "#00ff00" : (added.length > 0 ? "#ffa500" : "#ff0000"))
                .setFooter({ text: originalMessage.author.tag, iconURL: originalMessage.author.displayAvatarURL() })
                .setTimestamp();

            // Only show statistics for multiple players
            const totalPlayers = added.length + existing.length + failed.length;
            if (totalPlayers > 1) {
                embed.addFields([
                    {
                        name: lang.players.addPlayer.content.statisticsField.name,
                        value: lang.players.addPlayer.content.statisticsField.value
                            .replace('{added}', added.length)
                            .replace('{alreadyExist}', existing.length)
                            .replace('{failed}', failed.length),
                    }
                ]);
            }

            // Show added players (limit to 10)
            if (added.length > 0) {
                const displayedAdded = added.slice(0, 10);
                const addedList = displayedAdded
                    .map(p => lang.players.addPlayer.content.addedField.value
                            .replace('{id}', formatPlayerWithId(p))
                            .replace('{state}', getEffectivePlayerState(p, alliance.state) ?? p.state ?? 'Unknown'))
                    .join('\n');

                let addedValue = addedList;
                if (added.length > 10) {
                    addedValue += lang.players.addPlayer.content.moreThanTen.replace('{count}', added.length - 10);
                }

                embed.addFields([
                    {
                        name: lang.players.addPlayer.content.addedField.name,
                        value: addedValue.length > 1024 ? addedValue.substring(0, 1020) + '...' : addedValue,
                    }
                ]);
            }

            // Show existing players (limit to 10)
            if (existing.length > 0) {
                const displayedExisting = existing.slice(0, 10);
                const existingList = displayedExisting
                    .map(p => lang.players.addPlayer.content.alreadyExistField.value
                            .replace('{id}', formatPlayerWithId(p))
                            .replace('{state}', getEffectivePlayerState(p, alliance.state) ?? p.state ?? 'Unknown'))
                    .join('\n');

                let existingValue = existingList;
                if (existing.length > 10) {
                    existingValue += lang.players.addPlayer.content.moreThanTen.replace('{count}', existing.length - 10);
                }

                embed.addFields([
                    {
                        name: lang.players.addPlayer.content.alreadyExistField.name.replace,
                        value: existingValue.length > 1024 ? existingValue.substring(0, 1020) + '...' : existingValue,
                    }
                ]);
            }

            // Show failed players (limit to 10)
            if (failed.length > 0) {
                const displayedFailed = failed.slice(0, 10);
                const failedList = displayedFailed
                    .map(id => lang.players.addPlayer.content.failedField.value.replace('{id}', id))
                    .join('\n');

                let failedValue = failedList;
                if (failed.length > 10) {
                    failedValue += lang.players.addPlayer.content.moreThanTen.replace('{count}', failed.length - 10);
                }

                embed.addFields([
                    {
                        name: lang.players.addPlayer.content.failedField.name,
                        value: failedValue.length > 1024 ? failedValue.substring(0, 1020) + '...' : failedValue,
                    }
                ]);
            }

            // Edit the existing reply or reply to the original message
            if (processData.details.id_channel_reply_id) {
                try {
                    const replyMessage = await channel.messages.fetch(processData.details.id_channel_reply_id);
                    await replyMessage.edit({ embeds: [embed] });
                } catch {
                    // Fallback to replying if the reply message can't be found
                    await originalMessage.reply({ embeds: [embed] });
                }
            } else {
                await originalMessage.reply({ embeds: [embed] });
            }

        } catch (error) {
            await handleError(null, lang, error, 'handleAddPlayerButton', false);
        }
    }

    /**
     * Updates progress embed during processing
     * @param {number} processId - Process ID
     * @param {Object} processData - Process data
     * @param {Object} alliance - Alliance data
     * @param {Object} lang - Language object
     * @returns {Promise<void>}
     */
    async updateProgressEmbed(processId, processData, alliance, lang) {
        try {
            const processingState = this.processing.get(processId);
            if (!processingState || !processingState.embedMessage) {
                return;
            }

            const progressEmbed = this.createProgressEmbed(
                processData,
                alliance,
                lang,
                {
                    totalPlayers: processingState.totalPlayers,
                    processed: processingState.processed,
                    added: processingState.added,
                    failed: processingState.failed,
                    existing: processingState.existing,
                    status: lang.players.addPlayer.content.status.progressUpdate.replace('{processed}', processingState.processed).replace('{total}', processingState.totalPlayers)
                },
                processData,
                { status: processData.status }
            );

            await processingState.embedMessage.edit({
                embeds: [progressEmbed]
            });

        } catch (error) {
            await handleError(null, lang, error, 'updateProgressEmbed', false);
        }
    }

    /**
     * Creates progress embed for player processing
     * @param {Object} processData - Process data
     * @param {Object} alliance - Alliance data
     * @param {Object} lang - Language object
     * @param {Object} stats - Processing statistics
     * @returns {EmbedBuilder} Progress embed
     */
    createProgressEmbed(processData, alliance, lang, stats, processResult = {}, queueResult = {}) {
        const progressBar = this.createProgressBar(stats.processed, stats.totalPlayers);

        const playerCount = stats.totalPlayers;

        // Check if process is completed based on progress OR status
        const processStatus = (queueResult.status || processData.status || '').toLowerCase();
        const isAllProcessed = stats.processed >= stats.totalPlayers && stats.totalPlayers > 0;
        const isCompleted = processStatus === 'completed' || isAllProcessed;

        const embed = new EmbedBuilder()
            .setTitle(lang.players.addPlayer.content.title.addPlayerProcess)
            .setDescription(stats.status)
            .setColor(isCompleted ? "#00ff00" : "#3498db")
            .addFields([
                {
                    name: lang.players.addPlayer.content.progressField.name,
                    value: progressBar,
                },
                {
                    name: lang.players.addPlayer.content.statisticsField.name,
                    value: lang.players.addPlayer.content.statisticsField.value
                        .replace('{added}', stats.added || 0)
                        .replace('{alreadyExist}', stats.existing || 0)
                        .replace('{failed}', stats.failed || 0),
                }
            ])
            .setTimestamp();

        const deferred = this.processing.get(processData.id)?.profileDeferred || processResult.progress?.profile_deferred?.length || 0;
        if (deferred) embed.addFields({
            name: lang.plugins?.['player-sync']?.title || 'Player Sync',
            value: (lang.plugins?.['player-sync']?.deferredNotice || 'Profile lookup deferred for {count} player(s). Their IDs were added successfully.').replace('{count}', deferred)
        });

        return embed;
    }

    /**
     * Creates a visual progress bar
     * @param {number} processed - Number of processed items
     * @param {number} total - Total number of items
     * @param {number} [length=20] - Bar length
     * @returns {string} Progress bar string
     */
    createProgressBar(processed, total, length = 20) {
        const styles = [
            { filled: '█', empty: '░' },
            { filled: '▰', empty: '▱' },
            { filled: '▶', empty: '▷' },
            { filled: '★', empty: '☆' }
        ];
        const style = styles[Math.floor(Math.random() * styles.length)];

        if (total <= 0) {
            return style.empty.repeat(length) + ' 0%';
        }

        const ratio = Math.max(0, Math.min(1, processed / total));
        const filled = Math.round(ratio * length);
        const empty = Math.max(length - filled, 0);
        const percent = Math.min(100, Math.round(ratio * 100));
        return style.filled.repeat(filled) + style.empty.repeat(empty) + ` ${percent}%`;
    }

}

// Create singleton instance
const playerDataProcessor = new PlayerDataProcessor();

/**
 * Handles the view failed players button
 * @param {import('discord.js').ButtonInteraction} interaction
 * @returns {Promise<void>}
 */
async function handleViewFailedPlayersButton(interaction) {
    try {
        const processId = parseInt(interaction.customId.split('_').pop());

        const processData = await getProcessById(processId);
        if (!processData) {
            return await interaction.reply({
                content: 'Process not found.',
                ephemeral: true
            });
        }

        // Get user language
        const { userLang } = getUserInfo(interaction.user.id);
        const lang = languages[userLang] || languages['en'] || {};

        const failedIds = processData.progress?.failed || [];

        if (failedIds.length === 0) {
            return await interaction.reply({
                content: lang.players.addPlayer.content.description.noFailedPlayers || 'No failed players found.',
                ephemeral: true
            });
        }

        // Get alliance data
        const alliance = allianceQueries.getAllianceByIdAny(processData.target);
        const allianceName = alliance ? alliance.name : 'Unknown Alliance';

        // Build embed
        const embed = new EmbedBuilder()
            .setTitle(lang.players.addPlayer.content.failedField.name)
            .setDescription(`Failed player IDs for alliance **${allianceName}**:\n\nThese players could not be stored. Check the bot logs for the database error.`)
            .setColor('#ff0000')
            .setTimestamp();

        // Split into chunks of 20 for better readability
        const chunkSize = 20;
        const chunks = [];
        for (let i = 0; i < failedIds.length; i += chunkSize) {
            chunks.push(failedIds.slice(i, i + chunkSize));
        }

        // Add fields for each chunk
        chunks.forEach((chunk, index) => {
            const fieldName = chunks.length > 1 ? `Failed IDs (${index * chunkSize + 1}-${Math.min((index + 1) * chunkSize, failedIds.length)})` : 'Failed Player IDs';
            const fieldValue = chunk.map(id => `\`${id}\``).join(', ');
            embed.addFields([{
                name: fieldName,
                value: fieldValue.length > 1024 ? fieldValue.substring(0, 1020) + '...' : fieldValue,
                inline: false
            }]);
        });

        embed.addFields([{
            name: 'Total Failed',
            value: `${failedIds.length} player(s)`,
            inline: false
        }]);

        await interaction.reply({
            embeds: [embed],
            ephemeral: true
        });

    } catch (error) {
        console.error('Error in handleViewFailedPlayersButton:', error);
        await interaction.reply({
            content: 'An error occurred while viewing failed players.',
            ephemeral: true
        }).catch(() => { });
    }
}

/**
 * Main function to process player data (called from executeProcesses)
 * @param {number} processId - Process ID to execute
 * @returns {Promise<void>}
 */
async function processPlayerData(processId) {
    return await playerDataProcessor.processPlayerData(processId);
}

module.exports = {
    processPlayerData,
    playerDataProcessor,
    handleViewFailedPlayersButton
};

