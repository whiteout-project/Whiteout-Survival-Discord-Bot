// Keep the optional service stable across core hot reloads; cleanup only owns its registration.
const slot = Symbol.for('wosland.playerSyncIntegration');

function registerPlayerSyncIntegration(service) {
    if (!service || service.apiVersion !== 1 || typeof service.enrichPlayer !== 'function' ||
        typeof service.executeProcess !== 'function' || typeof service.canRunProcess !== 'function') {
        throw new TypeError('Unsupported Player Sync integration');
    }
    if (globalThis[slot]) throw new Error('Player Sync is already registered');
    globalThis[slot] = service;
    return () => { if (globalThis[slot] === service) delete globalThis[slot]; };
}

function getPlayerSyncIntegration() { return globalThis[slot] || null; }

function canRunPlayerSyncProcess(process) {
    if (process.action !== 'player_sync') return true;
    try { return !!getPlayerSyncIntegration()?.canRunProcess(process); } catch { return false; }
}

module.exports = { registerPlayerSyncIntegration, getPlayerSyncIntegration, canRunPlayerSyncProcess };
