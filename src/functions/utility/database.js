const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Database path
const dbDir = path.join(__dirname, '../../database');
const dbPath = path.join(dbDir, 'Database.db');

// Ensure database directory exists
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

// Initialize database
const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Enable WAL mode for better performance and concurrency
db.pragma('journal_mode = WAL');

// Database schema definitions
const schemas = {
    admins: `
        CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT UNIQUE NOT NULL,
            added_by TEXT,
            added_at TEXT,
            permissions INTEGER DEFAULT 0,
            alliances TEXT,
            is_owner BOOLEAN DEFAULT 0,
            language TEXT,
            custom_emoji INTEGER
        )
    `,
    custom_emojis: `
        CREATE TABLE IF NOT EXISTS custom_emojis (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            data TEXT,
            active BOOLEAN DEFAULT 0
        )
    `,
    alliance: `
        CREATE TABLE IF NOT EXISTS alliance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            priority INTEGER UNIQUE NOT NULL,
            name TEXT NOT NULL,
            guide_id TEXT,
            channel_id TEXT,
            interval TEXT,
            auto_redeem BOOLEAN,
            created_by TEXT
        )
    `,
    id_channels: `
        CREATE TABLE IF NOT EXISTS id_channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guide_id TEXT,
            alliance_id INTEGER NOT NULL REFERENCES alliance(id),
            channel_id TEXT NOT NULL,
            linked_by TEXT
        )
    `,
    gift_code_channels: `
        CREATE TABLE IF NOT EXISTS gift_code_channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id TEXT NOT NULL UNIQUE,
            linked_by TEXT,
            created_at TEXT NOT NULL
        )
    `,
    players: `
        CREATE TABLE IF NOT EXISTS players (
            fid INTEGER PRIMARY KEY,
            user_id TEXT,
            nickname TEXT,
            furnace_level INTEGER,
            state INTEGER,
            image_url TEXT,
            alliance_id INTEGER,
            added_by TEXT NOT NULL,
            is_rich BOOLEAN DEFAULT 0,
            vip_count INTEGER DEFAULT 0,
            exist INTEGER DEFAULT 0
        )
    `,
    furnace_changes: `
        CREATE TABLE IF NOT EXISTS furnace_changes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fid INTEGER NOT NULL REFERENCES players(fid),
            old_furnace_lv INTEGER,
            new_furnace_lv INTEGER,
            change_date TEXT
        )
    `,
    nickname_changes: `
        CREATE TABLE IF NOT EXISTS nickname_changes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fid INTEGER NOT NULL REFERENCES players(fid),
            old_nickname TEXT,
            new_nickname TEXT,
            change_date TEXT
        )
    `,
    gift_codes: `
        CREATE TABLE IF NOT EXISTS gift_codes (
            gift_code TEXT PRIMARY KEY,
            date TEXT,
            status TEXT,
            added_by TEXT,
            source TEXT,
            api_pushed BOOLEAN DEFAULT 0,
            last_validated TEXT,
            is_vip BOOLEAN DEFAULT 0
        )
    `,
    giftcode_usage: `
        CREATE TABLE IF NOT EXISTS giftcode_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fid INTEGER NOT NULL,
            gift_code TEXT NOT NULL,
            status TEXT
        )
    `,
    notifications: `
        CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            completed BOOLEAN DEFAULT 0,
            guild_id TEXT,
            channel_id TEXT,
            hour INTEGER,
            minute INTEGER,
            message_content TEXT,
            title TEXT,
            description TEXT,
            color TEXT,
            image_url TEXT,
            thumbnail_url TEXT,
            footer TEXT,
            author TEXT,
            fields TEXT,
            pattern TEXT,
            mention TEXT,
            repeat_status INTEGER,
            repeat_frequency INTEGER,
            embed_toggle BOOLEAN DEFAULT 0,
            is_active BOOLEAN DEFAULT 1,
            created_at TEXT,
            last_trigger TEXT,
            next_trigger TEXT,
            created_by TEXT
        )
    `,
    alliance_logs: `
        CREATE TABLE IF NOT EXISTS alliance_logs (
            alliance_id INTEGER PRIMARY KEY REFERENCES alliance(id),
            channel_id TEXT
        )
    `,
    admin_logs: `
        CREATE TABLE IF NOT EXISTS admin_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            log_code INTEGER,
            details TEXT,
            time TEXT NOT NULL
        )
    `,
    system_logs: `
        CREATE TABLE IF NOT EXISTS system_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action_type TEXT NOT NULL,
            action TEXT NOT NULL,
            extra_details TEXT,
            time TEXT NOT NULL,
            event_id TEXT,
            severity TEXT,
            module TEXT,
            correlation_id TEXT
        )
    `,
    processes: `
        CREATE TABLE IF NOT EXISTS processes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            target TEXT NOT NULL,
            status TEXT NOT NULL,
            priority INTEGER NOT NULL DEFAULT 5,
            details TEXT NOT NULL,
            progress TEXT NOT NULL,
            resume_after INTEGER,
            preempted_by INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT,
            created_by TEXT
        )
    `,
    test_ids: `
        CREATE TABLE IF NOT EXISTS test_ids (
            id INTEGER PRIMARY KEY CHECK (id <= 2),
            fid INTEGER NOT NULL,
            is_default BOOLEAN DEFAULT 0,
            set_by TEXT,
            set_at TEXT
        )
    `,
    settings: `
        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            auto_delete BOOLEAN NOT NULL DEFAULT 1,
            gdrive_token TEXT
        )
    `
};

// Create all tables
try {
    Object.entries(schemas).forEach(([tableName, schema]) => {
        db.exec(schema);
    });

    // Create indexes for processes table
    db.exec(`CREATE INDEX IF NOT EXISTS idx_processes_status_priority ON processes (status, priority)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_processes_resume_after ON processes (resume_after)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_processes_created_at ON processes (created_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_processes_preempted_by ON processes (preempted_by)`);

    // Create indexes for giftcode_usage table (for fast lookups)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_giftcode_usage_fid ON giftcode_usage (fid)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_giftcode_usage_gift_code ON giftcode_usage (gift_code)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_giftcode_usage_fid_gift_code ON giftcode_usage (fid, gift_code)`);

    // Create index for log_code for faster filtering
    db.exec(`CREATE INDEX IF NOT EXISTS idx_admin_logs_log_code ON admin_logs (log_code)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_admin_logs_user_id_time ON admin_logs (user_id, time)`);

    // Initialize default test IDs
    const existingTestIds = db.prepare('SELECT COUNT(*) as count FROM test_ids').get();
    if (existingTestIds.count === 0) {
        // Insert default test ID (40393986)
        db.prepare(`INSERT INTO test_ids (id, fid, is_default, set_by, set_at) VALUES (1, 40393986, 1, 'system', ?)`).run(getCurrentTimestamp());
        // Insert placeholder for user-set test ID
        db.prepare(`INSERT INTO test_ids (id, fid, is_default, set_by, set_at) VALUES (2, 40393986, 0, NULL, NULL)`).run();
    }
} catch (error) {
    console.error('FATAL: Database initialization failed:', error);
    process.exit(1);
}

// Helper function to get current timestamp
function getCurrentTimestamp() {
    return new Date().toISOString();
}

// Admin queries
const adminQueries = {
    // Create admin
    addAdmin: db.prepare(`
        INSERT INTO admins (user_id, added_by, added_at, permissions, alliances, is_owner, language)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `),

    // Get admin by user_id
    getAdmin: db.prepare('SELECT * FROM admins WHERE user_id = ?'),

    // Get admin by id
    getAdminById: db.prepare('SELECT * FROM admins WHERE id = ?'),

    // Get all admins
    getAllAdmins: db.prepare('SELECT * FROM admins'),

    // Update admin permissions
    updateAdminPermissions: db.prepare('UPDATE admins SET permissions = ? WHERE user_id = ?'),

    // Update admin language
    updateAdminLanguage: db.prepare('UPDATE admins SET language = ? WHERE user_id = ?'),

    // Update admin alliances
    updateAdminAlliances: db.prepare('UPDATE admins SET alliances = ? WHERE user_id = ?'),

    // Update admin custom emoji set (nullable)
    updateAdminCustomEmoji: db.prepare('UPDATE admins SET custom_emoji = ? WHERE user_id = ?'),

    // Get admins using a specific custom emoji set
    getAdminsByCustomEmoji: db.prepare('SELECT user_id FROM admins WHERE custom_emoji = ?'),

    // Delete admin
    deleteAdmin: db.prepare('DELETE FROM admins WHERE user_id = ?'),

    // Check if user is owner
    isOwner: db.prepare('SELECT is_owner FROM admins WHERE user_id = ? AND is_owner = 1'),

    // Update owner status
    updateOwnerStatus: db.prepare('UPDATE admins SET is_owner = ? WHERE user_id = ?')
};

// Custom emoji set queries
const customEmojiQueries = {
    // Create emoji set
    addCustomEmojiSet: db.prepare(`
        INSERT INTO custom_emojis (name, data, active)
        VALUES (?, ?, ?)
    `),

    // Get emoji set by id
    getCustomEmojiSetById: db.prepare('SELECT * FROM custom_emojis WHERE id = ?'),

    // Get emoji set by name
    getCustomEmojiSetByName: db.prepare('SELECT * FROM custom_emojis WHERE name = ?'),

    // Get all emoji sets
    getAllCustomEmojiSets: db.prepare('SELECT * FROM custom_emojis ORDER BY id'),

    // Get active emoji set
    getActiveCustomEmojiSet: db.prepare('SELECT * FROM custom_emojis WHERE active = 1 ORDER BY id LIMIT 1'),

    // Update emoji set name
    updateCustomEmojiSetName: db.prepare('UPDATE custom_emojis SET name = ? WHERE id = ?'),

    // Update emoji set data
    updateCustomEmojiSetData: db.prepare('UPDATE custom_emojis SET data = ? WHERE id = ?'),

    // Clear active emoji set
    clearActiveCustomEmojiSet: db.prepare('UPDATE custom_emojis SET active = 0'),

    // Set active emoji set
    setActiveCustomEmojiSet: db.prepare('UPDATE custom_emojis SET active = 1 WHERE id = ?'),

    // Delete emoji set
    deleteCustomEmojiSet: db.prepare('DELETE FROM custom_emojis WHERE id = ?'),

    // Count emoji sets
    countCustomEmojiSets: db.prepare('SELECT COUNT(*) as count FROM custom_emojis')
};

// Alliance queries
const allianceQueries = {
    // Create alliance
    addAlliance: db.prepare(`
        INSERT INTO alliance (priority, name, guide_id, channel_id, interval, auto_redeem, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `),

    // Get alliance by id
    getAllianceById: db.prepare('SELECT * FROM alliance WHERE id = ?'),

    // Get all alliances
    getAllAlliances: db.prepare('SELECT * FROM alliance ORDER BY priority'),

    // Update alliance
    updateAlliance: db.prepare(`
        UPDATE alliance SET priority = ?, name = ?, guide_id = ?, channel_id = ?, 
        interval = ?, auto_redeem = ? WHERE id = ?
    `),

    // Update alliance priority only
    updateAlliancePriority: db.prepare('UPDATE alliance SET priority = ? WHERE id = ?'),

    // Delete alliance
    deleteAlliance: db.prepare('DELETE FROM alliance WHERE id = ?'),

    // Get alliance by priority
    getAllianceByPriority: db.prepare('SELECT * FROM alliance WHERE priority = ?'),

    // Get alliances by a list of IDs
    getAlliancesByIds: db.prepare('SELECT * FROM alliance WHERE id IN (SELECT value FROM json_each(?))'),

    // Get alliances with auto-redeem enabled, ordered by priority
    getAlliancesWithAutoRedeem: db.prepare('SELECT * FROM alliance WHERE auto_redeem = 1 ORDER BY priority')
};

// ID Channels queries
const idChannelQueries = {
    // Add channel
    addIdChannel: db.prepare(`
        INSERT INTO id_channels (guide_id, alliance_id, channel_id, linked_by)
        VALUES (?, ?, ?, ?)
    `),

    // Get channels by alliance
    getChannelsByAlliance: db.prepare('SELECT * FROM id_channels WHERE alliance_id = ?'),

    // Get channels by multiple alliance IDs
    getChannelsByAllianceIds: db.prepare('SELECT * FROM id_channels WHERE alliance_id IN (SELECT value FROM json_each(?))'),

    // Get channel by id
    getChannelById: db.prepare('SELECT * FROM id_channels WHERE id = ?'),

    // Get channel by channel_id (Discord channel ID)
    getChannelByChannelId: db.prepare('SELECT * FROM id_channels WHERE channel_id = ?'),

    // Delete channel
    deleteChannel: db.prepare('DELETE FROM id_channels WHERE id = ?'),

    // Get all channels
    getAllChannels: db.prepare('SELECT * FROM id_channels')
};

// Gift code channel queries
const giftCodeChannelQueries = {
    // Add gift code channel
    addChannel: db.prepare(`
        INSERT INTO gift_code_channels (channel_id, linked_by, created_at)
        VALUES (?, ?, ?)
    `),

    // Get channel by channel_id (Discord channel ID)
    getChannelByChannelId: db.prepare('SELECT * FROM gift_code_channels WHERE channel_id = ?'),

    // Get channel by id
    getChannelById: db.prepare('SELECT * FROM gift_code_channels WHERE id = ?'),

    // Get all gift code channels
    getAllChannels: db.prepare('SELECT * FROM gift_code_channels'),

    // Delete channel
    deleteChannel: db.prepare('DELETE FROM gift_code_channels WHERE id = ?'),

    // Check if channel exists
    channelExists: db.prepare('SELECT 1 FROM gift_code_channels WHERE channel_id = ? LIMIT 1')
};

// Player queries
const playerQueries = {
    // Add player
    addPlayer: db.prepare(`
        INSERT INTO players (fid, user_id, nickname, furnace_level, state, image_url, alliance_id, added_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),

    // Get player by fid
    getPlayer: db.prepare('SELECT * FROM players WHERE fid = ?'),

    // Get players by alliance
    getPlayersByAlliance: db.prepare('SELECT * FROM players WHERE alliance_id = ? AND exist < 3'),

    // Get player counts for multiple alliances (used for pagination efficiency)
    getPlayerCountsByAllianceIds: db.prepare(`
        SELECT alliance_id, COUNT(*) as player_count 
        FROM players 
        WHERE alliance_id IN (SELECT value FROM json_each(?)) AND exist < 3
        GROUP BY alliance_id
    `),

    // Update player
    updatePlayer: db.prepare(`
        UPDATE players SET user_id = ?, nickname = ?, furnace_level = ?, state = ?, 
        image_url = ?, alliance_id = ? WHERE fid = ?
    `),

    // Update furnace level
    updateFurnaceLevel: db.prepare('UPDATE players SET furnace_level = ? WHERE fid = ?'),

    // Update nickname
    updateNickname: db.prepare('UPDATE players SET nickname = ? WHERE fid = ?'),

    // Update player alliance
    updatePlayerAlliance: db.prepare('UPDATE players SET alliance_id = ? WHERE fid = ?'),

    // Delete player
    deletePlayer: db.prepare('DELETE FROM players WHERE fid = ?'),

    // Delete furnace changes for player
    deleteFurnaceChanges: db.prepare('DELETE FROM furnace_changes WHERE fid = ?'),

    // Delete nickname changes for player
    deleteNicknameChanges: db.prepare('DELETE FROM nickname_changes WHERE fid = ?'),

    // Delete giftcode usage for player
    deleteGiftcodeUsage: db.prepare('DELETE FROM giftcode_usage WHERE fid = ?'),

    // Get all players
    getAllPlayers: db.prepare('SELECT * FROM players'),

    // Update player rich status
    updatePlayerRichStatus: db.prepare('UPDATE players SET is_rich = ? WHERE fid = ?'),

    // Update player VIP count
    updatePlayerVipCount: db.prepare('UPDATE players SET vip_count = ? WHERE fid = ?'),

    // Increment VIP count for all non-rich players
    incrementVipCountForNonRich: db.prepare('UPDATE players SET vip_count = vip_count + 1 WHERE is_rich = 0'),

    // Reset VIP count for a player
    resetPlayerVipCount: db.prepare('UPDATE players SET vip_count = 1 WHERE fid = ?'),

    // Get players eligible for VIP codes (is_rich = 1 OR vip_count = 0 OR vip_count >= 5)
    // vip_count = 0: Untested players (first time, give them a chance)
    // vip_count >= 5: Players who failed VIP redemption multiple times (likely eligible)
    // is_rich = 1: Confirmed VIP/rich players
    getVipEligiblePlayers: db.prepare(`
        SELECT * FROM players 
        WHERE alliance_id = ? AND (is_rich = 1 OR vip_count = 0 OR vip_count >= 5) AND exist < 3
    `),
    // Increment exist counter for non-existent players
    incrementPlayerExist: db.prepare('UPDATE players SET exist = exist + 1 WHERE fid = ?'),
    // Reset exist counter when player returns valid data (false positive)
    resetPlayerExist: db.prepare('UPDATE players SET exist = 0 WHERE fid = ?'),
    // Get players with exist >= 3 (for future features)
    getNonExistentPlayers: db.prepare('SELECT * FROM players WHERE exist >= 3'),
    // Get players by alliance excluding non-existent
    getPlayersByAllianceId: db.prepare('SELECT * FROM players WHERE alliance_id = ? AND exist < 3'),

    // Get multiple players by FIDs in a single query
    getPlayersByFids: (fids) => {
        if (!fids || fids.length === 0) return [];
        const placeholders = fids.map(() => '?').join(',');
        const query = `SELECT * FROM players WHERE fid IN (${placeholders})`;
        return db.prepare(query).all(...fids);
    },

    // Delete multiple players in a single transaction
    deletePlayers: (fids) => {
        if (!fids || fids.length === 0) return;
        const placeholders = fids.map(() => '?').join(',');

        // Delete related records
        const deleteFurnaceChangesQuery = `DELETE FROM furnace_changes WHERE fid IN (${placeholders})`;
        const deleteNicknameChangesQuery = `DELETE FROM nickname_changes WHERE fid IN (${placeholders})`;
        const deleteGiftcodeUsageQuery = `DELETE FROM giftcode_usage WHERE fid IN (${placeholders})`;
        const deletePlayersQuery = `DELETE FROM players WHERE fid IN (${placeholders})`;

        db.prepare(deleteFurnaceChangesQuery).run(...fids);
        db.prepare(deleteNicknameChangesQuery).run(...fids);
        db.prepare(deleteGiftcodeUsageQuery).run(...fids);
        db.prepare(deletePlayersQuery).run(...fids);
    }
};

// Furnace changes queries
const furnaceChangeQueries = {
    // Add furnace change
    addFurnaceChange: db.prepare(`
        INSERT INTO furnace_changes (fid, old_furnace_lv, new_furnace_lv, change_date)
        VALUES (?, ?, ?, ?)
    `),

    // Get changes by player
    getChangesByPlayer: db.prepare('SELECT * FROM furnace_changes WHERE fid = ? ORDER BY change_date DESC'),

    // Get all changes
    getAllChanges: db.prepare('SELECT * FROM furnace_changes ORDER BY change_date DESC')
};

// Nickname changes queries
const nicknameChangeQueries = {
    // Add nickname change
    addNicknameChange: db.prepare(`
        INSERT INTO nickname_changes (fid, old_nickname, new_nickname, change_date)
        VALUES (?, ?, ?, ?)
    `),

    // Get changes by player
    getChangesByPlayer: db.prepare('SELECT * FROM nickname_changes WHERE fid = ? ORDER BY change_date DESC'),

    // Get all changes
    getAllChanges: db.prepare('SELECT * FROM nickname_changes ORDER BY change_date DESC')
};

// Gift code queries
const giftCodeQueries = {
    // Add gift code
    addGiftCode: db.prepare(`
        INSERT INTO gift_codes (gift_code, date, status, added_by, source, api_pushed, last_validated, is_vip)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),

    // Get gift code
    getGiftCode: db.prepare('SELECT * FROM gift_codes WHERE gift_code = ?'),

    // Get all gift codes
    getAllGiftCodes: db.prepare('SELECT * FROM gift_codes ORDER BY date DESC'),

    // Update gift code status
    updateGiftCodeStatus: db.prepare('UPDATE gift_codes SET status = ? WHERE gift_code = ?'),

    // Update last validated timestamp
    updateLastValidated: db.prepare('UPDATE gift_codes SET last_validated = ? WHERE gift_code = ?'),

    // Get codes that need revalidation (not validated in last 24 hours and added more than 1 hour ago)
    getCodesNeedingValidation: db.prepare(`
        SELECT * FROM gift_codes 
        WHERE status != 'invalid' 
        AND datetime(date) < datetime('now', '-1 hours')
        AND (last_validated IS NULL OR datetime(last_validated) < datetime('now', '-24 hours'))
    `),

    // Delete gift code
    removeGiftCode: db.prepare('DELETE FROM gift_codes WHERE gift_code = ?'),

    // Update gift code VIP status
    updateGiftCodeVipStatus: db.prepare('UPDATE gift_codes SET is_vip = ? WHERE gift_code = ?'),

    // Update gift code API push status
    updateApiPushed: db.prepare('UPDATE gift_codes SET api_pushed = ? WHERE gift_code = ?'),

    // Get VIP gift codes
    getVipGiftCodes: db.prepare('SELECT * FROM gift_codes WHERE is_vip = 1 AND status = \'active\' ORDER BY date DESC')
};

// Gift code usage queries
const giftCodeUsageQueries = {
    // Add usage
    addUsage: db.prepare(`
        INSERT INTO giftcode_usage (fid, gift_code, status)
        VALUES (?, ?, ?)
    `),

    // Get usage by player
    getUsageByPlayer: db.prepare('SELECT * FROM giftcode_usage WHERE fid = ?'),

    // Get usage by gift code
    getUsageByGiftCode: db.prepare('SELECT * FROM giftcode_usage WHERE gift_code = ?'),

    // Check if player used code
    checkUsage: db.prepare('SELECT * FROM giftcode_usage WHERE fid = ? AND gift_code = ?'),

    // Update usage status
    updateUsageStatus: db.prepare('UPDATE giftcode_usage SET status = ? WHERE id = ?'),

    // Get all FIDs who already redeemed a specific gift code (FAST - for filtering)
    getFidsWhoRedeemedCode: db.prepare('SELECT fid FROM giftcode_usage WHERE gift_code = ?'),

    // Check if multiple players already redeemed a code (bulk check)
    // Returns FIDs that HAVE redeemed the code
    checkBulkUsage: db.prepare(`
        SELECT DISTINCT fid 
        FROM giftcode_usage 
        WHERE gift_code = ? AND fid IN (SELECT value FROM json_each(?))
    `),

    // Get count of how many times a gift code was redeemed
    getUsageCount: db.prepare('SELECT COUNT(*) as count FROM giftcode_usage WHERE gift_code = ?'),

    // Get usage counts for multiple gift codes (batch)
    getUsageCountsBatch: (giftCodes) => {
        if (!giftCodes || giftCodes.length === 0) return {};
        const placeholders = giftCodes.map(() => '?').join(',');
        const query = `SELECT gift_code, COUNT(*) as count FROM giftcode_usage WHERE gift_code IN (${placeholders}) GROUP BY gift_code`;
        const rows = db.prepare(query).all(giftCodes);
        const result = {};
        rows.forEach(row => {
            result[row.gift_code] = row.count;
        });
        return result;
    },

    // Delete all usage records for a gift code
    deleteUsageByGiftCode: db.prepare('DELETE FROM giftcode_usage WHERE gift_code = ?')
};

// Notification queries
const notificationQueries = {
    // Add notification
    addNotification: db.prepare(`
        INSERT INTO notifications (name, type, completed, guild_id, channel_id, hour, minute, message_content, title, description, 
        color, image_url, thumbnail_url, footer, author, fields, pattern, mention, repeat_status, repeat_frequency, 
        embed_toggle, is_active, created_at, last_trigger, next_trigger, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),

    // Get notification by id
    getNotificationById: db.prepare('SELECT * FROM notifications WHERE id = ?'),

    // Get all notifications
    getAllNotifications: db.prepare('SELECT * FROM notifications'),

    // Get notifications by guild
    getNotificationsByGuild: db.prepare('SELECT * FROM notifications WHERE guild_id = ?'),

    // Update notification
    updateNotification: db.prepare(`
        UPDATE notifications SET name = ?, guild_id = ?, channel_id = ?, hour = ?, minute = ?, 
        message_content = ?, title = ?, description = ?, color = ?, image_url = ?, thumbnail_url = ?, 
        footer = ?, author = ?, fields = ?, pattern = ?, mention = ?, repeat_status = ?, repeat_frequency = ?, 
        embed_toggle = ?, is_active = ?, last_trigger = ?, next_trigger = ? WHERE id = ?
    `),

    // Update notification active status
    updateNotificationActiveStatus: db.prepare('UPDATE notifications SET is_active = ? WHERE id = ?'),

    // Update notification completed status
    updateNotificationCompletedStatus: db.prepare('UPDATE notifications SET completed = ? WHERE id = ?'),

    // Get active notifications
    getActiveNotifications: db.prepare('SELECT * FROM notifications WHERE is_active = 1'),

    // Delete notification
    deleteNotification: db.prepare('DELETE FROM notifications WHERE id = ?')
};

// Alliance logs queries
const allianceLogQueries = {
    // Add log channel
    addLogChannel: db.prepare(`
        INSERT OR REPLACE INTO alliance_logs (alliance_id, channel_id)
        VALUES (?, ?)
    `),

    // Get log channel
    getLogChannel: db.prepare('SELECT * FROM alliance_logs WHERE alliance_id = ?'),

    // Get all log channels
    getAllLogChannels: db.prepare('SELECT * FROM alliance_logs'),

    // Delete log channel
    deleteLogChannel: db.prepare('DELETE FROM alliance_logs WHERE alliance_id = ?')
};

// Admin logs queries
const adminLogQueries = {
    // Add admin log
    addLog: db.prepare(`
        INSERT INTO admin_logs (user_id, log_code, details, time)
        VALUES (?, ?, ?, ?)
    `),

    // Get logs by user
    getLogsByUser: db.prepare('SELECT * FROM admin_logs WHERE user_id = ? ORDER BY time DESC'),

    // Get logs by user with limit and offset
    getAdminLogs: db.prepare('SELECT * FROM admin_logs WHERE user_id = ? ORDER BY time DESC LIMIT ? OFFSET ?'),

    // Get count of logs by user
    getAdminLogsCount: db.prepare('SELECT COUNT(*) as count FROM admin_logs WHERE user_id = ?'),

    // Get logs by code range (e.g., 10000-19999 for alliance)
    getLogsByCodeRange: db.prepare('SELECT * FROM admin_logs WHERE user_id = ? AND log_code >= ? AND log_code <= ? ORDER BY time DESC LIMIT ? OFFSET ?'),

    // Get logs by multiple code ranges (static two-range helper)
    getLogsByMultipleTypes: db.prepare('SELECT * FROM admin_logs WHERE user_id = ? AND (log_code BETWEEN ? AND ? OR log_code BETWEEN ? AND ?) ORDER BY time DESC LIMIT ? OFFSET ?'),

    // Get logs by an arbitrary number of code ranges (array of {min, max})
    // This builds a dynamic SQL query to avoid loading all logs into memory
    getLogsByCodeRanges: (userId, ranges, limit = 9999, offset = 0) => {
        if (!ranges || !Array.isArray(ranges) || ranges.length === 0) return [];

        const clauses = ranges.map(() => '(log_code BETWEEN ? AND ?)').join(' OR ');
        const sql = `SELECT * FROM admin_logs WHERE user_id = ? AND (${clauses}) ORDER BY time DESC LIMIT ? OFFSET ?`;
        const params = [userId];
        ranges.forEach(r => {
            params.push(r.min, r.max);
        });
        params.push(limit, offset);
        return db.prepare(sql).all(...params);
    },

    // Get all admin logs
    getAllLogs: db.prepare('SELECT * FROM admin_logs ORDER BY time DESC'),

    // Get recent logs (limit)
    getRecentLogs: db.prepare('SELECT * FROM admin_logs ORDER BY time DESC LIMIT ?')
};

// System logs queries
const systemLogQueries = {
    // Add system log
    addLog: db.prepare(`
        INSERT INTO system_logs (action_type, action, extra_details, time)
        VALUES (?, ?, ?, ?)
    `),

    // Get logs by action type
    getLogsByActionType: db.prepare('SELECT * FROM system_logs WHERE action_type = ? ORDER BY time DESC'),

    // Get all system logs
    getAllLogs: db.prepare('SELECT * FROM system_logs ORDER BY time DESC'),

    // Get recent logs (limit)
    getRecentLogs: db.prepare('SELECT * FROM system_logs ORDER BY time DESC LIMIT ?')
};

// Processes queries
const processQueries = {
    // Add process
    addProcess: db.prepare(`
        INSERT INTO processes (action, target, status, priority, details, progress, created_at, updated_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),

    // Get process by id
    getProcessById: db.prepare('SELECT * FROM processes WHERE id = ?'),

    // Get all processes
    getAllProcesses: db.prepare('SELECT * FROM processes ORDER BY created_at DESC'),

    // Get processes by action
    getProcessesByAction: db.prepare('SELECT * FROM processes WHERE action = ? ORDER BY created_at DESC'),

    // Get processes by status
    getProcessesByStatus: db.prepare('SELECT * FROM processes WHERE status = ? ORDER BY priority ASC, created_at ASC'),

    // Get processes by created_by
    getProcessesByCreator: db.prepare('SELECT * FROM processes WHERE created_by = ? ORDER BY created_at DESC'),

    // Get next queued process by priority
    getNextQueuedProcess: db.prepare(`
        SELECT * FROM processes 
        WHERE status = 'queued' 
        ORDER BY priority ASC, created_at ASC 
        LIMIT 1
    `),

    // Get active processes
    getActiveProcesses: db.prepare(`
        SELECT * FROM processes 
        WHERE status = 'active' 
        ORDER BY priority ASC
    `),

    // Get paused processes ready to resume (preempted processes that are now queued)
    getPausedProcessesReadyToResume: db.prepare(`
        SELECT * FROM processes 
        WHERE status = 'queued' AND preempted_by IS NOT NULL AND (resume_after IS NULL OR resume_after <= ?)
        ORDER BY priority ASC, created_at ASC
    `),

    // Get processes by priority range
    getProcessesByPriorityRange: db.prepare(`
        SELECT * FROM processes 
        WHERE status IN ('queued', 'active') AND priority BETWEEN ? AND ?
        ORDER BY priority ASC, created_at ASC
    `),

    // Update process status
    updateProcessStatus: db.prepare(`
        UPDATE processes 
        SET status = ?, updated_at = ?
        WHERE id = ?
    `),

    // Update process progress
    updateProcessProgress: db.prepare(`
        UPDATE processes 
        SET progress = ?, updated_at = ?
        WHERE id = ?
    `),

    // Update process details
    updateProcessDetails: db.prepare(`
        UPDATE processes 
        SET details = ?, updated_at = ?
        WHERE id = ?
    `),

    // Set process resume time (for rate limiting)
    setProcessResumeTime: db.prepare(`
        UPDATE processes 
        SET resume_after = ?, updated_at = ?
        WHERE id = ?
    `),

    // Set process preemption
    setProcessPreemption: db.prepare(`
        UPDATE processes 
        SET preempted_by = ?, status = 'queued', resume_after = NULL, updated_at = ?
        WHERE id = ?
    `),

    // Complete process
    completeProcess: db.prepare(`
        UPDATE processes 
        SET status = 'completed', completed_at = ?, updated_at = ?
        WHERE id = ?
    `),

    // Fail process
    failProcess: db.prepare(`
        UPDATE processes 
        SET status = 'failed', completed_at = ?, updated_at = ?
        WHERE id = ?
    `),

    // Update process (full update)
    updateProcess: db.prepare(`
        UPDATE processes 
        SET action = ?, target = ?, status = ?, priority = ?, details = ?, progress = ?, updated_at = ?
        WHERE id = ?
    `),

    // Delete process
    deleteProcess: db.prepare('DELETE FROM processes WHERE id = ?'),

    // Get recent processes (limit)
    getRecentProcesses: db.prepare('SELECT * FROM processes ORDER BY created_at DESC LIMIT ?'),

    // Clean up old completed processes
    cleanupOldProcesses: db.prepare(`
        DELETE FROM processes 
        WHERE status IN ('completed', 'failed') AND created_at < ?
    `),

    // Clean up all completed and failed processes
    cleanupCompletedFailedProcesses: db.prepare(`
        DELETE FROM processes 
        WHERE status IN ('completed', 'failed')
    `),

    // Get process statistics
    getProcessStats: db.prepare(`
        SELECT 
            status,
            COUNT(*) as count,
            AVG(priority) as avg_priority
        FROM processes 
        WHERE status NOT IN ('completed', 'failed')
        GROUP BY status
    `),

    // Check for higher priority queued processes
    hasHigherPriorityQueued: db.prepare(`
        SELECT COUNT(*) as count
        FROM processes 
        WHERE status = 'queued' AND priority < ?
    `),

    // Reset crashed processes (active processes without preemption back to queued)
    resetCrashedProcesses: db.prepare(`
        UPDATE processes 
        SET status = 'queued', updated_at = ?
        WHERE status = 'active' AND preempted_by IS NULL
    `)
};

// Test ID queries
const testIdQueries = {
    // Get default test ID (id = 1)
    getDefaultTestId: db.prepare('SELECT * FROM test_ids WHERE id = 1'),

    // Get user-set test ID (id = 2)
    getUserTestId: db.prepare('SELECT * FROM test_ids WHERE id = 2'),

    // Get all test IDs
    getAllTestIds: db.prepare('SELECT * FROM test_ids ORDER BY id'),

    // Update user test ID (id = 2)
    updateUserTestId: db.prepare('UPDATE test_ids SET fid = ?, set_by = ?, set_at = ? WHERE id = 2')
};

// Settings queries
const settingsQueries = {
    // Get settings (always returns one row)
    getSettings: db.prepare('SELECT * FROM settings WHERE id = 1'),
    // Initialize settings if not exists
    initSettings: db.prepare('INSERT OR IGNORE INTO settings (id, auto_delete) VALUES (1, 1)'),
    // Update auto_delete setting
    updateAutoDelete: db.prepare('UPDATE settings SET auto_delete = ? WHERE id = 1'),
    // Get Google Drive token
    getGDriveToken: db.prepare('SELECT gdrive_token FROM settings WHERE id = 1'),
    // Set Google Drive token
    setGDriveToken: db.prepare('UPDATE settings SET gdrive_token = ? WHERE id = 1'),
    // Clear Google Drive token
    clearGDriveToken: db.prepare('UPDATE settings SET gdrive_token = NULL WHERE id = 1')
};

// Initialize settings on startup
try {
    settingsQueries.initSettings.run();
} catch (error) {
    // Settings initialization failed - non-critical
}

// Wrapper functions with error handling and current timestamp
const createAdmin = (userId, addedBy, permissions = 0, alliances = '[]', isOwner = false, language = 'en') => {
    const isOwnerInt = isOwner ? 1 : 0;
    return adminQueries.addAdmin.run(userId, addedBy, getCurrentTimestamp(), permissions, alliances, isOwnerInt, language);
};

const createGiftCode = (giftCode, status = 'active', addedBy, source = 'manual', apiPushed = false, isVip = false) => {
    const now = getCurrentTimestamp();
    const isVipInt = isVip ? 1 : 0;
    const apiPushedInt = apiPushed ? 1 : 0;
    return giftCodeQueries.addGiftCode.run(giftCode, now, status, addedBy, source, apiPushedInt, now, isVipInt);
};

// Migration utilities
const migrationQueries = {
    // Clear all data except settings, custom_emojis, and test_ids
    clearAllData: () => {
        // Clear tables in correct order to respect foreign key constraints
        db.prepare('DELETE FROM giftcode_usage').run();
        db.prepare('DELETE FROM furnace_changes').run();
        db.prepare('DELETE FROM nickname_changes').run();
        db.prepare('DELETE FROM id_channels').run();
        db.prepare('DELETE FROM gift_code_channels').run();
        db.prepare('DELETE FROM players').run();
        db.prepare('DELETE FROM alliance_logs').run();
        db.prepare('DELETE FROM alliance').run();
        db.prepare('DELETE FROM admin_logs').run();
        db.prepare('DELETE FROM admins').run();
        db.prepare('DELETE FROM processes').run();
        db.prepare('DELETE FROM notifications').run();
        db.prepare('DELETE FROM gift_codes').run();
    }
};

// Export all query objects and helper functions
module.exports = {
    db,
    adminQueries: {
        ...adminQueries,
        addAdmin: createAdmin,
        getAllAdmins: () => adminQueries.getAllAdmins.all(),
        getAdmin: (userId) => adminQueries.getAdmin.get(userId),
        getAdminById: (id) => adminQueries.getAdminById.get(id),
        updateAdminPermissions: (permissions, userId) => adminQueries.updateAdminPermissions.run(permissions, userId),
        updateAdminLanguage: (language, userId) => adminQueries.updateAdminLanguage.run(language, userId),
        updateAdminAlliances: (alliances, userId) => adminQueries.updateAdminAlliances.run(alliances, userId),
        updateAdminCustomEmoji: (customEmojiId, userId) => adminQueries.updateAdminCustomEmoji.run(customEmojiId, userId),
        getAdminsByCustomEmoji: (customEmojiId) => adminQueries.getAdminsByCustomEmoji.all(customEmojiId),
        deleteAdmin: (userId) => adminQueries.deleteAdmin.run(userId),
        isOwner: (userId) => adminQueries.isOwner.get(userId),
        updateOwnerStatus: (isOwner, userId) => adminQueries.updateOwnerStatus.run(isOwner, userId)
    },
    customEmojiQueries: {
        ...customEmojiQueries,
        addCustomEmojiSet: (name, data, active = 0) => customEmojiQueries.addCustomEmojiSet.run(name, data, active ? 1 : 0),
        getCustomEmojiSetById: (id) => customEmojiQueries.getCustomEmojiSetById.get(id),
        getCustomEmojiSetByName: (name) => customEmojiQueries.getCustomEmojiSetByName.get(name),
        getAllCustomEmojiSets: () => customEmojiQueries.getAllCustomEmojiSets.all(),
        getActiveCustomEmojiSet: () => customEmojiQueries.getActiveCustomEmojiSet.get(),
        updateCustomEmojiSetName: (name, id) => customEmojiQueries.updateCustomEmojiSetName.run(name, id),
        updateCustomEmojiSetData: (data, id) => customEmojiQueries.updateCustomEmojiSetData.run(data, id),
        clearActiveCustomEmojiSet: () => customEmojiQueries.clearActiveCustomEmojiSet.run(),
        setActiveCustomEmojiSet: (id) => customEmojiQueries.setActiveCustomEmojiSet.run(id),
        deleteCustomEmojiSet: (id) => customEmojiQueries.deleteCustomEmojiSet.run(id),
        countCustomEmojiSets: () => customEmojiQueries.countCustomEmojiSets.get()?.count || 0
    },
    allianceQueries: {
        ...allianceQueries,
        addAlliance: (priority, name, guideId, channelId, interval, autoRedeem, createdBy) =>
            allianceQueries.addAlliance.run(priority, name, guideId, channelId, interval, autoRedeem, createdBy),
        getAllianceById: (id) => allianceQueries.getAllianceById.get(id),
        getAllAlliances: () => allianceQueries.getAllAlliances.all(),
        getAlliancesByIds: (ids) => allianceQueries.getAlliancesByIds.all(JSON.stringify(ids)),
        updateAlliance: (priority, name, guideId, channelId, interval, autoRedeem, id) =>
            allianceQueries.updateAlliance.run(priority, name, guideId, channelId, interval, autoRedeem, id),
        updateAlliancePriority: (id, priority) => allianceQueries.updateAlliancePriority.run(priority, id),
        deleteAlliance: (id) => allianceQueries.deleteAlliance.run(id),
        getAllianceByPriority: (priority) => allianceQueries.getAllianceByPriority.get(priority),
        getAlliancesWithAutoRedeem: () => allianceQueries.getAlliancesWithAutoRedeem.all()
    },
    idChannelQueries: {
        ...idChannelQueries,
        addIdChannel: (guideId, allianceId, channelId, linkedBy) =>
            idChannelQueries.addIdChannel.run(guideId, allianceId, channelId, linkedBy),
        getChannelsByAlliance: (allianceId) => idChannelQueries.getChannelsByAlliance.all(allianceId),
        getChannelsByAllianceIds: (allianceIds) => idChannelQueries.getChannelsByAllianceIds.all(JSON.stringify(allianceIds)),
        getChannelById: (id) => idChannelQueries.getChannelById.get(id),
        getChannelByChannelId: (channelId) => idChannelQueries.getChannelByChannelId.get(channelId),
        removeIdChannel: (id) => idChannelQueries.deleteChannel.run(id),
        deleteChannel: (id) => idChannelQueries.deleteChannel.run(id),
        getAllChannels: () => idChannelQueries.getAllChannels.all()
    },
    giftCodeChannelQueries: {
        ...giftCodeChannelQueries,
        addChannel: (channelId, linkedBy) =>
            giftCodeChannelQueries.addChannel.run(channelId, linkedBy, getCurrentTimestamp()),
        getChannelByChannelId: (channelId) => giftCodeChannelQueries.getChannelByChannelId.get(channelId),
        getChannelById: (id) => giftCodeChannelQueries.getChannelById.get(id),
        getAllChannels: () => giftCodeChannelQueries.getAllChannels.all(),
        deleteChannel: (id) => giftCodeChannelQueries.deleteChannel.run(id),
        channelExists: (channelId) => {
            const result = giftCodeChannelQueries.channelExists.get(channelId);
            return result !== undefined;
        }
    },
    playerQueries: {
        ...playerQueries,
        addPlayer: (fid, userId, nickname, furnaceLevel, state, imageUrl, allianceId, addedBy) => {
            const addedByStr = String(addedBy);
            return playerQueries.addPlayer.run(fid, userId, nickname, furnaceLevel, state, imageUrl, allianceId, addedByStr);
        },
        getPlayer: (fid) => playerQueries.getPlayer.get(fid),
        getPlayerByFid: (fid) => playerQueries.getPlayer.get(fid),
        getPlayersByAlliance: (allianceId) => playerQueries.getPlayersByAlliance.all(allianceId),
        incrementPlayerExist: (fid) => playerQueries.incrementPlayerExist.run(fid),
        resetPlayerExist: (fid) => playerQueries.resetPlayerExist.run(fid),
        getNonExistentPlayers: () => playerQueries.getNonExistentPlayers.all(),
        getPlayersByAllianceId: (allianceId) => playerQueries.getPlayersByAlliance.all(allianceId),
        getPlayerCountsByAllianceIds: (allianceIds) => playerQueries.getPlayerCountsByAllianceIds.all(JSON.stringify(allianceIds)),
        updatePlayer: (userId, nickname, furnaceLevel, state, imageUrl, allianceId, fid) =>
            playerQueries.updatePlayer.run(userId, nickname, furnaceLevel, state, imageUrl, allianceId, fid),
        updatePlayerAlliance: (fid, allianceId) => playerQueries.updatePlayerAlliance.run(allianceId, fid),
        updateFurnaceLevel: (furnaceLevel, fid) => playerQueries.updateFurnaceLevel.run(furnaceLevel, fid),
        updateNickname: (nickname, fid) => playerQueries.updateNickname.run(nickname, fid),
        deletePlayer: (fid) => {
            playerQueries.deleteFurnaceChanges.run(fid);
            playerQueries.deleteNicknameChanges.run(fid);
            playerQueries.deleteGiftcodeUsage.run(fid);
            playerQueries.deletePlayer.run(fid);
        },
        getAllPlayers: () => playerQueries.getAllPlayers.all(),
        getPlayersForExport: (filters) => {
            // Build dynamic SQL query based on provided filters
            let query = 'SELECT p.fid, p.nickname, p.furnace_level, a.name as alliance_name, p.state FROM players p LEFT JOIN alliance a ON p.alliance_id = a.id WHERE p.exist < 3';
            const params = [];

            // Add state filter
            if (filters.states && filters.states.length > 0) {
                const statePlaceholders = filters.states.map(() => '?').join(',');
                query += ` AND p.state IN (${statePlaceholders})`;
                params.push(...filters.states);
            }

            // Add alliance filter
            if (filters.allianceIds && filters.allianceIds.length > 0) {
                const alliancePlaceholders = filters.allianceIds.map(() => '?').join(',');
                query += ` AND p.alliance_id IN (${alliancePlaceholders})`;
                params.push(...filters.allianceIds);
            }

            // Add furnace level filter
            if (filters.furnaceLevels && filters.furnaceLevels.length > 0) {
                const furnacePlaceholders = filters.furnaceLevels.map(() => '?').join(',');
                query += ` AND p.furnace_level IN (${furnacePlaceholders})`;
                params.push(...filters.furnaceLevels);
            }

            // Order players grouped by alliance, then by furnace level (desc), then by fid
            query += ' ORDER BY p.alliance_id, p.furnace_level DESC, p.fid';

            return db.prepare(query).all(...params);
        },
        updatePlayerRichStatus: (isRich, fid) => {
            const isRichInt = isRich ? 1 : 0;
            return playerQueries.updatePlayerRichStatus.run(isRichInt, fid);
        },
        updatePlayerVipCount: (vipCount, fid) => playerQueries.updatePlayerVipCount.run(vipCount, fid),
        incrementVipCountForNonRich: () => playerQueries.incrementVipCountForNonRich.run(),
        resetPlayerVipCount: (fid) => playerQueries.resetPlayerVipCount.run(fid),
        getVipEligiblePlayers: (allianceId) => playerQueries.getVipEligiblePlayers.all(allianceId),
        getPlayersByFids: (fids) => playerQueries.getPlayersByFids(fids),
        deletePlayers: (fids) => playerQueries.deletePlayers(fids)
    },
    furnaceChangeQueries: {
        ...furnaceChangeQueries,
        addFurnaceChange: (fid, oldLevel, newLevel) =>
            furnaceChangeQueries.addFurnaceChange.run(fid, oldLevel, newLevel, getCurrentTimestamp()),
        getChangesByPlayer: (fid) => furnaceChangeQueries.getChangesByPlayer.all(fid),
        getAllChanges: () => furnaceChangeQueries.getAllChanges.all(),
        // Raw insert for migrations (allows custom timestamps)
        rawInsert: furnaceChangeQueries.addFurnaceChange
    },
    nicknameChangeQueries: {
        ...nicknameChangeQueries,
        addNicknameChange: (fid, oldNickname, newNickname) =>
            nicknameChangeQueries.addNicknameChange.run(fid, oldNickname, newNickname, getCurrentTimestamp()),
        getChangesByPlayer: (fid) => nicknameChangeQueries.getChangesByPlayer.all(fid),
        getAllChanges: () => nicknameChangeQueries.getAllChanges.all(),
        // Raw insert for migrations (allows custom timestamps)
        rawInsert: nicknameChangeQueries.addNicknameChange
    },
    giftCodeQueries: {
        ...giftCodeQueries,
        addGiftCode: createGiftCode,
        getGiftCode: (giftCode) => giftCodeQueries.getGiftCode.get(giftCode),
        getAllGiftCodes: () => giftCodeQueries.getAllGiftCodes.all(),
        updateGiftCodeStatus: (status, giftCode) => giftCodeQueries.updateGiftCodeStatus.run(status, giftCode),
        updateLastValidated: (giftCode) => giftCodeQueries.updateLastValidated.run(getCurrentTimestamp(), giftCode),
        getCodesNeedingValidation: () => giftCodeQueries.getCodesNeedingValidation.all(),
        removeGiftCode: (giftCode) => {
            // Delete usage records first to avoid foreign key constraint
            try {
                giftCodeUsageQueries.deleteUsageByGiftCode.run(giftCode);
            } catch (error) {
                // Non-critical - continue with gift code deletion
            }
            return giftCodeQueries.removeGiftCode.run(giftCode);
        },
        updateGiftCodeVipStatus: (isVip, giftCode) => {
            const isVipInt = isVip ? 1 : 0;
            return giftCodeQueries.updateGiftCodeVipStatus.run(isVipInt, giftCode);
        },
        updateApiPushed: (apiPushed, giftCode) => {
            const apiPushedInt = apiPushed ? 1 : 0;
            return giftCodeQueries.updateApiPushed.run(apiPushedInt, giftCode);
        },
        getVipGiftCodes: () => giftCodeQueries.getVipGiftCodes.all()
    },
    giftCodeUsageQueries: {
        ...giftCodeUsageQueries,
        addUsage: (fid, giftCode, status) => giftCodeUsageQueries.addUsage.run(fid, giftCode, status),
        getUsageByPlayer: (fid) => giftCodeUsageQueries.getUsageByPlayer.all(fid),
        getUsageByGiftCode: (giftCode) => giftCodeUsageQueries.getUsageByGiftCode.all(giftCode),
        checkUsage: (fid, giftCode) => giftCodeUsageQueries.checkUsage.get(fid, giftCode),
        updateUsageStatus: (status, id) => giftCodeUsageQueries.updateUsageStatus.run(status, id),
        getFidsWhoRedeemedCode: (giftCode) => {
            const results = giftCodeUsageQueries.getFidsWhoRedeemedCode.all(giftCode);
            return results.map(row => row.fid);
        },
        checkBulkUsage: (giftCode, fids) => {
            // Convert array of FIDs to JSON array for SQLite
            const fidsJson = JSON.stringify(fids);
            const results = giftCodeUsageQueries.checkBulkUsage.all(giftCode, fidsJson);
            return results.map(row => row.fid);
        },
        getUsageCount: (giftCode) => {
            const result = giftCodeUsageQueries.getUsageCount.get(giftCode);
            return result ? result.count : 0;
        },
        deleteUsageByGiftCode: (giftCode) => giftCodeUsageQueries.deleteUsageByGiftCode.run(giftCode)
    },
    notificationQueries: {
        ...notificationQueries,
        addNotification: (name, type, completed, guildId, channelId, hour, minute, messageContent, title, description, color, imageUrl, thumbnailUrl, footer, author, fields, pattern, mention, repeatStatus, repeatFrequency, embedToggle, isActive, lastTrigger, nextTrigger, createdBy) =>
            notificationQueries.addNotification.run(name, type, completed ? 1 : 0, guildId, channelId, hour, minute, messageContent, title, description, color, imageUrl, thumbnailUrl, footer, author, fields, pattern, mention, repeatStatus, repeatFrequency, embedToggle ? 1 : 0, isActive ? 1 : 0, getCurrentTimestamp(), lastTrigger, nextTrigger, createdBy),
        getNotificationById: (id) => notificationQueries.getNotificationById.get(id),
        getAllNotifications: () => notificationQueries.getAllNotifications.all(),
        getNotificationsByGuild: (guildId) => notificationQueries.getNotificationsByGuild.all(guildId),
        getActiveNotifications: () => notificationQueries.getActiveNotifications.all(),
        updateNotification: (id, name, guildId, channelId, hour, minute, messageContent, title, description, color, imageUrl, thumbnailUrl, footer, author, fields, pattern, mention, repeatStatus, repeatFrequency, embedToggle, isActive, lastTrigger, nextTrigger) =>
            notificationQueries.updateNotification.run(name, guildId, channelId, hour, minute, messageContent, title, description, color, imageUrl, thumbnailUrl, footer, author, fields, pattern, mention, repeatStatus, repeatFrequency, embedToggle ? 1 : 0, isActive ? 1 : 0, lastTrigger, nextTrigger, id),
        updateNotificationActiveStatus: (id, isActive) => notificationQueries.updateNotificationActiveStatus.run(isActive ? 1 : 0, id),
        updateNotificationCompletedStatus: (id, completed) => notificationQueries.updateNotificationCompletedStatus.run(completed ? 1 : 0, id),
        deleteNotification: (id) => notificationQueries.deleteNotification.run(id)
    },
    allianceLogQueries: {
        ...allianceLogQueries,
        addLogChannel: (allianceId, channelId) => allianceLogQueries.addLogChannel.run(allianceId, channelId),
        getLogChannel: (allianceId) => allianceLogQueries.getLogChannel.get(allianceId),
        getAllLogChannels: () => allianceLogQueries.getAllLogChannels.all(),
        deleteLogChannel: (allianceId) => allianceLogQueries.deleteLogChannel.run(allianceId)
    },
    adminLogQueries: {
        ...adminLogQueries,
        addLog: (userId, logCode, details = null) =>
            adminLogQueries.addLog.run(userId, logCode, details, getCurrentTimestamp()),
        getLogsByUser: (userId) => adminLogQueries.getLogsByUser.all(userId),
        getAdminLogs: (userId, limit = 50, offset = 0) => adminLogQueries.getAdminLogs.all(userId, limit, offset),
        getAdminLogsCount: (userId) => adminLogQueries.getAdminLogsCount.get(userId)?.count || 0,
        getLogsByCodeRange: (userId, minCode, maxCode, limit = 50, offset = 0) =>
            adminLogQueries.getLogsByCodeRange.all(userId, minCode, maxCode, limit, offset),
        getLogsByMultipleTypes: (userId, range1Min, range1Max, range2Min, range2Max, limit = 50, offset = 0) =>
            adminLogQueries.getLogsByMultipleTypes.all(userId, range1Min, range1Max, range2Min, range2Max, limit, offset),
        getAllLogs: () => adminLogQueries.getAllLogs.all(),
        getRecentLogs: (limit) => adminLogQueries.getRecentLogs.all(limit)
    },
    systemLogQueries: {
        ...systemLogQueries,
        addLog: (actionType, action, extraDetails = null) =>
            systemLogQueries.addLog.run(actionType, action, extraDetails, getCurrentTimestamp()),
        getLogsByActionType: (actionType) => systemLogQueries.getLogsByActionType.all(actionType),
        getAllLogs: () => systemLogQueries.getAllLogs.all(),
        getRecentLogs: (limit) => systemLogQueries.getRecentLogs.all(limit)
    },
    processQueries: {
        ...processQueries,
        addProcess: (action, target, status, priority, details, progress, createdBy) =>
            processQueries.addProcess.run(action, target, status, priority, details, progress, getCurrentTimestamp(), getCurrentTimestamp(), createdBy),
        getProcessById: (id) => processQueries.getProcessById.get(id),
        getAllProcesses: () => processQueries.getAllProcesses.all(),
        getProcessesByAction: (action) => processQueries.getProcessesByAction.all(action),
        getProcessesByStatus: (status) => processQueries.getProcessesByStatus.all(status),
        getProcessesByCreator: (createdBy) => processQueries.getProcessesByCreator.all(createdBy),
        getNextQueuedProcess: () => processQueries.getNextQueuedProcess.get(),
        getActiveProcesses: () => processQueries.getActiveProcesses.all(),
        getPausedProcessesReadyToResume: () => processQueries.getPausedProcessesReadyToResume.all(Date.now()),
        getProcessesByPriorityRange: (minPriority, maxPriority) => processQueries.getProcessesByPriorityRange.all(minPriority, maxPriority),
        updateProcessStatus: (id, status) => processQueries.updateProcessStatus.run(status, getCurrentTimestamp(), id),
        updateProcessProgress: (id, progress) => processQueries.updateProcessProgress.run(progress, getCurrentTimestamp(), id),
        updateProcessDetails: (id, details) => processQueries.updateProcessDetails.run(details, getCurrentTimestamp(), id),
        setProcessResumeTime: (id, resumeAfter) => processQueries.setProcessResumeTime.run(resumeAfter, getCurrentTimestamp(), id),
        setProcessPreemption: (id, preemptedBy) => processQueries.setProcessPreemption.run(preemptedBy, getCurrentTimestamp(), id),
        completeProcess: (id) => processQueries.completeProcess.run(getCurrentTimestamp(), getCurrentTimestamp(), id),
        failProcess: (id) => processQueries.failProcess.run(getCurrentTimestamp(), getCurrentTimestamp(), id),
        updateProcess: (id, action, target, status, priority, details, progress) =>
            processQueries.updateProcess.run(action, target, status, priority, details, progress, getCurrentTimestamp(), id),
        deleteProcess: (id) => processQueries.deleteProcess.run(id),
        getRecentProcesses: (limit) => processQueries.getRecentProcesses.all(limit),
        cleanupOldProcesses: (cutoffDate) => processQueries.cleanupOldProcesses.run(cutoffDate),
        cleanupCompletedFailedProcesses: () => processQueries.cleanupCompletedFailedProcesses.run(),
        getProcessStats: () => processQueries.getProcessStats.all(),
        hasHigherPriorityQueued: (priority) => processQueries.hasHigherPriorityQueued.get(priority)?.count > 0,
        resetCrashedProcesses: () => processQueries.resetCrashedProcesses.run(getCurrentTimestamp())
    },
    testIdQueries: {
        ...testIdQueries,
        getDefaultTestId: () => testIdQueries.getDefaultTestId.get(),
        getUserTestId: () => testIdQueries.getUserTestId.get(),
        getAllTestIds: () => testIdQueries.getAllTestIds.all(),
        updateUserTestId: (fid, setBy) => testIdQueries.updateUserTestId.run(fid, setBy, getCurrentTimestamp())
    },
    settingsQueries,
    migrationQueries,
    getCurrentTimestamp
};