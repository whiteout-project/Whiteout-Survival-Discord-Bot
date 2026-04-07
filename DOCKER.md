# Docker Deployment Guide

Run the bot in Docker with automatic updates and zero maintenance.

---

## Quick Start

### Linux / macOS

Run this single command on any Linux server with `curl` installed:

```bash
curl -fsSL https://raw.githubusercontent.com/whiteout-project/Whiteout-Survival-Discord-Bot/main/install.sh | bash
```

### Windows

1. Install [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/) if you don't have it
2. Download [`install.bat`](https://raw.githubusercontent.com/whiteout-project/Whiteout-Survival-Discord-Bot/main/install.bat) and double-click it

Both installers will:
1. Verify Docker is installed and running
2. Create the install directory (`~/woslandjs` on Linux, `%USERPROFILE%\woslandjs` on Windows)
3. Download the Docker Compose configuration
4. Prompt for your Discord bot token
5. Pull the image and start the bot

That's it. The bot is running and will auto-update itself.

---

## Manual Setup

### Linux / macOS

```bash
# Create a directory
mkdir -p ~/woslandjs/data/database ~/woslandjs/data/plugins
cd ~/woslandjs

# Download the compose file
curl -fsSL https://raw.githubusercontent.com/whiteout-project/Whiteout-Survival-Discord-Bot/main/docker-compose.yml -o docker-compose.yml

# Create your .env file with your Discord bot token
echo "TOKEN=your_discord_bot_token_here" > .env
chmod 600 .env

# Start the bot
docker compose pull
docker compose up -d
```

### Windows (Command Prompt)

```cmd
REM Create a directory
mkdir %USERPROFILE%\woslandjs\data\database
mkdir %USERPROFILE%\woslandjs\data\plugins
cd /d %USERPROFILE%\woslandjs

REM Download the compose file
curl -fsSL https://raw.githubusercontent.com/whiteout-project/Whiteout-Survival-Discord-Bot/main/docker-compose.yml -o docker-compose.yml

REM Create your .env file with your Discord bot token
echo TOKEN=your_discord_bot_token_here> .env

REM Start the bot
docker compose pull
docker compose up -d
```

---

## Useful Commands

```bash
cd ~/woslandjs

# View live logs
docker compose logs -f

# Stop the bot
docker compose down

# Start the bot
docker compose up -d

# Restart the bot
docker compose restart

# Check bot status
docker compose ps

# Pull latest image manually
docker compose pull
docker compose up -d
```

---

## How Auto-Update Works

The bot checks for updates every 5 minutes. When a new version is available:

1. The bot owner receives a DM notification
2. If auto-update is enabled (default), the bot pulls the new Docker image, stops the current container, and recreates it with the updated image
3. If auto-update is disabled, the owner is notified and can apply the update manually from the settings panel

This requires the Docker socket to be mounted (included in the default `docker-compose.yml`). Without the socket, updates fall back to the ZIP download method used by non-Docker installations.

---

## Configuration

### Environment Variables

Set these in your `.env` file:

| Variable | Required | Description |
|----------|----------|-------------|
| `TOKEN` | Yes | Your Discord bot token |

The following are set automatically by the compose file and should not be changed:

| Variable | Purpose |
|----------|---------|
| `BOT_CONTAINER` | Container name for self-update API calls |
| `BOT_IMAGE` | Image name for pulling updates |
| `DOCKER_CONTAINER` | Signals to the bot that it's running in Docker |

### Volumes

| Host Path | Container Path | Purpose |
|-----------|---------------|---------|
| `./data/database` | `/app/src/database` | SQLite database files (persistent) |
| `./data/plugins` | `/app/plugins` | Installed plugins (persistent) |
| `/var/run/docker.sock` | `/var/run/docker.sock` | Docker socket for self-updates |

Your database and plugins survive container restarts, updates, and image rebuilds.

### Docker Socket

The Docker socket mount (`/var/run/docker.sock`) allows the bot to update itself by pulling new images and recreating its own container. This is standard practice for self-updating Docker applications.

If you're running on a managed hosting platform (Pterodactyl, PebbleHost, etc.) that doesn't expose the Docker socket, the bot will fall back to ZIP-based updates automatically.

---

## Backups

The bot's data lives in `~/woslandjs/data/database/`. To back up:

```bash
# Simple file copy
cp -r ~/woslandjs/data/database ~/woslandjs-backup-$(date +%Y%m%d)
```

The bot also has a built-in Google Drive backup feature accessible from the settings panel.

---

## Uninstall

### Linux / macOS

```bash
cd ~/woslandjs
docker compose down --rmi all    # Stop and remove the image
cd ~
rm -rf ~/woslandjs               # Remove all files (including database)
```

### Windows

```cmd
cd /d %USERPROFILE%\woslandjs
docker compose down --rmi all
cd /d %USERPROFILE%
rmdir /s /q woslandjs
```

To keep your data, copy the `data/` folder somewhere safe before removing the directory.

---

## Troubleshooting

### Bot won't start
```bash
# Check logs for errors
docker compose logs --tail 50

# Verify your token is set
cat ~/woslandjs/.env
```

### Token is invalid
```bash
# Update your token
echo "TOKEN=your_new_token_here" > ~/woslandjs/.env
docker compose restart
```

### Updates aren't working
```bash
# Check if Docker socket is mounted
docker inspect woslandjs | grep docker.sock

# Manual update
cd ~/woslandjs
docker compose pull
docker compose up -d
```

### Container keeps restarting
```bash
# Check for crash loops
docker compose logs --tail 100

# Common cause: invalid token or missing .env file
```

---

## Building From Source

If you want to build the image yourself instead of using the pre-built one:

```bash
git clone https://github.com/whiteout-project/Whiteout-Survival-Discord-Bot.git
cd Whiteout-Survival-Discord-Bot
docker build -t woslandjs .

# Update docker-compose.yml to use your local image:
# image: woslandjs (instead of ghcr.io/...)
```
