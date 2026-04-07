#!/bin/bash
set -e

# WOSLandJS Discord Bot - Docker Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/whiteout-project/Whiteout-Survival-Discord-Bot/main/install.sh | bash

REPO="whiteout-project/Whiteout-Survival-Discord-Bot"
INSTALL_DIR="$HOME/woslandjs"
COMPOSE_URL="https://raw.githubusercontent.com/${REPO}/main/docker-compose.yml"

echo ""
echo "========================================"
echo "  WOSLandJS Discord Bot - Installer"
echo "========================================"
echo ""

# ------------------------------------------------------------------
# 1. Check / install Docker
# ------------------------------------------------------------------
if ! command -v docker &> /dev/null; then
    echo "[1/5] Docker not found. Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    # Add current user to docker group (avoids needing sudo for docker commands)
    sudo usermod -aG docker "$USER"
    echo "  Docker installed successfully."
    echo "  NOTE: You may need to log out and back in for group changes to take effect."
else
    echo "[1/5] Docker is already installed."
fi

# Verify docker compose is available
if ! docker compose version &> /dev/null; then
    echo "ERROR: 'docker compose' command not available."
    echo "Please install Docker Compose v2: https://docs.docker.com/compose/install/"
    exit 1
fi

# ------------------------------------------------------------------
# 2. Create install directory
# ------------------------------------------------------------------
echo "[2/5] Setting up directory at ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}/data/database"
mkdir -p "${INSTALL_DIR}/data/plugins"

# ------------------------------------------------------------------
# 3. Download docker-compose.yml
# ------------------------------------------------------------------
echo "[3/5] Downloading configuration..."
curl -fsSL "${COMPOSE_URL}" -o "${INSTALL_DIR}/docker-compose.yml"

# ------------------------------------------------------------------
# 4. Prompt for Discord bot token
# ------------------------------------------------------------------
if [ -f "${INSTALL_DIR}/.env" ] && grep -q "^TOKEN=" "${INSTALL_DIR}/.env"; then
    echo "[4/5] Existing token found in .env file. Keeping it."
else
    echo ""
    echo "[4/5] Enter your Discord bot token:"
    read -r -p "  Token: " BOT_TOKEN

    if [ -z "$BOT_TOKEN" ]; then
        echo "ERROR: Token cannot be empty."
        exit 1
    fi

    echo "TOKEN=${BOT_TOKEN}" > "${INSTALL_DIR}/.env"
    chmod 600 "${INSTALL_DIR}/.env"
    echo "  Token saved."
fi

# ------------------------------------------------------------------
# 5. Pull images and start the bot
# ------------------------------------------------------------------
echo "[5/5] Pulling latest images and starting the bot..."
cd "${INSTALL_DIR}"
docker compose pull
docker compose up -d

# ------------------------------------------------------------------
# Done
# ------------------------------------------------------------------
echo ""
echo "========================================"
echo "  WOSLandJS is running!"
echo "========================================"
echo ""
echo "  Install directory: ${INSTALL_DIR}"
echo "  Auto-update: built-in (checks every 5 minutes)"
echo ""
echo "  Useful commands:"
echo "    cd ${INSTALL_DIR}"
echo "    docker compose logs -f        View live logs"
echo "    docker compose down            Stop the bot"
echo "    docker compose up -d           Start the bot"
echo ""
