# WOSLand Discord Bot

A powerful Discord bot for managing Whiteout Survival and Kingshot game data, alliances, players, gift codes, calculators, and automated notifications.

---

## Table of Contents

1. [Features](#features)
2. [Quick Start](#quick-start)
3. [Usage](#usage)
4. [Hosting Options](#hosting-options)
5. [About](#about)

---

## Features

- **Multi-Game Support** - Run the bot in `wos`, `ks`, or `both` mode
- **FID-Based Player Management** - Add, move, remove, export, and organize players by alliance-assigned state
- **Gift Code System** - Add and auto-redeem gift codes
- **Notification Scheduler** - Create scheduled notifications with embeds, patterns, and mentions
- **Admin System** - Multi-admin support with granular permissions
- **Web Panel** - Manage the bot from the browser with game-aware pages and calculators
- **Calculators** - Includes Buildings and War Academy calculators for supported games
- **Backup & Restore** - Google Drive integration for automated backups
- **Multi-Language** - i18n setup with custom emoji themes
- **Process Queue** - Priority-based task queue with preemption and crash recovery
- **Auto-Update** - Check for and apply updates directly from the bot settings panel

---

## Quick Start

### Prerequisites

- **Node.js**: Versions 18.x, 20.x, and 22.x are the only supported versions ([Install from here](https://nodejs.org/en/download))
- A **Discord Bot Token** ([Create one here](https://discord.com/developers/applications))

### One-Click Install

Only Node.js is required. Download or place `starter.js` in an empty folder and run it — the script will download the repository, install dependencies, and start the bot for you.

Steps:

```bash
# Ensure Node.js (v18+) is installed
# Place starter.js in an empty directory and run:
node starter.js

# Start in Kingshot mode
node starter.js --type=ks

# Start in both mode
node starter.js --type=both

# Optional: cap bot and installer heap size
node starter.js --ram=512

# You can combine both
node starter.js --type=both --ram=512
```

If you prefer manual installation or need to customize the setup, you can still clone the repository and install dependencies yourself:

```bash
# Clone the repository (optional)
git clone https://github.com/whiteout-project/Whiteout-Survival-Discord-Bot.git
cd Whiteout-Survival-JS-Discord-Bot

# Install dependencies
npm install

# Start the bot (defaults to WOS)
npm start

# Start specific runtime modes
node starter.js --type=wos
node starter.js --type=ks
node starter.js --type=both
```

On first run, the bot will prompt you to enter your Discord bot token. It will be saved to `src/.env` automatically.

---


### Privileged Gateway Intents

The bot requires two **privileged intents** that must be enabled manually in the [Discord Developer Portal](https://discord.com/developers/applications):

1. Go to your application → **Bot** → **Privileged Gateway Intents**
2. Enable **Server Members Intent**
3. Enable **Message Content Intent**
4. Click **Save Changes**

> Without these intents enabled, the bot will crash on startup with an error about disallowed intents.

### Bot Permissions

When inviting the bot to your server, ensure it has these permissions:
- Send Messages
- Embed Links
- Attach Files
- Read Message History
- Add Reactions
- Use External Emojis
- Manage Messages (for auto-clean features)

---

## Usage

### Runtime Modes

The bot supports three runtime modes:

| Mode | Description |
|------|-------------|
| `wos` | Whiteout Survival only |
| `ks` | Kingshot only |
| `both` | Whiteout Survival and Kingshot in the same bot |

Notes:
- If you do not pass `--type`, the bot defaults to `wos`
- In `both` mode, the bot and web panel will ask for game context where needed
- Game-aware pages and actions in the web panel follow the currently selected game context

Examples:

```bash
node starter.js --type=wos
node starter.js --type=ks
node starter.js --type=both
```

### Self-hosted web panel login

To serve the web panel on your own HTTPS domain, set these in the bot's `src/.env` and restart the bot:

```dotenv
PUBLIC_URL=https://panel.example.com
WEB_PANEL_CLIENT_SECRET=your_discord_application_client_secret
```

Set the Discord application's OAuth2 redirect URI to `https://panel.example.com/auth/callback`. Reverse proxy the domain to the web panel's local port (default `3010`), preserving the `Host` header and HTTPS forwarding. If you use `WEB_PANEL_BASE_PATH`, include that path in `PUBLIC_URL` and the redirect URI. Keep the client secret private. Run `/webpanel` to get your panel URL.

### Slash Commands

| Command | Description |
|---------|-------------|
| `/panel` | Open the main management panel |
| `/notification` | Open the notification management panel |

### Console Commands

The bot includes a CLI with hot-reload capabilities:

| Command | Description |
|---------|-------------|
| `reload <file>` | Hot reload a specific file (Tab to autocomplete) |
| `reload files` | Reload all files without bot restart |
| `restart` | Full bot restart (clears all cache) |
| `usage` | Show RAM/storage usage |
| `token [TOKEN]` | Update Discord bot token |
| `update` | Check for and apply updates from GitHub |
| `exit` | Shutdown the bot |

Runtime args available from the launcher:
- `--type=wos|ks|both`
- `--ram=<MB>`

---

## Hosting Options

**This is a self-hosted bot!** That means you will need to run the bot somewhere. You could do this on your own PC if you like, but it will stop running if you shut the PC down. Luckily there are some other hosting options available which you can find on [our Discord server](https://discord.gg/apYByj6K2m) under the `#host-setup` channel, many of which are free.

We have a list of known working VPS providers below that you could also check out. **Please note that the bot developers are not affiliated with any of these hosting providers (except ikketim) and we do not provider support if your hosting provider has issues.**

| Provider       | URL                                | Notes                                 |
|----------------|------------------------------------|---------------------------------------|
| ikketim        | https://ikketim.nl/                | Free tier, easy setup, recommended and supported by our community. Join https://ikketim.nl/discord for help getting started. |
| Bot-Hosting    | https://bot-hosting.net/           | Free tier. Requires earning coins though CAPTCHA / ads to maintain. |
| Lunes          | https://lunes.host/                | Free tier with barely enough capacity to run the latest version of the bot. Least recommended host out of the list here. |

---

## About
- This bot is built by [**Bahraini**](https://github.com/bahraini69) and will be maintained by WOSLand team

- For emotional and financial support, you can buy me a coffee here [Buy Me A Coffee](https://buymeacoffee.com/wosland) ❤️


