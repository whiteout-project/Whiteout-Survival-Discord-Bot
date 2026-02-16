process.removeAllListeners('warning');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Create a new client instance
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// Create collections for commands
client.commands = new Collection();

const baseDir = __dirname;
const eventsDir = path.join(baseDir, 'events');
const handlersDir = path.join(baseDir, 'handlers');
const commandsDir = path.join(baseDir, 'commands');

const loadedEvents = new Map();
const loadedHandlers = new Map();
const loadedCommands = new Map();

function registerEvent(filePath) {
    const event = require(filePath);
    if (!event || !event.name || typeof event.execute !== 'function') {
        throw new Error(`Event at ${filePath} is missing required "name" or "execute" property.`);
    }

    const listener = (...args) => event.execute(...args);
    if (event.once) {
        client.once(event.name, listener);
    } else {
        client.on(event.name, listener);
    }

    loadedEvents.set(filePath, {
        name: event.name,
        listener,
        once: Boolean(event.once)
    });
}

function unregisterEvent(filePath) {
    const entry = loadedEvents.get(filePath);
    if (!entry) return;

    client.off(entry.name, entry.listener);
    loadedEvents.delete(filePath);
}

function registerHandler(filePath) {
    const handler = require(filePath);
    if (typeof handler !== 'function') {
        throw new Error(`Handler at ${filePath} must export a function.`);
    }

    const cleanup = handler(client);
    loadedHandlers.set(filePath, {
        cleanup: typeof cleanup === 'function' ? cleanup : null
    });
}

function unregisterHandler(filePath) {
    const entry = loadedHandlers.get(filePath);
    if (!entry) return;

    if (typeof entry.cleanup === 'function') {
        try {
            entry.cleanup();
        } catch (error) {
            console.error(`Error during cleanup of handler at ${filePath}:`, error);
        }
    }

    loadedHandlers.delete(filePath);
}

function registerCommand(filePath) {
    const command = require(filePath);
    if (!('data' in command) || typeof command.execute !== 'function') {
        throw new Error(`Command at ${filePath} is missing required "data" or "execute" property.`);
    }

    const commandName = command.data.name;
    client.commands.set(commandName, command);
    loadedCommands.set(filePath, { name: commandName });
}

function unregisterCommand(filePath) {
    const entry = loadedCommands.get(filePath);
    if (!entry) return;

    client.commands.delete(entry.name);
    loadedCommands.delete(filePath);
}

function loadEvents() {
    if (!fs.existsSync(eventsDir)) return;

    const eventFiles = fs.readdirSync(eventsDir).filter((file) => file.endsWith('.js'));
    for (const file of eventFiles) {
        const filePath = path.join(eventsDir, file);
        try {
            registerEvent(filePath);
        } catch (error) {
            console.error(`Failed to load event ${file}:`, error.message);
        }
    }
}

function loadHandlers() {
    if (!fs.existsSync(handlersDir)) return;

    const handlerFiles = fs.readdirSync(handlersDir).filter((file) => file.endsWith('.js'));
    for (const file of handlerFiles) {
        const filePath = path.join(handlersDir, file);
        try {
            registerHandler(filePath);
        } catch (error) {
            console.error(`Failed to load handler ${file}:`, error.message);
        }
    }
}

function loadCommands() {
    if (!fs.existsSync(commandsDir)) return;

    const commandFiles = fs.readdirSync(commandsDir).filter((file) => file.endsWith('.js'));
    for (const file of commandFiles) {
        const filePath = path.join(commandsDir, file);
        try {
            registerCommand(filePath);
        } catch (error) {
            console.error(`Failed to load command ${file}:`, error.message);
        }
    }
}

function getAllHandlerPaths() {
    if (!fs.existsSync(handlersDir)) return [];

    return fs.readdirSync(handlersDir)
        .filter((file) => file.endsWith('.js'))
        .map((file) => path.join(handlersDir, file));
}

/**
 * Get all event paths
 */
function getAllEventPaths() {
    return Array.from(loadedEvents.keys());
}

/**
 * Get all command paths
 */
function getAllCommandPaths() {
    return Array.from(loadedCommands.keys());
}

// Helper: write/update TOKEN in src/.env
const os = require('os');
async function updateTokenInEnv(token) {
    try {
        const envPath = path.join(__dirname, '.env');
        let content = '';
        if (fs.existsSync(envPath)) content = fs.readFileSync(envPath, 'utf8');
        const lines = content.split(/\r?\n/);
        let found = false;
        for (let i = 0; i < lines.length; i++) {
            if (/^\s*TOKEN\s*=/.test(lines[i])) {
                lines[i] = `TOKEN=${token}`;
                found = true;
                break;
            }
        }
        if (!found) lines.unshift(`TOKEN=${token}`);
        fs.writeFileSync(envPath, lines.join(os.EOL), 'utf8');
    } catch (e) {
        console.error('Failed to write token to .env:', e.message);
    }
}

// Prompt for token and attempt login (handles missing/invalid token)
async function ensureTokenAndLogin() {
    // Prefer a shared prompt if starter.js exposed one to avoid multiple readline instances
    const hasSharedPrompt = typeof global.promptLine === 'function';
    const question = hasSharedPrompt
        ? (q) => Promise.resolve(global.promptLine(q))
        : (() => {
            const readline = require('readline');
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const qfn = (q) => new Promise((res) => rl.question(q, res));
            // when using a private rl, ensure we close it when finished
            qfn._close = () => rl.close();
            return qfn;
        })();

    loadEvents();
    loadHandlers();
    loadCommands();

    let token = process.env.TOKEN && process.env.TOKEN.trim() ? process.env.TOKEN.trim() : null;

    while (true) {
        if (!token) {
            token = await question('Discord token missing — paste your bot token (input hidden not supported): ');
            token = token && token.trim() ? token.trim() : null;
            if (!token) continue;
            await updateTokenInEnv(token);
            process.env.TOKEN = token;
            console.log('Token saved to .env file, bot started with new token.');
        }

        try {
            await client.login(token);
            // close private readline if we created one
            if (question && typeof question._close === 'function') question._close();
            break;
        } catch (error) {
            // Handle invalid token specifically by prompting user to re-enter
            const isInvalid = error && (error.code === 'TokenInvalid' || /TokenInvalid/i.test(String(error.message)));
            console.error('Failed to login:', isInvalid ? 'Invalid token.' : error.message);
            if (isInvalid) {
                // Ask user for a new token and persist it
                token = await question('The provided token is invalid — please paste a valid token: ');
                token = token && token.trim() ? token.trim() : null;
                if (!token) continue;
                await updateTokenInEnv(token);
                process.env.TOKEN = token;
                continue;
            }

            // Other errors: rethrow to allow caller to handle
            if (question && typeof question._close === 'function') question._close();
            throw error;
        }
    }
}

// Initialize the bot
async function init() {
    try {
        await ensureTokenAndLogin();
    } catch (error) {
        console.error('Failed to initialize bot:', error);
        process.exit(1);
    }
}

// Start the bot
init();

// Export internals for hot reload management
module.exports = {
    client,
    // Expose internal maps and functions for external reload system
    loadedEvents,
    loadedHandlers,
    loadedCommands,
    registerEvent,
    unregisterEvent,
    registerHandler,
    unregisterHandler,
    registerCommand,
    unregisterCommand,
    getAllHandlerPaths,
    getAllEventPaths,
    getAllCommandPaths,
    baseDir,
    eventsDir,
    handlersDir,
    commandsDir
};