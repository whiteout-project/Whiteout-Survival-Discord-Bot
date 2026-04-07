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

function loadModules(dir, registerFn, label) {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
        try {
            registerFn(path.join(dir, file));
        } catch (error) {
            console.error(`Failed to load ${label} ${file}:`, error.message);
        }
    }
}

function getAllHandlerPaths() {
    return Array.from(loadedHandlers.keys());
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

function updateTokenInEnv(token) {
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
        fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
    } catch (error) {
        console.error('Failed to write token to .env:', error.message);
    }
}

function loadCoreModules() {
    loadModules(eventsDir, registerEvent, 'event');
    loadModules(handlersDir, registerHandler, 'handler');
    loadModules(commandsDir, registerCommand, 'command');
}

function loadPluginsAndManager() {
    const pluginsLoader = require('./functions/Plugin/pluginsLoader');
    const pluginInstallModule = require('./functions/Plugin/pluginInstall');
    const pluginDeleteModule = require('./functions/Plugin/pluginDelete');
    const pluginResults = pluginsLoader.loadPlugins({ registerCommand, registerEvent, registerHandler });
    if (pluginResults.failed.length > 0) {
        for (const fail of pluginResults.failed) {
            console.error(`[PLUGINS] ${fail.name}: ${fail.error}`);
        }
    }

    const pluginRegistrar = {
        registerCommand, unregisterCommand,
        registerEvent, unregisterEvent,
        registerHandler, unregisterHandler
    };
    global.pluginManager = {
        fetchRegistry: () => pluginInstallModule.fetchRegistry(),
        getInstalled: () => pluginsLoader.getInstalledPlugins(),
        getCount: () => pluginsLoader.getPluginCount(),
        install: (name) => pluginInstallModule.installPlugin(name, pluginRegistrar),
        remove: (name) => pluginDeleteModule.removePlugin(name, pluginRegistrar),
        checkUpdates: () => pluginInstallModule.checkPluginUpdates(),
        update: (name) => pluginInstallModule.updatePlugin(name, pluginRegistrar)
    };
}

function createQuestionPrompt() {
    if (typeof global.promptLine === 'function') {
        return (q) => Promise.resolve(global.promptLine(q));
    }
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const questionFn = (q) => new Promise((resolve) => rl.question(q, resolve));
    questionFn._close = () => rl.close();
    return questionFn;
}

async function promptAndLogin(question) {
    const isNonInteractive = global.isDocker || !process.stdin.isTTY;
    let token = process.env.TOKEN?.trim() || null;

    while (true) {
        if (!token) {
            if (isNonInteractive) {
                console.error('Discord token missing. Set the TOKEN environment variable in your .env file.');
                process.exit(1);
            }
            process.stdout.write('\nDiscord token missing -- paste your bot token below and press Enter:\n');
            token = await question('> ');
            token = token?.trim() || null;
            if (!token) continue;
            updateTokenInEnv(token);
            process.env.TOKEN = token;
            console.log('Token saved to .env file, bot started with new token.');
        }

        try {
            await client.login(token);
            if (typeof question._close === 'function') question._close();
            break;
        } catch (error) {
            const isInvalid = error && (error.code === 'TokenInvalid' || /TokenInvalid/i.test(String(error.message)));
            console.error('Failed to login:', isInvalid ? 'Invalid token.' : error.message);
            if (isInvalid) {
                if (isNonInteractive) {
                    console.error('Fix the TOKEN in your .env file and restart the container.');
                    process.exit(1);
                }
                process.stdout.write('\nThe provided token is invalid -- paste a valid bot token below and press Enter:\n');
                token = await question('> ');
                token = token?.trim() || null;
                if (!token) continue;
                updateTokenInEnv(token);
                process.env.TOKEN = token;
                continue;
            }

            if (typeof question._close === 'function') question._close();
            throw error;
        }
    }
}

async function ensureTokenAndLogin() {
    const question = createQuestionPrompt();
    loadCoreModules();
    loadPluginsAndManager();
    await promptAndLogin(question);
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