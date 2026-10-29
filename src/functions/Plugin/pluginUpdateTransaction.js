const fs = require('fs');
const path = require('path');
const { isGitMetadataPath } = require('./pluginGitMetadata');

function isProtectedPluginPath(relativePath, isDirectory, preserveConfig) {
    const name = relativePath.replace(/\\/g, '/');
    if (['plugin.json', 'package.json', 'package-lock.json'].includes(name)) return false;
    if (
        isGitMetadataPath(name) ||
        name.split('/').some(part => part === 'node_modules' || /^\.env(?:\.|$)/i.test(part))
    )
        return true;
    if (!isDirectory && /\.(?:db|sqlite)(?:-(?:wal|shm))?$/i.test(name)) return true;
    for (const dir of preserveConfig.dirs) if (name === dir || name.startsWith(`${dir}/`)) return true;
    return (
        !isDirectory &&
        (preserveConfig.files.has(name) || preserveConfig.extensions.has(path.extname(name).toLowerCase()))
    );
}

function transactionPath(pluginsDir, name) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('Invalid plugin update name.');
    const updates = path.resolve(pluginsDir, '.updates');
    if (fs.existsSync(updates) && fs.lstatSync(updates).isSymbolicLink())
        throw new Error('Plugin update directory must not be a link.');
    const result = path.join(updates, name);
    if (fs.existsSync(result) && fs.lstatSync(result).isSymbolicLink())
        throw new Error('Plugin transaction must not be a link.');
    return result;
}

function writeRecord(dir, record) {
    const file = path.join(dir, 'transaction.json');
    for (const target of [file, `${file}.tmp`]) {
        if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Plugin recovery record must not be a link.');
    }
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(record));
    fs.renameSync(`${file}.tmp`, file);
}

function readRecord(dir, name) {
    if (fs.lstatSync(path.join(dir, 'transaction.json')).isSymbolicLink()) throw new Error('Plugin recovery record must not be a link.');
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'transaction.json'), 'utf8'));
    if (
        record.name !== name ||
        !['incomplete', 'prepared', 'applying', 'committed', 'restored'].includes(record.phase) ||
        typeof record.dependencies !== 'boolean' || typeof record.hadNodeModules !== 'boolean' ||
        !record.preserve ||
        ['dirs', 'files', 'extensions'].some(
            key => !Array.isArray(record.preserve[key]) || record.preserve[key].some(value => typeof value !== 'string')
        )
    ) {
        throw new Error('Invalid plugin recovery record.');
    }
    return record;
}

function configFromRecord(record) {
    return Object.fromEntries(Object.entries(record.preserve).map(([key, values]) => [key, new Set(values)]));
}

function hasIncompleteOfficialInstall(pluginsDir, name) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return false;
    const pluginDir = path.join(pluginsDir, name);
    try {
        const dir = fs.lstatSync(pluginDir);
        if (!dir.isDirectory() || dir.isSymbolicLink()) return false;
        // Uploaded plugins must never be promoted into trusted catalog installations.
        if (fs.lstatSync(path.join(pluginDir, '.wosland-upload.json'), { throwIfNoEntry: false })) return false;
        const marker = fs.lstatSync(path.join(pluginDir, '.wosland-install-pending.json'));
        return marker.isFile() && !marker.isSymbolicLink();
    } catch { return false; }
}

function ensureInstallRecovery(pluginsDir, name) {
    const dir = transactionPath(pluginsDir, name);
    if (!fs.existsSync(dir) && hasIncompleteOfficialInstall(pluginsDir, name)) {
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(path.join(pluginsDir, name, '.wosland-install-pending.json'), path.join(dir, 'install-pending.json'));
        writeRecord(dir, {
            name, phase: 'incomplete', dependencies: false,
            hadNodeModules: fs.existsSync(path.join(pluginsDir, name, 'node_modules')),
            preserve: { dirs: [], files: [], extensions: [] }
        });
    }
    return dir;
}

// Keep ambiguous backups outside the active transaction slot; never execute their contents.
function preservePendingPluginUpdate(pluginsDir, name) {
    const dir = transactionPath(pluginsDir, name);
    if (!fs.existsSync(dir)) return null;
    const saved = path.join(path.dirname(dir), `.preserved-${name}-${require('crypto').randomBytes(8).toString('hex')}`);
    fs.renameSync(dir, saved);
    return saved;
}

function finishUpdate(pluginsDir, name, keepBackup = false, dir = transactionPath(pluginsDir, name)) {
    try {
        const saved = path.join(path.dirname(dir), `.preserved-${name}-${require('crypto').randomBytes(8).toString('hex')}`);
        fs.renameSync(dir, saved);
        if (saved && !keepBackup) fs.rmSync(saved, { recursive: true, force: true });
    } catch (error) {
        console.warn(`[PLUGINS] Completed update backup for ${name} was kept (${error.code || 'CLEANUP_FAILED'}).`);
    }
}

// Snapshot only replaceable code. Databases, local configuration and Git metadata stay in place.
function copyCode(src, dest, preserveConfig, base = src) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const from = path.join(src, entry.name);
        const relative = path.relative(base, from).replace(/\\/g, '/');
        if (isProtectedPluginPath(relative, entry.isDirectory(), preserveConfig)) continue;
        if (entry.isSymbolicLink()) throw new Error(`Unprotected plugin link cannot be updated: ${relative}`);
        const to = path.join(dest, entry.name);
        if (entry.isDirectory()) copyCode(from, to, preserveConfig, base);
        else if (entry.isFile()) fs.copyFileSync(from, to);
        else throw new Error('Unsupported plugin file.');
    }
}

function removeCode(dir, preserveConfig, base = dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        const relative = path.relative(base, file).replace(/\\/g, '/');
        if (isProtectedPluginPath(relative, entry.isDirectory(), preserveConfig)) continue;
        if (entry.isDirectory()) {
            removeCode(file, preserveConfig, base);
            if (!fs.readdirSync(file).length) fs.rmdirSync(file);
        } else fs.unlinkSync(file);
    }
}

function beginPluginUpdate(pluginsDir, name, preserveConfig, { repair = false } = {}) {
    const pending = repair ? ensureInstallRecovery(pluginsDir, name) : transactionPath(pluginsDir, name);
    if (!repair && fs.existsSync(pending) && !hasPendingPluginUpdate(pluginsDir, name))
        restorePluginUpdate(pluginsDir, name);
    if (!repair && fs.existsSync(pending)) throw new Error('A previous plugin update must be recovered first.');
    if (repair && !fs.existsSync(pending)) throw new Error('The interrupted plugin update no longer exists.');
    // A repair never vacates the original blocker until the replacement has loaded successfully.
    const dir = repair ? path.join(path.dirname(pending), `.repair-${name}-${require('crypto').randomBytes(8).toString('hex')}`) : pending;
    const pluginDir = path.join(pluginsDir, name);
    if (!fs.lstatSync(pluginDir).isDirectory() || fs.lstatSync(pluginDir).isSymbolicLink())
        throw new Error('Installed plugin must be a real directory.');
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const staging = fs.mkdtempSync(path.join(path.dirname(dir), `.preparing-${name}-`));
    const record = {
        name,
        phase: 'prepared',
        dependencies: false,
        hadNodeModules: fs.existsSync(path.join(pluginDir, 'node_modules')),
        preserve: Object.fromEntries(Object.entries(preserveConfig).map(([key, values]) => [key, [...values]]))
    };
    try {
        copyCode(pluginDir, path.join(staging, 'code'), preserveConfig);
        writeRecord(staging, record);
        if (fs.existsSync(dir)) throw new Error('A previous plugin update must be recovered first.');
        fs.renameSync(staging, dir);
    } catch (error) {
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* The untouched plugin remains usable. */ }
        throw error;
    }
    return {
        apply() {
            record.phase = 'applying';
            writeRecord(dir, record);
        },
        replaceDependencies() {
            record.dependencies = true;
            writeRecord(dir, record);
            const modules = path.join(pluginDir, 'node_modules');
            if (fs.existsSync(modules)) fs.renameSync(modules, path.join(dir, 'node_modules'));
        },
        rollback() {
            restorePluginUpdate(pluginsDir, name, dir, repair);
        },
        commit({ keepBackup = false } = {}) {
            if (repair) {
                const marker = path.join(pluginDir, '.wosland-install-pending.json');
                if (fs.existsSync(marker)) {
                    if (!hasIncompleteOfficialInstall(pluginsDir, name)) throw new Error('Plugin installation marker changed.');
                    fs.unlinkSync(marker);
                }
                // This atomic rename is the commit point; subsequent cleanup must not roll it back.
                preservePendingPluginUpdate(pluginsDir, name);
                finishUpdate(pluginsDir, name, true, dir);
                return;
            }
            record.phase = 'committed';
            writeRecord(dir, record);
            finishUpdate(pluginsDir, name, keepBackup);
        }
    };
}

function restorePluginUpdate(pluginsDir, name, dir = transactionPath(pluginsDir, name), repairSnapshot = false) {
    const record = readRecord(dir, name);
    // There is no complete previous installation to restore; only a verified repair can finish it.
    if (record.phase === 'incomplete') return;
    if (record.phase === 'applying') {
        const pluginDir = path.join(pluginsDir, name);
        if (fs.lstatSync(pluginDir).isSymbolicLink()) throw new Error('Cannot recover a linked plugin directory.');
        const config = configFromRecord(record);
        const backup = path.join(dir, 'code');
        if (fs.lstatSync(backup).isSymbolicLink()) throw new Error('Cannot recover a linked backup.');
        if (!repairSnapshot && !fs.existsSync(path.join(backup, 'plugin.json'))) throw new Error('Plugin update backup is incomplete.');
        validateBackup(backup);
        removeCode(pluginDir, config);
        copyCode(backup, pluginDir, config);
        if (record.dependencies) {
            const saved = path.join(dir, 'node_modules');
            const modules = path.join(pluginDir, 'node_modules');
            if (fs.existsSync(saved) || !record.hadNodeModules) {
                fs.rmSync(modules, { recursive: true, force: true });
                if (fs.existsSync(saved)) fs.renameSync(saved, modules);
            }
        }
        record.phase = 'restored';
        writeRecord(dir, record);
    }
    finishUpdate(pluginsDir, name, repairSnapshot, dir);
}

function validateBackup(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('Invalid plugin backup file.');
        if (entry.isDirectory()) validateBackup(path.join(dir, entry.name));
    }
}

// The counter lives with the interrupted update, so a restart cannot reset the retry budget.
function claimPluginRecoveryAttempt(pluginsDir, name) {
    const dir = ensureInstallRecovery(pluginsDir, name);
    const file = path.join(dir, 'recovery.json');
    let attempts = 0;
    if (fs.existsSync(file)) {
        if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Plugin recovery counter must not be a link.');
        attempts = JSON.parse(fs.readFileSync(file, 'utf8')).attempts;
        if (!Number.isInteger(attempts) || attempts < 0 || attempts > 3) throw new Error('Invalid plugin recovery counter.');
    }
    if (attempts === 3) return null;
    const temp = `${file}.tmp`;
    if (fs.existsSync(temp) && fs.lstatSync(temp).isSymbolicLink()) throw new Error('Plugin recovery counter must not be a link.');
    fs.writeFileSync(temp, JSON.stringify({ attempts: attempts + 1 }));
    fs.renameSync(temp, file);
    return attempts + 1;
}

function recoverPluginUpdates(pluginsDir) {
    const updates = path.join(pluginsDir, '.updates');
    if (!fs.existsSync(updates)) return;
    if (fs.lstatSync(updates).isSymbolicLink()) {
        console.warn('[PLUGINS] Linked update storage is disabled; plugin backups were not touched.');
        return;
    }
    for (const entry of fs.readdirSync(updates, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        try {
            restorePluginUpdate(pluginsDir, entry.name);
        } catch (error) {
            const file = typeof error.path === 'string' && path.resolve(error.path).startsWith(path.resolve(pluginsDir) + path.sep)
                ? ` ${path.relative(pluginsDir, error.path).replace(/[\r\n]/g, ' ').slice(0, 180)}` : '';
            console.warn(`[PLUGINS] Could not restore update for ${entry.name} (${error.code || 'INVALID_RECORD'}${file}); backup preserved for recovery.`);
        }
    }
}

function hasPendingPluginUpdate(pluginsDir, name) {
    try {
        const dir = transactionPath(pluginsDir, name);
        return fs.existsSync(dir) && !['committed', 'restored'].includes(readRecord(dir, name).phase);
    } catch {
        return true;
    }
}

module.exports = { isProtectedPluginPath, beginPluginUpdate, recoverPluginUpdates, hasPendingPluginUpdate, claimPluginRecoveryAttempt, hasIncompleteOfficialInstall };
