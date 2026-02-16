/**
 * Global cache for admin usernames to prevent repeated Discord API fetches
 * Auto-refreshes every 24 hours and updates when admins are added/removed
 */

const { adminQueries } = require('./database');

class AdminUsernameCache {
    constructor() {
        this.cache = new Map(); // userId -> { username: string, tag: string, fetchedAt: Date }
        this.client = null;
        this.refreshInterval = null;
        this.isInitialized = false;
    }

    /**
     * Initialize the cache with Discord client
     * @param {import('discord.js').Client} client - Discord client instance
     */
    async initialize(client) {
        if (this.isInitialized) {
            console.log('Admin username cache already initialized');
            return;
        }

        this.client = client;

        // Wait for client to be ready
        if (!this.client.isReady()) {
            await new Promise((resolve) => {
                this.client.once('ready', resolve);
            });
        }

        // Initial fetch
        await this.refreshAll();

        // Set up 24-hour refresh interval
        this.refreshInterval = setInterval(() => {
            this.refreshAll().catch(error => {
                console.error('Error in admin username cache auto-refresh:', error);
            });
        }, 24 * 60 * 60 * 1000); // 24 hours

        this.isInitialized = true;
    }

    /**
     * Refresh all admin usernames from Discord
     */
    async refreshAll() {
        if (!this.client) {
            console.error('Cannot refresh cache: client not initialized');
            return;
        }

        const allAdmins = adminQueries.getAllAdmins();
        let successCount = 0;
        let failCount = 0;

        for (const admin of allAdmins) {
            try {
                const user = await this.client.users.fetch(admin.user_id);
                this.cache.set(admin.user_id, {
                    username: user.username,
                    tag: user.tag,
                    fetchedAt: new Date()
                });
                successCount++;
            } catch (error) {
                // Store placeholder for users that can't be fetched
                this.cache.set(admin.user_id, {
                    username: `User-${admin.user_id}`,
                    tag: `Unknown User (${admin.user_id})`,
                    fetchedAt: new Date(),
                    fetchFailed: true
                });
                failCount++;
            }
        }

    }

    /**
     * Add or update a single admin in the cache
     * @param {string} userId - Discord user ID
     */
    async add(userId) {
        if (!this.client) {
            console.error('Cannot add to cache: client not initialized');
            return;
        }

        try {
            const user = await this.client.users.fetch(userId);
            this.cache.set(userId, {
                username: user.username,
                tag: user.tag,
                fetchedAt: new Date()
            });
        } catch (error) {
            // Store placeholder if fetch fails
            this.cache.set(userId, {
                username: `User-${userId}`,
                tag: `Unknown User (${userId})`,
                fetchedAt: new Date(),
                fetchFailed: true
            });
            console.error(`Failed to fetch admin ${userId}, using placeholder`);
        }
    }

    /**
     * Remove an admin from the cache
     * @param {string} userId - Discord user ID
     */
    remove(userId) {
        this.cache.delete(userId);
    }

    /**
     * Get username for an admin (returns cached value or placeholder)
     * @param {string} userId - Discord user ID
     * @returns {Object} { username: string, tag: string, isCached: boolean }
     */
    get(userId) {
        const cached = this.cache.get(userId);

        if (cached) {
            return {
                username: cached.username,
                tag: cached.tag,
                isCached: true,
                fetchFailed: cached.fetchFailed || false
            };
        }

        // Return placeholder if not in cache
        return {
            username: `User-${userId}`,
            tag: `Unknown User (${userId})`,
            isCached: false
        };
    }

    /**
     * Get tag for an admin (shorthand for get().tag)
     * @param {string} userId - Discord user ID
     * @returns {string} User tag
     */
    getTag(userId) {
        return this.get(userId).tag;
    }

    /**
     * Get username for an admin (shorthand for get().username)
     * @param {string} userId - Discord user ID
     * @returns {string} Username
     */
    getUsername(userId) {
        return this.get(userId).username;
    }

    /**
     * Check if cache is initialized
     * @returns {boolean}
     */
    isReady() {
        return this.isInitialized;
    }

    /**
     * Clean up resources
     */
    destroy() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
        this.cache.clear();
        this.client = null;
        this.isInitialized = false;
    }
}

// Export singleton instance
const adminUsernameCache = new AdminUsernameCache();

module.exports = { adminUsernameCache };
