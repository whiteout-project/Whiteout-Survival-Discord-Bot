# Plugin Development Guide

This guide covers everything you need to create, structure, and distribute plugins for the Whiteout Survival Discord Bot.

---

## Table of Contents

1. [Overview](#overview)
2. [Plugin Structure](#plugin-structure)
3. [Manifest (`plugin.json`)](#manifest-pluginjson)
4. [Commands](#commands)
5. [Handlers](#handlers)
6. [Events](#events)
7. [Localization](#localization)
8. [Using Bot Utilities](#using-bot-utilities)
9. [Access Control](#access-control)
10. [Lifecycle](#lifecycle)
11. [Installation & Distribution](#installation--distribution)
12. [Best Practices](#best-practices)
13. [Complete Example](#complete-example)

---

## Overview

The plugin system lets you extend the bot with new slash commands, button/menu handlers, and event listeners — all loaded dynamically from the `plugins/` directory at the project root.

**Key facts:**
- Plugins are loaded on bot startup and can be installed/removed at runtime via the admin panel
- Each plugin lives in its own directory under `plugins/`
- A `plugin.json` manifest is **required**
- Plugins can register **commands**, **handlers**, and **events**
- Plugins are unloaded cleanly — handlers return cleanup functions, commands/events are deregistered

---

## Plugin Structure

```
plugins/
└── my-plugin/
    ├── plugin.json          # Required — manifest
    ├── package.json         # Optional — if you need npm dependencies
    ├── commands/            # Optional — slash commands
    │   └── mycommand.js
    ├── handlers/            # Optional — button/interaction handlers
    │   └── myhandler.js
    ├── events/              # Optional — Discord event listeners
    │   └── myevent.js
    └── locales/             # Optional — i18n translations
        ├── en.json
        └── fr.json
```

All directories (`commands/`, `handlers/`, `events/`, `locales/`) are optional. Include only what your plugin needs. Every `.js` file inside each directory is auto-loaded.

---

## Manifest (`plugin.json`)

Every plugin **must** have a `plugin.json` in its root directory.

```json
{
    "name": "my-plugin",
    "version": "1.0.0",
    "description": "A brief description of what this plugin does.",
    "author": "YourName"
}
```

### Required Fields

| Field     | Type   | Rules                                           |
|-----------|--------|------------------------------------------------|
| `name`    | string | Must match `[a-zA-Z0-9_-]+` (no spaces/special chars) |
| `version` | string | Semver format recommended (e.g., `1.0.0`)       |

### Optional Fields

| Field         | Type   | Description                              |
|---------------|--------|------------------------------------------|
| `description` | string | Shown in the plugin management UI        |
| `author`      | string | Plugin author name (defaults to "Unknown") |

### Validation Rules

- `name` and `version` are **required** — missing either will prevent loading
- `name` must only contain letters, numbers, underscores, and hyphens
- Duplicate plugin names are rejected (first loaded wins)

---

## Commands

Place slash command files in `plugins/my-plugin/commands/`. Each file must export an object with `data` (a `SlashCommandBuilder`) and an `execute` function.

### Template

```javascript
const { SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mycommand')
        .setDescription('Description of my command')
        .addStringOption(opt =>
            opt.setName('input')
                .setDescription('Some input')
                .setRequired(false)
        ),

    async execute(interaction) {
        const input = interaction.options.getString('input') || 'default';

        // Using Components V2 (preferred for this bot)
        const container = new ContainerBuilder()
            .setAccentColor(0x3498db)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`You said: **${input}**`)
            );

        await interaction.reply({
            components: [container],
            flags: MessageFlags.IsComponentsV2
        });
    }
};
```

### Key Points

- Commands are registered globally with Discord on bot startup via the `ready` event
- Command names must be unique across all plugins and the core bot
- Use `MessageFlags.IsComponentsV2` with `ContainerBuilder` for UI consistency
- The `execute` function receives a `ChatInputCommandInteraction`

---

## Handlers

Place handler files in `plugins/my-plugin/handlers/`. Each file must export a **function** that receives the Discord `client` and returns a **cleanup function**.

Handlers are used for button clicks, select menus, and other component interactions.

### Template

```javascript
const { MessageFlags, ContainerBuilder, TextDisplayBuilder } = require('discord.js');

/**
 * @param {import('discord.js').Client} client
 * @returns {Function} Cleanup function called on plugin unload
 */
module.exports = function (client) {
    async function listener(interaction) {
        // Filter to only the interactions you care about
        if (!interaction.isButton()) return;
        if (!interaction.customId.startsWith('myplugin_')) return;

        // Parse customId: myplugin_action_userId
        const parts = interaction.customId.split('_');
        const action = parts[1];
        const expectedUserId = parts[2];

        // Authorization check
        if (interaction.user.id !== expectedUserId) {
            return await interaction.reply({
                content: 'This button is not for you!',
                ephemeral: true
            });
        }

        // Handle the interaction
        const container = new ContainerBuilder()
            .setAccentColor(0x2ecc71)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`Action: **${action}**`)
            );

        await interaction.update({
            components: [container],
            flags: MessageFlags.IsComponentsV2
        });
    }

    // Register listener
    client.on('interactionCreate', listener);

    // Return cleanup function — IMPORTANT for clean unload
    return () => client.off('interactionCreate', listener);
};
```

### Key Points

- **Must export a function**, not an object
- The function receives the `client` instance
- **Must return a cleanup function** that removes the listener — this is called when the plugin is unloaded
- Filter early — check `interaction.isButton()` / `interaction.isStringSelectMenu()` and your customId prefix before doing any work
- Use a unique prefix for your customId values (e.g., `myplugin_`) to avoid conflicts with core handlers or other plugins

### CustomId Convention

Use your plugin name as a prefix to avoid collisions:

```
{pluginName}_{action}_{...params}_{userId}

Examples:
dice_reroll_3_6_123456789        # dice plugin, reroll, 3 dice, 6 sides, userId
myquiz_answer_q5_b_123456789    # quiz plugin, answer, question 5, option b, userId
```

---

## Events

Place event files in `plugins/my-plugin/events/`. Each file must export an object with `name`, optional `once`, and `execute`.

### Template

```javascript
const { Events } = require('discord.js');

module.exports = {
    name: Events.MessageCreate,
    once: false,  // false = on(), true = once()
    async execute(message) {
        // Ignore bots
        if (message.author.bot) return;

        // Your event logic here
        if (message.content.toLowerCase() === '!ping') {
            await message.reply('Pong! 🏓');
        }
    }
};
```

### Available Event Properties

| Property  | Type     | Required | Description                           |
|-----------|----------|----------|---------------------------------------|
| `name`    | string   | Yes      | Discord.js event name (e.g., `Events.MessageCreate`) |
| `once`    | boolean  | No       | If `true`, listener fires only once   |
| `execute` | function | Yes      | Event handler function                |

---

## Localization

Plugins can provide their own translated strings by including a `locales/` directory. Locale files are automatically merged into the bot's in-memory language objects on plugin load, and removed on unload.

### Directory Structure

```
plugins/my-plugin/
├── plugin.json
├── locales/
│   ├── en.json          # English strings (required as baseline)
│   └── fr.json          # French strings (optional)
├── commands/
└── handlers/
```

### Locale File Format

Each file must follow this exact structure — only the `plugins.<pluginName>` subtree is merged:

```json
{
    "plugins": {
        "my-plugin": {
            "title": "My Plugin Title",
            "description": "What this plugin does",
            "buttons": {
                "action": "Do Something",
                "back": "Go Back"
            },
            "messages": {
                "success": "Operation completed!",
                "error": "Something went wrong."
            }
        }
    }
}
```

### Rules

- The file name must match a language code the bot supports (e.g., `en.json`, `fr.json`)
- The plugin name key inside `plugins` must match your `plugin.json` `name` field exactly
- Only the content under `plugins.<yourPluginName>` is merged — other keys are ignored for safety
- If a language file doesn't exist for a locale, those strings won't be available (English fallback still works via the bot's proxy system)
- Strings are merged on load and removed on unload — no permanent changes to language files

### Using Locale Strings in Your Plugin

```javascript
const languages = require('../../../src/i18n');

// In a command or handler:
async execute(interaction) {
    // Get user's language preference
    const { getUserInfo } = require('../../../src/functions/utility/commonFunctions');
    const { lang } = getUserInfo(interaction.user.id);

    // Access your plugin's strings
    const pluginLang = lang.plugins?.['my-plugin'];

    // Use with fallback for safety
    const title = pluginLang?.title || 'My Plugin';
    const successMsg = pluginLang?.messages?.success || 'Done!';
}
```

### Example

**`plugins/my-plugin/locales/en.json`:**
```json
{
    "plugins": {
        "my-plugin": {
            "rollResult": "Dice Roll",
            "total": "Total",
            "rollAgain": "Roll Again"
        }
    }
}
```

**`plugins/my-plugin/locales/fr.json`:**
```json
{
    "plugins": {
        "my-plugin": {
            "rollResult": "Lancer de dés",
            "total": "Total",
            "rollAgain": "Relancer"
        }
    }
}
```

The bot automatically merges these into `lang.plugins['my-plugin']` at load time.

---

## Using Bot Utilities

Plugins can `require()` any of the bot's internal modules — you have full access to the same functions core features use. Here are the most commonly used:

### Database

```javascript
const { adminQueries, userQueries, settingsQueries } = require('../../src/functions/utility/database');

// Get user data
const user = userQueries.getUser(userId);

// Check if user is admin
const admin = adminQueries.getAdmin(userId);
```

> **CRITICAL:** Database exports are wrapper **functions**, NOT prepared statements. Call them directly: `userQueries.getUser(userId)` — never `userQueries.getUser.get(userId)`.

### Common Functions

```javascript
const { getUserInfo, handleError, assertUserMatches, hasPermission } = require('../../src/functions/utility/commonFunctions');

// Get admin data + language for a user
const { adminData, lang } = getUserInfo(interaction.user.id);

// Verify button belongs to the clicking user
if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

// Handle errors consistently
try {
    // ...
} catch (error) {
    await handleError(interaction, lang, error, 'myFunctionName');
}
```

### Emoji System

```javascript
const { getEmojiMapForUser, getComponentEmoji } = require('../../src/functions/utility/emojis');

const emojiMap = getEmojiMapForUser(userId);
const emoji = getComponentEmoji(emojiMap, '1035');  // gear emoji

// Use in buttons
new ButtonBuilder()
    .setEmoji(emoji)
```

### Access Control

```javascript
const { checkFeatureAccess } = require('../../src/functions/utility/checkAccess');

// Check if a feature is accessible for this user/channel
if (!checkFeatureAccess('myFeatureKey', interaction)) {
    return interaction.reply({ content: lang.common.noPermission, ephemeral: true });
}
```

### Internationalization

```javascript
const languages = require('../../src/i18n');
const lang = languages[userLang] || languages.en;

// Use strings
const text = lang.common.noPermission;
```

### Relative Paths

Since plugins live in `plugins/my-plugin/`, paths to bot internals use `../../src/`:

```javascript
// From plugins/my-plugin/commands/mycommand.js:
require('../../../src/functions/utility/database');

// From plugins/my-plugin/handlers/myhandler.js:
require('../../../src/functions/utility/commonFunctions');
```

> **Tip:** Store the base path if you need multiple requires:
> ```javascript
> const botRoot = require('path').join(__dirname, '..', '..', '..');
> const database = require(path.join(botRoot, 'src', 'functions', 'utility', 'database'));
> ```

---

## Access Control

Plugin features integrate with the bot's existing feature access system.

### Checking Access in Your Plugin

Use `checkFeatureAccess()` with a unique feature key:

```javascript
const { checkFeatureAccess } = require('../../../src/functions/utility/checkAccess');

// In your command's execute():
async execute(interaction) {
    if (!checkFeatureAccess('myPluginFeature', interaction)) {
        return interaction.reply({ content: 'No permission.', ephemeral: true });
    }
    // ... rest of command
}
```

### Access Levels

The system supports these access levels (defined in `FEATURE_ACCESS`):

| Level         | Bit | Behavior                                    |
|---------------|-----|---------------------------------------------|
| `EVERYONE`    | 1   | All users can use the feature               |
| `ADMINS_ONLY` | 2   | Only users in the `admins` table can use it |
| `BY_CHANNEL`  | 4   | Only in whitelisted channels                |
| `NO_ONE`      | 8   | Feature is disabled for everyone            |

The bot owner always has access regardless of settings.

---

## Lifecycle

### Loading (Bot Startup)

1. Bot starts → `loadPlugins()` scans `plugins/` directory
2. Each subdirectory with a valid `plugin.json` is processed
3. Files in `commands/`, `events/`, `handlers/` are registered
4. Plugin data is stored in the in-memory `loadedPlugins` map

### Runtime Install (Admin Panel)

1. Admin clicks Install in Plugins menu
2. Plugin ZIP is downloaded from the registry
3. Extracted to `plugins/{name}/`
4. `npm install` runs if `package.json` exists
5. Commands, events, and handlers are registered live
6. Slash commands are re-registered with Discord

### Unload / Remove

1. Commands are deregistered from the client
2. Events are removed from their listeners
3. Handler cleanup functions are called (removes `interactionCreate` listeners)
4. `require.cache` entries are cleared
5. Plugin files are deleted (on remove)

### Hot Reload

Using the CLI `reload files` command reloads all modules including plugins. A full `restart` clears everything and re-loads from scratch.

---

## Installation & Distribution

### Local Development

Drop your plugin folder directly into `plugins/`:

```
plugins/
└── my-plugin/
    ├── plugin.json
    └── commands/
        └── mycommand.js
```

Restart the bot or use `reload files` to load it.

### Official Registry

To distribute via the bot's 1-click install system:

1. Package your plugin as a ZIP file
2. Submit to the [wosJS-plugins](https://github.com/whiteout-project/wosJS-plugins) repository
3. Add an entry to `registry.json`:

```json
{
    "plugins": [
        {
            "name": "my-plugin",
            "version": "1.0.0",
            "description": "What it does",
            "author": "YourName",
            "downloadUrl": "https://github.com/whiteout-project/wosJS-plugins/raw/main/plugins/my-plugin.zip"
        }
    ]
}
```

### Dependencies

If your plugin needs npm packages, include a `package.json`:

```json
{
    "name": "my-plugin",
    "private": true,
    "dependencies": {
        "some-package": "^1.0.0"
    }
}
```

Dependencies are auto-installed during the install process (`npm install --omit=optional --production`).

---

## Best Practices

### DO

- **Return cleanup functions** from handlers — prevents memory leaks on unload
- **Prefix customIds** with your plugin name to avoid collisions
- **Use Components V2** (`ContainerBuilder`, `TextDisplayBuilder`, etc.) for UI consistency
- **Check user authorization** on every button/menu interaction
- **Use `handleError()`** for consistent error reporting
- **Use `assertUserMatches()`** to verify button ownership
- **Keep memory usage low** — the bot runs with a 256MB heap limit
- **Use the bot's existing utilities** (database, i18n, emojis) instead of reinventing them

### DON'T

- **Don't call `.get()` / `.run()` / `.all()`** on database query exports — they're already wrapper functions
- **Don't use generic customId prefixes** like `button_` or `select_` — they'll collide with core handlers
- **Don't create large in-memory caches** — respect the 256MB limit
- **Don't bypass the process queue** for long-running operations — use `createProcess()`
- **Don't hardcode strings** — use the i18n system when possible
- **Don't modify core bot files** — plugins should be self-contained

---

## Complete Example

Here's a minimal but complete plugin that adds a `/coinflip` command with a "Flip Again" button.

### `plugins/coinflip/plugin.json`

```json
{
    "name": "coinflip",
    "version": "1.0.0",
    "description": "Flip a coin! Heads or tails.",
    "author": "Developer"
}
```

### `plugins/coinflip/commands/coinflip.js`

```javascript
const {
    SlashCommandBuilder, MessageFlags, ContainerBuilder,
    TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
    ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('coinflip')
        .setDescription('Flip a coin!'),

    async execute(interaction) {
        const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
        const emoji = result === 'Heads' ? '👑' : '🪙';

        const container = new ContainerBuilder()
            .setAccentColor(result === 'Heads' ? 0xffd700 : 0xc0c0c0)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`${emoji} **Coin Flip**`)
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`Result: **${result}**`)
            )
            .addActionRowComponents(
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`coinflip_again_${interaction.user.id}`)
                        .setLabel('Flip Again')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('🪙')
                )
            );

        await interaction.reply({
            components: [container],
            flags: MessageFlags.IsComponentsV2
        });
    }
};
```

### `plugins/coinflip/handlers/coinflipButtons.js`

```javascript
const {
    ContainerBuilder, TextDisplayBuilder, SeparatorBuilder,
    SeparatorSpacingSize, ActionRowBuilder, ButtonBuilder,
    ButtonStyle, MessageFlags
} = require('discord.js');

module.exports = function (client) {
    async function listener(interaction) {
        if (!interaction.isButton()) return;
        if (!interaction.customId.startsWith('coinflip_again_')) return;

        const expectedUserId = interaction.customId.split('_')[2];
        if (interaction.user.id !== expectedUserId) {
            return await interaction.reply({
                content: 'This button is not for you!',
                ephemeral: true
            });
        }

        const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
        const emoji = result === 'Heads' ? '👑' : '🪙';

        const container = new ContainerBuilder()
            .setAccentColor(result === 'Heads' ? 0xffd700 : 0xc0c0c0)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`${emoji} **Coin Flip**`)
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`Result: **${result}**`)
            )
            .addActionRowComponents(
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`coinflip_again_${interaction.user.id}`)
                        .setLabel('Flip Again')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('🪙')
                )
            );

        await interaction.update({
            components: [container],
            flags: MessageFlags.IsComponentsV2
        });
    }

    client.on('interactionCreate', listener);
    return () => client.off('interactionCreate', listener);
};
```

### Install & Test

1. Place the `coinflip/` folder in `plugins/`
2. Restart the bot (or `reload files` + `restart` for slash command registration)
3. Use `/coinflip` in Discord
4. Click "Flip Again" to re-flip
