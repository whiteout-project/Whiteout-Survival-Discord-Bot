@echo off
setlocal enabledelayedexpansion

REM WOSLandJS Discord Bot - Windows Docker Installer
REM Usage: Download and double-click, or run from Command Prompt

set "REPO=whiteout-project/Whiteout-Survival-Discord-Bot"
set "INSTALL_DIR=%USERPROFILE%\woslandjs"
set "COMPOSE_URL=https://raw.githubusercontent.com/%REPO%/main/docker-compose.yml"

echo.
echo ========================================
echo   WOSLandJS Discord Bot - Installer
echo ========================================
echo.

REM ------------------------------------------------------------------
REM 1. Check Docker
REM ------------------------------------------------------------------
docker --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [1/5] Docker is not installed.
    echo.
    echo   Please install Docker Desktop for Windows:
    echo   https://docs.docker.com/desktop/setup/install/windows-install/
    echo.
    echo   After installing Docker Desktop, restart your computer
    echo   and run this installer again.
    echo.
    pause
    exit /b 1
)
echo [1/5] Docker is installed.

REM Verify Docker is running
docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   Docker is installed but not running.
    echo   Please start Docker Desktop and run this installer again.
    echo.
    pause
    exit /b 1
)

REM Verify docker compose is available
docker compose version >nul 2>&1
if %errorlevel% neq 0 (
    echo   ERROR: "docker compose" command not available.
    echo   Please update Docker Desktop to the latest version.
    echo.
    pause
    exit /b 1
)

REM ------------------------------------------------------------------
REM 2. Create install directory
REM ------------------------------------------------------------------
echo [2/5] Setting up directory at %INSTALL_DIR%...
if not exist "%INSTALL_DIR%\data\database" mkdir "%INSTALL_DIR%\data\database"
if not exist "%INSTALL_DIR%\data\plugins" mkdir "%INSTALL_DIR%\data\plugins"

REM ------------------------------------------------------------------
REM 3. Download docker-compose.yml
REM ------------------------------------------------------------------
echo [3/5] Downloading configuration...
curl -fsSL "%COMPOSE_URL%" -o "%INSTALL_DIR%\docker-compose.yml"
if %errorlevel% neq 0 (
    echo   ERROR: Failed to download docker-compose.yml
    echo   Check your internet connection and try again.
    echo.
    pause
    exit /b 1
)

REM ------------------------------------------------------------------
REM 4. Prompt for Discord bot token
REM ------------------------------------------------------------------
if exist "%INSTALL_DIR%\.env" (
    findstr /B "TOKEN=" "%INSTALL_DIR%\.env" >nul 2>&1
    if !errorlevel! equ 0 (
        echo [4/5] Existing token found in .env file. Keeping it.
        goto :pull
    )
)

echo.
echo [4/5] Enter your Discord bot token:
set /p "BOT_TOKEN=  Token: "

if "%BOT_TOKEN%"=="" (
    echo   ERROR: Token cannot be empty.
    echo.
    pause
    exit /b 1
)

echo TOKEN=%BOT_TOKEN%> "%INSTALL_DIR%\.env"
echo   Token saved.

REM ------------------------------------------------------------------
REM 5. Pull images and start the bot
REM ------------------------------------------------------------------
:pull
echo [5/5] Pulling latest images and starting the bot...
cd /d "%INSTALL_DIR%"
docker compose pull
if %errorlevel% neq 0 (
    echo   ERROR: Failed to pull Docker image.
    echo   Check your internet connection and try again.
    echo.
    pause
    exit /b 1
)

docker compose up -d
if %errorlevel% neq 0 (
    echo   ERROR: Failed to start the bot container.
    echo.
    pause
    exit /b 1
)

REM ------------------------------------------------------------------
REM Done
REM ------------------------------------------------------------------
echo.
echo ========================================
echo   WOSLandJS is running!
echo ========================================
echo.
echo   Install directory: %INSTALL_DIR%
echo   Auto-update: built-in (checks every 5 minutes)
echo.
echo   Useful commands:
echo     cd %INSTALL_DIR%
echo     docker compose logs -f        View live logs
echo     docker compose down            Stop the bot
echo     docker compose up -d           Start the bot
echo.
pause
