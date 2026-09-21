const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { getDefaultGameType } = require('./gameRuntime');
const { normalizeGameType } = require('./gameProfiles');

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

function resolveGameType(gameType = getDefaultGameType()) {
    return normalizeGameType(gameType || getDefaultGameType());
}

function tableExists(tableName) {
    const result = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName);
    return Boolean(result);
}

function restoreLegacyTable(baseName) {
    const legacyName = `${baseName}_legacy`;
    if (!tableExists(legacyName)) {
        return;
    }

    if (tableExists(baseName)) {
        db.exec(`DROP TABLE ${legacyName}`);
        return;
    }

    db.pragma('foreign_keys = OFF');
    db.exec(`ALTER TABLE ${legacyName} RENAME TO ${baseName}`);
    db.pragma('foreign_keys = ON');
}

function getTableSql(tableName) {
    const result = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName);
    return result?.sql || '';
}

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
            is_owner BOOLEAN DEFAULT 0
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
            game_type TEXT NOT NULL DEFAULT 'wos',
            priority INTEGER NOT NULL,
            name TEXT NOT NULL,
            state INTEGER,
            guide_id TEXT,
            channel_id TEXT,
            interval TEXT,
            auto_redeem BOOLEAN,
            created_by TEXT,
            UNIQUE (game_type, priority)
        )
    `,
    id_channels: `
        CREATE TABLE IF NOT EXISTS id_channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_type TEXT NOT NULL DEFAULT 'wos',
            guide_id TEXT,
            alliance_id INTEGER NOT NULL REFERENCES alliance(id),
            channel_id TEXT NOT NULL,
            linked_by TEXT,
            auto_clean INTEGER DEFAULT 0
        )
    `,
    gift_code_channels: `
        CREATE TABLE IF NOT EXISTS gift_code_channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_type TEXT NOT NULL DEFAULT 'wos',
            channel_id TEXT NOT NULL UNIQUE,
            linked_by TEXT,
            created_at TEXT NOT NULL
        )
    `,
    players: `
        CREATE TABLE IF NOT EXISTS players (
            game_type TEXT NOT NULL DEFAULT 'wos',
            fid INTEGER NOT NULL,
            user_id TEXT,
            nickname TEXT,
            furnace_level INTEGER,
            state INTEGER,
            state_override INTEGER,
            state_search_blocked_for INTEGER,
            image_url TEXT,
            alliance_id INTEGER,
            added_by TEXT NOT NULL,
            is_rich BOOLEAN DEFAULT 0,
            vip_count INTEGER DEFAULT 0,
            exist INTEGER DEFAULT 0,
            PRIMARY KEY (game_type, fid)
        )
    `,
    furnace_changes: `
        CREATE TABLE IF NOT EXISTS furnace_changes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_type TEXT NOT NULL DEFAULT 'wos',
            fid INTEGER NOT NULL,
            old_furnace_lv INTEGER,
            new_furnace_lv INTEGER,
            change_date TEXT,
            FOREIGN KEY (game_type, fid) REFERENCES players(game_type, fid)
        )
    `,
    nickname_changes: `
        CREATE TABLE IF NOT EXISTS nickname_changes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_type TEXT NOT NULL DEFAULT 'wos',
            fid INTEGER NOT NULL,
            old_nickname TEXT,
            new_nickname TEXT,
            change_date TEXT,
            FOREIGN KEY (game_type, fid) REFERENCES players(game_type, fid)
        )
    `,
    gift_codes: `
        CREATE TABLE IF NOT EXISTS gift_codes (
            game_type TEXT NOT NULL DEFAULT 'wos',
            gift_code TEXT NOT NULL,
            date TEXT,
            status TEXT,
            added_by TEXT,
            source TEXT,
            api_pushed BOOLEAN DEFAULT 0,
            last_validated TEXT,
            is_vip BOOLEAN DEFAULT 0,
            PRIMARY KEY (game_type, gift_code)
        )
    `,
    giftcode_usage: `
        CREATE TABLE IF NOT EXISTS giftcode_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_type TEXT NOT NULL DEFAULT 'wos',
            fid INTEGER NOT NULL,
            gift_code TEXT NOT NULL,
            status TEXT
        )
    `,
    state_search_retries: `
        CREATE TABLE IF NOT EXISTS state_search_retries (
            game_type TEXT NOT NULL,
            fid INTEGER NOT NULL,
            gift_code TEXT NOT NULL,
            PRIMARY KEY (game_type, fid, gift_code)
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
            game_type TEXT NOT NULL DEFAULT 'wos',
            id INTEGER NOT NULL CHECK (id <= 2),
            fid INTEGER NOT NULL,
            state INTEGER,
            is_default BOOLEAN DEFAULT 0,
            set_by TEXT,
            set_at TEXT,
            PRIMARY KEY (game_type, id)
        )
    `,
    settings: `
        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            auto_delete BOOLEAN NOT NULL DEFAULT 1,
            gdrive_token TEXT,
            feature_access TEXT DEFAULT '{}'
        )
    `,
    users: `
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            buffs TEXT NOT NULL DEFAULT '{}',
            language TEXT,
            custom_emoji INTEGER
        )
    `,
    schedule_boards: `
        CREATE TABLE IF NOT EXISTS schedule_boards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            target_channel_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            scope TEXT NOT NULL DEFAULT 'server_wide',
            filter_channel_id TEXT,
            created_by TEXT NOT NULL,
            created_at TEXT
        )
    `,
    notification_messages: `
        CREATE TABLE IF NOT EXISTS notification_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            notification_id INTEGER NOT NULL,
            channel_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            trigger_time INTEGER NOT NULL,
            sent_at INTEGER NOT NULL
        )
    `,
    notification_auto_clean: `
        CREATE TABLE IF NOT EXISTS notification_auto_clean (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id TEXT NOT NULL UNIQUE
        )
    `
};

// Create all tables
try {
    Object.entries(schemas).forEach(([tableName, schema]) => {
        db.exec(schema);
    });

    restoreLegacyTable('alliance');
    restoreLegacyTable('id_channels');
    restoreLegacyTable('players');
    restoreLegacyTable('furnace_changes');
    restoreLegacyTable('nickname_changes');

    db.pragma('foreign_keys = OFF');

    try {
        const allianceCols = db.prepare('PRAGMA table_info(alliance)').all();
        const hasAllianceGameType = allianceCols.some(c => c.name === 'game_type');
        if (!hasAllianceGameType) {
            db.exec(`
                ALTER TABLE alliance RENAME TO alliance_legacy;
                CREATE TABLE alliance (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    game_type TEXT NOT NULL DEFAULT 'wos',
                    priority INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    state INTEGER,
                    guide_id TEXT,
                    channel_id TEXT,
                    interval TEXT,
                    auto_redeem BOOLEAN,
                    created_by TEXT,
                    UNIQUE (game_type, priority)
                );
                INSERT INTO alliance (id, game_type, priority, name, state, guide_id, channel_id, interval, auto_redeem, created_by)
                SELECT id, 'wos', priority, name, NULL, guide_id, channel_id, interval, auto_redeem, created_by
                FROM alliance_legacy;
                DROP TABLE alliance_legacy;
            `);
        }

        const migratedAllianceCols = db.prepare('PRAGMA table_info(alliance)').all();
        if (!migratedAllianceCols.some(c => c.name === 'state')) {
            db.exec('ALTER TABLE alliance ADD COLUMN state INTEGER');
        }

        db.exec(`
            UPDATE alliance
            SET state = (
                SELECT MIN(players.state)
                FROM players
                WHERE players.game_type = alliance.game_type
                  AND players.alliance_id = alliance.id
                  AND players.state > 0
            )
            WHERE state IS NULL
              AND 1 = (
                  SELECT COUNT(DISTINCT players.state)
                  FROM players
                  WHERE players.game_type = alliance.game_type
                    AND players.alliance_id = alliance.id
                    AND players.state > 0
              )
        `);
    } catch (e) {
        console.error('Database migration: failed to migrate alliance to game-scoped schema', e);
    }

    try {
        const idChannelCols = db.prepare('PRAGMA table_info(id_channels)').all();
        const hasIdChannelGameType = idChannelCols.some(c => c.name === 'game_type');
        const hasIdChannelAutoClean = idChannelCols.some(c => c.name === 'auto_clean');
        if (!hasIdChannelGameType || !hasIdChannelAutoClean) {
            const autoCleanSelect = hasIdChannelAutoClean ? 'auto_clean' : '0';
            db.exec(`
                ALTER TABLE id_channels RENAME TO id_channels_legacy;
                CREATE TABLE id_channels (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    game_type TEXT NOT NULL DEFAULT 'wos',
                    guide_id TEXT,
                    alliance_id INTEGER NOT NULL REFERENCES alliance(id),
                    channel_id TEXT NOT NULL,
                    linked_by TEXT,
                    auto_clean INTEGER DEFAULT 0
                );
                INSERT INTO id_channels (id, game_type, guide_id, alliance_id, channel_id, linked_by, auto_clean)
                SELECT id, 'wos', guide_id, alliance_id, channel_id, linked_by, ${autoCleanSelect}
                FROM id_channels_legacy;
                DROP TABLE id_channels_legacy;
            `);
        }
    } catch (e) {
        console.error('Database migration: failed to migrate id_channels to game-scoped schema', e);
    }

    try {
        const playerCols = db.prepare('PRAGMA table_info(players)').all();
        const hasPlayerGameType = playerCols.some(c => c.name === 'game_type');
        const hasPlayerCompositePk = playerCols.filter(c => c.pk > 0).length > 1;
        if (!hasPlayerGameType || !hasPlayerCompositePk) {
            db.exec(`
                ALTER TABLE players RENAME TO players_legacy;
                CREATE TABLE players (
                    game_type TEXT NOT NULL DEFAULT 'wos',
                    fid INTEGER NOT NULL,
                    user_id TEXT,
                    nickname TEXT,
                    furnace_level INTEGER,
                    state INTEGER,
                    state_override INTEGER,
                    state_search_blocked_for INTEGER,
                    image_url TEXT,
                    alliance_id INTEGER,
                    added_by TEXT NOT NULL,
                    is_rich BOOLEAN DEFAULT 0,
                    vip_count INTEGER DEFAULT 0,
                    exist INTEGER DEFAULT 0,
                    PRIMARY KEY (game_type, fid)
                );
                INSERT INTO players (game_type, fid, user_id, nickname, furnace_level, state, image_url, alliance_id, added_by, is_rich, vip_count, exist)
                SELECT 'wos', fid, user_id, nickname, furnace_level, state, image_url, alliance_id, added_by, is_rich, vip_count, exist
                FROM players_legacy;
                DROP TABLE players_legacy;
            `);
        }
    } catch (e) {
        console.error('Database migration: failed to migrate players to game-scoped schema', e);
    }

    try {
        const playerCols = db.prepare('PRAGMA table_info(players)').all();
        if (!playerCols.some(c => c.name === 'state_override')) {
            db.exec('ALTER TABLE players ADD COLUMN state_override INTEGER');
        }
        if (!playerCols.some(c => c.name === 'state_search_blocked_for')) {
            db.exec('ALTER TABLE players ADD COLUMN state_search_blocked_for INTEGER');
        }
    } catch (e) {
        console.error('Database migration: failed to add player state columns', e);
    }

    try {
        const furnaceCols = db.prepare('PRAGMA table_info(furnace_changes)').all();
        const hasFurnaceGameType = furnaceCols.some(c => c.name === 'game_type');
        if (!hasFurnaceGameType) {
            db.exec(`
                ALTER TABLE furnace_changes RENAME TO furnace_changes_legacy;
                CREATE TABLE furnace_changes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    game_type TEXT NOT NULL DEFAULT 'wos',
                    fid INTEGER NOT NULL,
                    old_furnace_lv INTEGER,
                    new_furnace_lv INTEGER,
                    change_date TEXT,
                    FOREIGN KEY (game_type, fid) REFERENCES players(game_type, fid)
                );
                INSERT INTO furnace_changes (id, game_type, fid, old_furnace_lv, new_furnace_lv, change_date)
                SELECT id, 'wos', fid, old_furnace_lv, new_furnace_lv, change_date
                FROM furnace_changes_legacy;
                DROP TABLE furnace_changes_legacy;
            `);
        }
    } catch (e) {
        console.error('Database migration: failed to migrate furnace_changes to game-scoped schema', e);
    }

    try {
        const nicknameCols = db.prepare('PRAGMA table_info(nickname_changes)').all();
        const hasNicknameGameType = nicknameCols.some(c => c.name === 'game_type');
        if (!hasNicknameGameType) {
            db.exec(`
                ALTER TABLE nickname_changes RENAME TO nickname_changes_legacy;
                CREATE TABLE nickname_changes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    game_type TEXT NOT NULL DEFAULT 'wos',
                    fid INTEGER NOT NULL,
                    old_nickname TEXT,
                    new_nickname TEXT,
                    change_date TEXT,
                    FOREIGN KEY (game_type, fid) REFERENCES players(game_type, fid)
                );
                INSERT INTO nickname_changes (id, game_type, fid, old_nickname, new_nickname, change_date)
                SELECT id, 'wos', fid, old_nickname, new_nickname, change_date
                FROM nickname_changes_legacy;
                DROP TABLE nickname_changes_legacy;
            `);
        }
    } catch (e) {
        console.error('Database migration: failed to migrate nickname_changes to game-scoped schema', e);
    }

    try {
        const giftCodeCols = db.prepare('PRAGMA table_info(gift_codes)').all();
        const hasGiftCodeGameType = giftCodeCols.some(c => c.name === 'game_type');
        const hasGiftCodeCompositePk = giftCodeCols.filter(c => c.pk > 0).length > 1;
        if (!hasGiftCodeGameType || !hasGiftCodeCompositePk) {
            db.exec(`
                ALTER TABLE gift_codes RENAME TO gift_codes_legacy;
                CREATE TABLE gift_codes (
                    game_type TEXT NOT NULL DEFAULT 'wos',
                    gift_code TEXT NOT NULL,
                    date TEXT,
                    status TEXT,
                    added_by TEXT,
                    source TEXT,
                    api_pushed BOOLEAN DEFAULT 0,
                    last_validated TEXT,
                    is_vip BOOLEAN DEFAULT 0,
                    PRIMARY KEY (game_type, gift_code)
                );
                INSERT INTO gift_codes (game_type, gift_code, date, status, added_by, source, api_pushed, last_validated, is_vip)
                SELECT 'wos', gift_code, date, status, added_by, source, api_pushed, last_validated, is_vip
                FROM gift_codes_legacy;
                DROP TABLE gift_codes_legacy;
            `);
        }
    } catch (e) {
        console.error('Database migration: failed to migrate gift_codes to game-scoped schema', e);
    }

    try {
        const giftCodeChannelCols = db.prepare('PRAGMA table_info(gift_code_channels)').all();
        const hasGiftCodeChannelGameType = giftCodeChannelCols.some(c => c.name === 'game_type');
        if (!hasGiftCodeChannelGameType) {
            db.exec(`
                ALTER TABLE gift_code_channels RENAME TO gift_code_channels_legacy;
                CREATE TABLE gift_code_channels (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    game_type TEXT NOT NULL DEFAULT 'wos',
                    channel_id TEXT NOT NULL UNIQUE,
                    linked_by TEXT,
                    created_at TEXT NOT NULL
                );
                INSERT INTO gift_code_channels (id, game_type, channel_id, linked_by, created_at)
                SELECT id, 'wos', channel_id, linked_by, created_at
                FROM gift_code_channels_legacy;
                DROP TABLE gift_code_channels_legacy;
            `);
        }
    } catch (e) {
        console.error('Database migration: failed to migrate gift_code_channels to game-scoped schema', e);
    }

    try {
        const usageCols = db.prepare('PRAGMA table_info(giftcode_usage)').all();
        const hasUsageGameType = usageCols.some(c => c.name === 'game_type');
        if (!hasUsageGameType) {
            db.exec(`
                ALTER TABLE giftcode_usage RENAME TO giftcode_usage_legacy;
                CREATE TABLE giftcode_usage (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    game_type TEXT NOT NULL DEFAULT 'wos',
                    fid INTEGER NOT NULL,
                    gift_code TEXT NOT NULL,
                    status TEXT
                );
                INSERT INTO giftcode_usage (game_type, fid, gift_code, status)
                SELECT 'wos', fid, gift_code, status
                FROM giftcode_usage_legacy;
                DROP TABLE giftcode_usage_legacy;
            `);
        }
    } catch (e) {
        console.error('Database migration: failed to migrate giftcode_usage to game-scoped schema', e);
    }

    try {
        const testIdCols = db.prepare('PRAGMA table_info(test_ids)').all();
        const hasTestIdGameType = testIdCols.some(c => c.name === 'game_type');
        const hasTestIdCompositePk = testIdCols.filter(c => c.pk > 0).length > 1;
        const hasTestIdState = testIdCols.some(c => c.name === 'state');
        if (!hasTestIdGameType || !hasTestIdCompositePk) {
            db.exec(`
                ALTER TABLE test_ids RENAME TO test_ids_legacy;
                CREATE TABLE test_ids (
                    game_type TEXT NOT NULL DEFAULT 'wos',
                    id INTEGER NOT NULL CHECK (id <= 2),
                    fid INTEGER NOT NULL,
                    state INTEGER,
                    is_default BOOLEAN DEFAULT 0,
                    set_by TEXT,
                    set_at TEXT,
                    PRIMARY KEY (game_type, id)
                );
                INSERT INTO test_ids (game_type, id, fid, state, is_default, set_by, set_at)
                SELECT 'wos', id, fid, NULL, is_default, set_by, set_at
                FROM test_ids_legacy;
                DROP TABLE test_ids_legacy;
            `);
        } else if (!hasTestIdState) {
            db.exec('ALTER TABLE test_ids ADD COLUMN state INTEGER');
        }
    } catch (e) {
        console.error('Database migration: failed to migrate test_ids to game-scoped schema', e);
    }

    try {
        const idChannelsSql = getTableSql('id_channels');
        if (idChannelsSql.includes('alliance_legacy')) {
            db.exec(`
                ALTER TABLE id_channels RENAME TO id_channels_stale_fk;
                CREATE TABLE id_channels (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    game_type TEXT NOT NULL DEFAULT 'wos',
                    guide_id TEXT,
                    alliance_id INTEGER NOT NULL REFERENCES alliance(id),
                    channel_id TEXT NOT NULL,
                    linked_by TEXT,
                    auto_clean INTEGER DEFAULT 0
                );
                INSERT INTO id_channels (id, game_type, guide_id, alliance_id, channel_id, linked_by, auto_clean)
                SELECT id, game_type, guide_id, alliance_id, channel_id, linked_by, auto_clean
                FROM id_channels_stale_fk;
                DROP TABLE id_channels_stale_fk;
            `);
        }
    } catch (e) {
        console.error('Database migration: failed to repair id_channels foreign key reference', e);
    }

    try {
        const allianceLogsSql = getTableSql('alliance_logs');
        if (allianceLogsSql.includes('alliance_legacy')) {
            db.exec(`
                ALTER TABLE alliance_logs RENAME TO alliance_logs_stale_fk;
                CREATE TABLE alliance_logs (
                    alliance_id INTEGER PRIMARY KEY REFERENCES alliance(id),
                    channel_id TEXT
                );
                INSERT INTO alliance_logs (alliance_id, channel_id)
                SELECT alliance_id, channel_id
                FROM alliance_logs_stale_fk;
                DROP TABLE alliance_logs_stale_fk;
            `);
        }
    } catch (e) {
        console.error('Database migration: failed to repair alliance_logs foreign key reference', e);
    }

    try {
        const furnaceSql = getTableSql('furnace_changes');
        if (furnaceSql.includes('players_legacy')) {
            db.exec(`
                ALTER TABLE furnace_changes RENAME TO furnace_changes_stale_fk;
                CREATE TABLE furnace_changes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    game_type TEXT NOT NULL DEFAULT 'wos',
                    fid INTEGER NOT NULL,
                    old_furnace_lv INTEGER,
                    new_furnace_lv INTEGER,
                    change_date TEXT,
                    FOREIGN KEY (game_type, fid) REFERENCES players(game_type, fid)
                );
                INSERT INTO furnace_changes (id, game_type, fid, old_furnace_lv, new_furnace_lv, change_date)
                SELECT id, game_type, fid, old_furnace_lv, new_furnace_lv, change_date
                FROM furnace_changes_stale_fk;
                DROP TABLE furnace_changes_stale_fk;
            `);
        }
    } catch (e) {
        console.error('Database migration: failed to repair furnace_changes foreign key reference', e);
    }

    try {
        const nicknameSql = getTableSql('nickname_changes');
        if (nicknameSql.includes('players_legacy')) {
            db.exec(`
                ALTER TABLE nickname_changes RENAME TO nickname_changes_stale_fk;
                CREATE TABLE nickname_changes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    game_type TEXT NOT NULL DEFAULT 'wos',
                    fid INTEGER NOT NULL,
                    old_nickname TEXT,
                    new_nickname TEXT,
                    change_date TEXT,
                    FOREIGN KEY (game_type, fid) REFERENCES players(game_type, fid)
                );
                INSERT INTO nickname_changes (id, game_type, fid, old_nickname, new_nickname, change_date)
                SELECT id, game_type, fid, old_nickname, new_nickname, change_date
                FROM nickname_changes_stale_fk;
                DROP TABLE nickname_changes_stale_fk;
            `);
        }
    } catch (e) {
        console.error('Database migration: failed to repair nickname_changes foreign key reference', e);
    }

    db.pragma('foreign_keys = ON');

    // Create indexes for processes table
    db.exec(`CREATE INDEX IF NOT EXISTS idx_processes_status_priority ON processes (status, priority)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_processes_resume_after ON processes (resume_after)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_processes_created_at ON processes (created_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_processes_preempted_by ON processes (preempted_by)`);

    // Create indexes for giftcode_usage table (for fast lookups)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_giftcode_usage_fid ON giftcode_usage (game_type, fid)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_giftcode_usage_gift_code ON giftcode_usage (game_type, gift_code)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_giftcode_usage_fid_gift_code ON giftcode_usage (game_type, fid, gift_code)`);
    db.exec(`
        DELETE FROM giftcode_usage
        WHERE id NOT IN (
            SELECT MIN(id)
            FROM giftcode_usage
            GROUP BY game_type, fid, gift_code
        )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_giftcode_usage_unique_triplet ON giftcode_usage (game_type, fid, gift_code)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_gift_codes_game_date ON gift_codes (game_type, date DESC)`);

    // Create index for log_code for faster filtering
    db.exec(`CREATE INDEX IF NOT EXISTS idx_admin_logs_log_code ON admin_logs (log_code)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_admin_logs_user_id_time ON admin_logs (user_id, time)`);

    // Create index for system_logs.time (used by daily cleanup scheduler)
    db.exec("CREATE INDEX IF NOT EXISTS idx_system_logs_time ON system_logs (time)");

    // Create indexes for players table
    db.exec(`CREATE INDEX IF NOT EXISTS idx_alliance_game_priority ON alliance (game_type, priority)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_alliance_game_auto_redeem ON alliance (game_type, auto_redeem, priority)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_id_channels_game_alliance ON id_channels (game_type, alliance_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_id_channels_game_channel ON id_channels (game_type, channel_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_players_game_alliance_exist ON players (game_type, alliance_id, exist)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_players_nickname ON players (game_type, nickname)`);

    // Initialize default test IDs
    ['wos', 'ks'].forEach((gameType) => {
        const defaultFid = gameType === 'ks' ? 47576897 : 40393986;
        const defaultState = gameType === 'ks' ? 259 : 437;
        db.prepare(`INSERT OR IGNORE INTO test_ids (game_type, id, fid, state, is_default, set_by, set_at) VALUES (?, 1, ?, ?, 1, 'system', ?)`)
            .run(gameType, defaultFid, defaultState, getCurrentTimestamp());
        db.prepare(`INSERT OR IGNORE INTO test_ids (game_type, id, fid, state, is_default, set_by, set_at) VALUES (?, 2, ?, NULL, 0, NULL, NULL)`)
            .run(gameType, defaultFid);
    });
    db.prepare(`UPDATE test_ids SET state = 437 WHERE game_type = 'wos' AND id = 1 AND set_by = 'system'`).run();
    db.prepare(`UPDATE test_ids SET fid = 47576897, state = 259 WHERE game_type = 'ks' AND id = 1 AND set_by = 'system'`).run();

    // Ensure `feature_access` column exists in settings (safe migration)
    try {
        const cols = db.prepare("PRAGMA table_info(settings)").all();
        const hasFeatureAccess = cols.some(c => c && c.name === 'feature_access');
        if (!hasFeatureAccess) {
            db.exec("ALTER TABLE settings ADD COLUMN feature_access TEXT DEFAULT '{}' ");
        }
    } catch (e) {
        console.error('Database migration: failed to ensure feature_access column', e);
    }

    // Migrate language/custom_emoji from admins → users, then drop those columns from admins
    try {
        const adminCols = db.prepare('PRAGMA table_info(admins)').all();
        const hasLanguage = adminCols.some(c => c.name === 'language');
        if (hasLanguage) {
            // Ensure all admins have a users row (inherit their language/emoji)
            db.exec(`INSERT OR IGNORE INTO users (user_id, language, custom_emoji) SELECT user_id, CASE WHEN language = 'NA' THEN NULL ELSE language END, custom_emoji FROM admins`);
            // Recreate admins without language/custom_emoji
            db.exec(`
                CREATE TABLE admins_migrated (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT UNIQUE NOT NULL,
                    added_by TEXT,
                    added_at TEXT,
                    permissions INTEGER DEFAULT 0,
                    alliances TEXT,
                    is_owner BOOLEAN DEFAULT 0
                )
            `);
            db.exec(`INSERT INTO admins_migrated (id, user_id, added_by, added_at, permissions, alliances, is_owner) SELECT id, user_id, added_by, added_at, permissions, alliances, is_owner FROM admins`);
            db.exec(`DROP TABLE admins`);
            db.exec(`ALTER TABLE admins_migrated RENAME TO admins`);
        }
    } catch (e) {
        console.error('Database migration: failed to migrate admins language/emoji → users', e);
    }

    // Clean up pre-existing invalid gift codes and their usage history
    // Invalid codes are no longer kept — they are deleted so they can be re-added if they become active again
    try {
        const invalidCodes = db.prepare(`SELECT game_type, gift_code FROM gift_codes WHERE status = 'invalid'`).all();
        if (invalidCodes.length > 0) {
            const deleteUsage = db.prepare('DELETE FROM giftcode_usage WHERE game_type = ? AND gift_code = ?');
            const deleteCode = db.prepare(`DELETE FROM gift_codes WHERE game_type = ? AND gift_code = ?`);
            const deleteRetry = db.prepare('DELETE FROM state_search_retries WHERE game_type = ? AND gift_code = ?');
            const deleteInvalid = db.transaction((codes) => {
                for (const { game_type, gift_code } of codes) {
                    deleteUsage.run(game_type, gift_code);
                    deleteRetry.run(game_type, gift_code);
                    deleteCode.run(game_type, gift_code);
                }
            });
            deleteInvalid(invalidCodes);
            console.log(`Database migration: removed ${invalidCodes.length} pre-existing invalid gift code(s) and their usage history`);
        }
    } catch (e) {
        console.error('Database migration: failed to clean up invalid gift codes', e);
    }

    // Clean up leftover "process" and "recovery" action_type entries from system_logs
    try {
        const deleted = db.prepare(`DELETE FROM system_logs WHERE action_type IN ('process', 'recovery')`).run();
        if (deleted.changes > 0) {
            console.log(`Database migration: removed ${deleted.changes} leftover process/recovery system log(s)`);
        }
    } catch (e) {
        console.error('Database migration: failed to clean up process/recovery system logs', e);
    }

    // Ensure `auto_clean` column exists in id_channels (0 = disabled, >0 = interval in minutes)
    try {
        const idChCols = db.prepare('PRAGMA table_info(id_channels)').all();
        if (!idChCols.some(c => c.name === 'auto_clean')) {
            db.exec('ALTER TABLE id_channels ADD COLUMN auto_clean INTEGER DEFAULT 0');
        }
    } catch (e) {
        console.error('Database migration: failed to add auto_clean column to id_channels', e);
    }

    // Ensure notification auto-clean columns exist in settings
    try {
        const settingsCols = db.prepare('PRAGMA table_info(settings)').all();
        if (!settingsCols.some(c => c.name === 'notif_auto_clean')) {
            db.exec('ALTER TABLE settings ADD COLUMN notif_auto_clean BOOLEAN DEFAULT 0');
        }
        if (!settingsCols.some(c => c.name === 'notif_auto_clean_freq')) {
            db.exec('ALTER TABLE settings ADD COLUMN notif_auto_clean_freq INTEGER DEFAULT 0');
        }
    } catch (e) {
        console.error('Database migration: failed to add notif_auto_clean columns to settings', e);
    }

    // Ensure auto_update column exists in settings (defaults to enabled)
    try {
        const settingsColsAU = db.prepare('PRAGMA table_info(settings)').all();
        if (!settingsColsAU.some(c => c.name === 'auto_update')) {
            db.exec('ALTER TABLE settings ADD COLUMN auto_update BOOLEAN DEFAULT 1');
        }
    } catch (e) {
        console.error('Database migration: failed to add auto_update column to settings', e);
    }

    // Create indexes for notification_messages table
    db.exec('CREATE INDEX IF NOT EXISTS idx_notif_msgs_trigger ON notification_messages (trigger_time)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_notif_msgs_channel ON notification_messages (channel_id)');
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
        INSERT INTO admins (user_id, added_by, added_at, permissions, alliances, is_owner)
        VALUES (?, ?, ?, ?, ?, ?)
    `),

    // Get admin by user_id
    getAdmin: db.prepare('SELECT * FROM admins WHERE user_id = ?'),

    // Get admin by id
    getAdminById: db.prepare('SELECT * FROM admins WHERE id = ?'),

    // Get all admins
    getAllAdmins: db.prepare('SELECT * FROM admins'),

    // Update admin permissions
    updateAdminPermissions: db.prepare('UPDATE admins SET permissions = ? WHERE user_id = ?'),

    // Update admin alliances
    updateAdminAlliances: db.prepare('UPDATE admins SET alliances = ? WHERE user_id = ?'),

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
        INSERT INTO alliance (game_type, priority, name, state, guide_id, channel_id, interval, auto_redeem, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),

    // Get alliance by id
    getAllianceById: db.prepare('SELECT * FROM alliance WHERE game_type = ? AND id = ?'),
    getAllianceByIdAny: db.prepare('SELECT * FROM alliance WHERE id = ?'),

    // Get multiple alliances by IDs across all games (batch query to avoid N+1)
    getAlliancesByIdsAny: db.prepare('SELECT * FROM alliance WHERE id IN (SELECT value FROM json_each(?))'),

    // Get all alliances
    getAllAlliances: db.prepare('SELECT * FROM alliance WHERE game_type = ? ORDER BY priority'),
    getAllAlliancesAny: db.prepare('SELECT * FROM alliance ORDER BY game_type, priority'),

    // Count all alliances
    countAlliances: db.prepare('SELECT COUNT(*) AS count FROM alliance WHERE game_type = ?'),

    // Update alliance
    updateAlliance: db.prepare(`
        UPDATE alliance SET priority = ?, name = ?, guide_id = ?, channel_id = ?, 
        interval = ?, auto_redeem = ? WHERE game_type = ? AND id = ?
    `),

    updateAllianceState: db.prepare('UPDATE alliance SET state = ? WHERE game_type = ? AND id = ?'),

    // Update alliance priority only
    updateAlliancePriority: db.prepare('UPDATE alliance SET priority = ? WHERE game_type = ? AND id = ?'),

    // Delete alliance
    deleteAlliance: db.prepare('DELETE FROM alliance WHERE game_type = ? AND id = ?'),

    // Get alliance by priority
    getAllianceByPriority: db.prepare('SELECT * FROM alliance WHERE game_type = ? AND priority = ?'),

    // Get alliances by a list of IDs for one game
    getAlliancesByIds: db.prepare('SELECT * FROM alliance WHERE game_type = ? AND id IN (SELECT value FROM json_each(?))'),

    // Get alliances with auto-redeem enabled, ordered by priority
    getAlliancesWithAutoRedeem: db.prepare('SELECT * FROM alliance WHERE game_type = ? AND auto_redeem = 1 ORDER BY priority')
};

// ID Channels queries
const idChannelQueries = {
    // Add channel
    addIdChannel: db.prepare(`
        INSERT INTO id_channels (game_type, guide_id, alliance_id, channel_id, linked_by)
        VALUES (?, ?, ?, ?, ?)
    `),

    // Get channels by alliance
    getChannelsByAlliance: db.prepare('SELECT * FROM id_channels WHERE game_type = ? AND alliance_id = ?'),

    // Get channels by multiple alliance IDs
    getChannelsByAllianceIds: db.prepare('SELECT * FROM id_channels WHERE game_type = ? AND alliance_id IN (SELECT value FROM json_each(?))'),

    // Get channel by id
    getChannelById: db.prepare('SELECT * FROM id_channels WHERE game_type = ? AND id = ?'),

    // Get channel by channel_id (Discord channel ID) - single row
    getChannelByChannelId: db.prepare('SELECT * FROM id_channels WHERE game_type = ? AND channel_id = ?'),

    // Get all channels by channel_id (for multi-alliance support)
    getChannelsByChannelId: db.prepare('SELECT * FROM id_channels WHERE game_type = ? AND channel_id = ?'),

    // Get all channels by channel_id across all games
    getChannelsByChannelIdAny: db.prepare('SELECT * FROM id_channels WHERE channel_id = ?'),

    // Delete channel
    deleteChannel: db.prepare('DELETE FROM id_channels WHERE game_type = ? AND id = ?'),

    // Get all channels
    getAllChannels: db.prepare('SELECT * FROM id_channels WHERE game_type = ?'),

    // Update auto_clean interval
    updateAutoClean: db.prepare('UPDATE id_channels SET auto_clean = ? WHERE game_type = ? AND id = ?'),

    // Get channels with auto_clean enabled
    getAutoCleanChannels: db.prepare('SELECT * FROM id_channels WHERE game_type = ? AND auto_clean > 0')
};

// Gift code channel queries
const giftCodeChannelQueries = {
    // Add gift code channel
    addChannel: db.prepare(`
        INSERT INTO gift_code_channels (game_type, channel_id, linked_by, created_at)
        VALUES (?, ?, ?, ?)
    `),

    // Get channel by channel_id (Discord channel ID)
    getChannelByChannelId: db.prepare('SELECT * FROM gift_code_channels WHERE game_type = ? AND channel_id = ?'),
    getChannelByChannelIdAny: db.prepare('SELECT * FROM gift_code_channels WHERE channel_id = ?'),

    // Get channel by id
    getChannelById: db.prepare('SELECT * FROM gift_code_channels WHERE id = ?'),

    // Get all gift code channels
    getAllChannels: db.prepare('SELECT * FROM gift_code_channels WHERE game_type = ? ORDER BY id'),
    getAllChannelsAny: db.prepare('SELECT * FROM gift_code_channels ORDER BY game_type, id'),

    // Delete channel
    deleteChannel: db.prepare('DELETE FROM gift_code_channels WHERE id = ?'),

    // Check if channel exists
    channelExists: db.prepare('SELECT 1 FROM gift_code_channels WHERE game_type = ? AND channel_id = ? LIMIT 1')
};

// Player queries
const playerQueries = {
    // Add player
    addPlayer: db.prepare(`
        INSERT INTO players (game_type, fid, state, alliance_id, added_by)
        VALUES (?, ?, ?, ?, ?)
    `),

    // Get player by fid
    getPlayer: db.prepare('SELECT * FROM players WHERE game_type = ? AND fid = ?'),
    getPlayersByFidAny: db.prepare('SELECT * FROM players WHERE fid = ? ORDER BY game_type'),

    // Get players by alliance
    getPlayersByAlliance: db.prepare('SELECT * FROM players WHERE game_type = ? AND alliance_id = ? AND exist < 3'),

    // Get player counts for multiple alliances (used for pagination efficiency)
    getPlayerCountsByAllianceIds: db.prepare(`
        SELECT alliance_id, COUNT(*) as player_count 
        FROM players 
        WHERE game_type = ? AND alliance_id IN (SELECT value FROM json_each(?)) AND exist < 3
        GROUP BY alliance_id
    `),

    getDistinctStates: db.prepare(`
        SELECT DISTINCT state FROM players
        WHERE game_type = ? AND exist < 3 AND state IS NOT NULL AND alliance_id IN (SELECT value FROM json_each(?))
        ORDER BY state ASC
    `),

    // Update player alliance
    updatePlayerAlliance: db.prepare('UPDATE players SET alliance_id = ?, state = ?, state_search_blocked_for = NULL WHERE game_type = ? AND fid = ?'),

    // Update player state override (NULL = follow alliance state)
    updatePlayerStateOverride: db.prepare('UPDATE players SET state_override = ?, state_search_blocked_for = NULL WHERE game_type = ? AND fid = ?'),
    blockStateSearch: db.prepare('UPDATE players SET state_search_blocked_for = ? WHERE game_type = ? AND fid = ?'),
    clearAllianceStateSearchBlocks: db.prepare('UPDATE players SET state_search_blocked_for = NULL WHERE game_type = ? AND alliance_id = ?'),

    // Update player nickname
    updatePlayerNickname: db.prepare('UPDATE players SET nickname = ? WHERE game_type = ? AND fid = ?'),

    // Search players by FID or nickname within a set of alliances (for autocomplete)
    searchPlayersByQuery: (query, allianceIds, gameType) => {
        const like = `%${query}%`;
        return db.prepare(`
            SELECT p.fid, p.nickname, p.state, p.state_override, p.alliance_id, p.game_type,
                   a.name AS alliance_name, a.priority AS alliance_priority
            FROM players p
            LEFT JOIN alliance a ON a.id = p.alliance_id AND a.game_type = p.game_type
            WHERE p.game_type = ?
              AND p.exist < 3
              AND p.alliance_id IN (SELECT value FROM json_each(?))
              AND (CAST(p.fid AS TEXT) LIKE ? OR p.nickname LIKE ? COLLATE NOCASE)
            ORDER BY p.nickname IS NULL, p.nickname COLLATE NOCASE ASC, p.fid ASC
            LIMIT 25
        `).all(gameType, JSON.stringify(allianceIds), like, like);
    },

    // Delete player
    deletePlayer: db.prepare('DELETE FROM players WHERE game_type = ? AND fid = ?'),

    // Delete furnace changes for player
    deleteFurnaceChanges: db.prepare('DELETE FROM furnace_changes WHERE game_type = ? AND fid = ?'),

    // Delete nickname changes for player
    deleteNicknameChanges: db.prepare('DELETE FROM nickname_changes WHERE game_type = ? AND fid = ?'),

    // Delete giftcode usage for player
    deleteGiftcodeUsage: db.prepare('DELETE FROM giftcode_usage WHERE game_type = ? AND fid = ?'),

    // Get all players
    getAllPlayers: db.prepare('SELECT * FROM players WHERE game_type = ?'),

    // Count all players
    countPlayers: db.prepare('SELECT COUNT(*) AS count FROM players WHERE game_type = ?'),

    // Update player rich status
    updatePlayerRichStatus: db.prepare('UPDATE players SET is_rich = ? WHERE game_type = ? AND fid = ?'),

    // Update player VIP count
    updatePlayerVipCount: db.prepare('UPDATE players SET vip_count = ? WHERE game_type = ? AND fid = ?'),

    // Increment VIP count for all non-rich players
    incrementVipCountForNonRich: db.prepare('UPDATE players SET vip_count = vip_count + 1 WHERE game_type = ? AND is_rich = 0'),

    // Reset VIP count for a player
    resetPlayerVipCount: db.prepare('UPDATE players SET vip_count = 1 WHERE game_type = ? AND fid = ?'),

    // Get players eligible for VIP codes (is_rich = 1 OR vip_count = 0 OR vip_count >= 5)
    // vip_count = 0: Untested players (first time, give them a chance)
    // vip_count >= 5: Players who failed VIP redemption multiple times (likely eligible)
    // is_rich = 1: Confirmed VIP/rich players
    getVipEligiblePlayers: db.prepare(`
        SELECT * FROM players 
        WHERE game_type = ? AND alliance_id = ? AND (is_rich = 1 OR vip_count = 0 OR vip_count >= 5) AND exist < 3
    `),
    // Increment exist counter for non-existent players
    incrementPlayerExist: db.prepare('UPDATE players SET exist = exist + 1 WHERE game_type = ? AND fid = ?'),
    // Reset exist counter when player returns valid data (false positive)
    resetPlayerExist: db.prepare('UPDATE players SET exist = 0 WHERE game_type = ? AND fid = ?'),
    // Get players with exist >= 3 (for future features)
    getNonExistentPlayers: db.prepare('SELECT * FROM players WHERE game_type = ? AND exist >= 3'),
    // Get players by alliance excluding non-existent
    getPlayersByAllianceId: db.prepare('SELECT * FROM players WHERE game_type = ? AND alliance_id = ? AND exist < 3'),

    // Get multiple players by FIDs in a single query
    getPlayersByFids: (gameType, fids) => {
        if (!fids || fids.length === 0) return [];
        const placeholders = fids.map(() => '?').join(',');
        const query = `SELECT * FROM players WHERE game_type = ? AND fid IN (${placeholders})`;
        return db.prepare(query).all(gameType, ...fids);
    },

    // Delete multiple players in a single atomic transaction
    deletePlayers: (gameType, fids) => {
        if (!fids || fids.length === 0) return;
        const placeholders = fids.map(() => '?').join(',');

        // Delete related records
        const deleteFurnaceChangesQuery = `DELETE FROM furnace_changes WHERE game_type = ? AND fid IN (${placeholders})`;
        const deleteNicknameChangesQuery = `DELETE FROM nickname_changes WHERE game_type = ? AND fid IN (${placeholders})`;
        const deleteGiftcodeUsageQuery = `DELETE FROM giftcode_usage WHERE game_type = ? AND fid IN (${placeholders})`;
        const deletePlayersQuery = `DELETE FROM players WHERE game_type = ? AND fid IN (${placeholders})`;

        db.transaction(() => {
            db.prepare(deleteFurnaceChangesQuery).run(gameType, ...fids);
            db.prepare(deleteNicknameChangesQuery).run(gameType, ...fids);
            db.prepare(deleteGiftcodeUsageQuery).run(gameType, ...fids);
            db.prepare(deletePlayersQuery).run(gameType, ...fids);
        })();
    }
};

// Furnace changes queries
const furnaceChangeQueries = {
    // Add furnace change
    addFurnaceChange: db.prepare(`
        INSERT INTO furnace_changes (game_type, fid, old_furnace_lv, new_furnace_lv, change_date)
        VALUES (?, ?, ?, ?, ?)
    `),

};

// Nickname changes queries
const nicknameChangeQueries = {
    // Add nickname change
    addNicknameChange: db.prepare(`
        INSERT INTO nickname_changes (game_type, fid, old_nickname, new_nickname, change_date)
        VALUES (?, ?, ?, ?, ?)
    `),

};

// Gift code queries
const giftCodeQueries = {
    // Add gift code
    addGiftCode: db.prepare(`
        INSERT INTO gift_codes (game_type, gift_code, date, status, added_by, source, api_pushed, last_validated, is_vip)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),

    // Get gift code
    getGiftCode: db.prepare('SELECT * FROM gift_codes WHERE game_type = ? AND gift_code = ?'),

    // Get all gift codes
    getAllGiftCodes: db.prepare('SELECT * FROM gift_codes WHERE game_type = ? ORDER BY date DESC'),

    // Count all gift codes
    countGiftCodes: db.prepare('SELECT COUNT(*) AS count FROM gift_codes WHERE game_type = ?'),

    // Update gift code status
    updateGiftCodeStatus: db.prepare('UPDATE gift_codes SET status = ? WHERE game_type = ? AND gift_code = ?'),

    // Update last validated timestamp
    updateLastValidated: db.prepare('UPDATE gift_codes SET last_validated = ? WHERE game_type = ? AND gift_code = ?'),

    // Get codes that need revalidation (not validated in last 24 hours and added more than 1 hour ago)
    getCodesNeedingValidation: db.prepare(`
        SELECT * FROM gift_codes 
        WHERE game_type = ?
        AND status != 'invalid' 
        AND datetime(date) < datetime('now', '-1 hours')
        AND (last_validated IS NULL OR datetime(last_validated) < datetime('now', '-24 hours'))
    `),

    // Delete gift code
    removeGiftCode: db.prepare('DELETE FROM gift_codes WHERE game_type = ? AND gift_code = ?'),

    // Update gift code VIP status
    updateGiftCodeVipStatus: db.prepare('UPDATE gift_codes SET is_vip = ? WHERE game_type = ? AND gift_code = ?'),

    // Update gift code API push status
    updateApiPushed: db.prepare('UPDATE gift_codes SET api_pushed = ? WHERE game_type = ? AND gift_code = ?'),

    // Get VIP gift codes
    getVipGiftCodes: db.prepare('SELECT * FROM gift_codes WHERE game_type = ? AND is_vip = 1 AND status = \'active\' ORDER BY date DESC')
};

// Gift code usage queries
const giftCodeUsageQueries = {
    // Add usage
    addUsage: db.prepare(`
        INSERT INTO giftcode_usage (game_type, fid, gift_code, status)
        VALUES (?, ?, ?, ?)
    `),

    // Get usage by player
    getUsageByPlayer: db.prepare('SELECT * FROM giftcode_usage WHERE game_type = ? AND fid = ?'),

    // Get usage by gift code
    getUsageByGiftCode: db.prepare('SELECT * FROM giftcode_usage WHERE game_type = ? AND gift_code = ?'),

    // Check if player used code
    checkUsage: db.prepare('SELECT * FROM giftcode_usage WHERE game_type = ? AND fid = ? AND gift_code = ?'),

    // Update usage status
    updateUsageStatus: db.prepare('UPDATE giftcode_usage SET status = ? WHERE id = ?'),

    // Get all FIDs who already redeemed a specific gift code (FAST - for filtering)
    getFidsWhoRedeemedCode: db.prepare('SELECT fid FROM giftcode_usage WHERE game_type = ? AND gift_code = ?'),

    // Check if multiple players already redeemed a code (bulk check)
    // Returns FIDs that HAVE redeemed the code
    checkBulkUsage: db.prepare(`
        SELECT DISTINCT fid 
        FROM giftcode_usage 
        WHERE game_type = ? AND gift_code = ? AND fid IN (SELECT value FROM json_each(?))
    `),

    // Get count of how many times a gift code was redeemed
    getUsageCount: db.prepare('SELECT COUNT(*) as count FROM giftcode_usage WHERE game_type = ? AND gift_code = ?'),

    // Get usage counts for multiple gift codes (batch)
    getUsageCountsBatch: (gameType, giftCodes) => {
        if (!giftCodes || giftCodes.length === 0) return {};
        const placeholders = giftCodes.map(() => '?').join(',');
        const query = `SELECT gift_code, COUNT(*) as count FROM giftcode_usage WHERE game_type = ? AND gift_code IN (${placeholders}) GROUP BY gift_code`;
        const rows = db.prepare(query).all(resolveGameType(gameType), ...giftCodes);
        const result = {};
        rows.forEach(row => {
            result[row.gift_code] = row.count;
        });
        return result;
    },

    // Delete all usage records for a gift code
    deleteUsageByGiftCode: db.prepare('DELETE FROM giftcode_usage WHERE game_type = ? AND gift_code = ?')
};

const stateSearchRetryQueries = {
    add: db.prepare('INSERT OR IGNORE INTO state_search_retries (game_type, fid, gift_code) VALUES (?, ?, ?)'),
    getActive: db.prepare(`
        SELECT r.gift_code FROM state_search_retries r
        JOIN gift_codes c ON c.game_type = r.game_type AND c.gift_code = r.gift_code AND c.status = 'active'
        LEFT JOIN giftcode_usage u ON u.game_type = r.game_type AND u.fid = r.fid AND u.gift_code = r.gift_code
        WHERE r.game_type = ? AND r.fid = ? AND u.id IS NULL
        ORDER BY c.date DESC
    `),
    remove: db.prepare('DELETE FROM state_search_retries WHERE game_type = ? AND fid = ? AND gift_code = ?'),
    removeCode: db.prepare('DELETE FROM state_search_retries WHERE game_type = ? AND gift_code = ?'),
    removePlayer: db.prepare('DELETE FROM state_search_retries WHERE game_type = ? AND fid = ?')
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

    // Complete a scheduled occurrence without overwriting content edited while it was running
    updateNotificationScheduleState: db.prepare(`
        UPDATE notifications SET is_active = ?, last_trigger = ?, next_trigger = ?
        WHERE id = ? AND next_trigger = ?
    `),

    // Update notification active status
    updateNotificationActiveStatus: db.prepare('UPDATE notifications SET is_active = ? WHERE id = ?'),

    // Update notification completed status
    updateNotificationCompletedStatus: db.prepare('UPDATE notifications SET completed = ? WHERE id = ?'),

    // Get active notifications
    getActiveNotifications: db.prepare('SELECT * FROM notifications WHERE is_active = 1'),

    // Count active notifications
    countActiveNotifications: db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE is_active = 1'),

    // Get private notifications (where guild_id is NULL or empty)
    getPrivateNotifications: db.prepare("SELECT * FROM notifications WHERE guild_id IS NULL OR guild_id = ''"),

    // Get active private notifications created by specific user
    getActivePrivateNotificationsByUser: db.prepare("SELECT * FROM notifications WHERE (guild_id IS NULL OR guild_id = '') AND is_active = 1 AND created_by = ?"),

    // Get active private notifications NOT created by specific users (for bulk operations)
    getActivePrivateNotificationsExcludingUsers: db.prepare("SELECT * FROM notifications WHERE (guild_id IS NULL OR guild_id = '') AND is_active = 1 AND created_by NOT IN (SELECT value FROM json_each(?))"),

    // Delete notification
    deleteNotification: db.prepare('DELETE FROM notifications WHERE id = ?')
};

// Schedule board queries
const scheduleBoardQueries = {
    addBoard: db.prepare(`
        INSERT INTO schedule_boards (guild_id, target_channel_id, message_id, scope, filter_channel_id, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    getBoardById: db.prepare('SELECT * FROM schedule_boards WHERE id = ?'),
    getBoardsByGuild: db.prepare('SELECT * FROM schedule_boards WHERE guild_id = ?'),
    getBoardByMessage: db.prepare('SELECT * FROM schedule_boards WHERE message_id = ?'),
    updateBoardMessage: db.prepare('UPDATE schedule_boards SET message_id = ? WHERE id = ?'),
    deleteBoard: db.prepare('DELETE FROM schedule_boards WHERE id = ?'),
    deleteBoardsByGuild: db.prepare('DELETE FROM schedule_boards WHERE guild_id = ?')
};

// Notification message tracking queries (for auto-clean)
const notifMessageQueries = {
    addMessage: db.prepare(`
        INSERT INTO notification_messages (notification_id, channel_id, message_id, trigger_time, sent_at)
        VALUES (?, ?, ?, ?, ?)
    `),
    getMessagesByTriggerTime: db.prepare('SELECT * FROM notification_messages WHERE trigger_time <= ? AND channel_id IN (SELECT channel_id FROM notification_auto_clean)'),
    deleteMessage: db.prepare('DELETE FROM notification_messages WHERE id = ?'),
    deleteByNotification: db.prepare('DELETE FROM notification_messages WHERE notification_id = ?'),
    deleteOlderThan: db.prepare('DELETE FROM notification_messages WHERE trigger_time < ?')
};

// Notification auto-clean channel queries
const notifAutoCleanQueries = {
    addChannel: db.prepare('INSERT OR IGNORE INTO notification_auto_clean (channel_id) VALUES (?)'),
    removeChannel: db.prepare('DELETE FROM notification_auto_clean WHERE channel_id = ?'),
    getChannel: db.prepare('SELECT * FROM notification_auto_clean WHERE channel_id = ?'),
    getAllChannels: db.prepare('SELECT * FROM notification_auto_clean'),
    clearAll: db.prepare('DELETE FROM notification_auto_clean')
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

    // Paginated system logs
    getLogsPage: db.prepare('SELECT * FROM system_logs ORDER BY time DESC LIMIT ? OFFSET ?'),
    getLogsByTypePage: db.prepare('SELECT * FROM system_logs WHERE action_type = ? ORDER BY time DESC LIMIT ? OFFSET ?'),
    countAllLogs: db.prepare('SELECT COUNT(*) AS total FROM system_logs'),
    countLogsByType: db.prepare('SELECT COUNT(*) AS total FROM system_logs WHERE action_type = ?'),

    // Get recent logs (limit)
    getRecentLogs: db.prepare('SELECT * FROM system_logs ORDER BY time DESC LIMIT ?'),

    // Delete logs older than a given ISO timestamp
    deleteLogsOlderThan: db.prepare('DELETE FROM system_logs WHERE time < ?')
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

    // Count active processes
    countActiveProcesses: db.prepare("SELECT COUNT(*) AS count FROM processes WHERE status = 'active'"),

    // Count queue position for a process (how many processes are ahead in queue for same game type)
    countQueuePosition: db.prepare(`
        SELECT COUNT(*) AS position FROM processes 
        WHERE status = 'queued' 
        AND id != ?
        AND (json_extract(details, '$.game_type') = ? OR json_extract(details, '$.gameType') = ?)
        AND (
            priority < ? 
            OR (priority = ? AND created_at < ?)
        )
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

    // Set process preemption
    setProcessPreemption: db.prepare(`
        UPDATE processes 
        SET preempted_by = ?, status = 'queued', resume_after = NULL, updated_at = ?
        WHERE id = ?
    `),

    // Clear preempted_by without changing status (used when resuming a preempted process)
    clearProcessPreemption: db.prepare(`
        UPDATE processes 
        SET preempted_by = NULL, updated_at = ?
        WHERE id = ?
    `),

    // Get processes by action and target
    getProcessesByActionAndTarget: db.prepare(`
        SELECT * FROM processes
        WHERE action = ? AND target = ? AND status NOT IN ('completed', 'failed')
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
    getDefaultTestId: db.prepare('SELECT * FROM test_ids WHERE game_type = ? AND id = 1'),

    // Get user-set test ID (id = 2)
    getUserTestId: db.prepare('SELECT * FROM test_ids WHERE game_type = ? AND id = 2'),

    // Get all test IDs
    getAllTestIds: db.prepare('SELECT * FROM test_ids WHERE game_type = ? ORDER BY id'),

    // Update user test ID (id = 2)
    updateUserTestId: db.prepare('UPDATE test_ids SET fid = ?, state = ?, set_by = ?, set_at = ? WHERE game_type = ? AND id = 2')
};

// Settings queries
const settingsQueries = {
    // Get settings (always returns one row)
    getSettings: db.prepare('SELECT * FROM settings WHERE id = 1'),
    // Initialize settings if not exists
    initSettings: db.prepare('INSERT OR IGNORE INTO settings (id, auto_delete, feature_access) VALUES (1, 1, \'{}\')'),
    // Get feature_access JSON string
    getFeatureAccess: db.prepare('SELECT feature_access FROM settings WHERE id = 1'),
    // Set feature_access (expects JSON string)
    setFeatureAccess: db.prepare('UPDATE settings SET feature_access = ? WHERE id = 1'),
    // Update auto_delete setting
    updateAutoDelete: db.prepare('UPDATE settings SET auto_delete = ? WHERE id = 1'),
    // Get Google Drive token
    getGDriveToken: db.prepare('SELECT gdrive_token FROM settings WHERE id = 1'),
    // Set Google Drive token
    setGDriveToken: db.prepare('UPDATE settings SET gdrive_token = ? WHERE id = 1'),
    // Clear Google Drive token
    clearGDriveToken: db.prepare('UPDATE settings SET gdrive_token = NULL WHERE id = 1'),
    // Update notification auto-clean enabled
    updateNotifAutoClean: db.prepare('UPDATE settings SET notif_auto_clean = ? WHERE id = 1'),
    // Update notification auto-clean frequency (in seconds)
    updateNotifAutoCleanFreq: db.prepare('UPDATE settings SET notif_auto_clean_freq = ? WHERE id = 1'),
    // Update auto-update enabled/disabled
    updateAutoUpdate: db.prepare('UPDATE settings SET auto_update = ? WHERE id = 1')
};

// Initialize settings on startup
try {
    // Ensure a settings row exists and include feature_access default
    settingsQueries.initSettings.run();
} catch (error) {
    // Settings initialization failed - non-critical
}

// User queries (language, emoji theme, calculator buffs)
const userQueries = {
    // Get user record
    getUser: db.prepare('SELECT * FROM users WHERE user_id = ?'),
    // Create user record if not exists
    upsertUser: db.prepare('INSERT OR IGNORE INTO users (user_id) VALUES (?)'),
    // Get saved buffs for a user
    getBuffs: db.prepare('SELECT buffs FROM users WHERE user_id = ?'),
    // Save / update buffs for a user
    upsertBuffs: db.prepare('INSERT INTO users (user_id, buffs) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET buffs = excluded.buffs'),
    // Update user language
    updateLanguage: db.prepare('UPDATE users SET language = ? WHERE user_id = ?'),
    // Update user custom emoji set
    updateCustomEmoji: db.prepare('UPDATE users SET custom_emoji = ? WHERE user_id = ?'),
    // Get users using a specific custom emoji set
    getUsersByCustomEmoji: db.prepare('SELECT user_id FROM users WHERE custom_emoji = ?')
};

// Wrapper functions with error handling and current timestamp
const createAdmin = (userId, addedBy, permissions = 0, alliances = '[]', isOwner = false) => {
    const isOwnerInt = isOwner ? 1 : 0;
    return adminQueries.addAdmin.run(userId, addedBy, getCurrentTimestamp(), permissions, alliances, isOwnerInt);
};

const createGiftCode = (giftCode, status = 'active', addedBy, source = 'manual', apiPushed = false, isVip = false, gameType = getDefaultGameType()) => {
    const now = getCurrentTimestamp();
    const isVipInt = isVip ? 1 : 0;
    const apiPushedInt = apiPushed ? 1 : 0;
    return giftCodeQueries.addGiftCode.run(resolveGameType(gameType), giftCode, now, status, addedBy, source, apiPushedInt, now, isVipInt);
};

// Migration utilities
const migrationQueries = {
    // Clear all data except settings, custom_emojis, and test_ids
    clearAllData: () => {
        // Clear all tables atomically in correct order to respect foreign key constraints
        db.transaction(() => {
            db.prepare('DELETE FROM giftcode_usage').run();
            db.prepare('DELETE FROM state_search_retries').run();
            db.prepare('DELETE FROM furnace_changes').run();
            db.prepare('DELETE FROM nickname_changes').run();
            db.prepare('DELETE FROM id_channels').run();
            db.prepare('DELETE FROM gift_code_channels').run();
            db.prepare('DELETE FROM players').run();
            db.prepare('DELETE FROM alliance_logs').run();
            db.prepare('DELETE FROM alliance').run();
            db.prepare('DELETE FROM admin_logs').run();
            db.prepare('DELETE FROM admins').run();
            db.prepare('DELETE FROM users').run();
            db.prepare('DELETE FROM processes').run();
            db.prepare('DELETE FROM notifications').run();
            db.prepare('DELETE FROM gift_codes').run();
        })();
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
        updateAdminAlliances: (alliances, userId) => adminQueries.updateAdminAlliances.run(alliances, userId),
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
        addAlliance: (priority, name, guideId, channelId, interval, autoRedeem, createdBy, gameType = getDefaultGameType(), state = null) =>
            allianceQueries.addAlliance.run(resolveGameType(gameType), priority, name, state, guideId, channelId, interval, autoRedeem, createdBy),
        getAllianceById: (id, gameType = getDefaultGameType()) => allianceQueries.getAllianceById.get(resolveGameType(gameType), id),
        getAllianceByIdAny: (id) => allianceQueries.getAllianceByIdAny.get(id),
        getAlliancesByIdsAny: (ids) => allianceQueries.getAlliancesByIdsAny.all(JSON.stringify(ids)),
        getAllAlliances: (gameType = getDefaultGameType()) => allianceQueries.getAllAlliances.all(resolveGameType(gameType)),
        getAllAlliancesAny: () => allianceQueries.getAllAlliancesAny.all(),
        countAlliances: (gameType = getDefaultGameType()) => allianceQueries.countAlliances.get(resolveGameType(gameType))?.count || 0,
        getAlliancesByIds: (ids, gameType = getDefaultGameType()) => allianceQueries.getAlliancesByIds.all(resolveGameType(gameType), JSON.stringify(ids)),
        updateAlliance: (priority, name, guideId, channelId, interval, autoRedeem, id, gameType = getDefaultGameType()) =>
            allianceQueries.updateAlliance.run(priority, name, guideId, channelId, interval, autoRedeem, resolveGameType(gameType), id),
        setAllianceState: (id, state, gameType = getDefaultGameType()) => db.transaction(() => {
            const resolvedGameType = resolveGameType(gameType);
            const result = allianceQueries.updateAllianceState.run(state, resolvedGameType, id);
            playerQueries.clearAllianceStateSearchBlocks.run(resolvedGameType, id);
            return result;
        })(),
        updateAlliancePriority: (id, priority, gameType = getDefaultGameType()) => allianceQueries.updateAlliancePriority.run(priority, resolveGameType(gameType), id),
        deleteAlliance: (id, gameType = getDefaultGameType()) => allianceQueries.deleteAlliance.run(resolveGameType(gameType), id),
        getAllianceByPriority: (priority, gameType = getDefaultGameType()) => allianceQueries.getAllianceByPriority.get(resolveGameType(gameType), priority),
        getAlliancesWithAutoRedeem: (gameType = getDefaultGameType()) => allianceQueries.getAlliancesWithAutoRedeem.all(resolveGameType(gameType))
    },
    idChannelQueries: {
        ...idChannelQueries,
        addIdChannel: (guideId, allianceId, channelId, linkedBy, gameType = getDefaultGameType()) =>
            idChannelQueries.addIdChannel.run(resolveGameType(gameType), guideId, allianceId, channelId, linkedBy),
        getChannelsByAlliance: (allianceId, gameType = getDefaultGameType()) => idChannelQueries.getChannelsByAlliance.all(resolveGameType(gameType), allianceId),
        getChannelsByAllianceIds: (allianceIds, gameType = getDefaultGameType()) => idChannelQueries.getChannelsByAllianceIds.all(resolveGameType(gameType), JSON.stringify(allianceIds)),
        getChannelById: (id, gameType = getDefaultGameType()) => idChannelQueries.getChannelById.get(resolveGameType(gameType), id),
        getChannelByChannelId: (channelId, gameType = getDefaultGameType()) => idChannelQueries.getChannelByChannelId.get(resolveGameType(gameType), channelId),
        getChannelsByChannelId: (channelId, gameType = getDefaultGameType()) => idChannelQueries.getChannelsByChannelId.all(resolveGameType(gameType), channelId),
        getChannelsByChannelIdAny: (channelId) => idChannelQueries.getChannelsByChannelIdAny.all(channelId),
        removeIdChannel: (id, gameType = getDefaultGameType()) => idChannelQueries.deleteChannel.run(resolveGameType(gameType), id),
        deleteChannel: (id, gameType = getDefaultGameType()) => idChannelQueries.deleteChannel.run(resolveGameType(gameType), id),
        getAllChannels: (gameType = getDefaultGameType()) => idChannelQueries.getAllChannels.all(resolveGameType(gameType)),
        updateAutoClean: (interval, id, gameType = getDefaultGameType()) => idChannelQueries.updateAutoClean.run(interval, resolveGameType(gameType), id),
        getAutoCleanChannels: (gameType = getDefaultGameType()) => idChannelQueries.getAutoCleanChannels.all(resolveGameType(gameType))
    },
    giftCodeChannelQueries: {
        ...giftCodeChannelQueries,
        addChannel: (channelId, linkedBy, gameType = getDefaultGameType()) =>
            giftCodeChannelQueries.addChannel.run(resolveGameType(gameType), channelId, linkedBy, getCurrentTimestamp()),
        getChannelByChannelId: (channelId, gameType = getDefaultGameType()) =>
            giftCodeChannelQueries.getChannelByChannelId.get(resolveGameType(gameType), channelId),
        getChannelByChannelIdAny: (channelId) => giftCodeChannelQueries.getChannelByChannelIdAny.get(channelId),
        getChannelById: (id) => giftCodeChannelQueries.getChannelById.get(id),
        getAllChannels: (gameType = getDefaultGameType()) => giftCodeChannelQueries.getAllChannels.all(resolveGameType(gameType)),
        getAllChannelsAny: () => giftCodeChannelQueries.getAllChannelsAny.all(),
        deleteChannel: (id) => giftCodeChannelQueries.deleteChannel.run(id),
        channelExists: (channelId, gameType = getDefaultGameType()) => {
            const result = giftCodeChannelQueries.channelExists.get(resolveGameType(gameType), channelId);
            return result !== undefined;
        }
    },
    playerQueries: {
        ...playerQueries,
        addPlayer: (fid, state, allianceId, addedBy, gameType = getDefaultGameType()) => {
            const addedByStr = String(addedBy);
            return playerQueries.addPlayer.run(resolveGameType(gameType), fid, state, allianceId, addedByStr);
        },
        getPlayer: (fid, gameType = getDefaultGameType()) => playerQueries.getPlayer.get(resolveGameType(gameType), fid),
        getPlayerByFid: (fid, gameType = getDefaultGameType()) => playerQueries.getPlayer.get(resolveGameType(gameType), fid),
        getPlayersByFidAny: (fid) => playerQueries.getPlayersByFidAny.all(fid),
        getPlayersByAlliance: (allianceId, gameType = getDefaultGameType()) => playerQueries.getPlayersByAlliance.all(resolveGameType(gameType), allianceId),
        incrementPlayerExist: (fid, gameType = getDefaultGameType()) => playerQueries.incrementPlayerExist.run(resolveGameType(gameType), fid),
        resetPlayerExist: (fid, gameType = getDefaultGameType()) => playerQueries.resetPlayerExist.run(resolveGameType(gameType), fid),
        getNonExistentPlayers: (gameType = getDefaultGameType()) => playerQueries.getNonExistentPlayers.all(resolveGameType(gameType)),
        getPlayersByAllianceId: (allianceId, gameType = getDefaultGameType()) => playerQueries.getPlayersByAlliance.all(resolveGameType(gameType), allianceId),
        getPlayerCountsByAllianceIds: (allianceIds, gameType = getDefaultGameType()) => playerQueries.getPlayerCountsByAllianceIds.all(resolveGameType(gameType), JSON.stringify(allianceIds)),
        getDistinctStates: (allianceIds, gameType = getDefaultGameType()) => playerQueries.getDistinctStates.all(resolveGameType(gameType), JSON.stringify(allianceIds)).map(r => r.state),
        updatePlayerAlliance: (fid, allianceId, state, gameType = getDefaultGameType()) => playerQueries.updatePlayerAlliance.run(allianceId, state, resolveGameType(gameType), fid),
        updatePlayerStateOverride: (fid, stateOverride, gameType = getDefaultGameType()) => playerQueries.updatePlayerStateOverride.run(stateOverride, resolveGameType(gameType), fid),
        blockStateSearch: (fid, state, gameType = getDefaultGameType()) => playerQueries.blockStateSearch.run(state, resolveGameType(gameType), fid),
        updatePlayerNickname: (fid, nickname, gameType = getDefaultGameType()) => playerQueries.updatePlayerNickname.run(nickname, resolveGameType(gameType), fid),
        searchPlayersByQuery: (query, allianceIds, gameType = getDefaultGameType()) => playerQueries.searchPlayersByQuery(query, allianceIds, resolveGameType(gameType)),
        deletePlayer: (fid, gameType = getDefaultGameType()) => {
            const resolvedGameType = resolveGameType(gameType);
            playerQueries.deleteFurnaceChanges.run(resolvedGameType, fid);
            playerQueries.deleteNicknameChanges.run(resolvedGameType, fid);
            playerQueries.deleteGiftcodeUsage.run(resolvedGameType, fid);
            stateSearchRetryQueries.removePlayer.run(resolvedGameType, fid);
            playerQueries.deletePlayer.run(resolvedGameType, fid);
        },
        getAllPlayers: (gameType = getDefaultGameType()) => playerQueries.getAllPlayers.all(resolveGameType(gameType)),
        countPlayers: (gameType = getDefaultGameType()) => playerQueries.countPlayers.get(resolveGameType(gameType))?.count || 0,
        getPlayersForExport: (filters, gameType = getDefaultGameType()) => {
            // Build dynamic SQL query based on provided filters
            let query = `SELECT p.fid, p.nickname, p.state, p.state_override, a.name as alliance_name, a.state as alliance_state
                         FROM players p LEFT JOIN alliance a ON p.alliance_id = a.id
                         WHERE p.game_type = ? AND p.exist < 3`;
            const params = [resolveGameType(gameType)];

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

            // Order players by alliance, then FID.
            query += ' ORDER BY p.alliance_id, p.fid';

            return db.prepare(query).all(...params);
        },
        updatePlayerRichStatus: (isRich, fid, gameType = getDefaultGameType()) => {
            const isRichInt = isRich ? 1 : 0;
            return playerQueries.updatePlayerRichStatus.run(isRichInt, resolveGameType(gameType), fid);
        },
        updatePlayerVipCount: (vipCount, fid, gameType = getDefaultGameType()) => playerQueries.updatePlayerVipCount.run(vipCount, resolveGameType(gameType), fid),
        incrementVipCountForNonRich: (gameType = getDefaultGameType()) => playerQueries.incrementVipCountForNonRich.run(resolveGameType(gameType)),
        resetPlayerVipCount: (fid, gameType = getDefaultGameType()) => playerQueries.resetPlayerVipCount.run(resolveGameType(gameType), fid),
        getVipEligiblePlayers: (allianceId, gameType = getDefaultGameType()) => playerQueries.getVipEligiblePlayers.all(resolveGameType(gameType), allianceId),
        getPlayersByFids: (fids, gameType = getDefaultGameType()) => playerQueries.getPlayersByFids(resolveGameType(gameType), fids),
        deletePlayers: (fids, gameType = getDefaultGameType()) => playerQueries.deletePlayers(resolveGameType(gameType), fids)
    },
    furnaceChangeQueries: {
        // Raw insert for migrations (allows custom timestamps)
        rawInsert: furnaceChangeQueries.addFurnaceChange
    },
    nicknameChangeQueries: {
        // Raw insert for migrations (allows custom timestamps)
        rawInsert: nicknameChangeQueries.addNicknameChange,
        addNicknameChange: (fid, oldNickname, newNickname, gameType = getDefaultGameType()) =>
            nicknameChangeQueries.addNicknameChange.run(
                resolveGameType(gameType),
                fid,
                oldNickname,
                newNickname,
                getCurrentTimestamp()
            )
    },
    giftCodeQueries: {
        ...giftCodeQueries,
        addGiftCode: createGiftCode,
        getGiftCode: (giftCode, gameType = getDefaultGameType()) => giftCodeQueries.getGiftCode.get(resolveGameType(gameType), giftCode),
        getAllGiftCodes: (gameType = getDefaultGameType()) => giftCodeQueries.getAllGiftCodes.all(resolveGameType(gameType)),
        countGiftCodes: (gameType = getDefaultGameType()) => giftCodeQueries.countGiftCodes.get(resolveGameType(gameType))?.count || 0,
        updateGiftCodeStatus: (status, giftCode, gameType = getDefaultGameType()) => giftCodeQueries.updateGiftCodeStatus.run(status, resolveGameType(gameType), giftCode),
        updateLastValidated: (giftCode, gameType = getDefaultGameType()) => giftCodeQueries.updateLastValidated.run(getCurrentTimestamp(), resolveGameType(gameType), giftCode),
        getCodesNeedingValidation: (gameType = getDefaultGameType()) => giftCodeQueries.getCodesNeedingValidation.all(resolveGameType(gameType)),
        removeGiftCode: (giftCode, gameType = getDefaultGameType()) => {
            // Delete usage records first to avoid foreign key constraint
            try {
                giftCodeUsageQueries.deleteUsageByGiftCode.run(resolveGameType(gameType), giftCode);
            } catch (error) {
                // Non-critical - continue with gift code deletion
            }
            stateSearchRetryQueries.removeCode.run(resolveGameType(gameType), giftCode);
            return giftCodeQueries.removeGiftCode.run(resolveGameType(gameType), giftCode);
        },
        updateGiftCodeVipStatus: (isVip, giftCode, gameType = getDefaultGameType()) => {
            const isVipInt = isVip ? 1 : 0;
            return giftCodeQueries.updateGiftCodeVipStatus.run(isVipInt, resolveGameType(gameType), giftCode);
        },
        updateApiPushed: (apiPushed, giftCode, gameType = getDefaultGameType()) => {
            const apiPushedInt = apiPushed ? 1 : 0;
            return giftCodeQueries.updateApiPushed.run(apiPushedInt, resolveGameType(gameType), giftCode);
        },
        getVipGiftCodes: (gameType = getDefaultGameType()) => giftCodeQueries.getVipGiftCodes.all(resolveGameType(gameType))
    },
    giftCodeUsageQueries: {
        ...giftCodeUsageQueries,
        addUsage: (fid, giftCode, status, gameType = getDefaultGameType()) => giftCodeUsageQueries.addUsage.run(resolveGameType(gameType), fid, giftCode, status),
        getUsageByPlayer: (fid, gameType = getDefaultGameType()) => giftCodeUsageQueries.getUsageByPlayer.all(resolveGameType(gameType), fid),
        getUsageByGiftCode: (giftCode, gameType = getDefaultGameType()) => giftCodeUsageQueries.getUsageByGiftCode.all(resolveGameType(gameType), giftCode),
        checkUsage: (fid, giftCode, gameType = getDefaultGameType()) => giftCodeUsageQueries.checkUsage.get(resolveGameType(gameType), fid, giftCode),
        updateUsageStatus: (status, id) => giftCodeUsageQueries.updateUsageStatus.run(status, id),
        getFidsWhoRedeemedCode: (giftCode, gameType = getDefaultGameType()) => {
            const results = giftCodeUsageQueries.getFidsWhoRedeemedCode.all(resolveGameType(gameType), giftCode);
            return results.map(row => row.fid);
        },
        checkBulkUsage: (giftCode, fids, gameType = getDefaultGameType()) => {
            // Convert array of FIDs to JSON array for SQLite
            const fidsJson = JSON.stringify(fids);
            const results = giftCodeUsageQueries.checkBulkUsage.all(resolveGameType(gameType), giftCode, fidsJson);
            return results.map(row => row.fid);
        },
        getUsageCount: (giftCode, gameType = getDefaultGameType()) => {
            const result = giftCodeUsageQueries.getUsageCount.get(resolveGameType(gameType), giftCode);
            return result ? result.count : 0;
        },
        getUsageCountsBatch: (giftCodes, gameType = getDefaultGameType()) =>
            giftCodeUsageQueries.getUsageCountsBatch(resolveGameType(gameType), giftCodes),
        deleteUsageByGiftCode: (giftCode, gameType = getDefaultGameType()) => giftCodeUsageQueries.deleteUsageByGiftCode.run(resolveGameType(gameType), giftCode)
    },
    stateSearchRetryQueries: {
        add: (fid, giftCode, gameType = getDefaultGameType()) => stateSearchRetryQueries.add.run(resolveGameType(gameType), fid, giftCode),
        getActive: (fid, gameType = getDefaultGameType()) => stateSearchRetryQueries.getActive.all(resolveGameType(gameType), fid),
        remove: (fid, giftCode, gameType = getDefaultGameType()) => stateSearchRetryQueries.remove.run(resolveGameType(gameType), fid, giftCode)
    },
    notificationQueries: {
        ...notificationQueries,
        addNotification: (name, type, completed, guildId, channelId, hour, minute, messageContent, title, description, color, imageUrl, thumbnailUrl, footer, author, fields, pattern, mention, repeatStatus, repeatFrequency, embedToggle, isActive, lastTrigger, nextTrigger, createdBy) =>
            notificationQueries.addNotification.run(name, type, completed ? 1 : 0, guildId, channelId, hour, minute, messageContent, title, description, color, imageUrl, thumbnailUrl, footer, author, fields, pattern, mention, repeatStatus, repeatFrequency, embedToggle ? 1 : 0, isActive ? 1 : 0, getCurrentTimestamp(), lastTrigger, nextTrigger, createdBy),
        getNotificationById: (id) => notificationQueries.getNotificationById.get(id),
        getAllNotifications: () => notificationQueries.getAllNotifications.all(),
        getNotificationsByGuild: (guildId) => notificationQueries.getNotificationsByGuild.all(guildId),
        getActiveNotifications: () => notificationQueries.getActiveNotifications.all(),
        countActiveNotifications: () => notificationQueries.countActiveNotifications.get()?.count || 0,
        getPrivateNotifications: () => notificationQueries.getPrivateNotifications.all(),
        getActivePrivateNotificationsByUser: (userId) => notificationQueries.getActivePrivateNotificationsByUser.all(userId),
        getActivePrivateNotificationsExcludingUsers: (userIds) => notificationQueries.getActivePrivateNotificationsExcludingUsers.all(JSON.stringify(userIds)),
        updateNotification: (id, name, guildId, channelId, hour, minute, messageContent, title, description, color, imageUrl, thumbnailUrl, footer, author, fields, pattern, mention, repeatStatus, repeatFrequency, embedToggle, isActive, lastTrigger, nextTrigger) =>
            notificationQueries.updateNotification.run(name, guildId, channelId, hour, minute, messageContent, title, description, color, imageUrl, thumbnailUrl, footer, author, fields, pattern, mention, repeatStatus, repeatFrequency, embedToggle ? 1 : 0, isActive ? 1 : 0, lastTrigger, nextTrigger, id),
        updateNotificationScheduleState: (id, scheduledTime, isActive, lastTrigger, nextTrigger) =>
            notificationQueries.updateNotificationScheduleState.run(isActive ? 1 : 0, lastTrigger, nextTrigger, id, scheduledTime),
        updateNotificationActiveStatus: (id, isActive) => notificationQueries.updateNotificationActiveStatus.run(isActive ? 1 : 0, id),
        updateNotificationCompletedStatus: (id, completed) => notificationQueries.updateNotificationCompletedStatus.run(completed ? 1 : 0, id),
        deleteNotification: (id) => notificationQueries.deleteNotification.run(id)
    },
    scheduleBoardQueries: {
        ...scheduleBoardQueries,
        addBoard: (guildId, targetChannelId, messageId, scope, filterChannelId, createdBy) =>
            scheduleBoardQueries.addBoard.run(guildId, targetChannelId, messageId, scope, filterChannelId, createdBy, getCurrentTimestamp()),
        getBoardById: (id) => scheduleBoardQueries.getBoardById.get(id),
        getBoardsByGuild: (guildId) => scheduleBoardQueries.getBoardsByGuild.all(guildId),
        getBoardByMessage: (messageId) => scheduleBoardQueries.getBoardByMessage.get(messageId),
        updateBoardMessage: (id, messageId) => scheduleBoardQueries.updateBoardMessage.run(messageId, id),
        deleteBoard: (id) => scheduleBoardQueries.deleteBoard.run(id),
        deleteBoardsByGuild: (guildId) => scheduleBoardQueries.deleteBoardsByGuild.run(guildId)
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
        getLogsPage: (limit, offset) => systemLogQueries.getLogsPage.all(limit, offset),
        getLogsByTypePage: (actionType, limit, offset) => systemLogQueries.getLogsByTypePage.all(actionType, limit, offset),
        countAllLogs: () => systemLogQueries.countAllLogs.get().total,
        countLogsByType: (actionType) => systemLogQueries.countLogsByType.get(actionType).total,
        getRecentLogs: (limit) => systemLogQueries.getRecentLogs.all(limit),
        deleteLogsOlderThan: (isoTimestamp) => systemLogQueries.deleteLogsOlderThan.run(isoTimestamp)
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
        countActiveProcesses: () => processQueries.countActiveProcesses.get()?.count || 0,
        getProcessesByPriorityRange: (minPriority, maxPriority) => processQueries.getProcessesByPriorityRange.all(minPriority, maxPriority),
        updateProcessStatus: (id, status) => processQueries.updateProcessStatus.run(status, getCurrentTimestamp(), id),
        updateProcessProgress: (id, progress) => processQueries.updateProcessProgress.run(progress, getCurrentTimestamp(), id),
        updateProcessDetails: (id, details) => processQueries.updateProcessDetails.run(details, getCurrentTimestamp(), id),
        setProcessPreemption: (id, preemptedBy) => processQueries.setProcessPreemption.run(preemptedBy, getCurrentTimestamp(), id),
        clearProcessPreemption: (id) => processQueries.clearProcessPreemption.run(getCurrentTimestamp(), id),
        getProcessesByActionAndTarget: (action, target) => processQueries.getProcessesByActionAndTarget.all(action, target),
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
        getDefaultTestId: (gameType = getDefaultGameType()) => testIdQueries.getDefaultTestId.get(resolveGameType(gameType)),
        getUserTestId: (gameType = getDefaultGameType()) => testIdQueries.getUserTestId.get(resolveGameType(gameType)),
        getAllTestIds: (gameType = getDefaultGameType()) => testIdQueries.getAllTestIds.all(resolveGameType(gameType)),
        updateUserTestId: (fid, state, setBy, gameType = getDefaultGameType()) => testIdQueries.updateUserTestId.run(fid, state, setBy, getCurrentTimestamp(), resolveGameType(gameType))
    },
    settingsQueries,
    migrationQueries,
    userQueries: {
        getUser: (userId) => userQueries.getUser.get(userId),
        upsertUser: (userId) => userQueries.upsertUser.run(userId),
        getBuffs: (userId) => userQueries.getBuffs.get(userId),
        upsertBuffs: (userId, buffs) => userQueries.upsertBuffs.run(userId, buffs),
        updateLanguage: (language, userId) => userQueries.updateLanguage.run(language, userId),
        updateCustomEmoji: (setId, userId) => userQueries.updateCustomEmoji.run(setId, userId),
        getUsersByCustomEmoji: (setId) => userQueries.getUsersByCustomEmoji.all(setId)
    },
    notifMessageQueries: {
        addMessage: (notificationId, channelId, messageId, triggerTime, sentAt) =>
            notifMessageQueries.addMessage.run(notificationId, channelId, messageId, triggerTime, sentAt),
        getMessagesByTriggerTime: (triggerTime) => notifMessageQueries.getMessagesByTriggerTime.all(triggerTime),
        deleteMessage: (id) => notifMessageQueries.deleteMessage.run(id),
        deleteByNotification: (notificationId) => notifMessageQueries.deleteByNotification.run(notificationId),
        deleteOlderThan: (triggerTime) => notifMessageQueries.deleteOlderThan.run(triggerTime)
    },
    notifAutoCleanQueries: {
        addChannel: (channelId) => notifAutoCleanQueries.addChannel.run(channelId),
        removeChannel: (channelId) => notifAutoCleanQueries.removeChannel.run(channelId),
        getChannel: (channelId) => notifAutoCleanQueries.getChannel.get(channelId),
        getAllChannels: () => notifAutoCleanQueries.getAllChannels.all(),
        clearAll: () => notifAutoCleanQueries.clearAll.run()
    },
    getCurrentTimestamp
};
