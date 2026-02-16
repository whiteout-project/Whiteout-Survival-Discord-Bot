# Developer Guide

This document covers the technical architecture, contribution guidelines, and development workflow for the Whiteout Survival Discord Bot.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Module System](#module-system)
3. [Database Layer](#database-layer)
4. [Handler System](#handler-system)
5. [Process Queue](#process-queue)
6. [Internationalization (i18n)](#internationalization-i18n)
7. [Emoji Theme System](#emoji-theme-system)
8. [Auto-Update System](#auto-update-system)
9. [Adding New Features](#adding-new-features)
10. [Common Patterns](#common-patterns)
11. [Debugging & Hot Reload](#debugging--hot-reload)
12. [Known Issues & Gotchas](#known-issues--gotchas)

---

## Architecture Overview

```
├── starter.js              # Entry point with CLI, dependency checker, update system
├── package.json            # Dependencies and scripts
├── src/
│   ├── index.js            # Bot initialization and module loading
│   ├── .env                # Bot token (created on first run)
│   ├── utility/
│   │   └── database.js     # SQLite database schema and queries
│   ├── i18n/               # Language files (en.json, ar.json)
│   ├── model/              # ONNX captcha model
│   ├── events/             # Discord event handlers
│   ├── handlers/           # Button, dropdown, form handlers
│   ├── commands/           # Slash commands
│   └── functions/          # Feature modules
│       ├── Alliance/       # Alliance management
│       ├── Players/        # Player tracking
│       ├── GiftCode/       # Gift code system
│       ├── Notification/   # Notification scheduler
│       ├── Pagination/     # Universal pagination
│       ├── processes/      # Process queue system
│       ├── settings/       # Settings, admin, backup, themes
│       └── utility/        # Shared utilities
```

### Key Design Principles

- **Singleton Managers**: Long-running systems (AutoRefreshManager, PlayerDataProcessor) use singleton pattern
- **Pattern-Based Routing**: Handlers use regex pattern matching on `customId` to route interactions
- **Process Queue**: Long-running operations (player fetching, gift redemption) go through a priority queue
- **Components v2**: UI uses Discord's new Container/TextDisplay/Separator components

---

### Memory Settings

The bot runs with `--expose-gc` and `--max-old-space-size=256` by default. Adjust in `package.json` if needed:

```json
"scripts": {
    "start": "node --expose-gc --max-old-space-size=256 starter.js",
    "start:basic": "node starter.js"
}
```

---

## Module System

### Events (`src/events/`)

Each event file exports:
```js
module.exports = {
    name: Events.ClientReady,  // Discord.js event name
    once: true,                // true = fire once, false = fire every time
    async execute(client) {    // handler function
        // ...
    }
};
```

### Commands (`src/commands/`)

Each command file exports:
```js
module.exports = {
    data: new SlashCommandBuilder()
        .setName('panel')
        .setDescription('Open the management panel'),
    async execute(interaction) {
        // ...
    }
};
```

### Handlers (`src/handlers/`)

Handlers use a registry pattern with regex matching:

```js
const buttonHandlers = [
    { pattern: /^settings_/, fn: settings.handleSettingsButton },
    { pattern: /^add_player_/, fn: addPlayer.handleAddPlayerButton },
    // ...
];
```

**Important**: When adding new handlers, place more specific patterns BEFORE general ones to avoid false matches.

---

## Database Layer

### Technology

- **SQLite** via `better-sqlite3` (synchronous, fast, single-file)
- **WAL mode** enabled for concurrent reads
- **Foreign keys** enabled

### Query Pattern

Database queries are defined as prepared statements in `src/functions/utility/database.js`, then exported as wrapper functions:

```js
// Internal prepared statement
const playerQueries = {
    getPlayer: db.prepare('SELECT * FROM players WHERE fid = ?'),
};

// Exported wrapper
module.exports = {
    playerQueries: {
        getPlayer: (fid) => playerQueries.getPlayer.get(fid),
    }
};
```

**IMPORTANT**: Always use the exported wrapper functions, NOT `.run()` / `.get()` / `.all()` on the exports directly. The exports are functions, not prepared statements.

```js
// CORRECT
playerQueries.getPlayer(playerId);
playerQueries.deletePlayer(playerId);

// WRONG - will throw TypeError
playerQueries.getPlayer.get(playerId);
playerQueries.deletePlayer.run(playerId);
```

Exception: `settingsQueries` is exported with raw prepared statements (no wrappers), so `.get()` / `.run()` is valid there.

### Schema

All tables are defined in the `schemas` object in `database.js`. Tables are auto-created on startup.

---

## Handler System

### Button Handler (`buttons_handler.js`)

Routes button interactions based on `customId` regex patterns. The handler registry is an array of `{ pattern, fn }` objects processed in order.

### Dropdown Handler (`dropmenu_handlers.js`)

Routes select menu interactions. Adds a `type` field to distinguish between `string`, `user`, `role`, and `channel` select menus.

### Form Handler (`forms_handlers.js`)

Routes modal/form submissions based on `customId` patterns.

### CustomId Convention

CustomIds follow the pattern: `action_subaction_userId_extraData`

Example: `add_player_123456789_0` (action=add_player, userId=123456789, page=0)

**Discord limit**: CustomIds cannot exceed **100 characters**. Use `checkCustomIdLength()` to validate.

---

## Process Queue

### Overview

Long-running operations use a priority-based process queue (`src/functions/processes/`):

1. **createProcesses.js** - Creates process records in the database
2. **queueManager.js** - Manages process execution order and preemption
3. **executeProcesses.js** - Dispatches processes to their handler functions
4. **processRecovery.js** - Recovers processes after crashes

### Process Lifecycle

```
Created → Queued → Active → Completed/Failed
                     ↓
                  Preempted → Queued (resumes later)
```

### Priority Levels

Lower number = higher priority. Default priority is 5.

---

## Internationalization (i18n)

### Structure

Language files are in `src/i18n/`:
- `en.json` - English (default)
- `ar.json` - Arabic

### Usage Pattern

```js
const { getAdminLang } = require('../utility/commonFunctions');

const { adminData, lang } = getAdminLang(interaction.user.id);
// lang.settings.mainPage.content.title → "### ⚙️ Bot Settings"
```

The `lang` object auto-replaces `{emoji.XXX}` placeholders with the user's active emoji set.

### Adding New Keys

1. Add the key to `en.json`
2. Add the same key to `ar.json` (translated)
3. Use via `lang.section.subsection.key`

---

## Emoji Theme System

### How It Works

1. Each emoji has a numeric ID (e.g., `1000` = plus, `1004` = checkmark)
2. Emoji packs define mappings from IDs to Discord emojis
3. Users can create custom packs or use the default
4. The `{emoji.XXXX}` placeholder syntax works in language strings

### Using Emojis in Code

```js
const { getEmojiMapForAdmin, getComponentEmoji } = require('../utility/emojis');

// For embed text
const emojiMap = getEmojiMapForAdmin(userId);
// emojiMap['1004'] → '✅' or custom Discord emoji

// For button emojis (parsed format)
getComponentEmoji(emojiMap, '1004')
```

---

## Auto-Update System

### How It Works

1. `starter.js` checks the GitHub API for the latest release on startup
2. Users can trigger updates via the console (`update` command) or the Settings panel button
3. Updates pull from the GitHub repo and restart. Dependencies are only reinstalled if `package.json` changed

### Components

- **starter.js**: `checkForUpdates()`, `applyUpdate()` functions
- **settings/autoUpdate.js**: Discord button handler for in-bot updates
- **GitHub API**: Compares local `package.json` version with latest release tag

---

## Adding New Features

### Step-by-Step

1. **Create function module** in `src/functions/YourFeature/`
2. **Add button handlers** to `src/handlers/buttons_handler.js`
3. **Add dropdown handlers** to `src/handlers/dropmenu_handlers.js` (if needed)
4. **Add form handlers** to `src/handlers/forms_handlers.js` (if needed)
5. **Add language keys** to `src/i18n/en.json` and `ar.json`
6. **Add database tables** to `src/utility/database.js` (if needed)

### Example: Adding a New Settings Button

```js
// 1. Create src/functions/Settings/myFeature.js
function createMyFeatureButton(userId, lang) {
    return new ButtonBuilder()
        .setCustomId(`my_feature_${userId}`)
        .setLabel(lang.settings.mainPage.buttons.myFeature)
        .setStyle(ButtonStyle.Secondary);
}

async function handleMyFeatureButton(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    // ... your logic
}

// 2. Register in buttons_handler.js
{ pattern: /^my_feature_/, fn: myFeature.handleMyFeatureButton },

// 3. Add to settings.js createSettingsComponents()
// 4. Add lang keys to i18n setup (ex. en.json )
```

---

## Common Patterns

### Security Check Pattern

```js
async function handleSomething(interaction) {
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[2];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        
        if (!hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.SOME_PERMISSION)) {
            return interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }
        // ... your logic
    } catch (error) {
        await sendError(interaction, lang, error, 'handleSomething');
    }
}
```

### Components v2 Update Pattern

```js
const container = [
    new ContainerBuilder()
        .setAccentColor(0x3498db)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('...'))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addActionRowComponents(actionRow)
];

const content = updateComponentsV2AfterSeparator(interaction, container);
await interaction.update({ components: content, flags: MessageFlags.IsComponentsV2 });
```
- Containers are divided into two types: **main** and **sub**. 
  - The **main container** holds core modules such as `players.js`, while **sub containers** handle specific features like `addplayer.js`. Sub modules use `updateComponentsV2AfterSeparator` to append their section to the main container dynamically.

---

## Debugging & Hot Reload

### Hot Reload

The bot supports hot-reloading files without restarting:

```
> reload functions/Players/addPlayer.js
```

This clears the Node.js require cache and re-registers the module.

### Full Restart

```
> restart
```

Destroys the Discord client, clears all caches, and re-initializes everything.

### Logging

Errors are logged to:
1. **Console** - Full stack traces with formatting
2. **Database** - `system_logs` table with sanitized stack traces
3. **Discord** - Ephemeral error replies to users

---

## Known Issues & Gotchas

1. **Database wrapper vs raw statements**: The exported query objects from `database.js` use wrapper functions. Don't call `.run()` / `.get()` on them (except `settingsQueries` which exports raw statements).

2. **Handler order matters**: In the handler registries, more specific patterns must come before general ones. For example, `edit_alliance_prev_` must be before `edit_alliance_`.

3. **Process preemption**: When a higher-priority process starts, active processes are preempted. They must save progress and be resumable. Check `status !== 'active'` in processing loops.