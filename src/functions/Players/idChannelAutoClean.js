const { idChannelQueries } = require('../utility/database');
const { handleError } = require('../utility/commonFunctions');

/**
 * Scheduler that periodically cleans messages from ID channels.
 * Each channel with auto_clean > 0 gets a setInterval that bulk-deletes
 * messages at the configured interval (in minutes).
 */
class AutoCleanScheduler {
    constructor() {
        /** @type {Map<string, NodeJS.Timeout>} channelId → interval handle */
        this.intervals = new Map();
        /** @type {import('discord.js').Client|null} */
        this.client = null;
    }

    /**
     * Initializes the scheduler — loads all channels with auto_clean enabled
     * and starts their intervals.
     * @param {import('discord.js').Client} client - Discord.js client
     */
    initialize(client) {
        this.client = client;

        try {
            const channels = idChannelQueries.getAutoCleanChannels();
            for (const ch of channels) {
                this.scheduleChannel(ch.channel_id, ch.auto_clean);
            }
            if (channels.length > 0) {
                process.stderr.write(`[auto-clean] Initialized ${channels.length} channel(s)\n`);
            }
        } catch (error) {
            console.error('[auto-clean] Failed to initialize:', error);
        }
    }

    /**
     * Starts or updates the interval for a specific channel.
     * @param {string} channelId - Discord channel ID
     * @param {number} minutes - Interval in minutes
     */
    scheduleChannel(channelId, minutes) {
        // Cancel existing interval if any
        this.cancelChannel(channelId);

        if (minutes <= 0) return;

        const ms = minutes * 60 * 1000;
        const handle = setInterval(() => this._cleanChannel(channelId), ms);
        this.intervals.set(channelId, handle);
    }

    /**
     * Cancels the interval for a specific channel.
     * @param {string} channelId - Discord channel ID
     */
    cancelChannel(channelId) {
        const handle = this.intervals.get(channelId);
        if (handle) {
            clearInterval(handle);
            this.intervals.delete(channelId);
        }
    }

    /**
     * Checks if a message content looks like player IDs
     * (numeric strings of 6-15 digits separated by whitespace, commas, or newlines).
     * @param {string} content - Message content
     * @returns {boolean}
     */
    _isIdMessage(content) {
        if (!content || !content.trim()) return false;
        const parts = content.split(/[\s,\n]+/).filter(p => p.length > 0);
        return parts.length > 0 && parts.every(p => /^\d{6,15}$/.test(p));
    }

    /**
     * Performs the actual message cleanup for one channel.
     * Only deletes bot messages and ID messages (player IDs).
     * Uses bulkDelete which handles messages up to 14 days old.
     * @param {string} channelId - Discord channel ID
     */
    async _cleanChannel(channelId) {
        if (!this.client) return;

        try {
            const channel = await this.client.channels.fetch(channelId).catch(() => null);
            if (!channel || !channel.isTextBased()) {
                // Channel was deleted or inaccessible — remove from scheduler
                this.cancelChannel(channelId);
                return;
            }

            const botId = this.client.user.id;

            // Fetch up to 100 messages at a time and bulk-delete
            let deleted;
            do {
                const messages = await channel.messages.fetch({ limit: 100 });
                if (messages.size === 0) break;

                // Filter: only bot messages and ID messages, and < 14 days old
                const deletable = messages.filter(
                    msg => Date.now() - msg.createdTimestamp < 14 * 24 * 60 * 60 * 1000
                        && (msg.author.id === botId || this._isIdMessage(msg.content))
                );

                if (deletable.size === 0) break;

                deleted = await channel.bulkDelete(deletable, true).catch(() => null);
            } while (deleted && deleted.size >= 2);
        } catch (error) {
            await handleError(null, null, error, 'autoClean._cleanChannel', false);
        }
    }

    /**
     * Stops all intervals — call before bot shutdown / restart.
     */
    cleanup() {
        for (const handle of this.intervals.values()) {
            clearInterval(handle);
        }
        this.intervals.clear();
    }
}

const autoCleanScheduler = new AutoCleanScheduler();

module.exports = { autoCleanScheduler };
