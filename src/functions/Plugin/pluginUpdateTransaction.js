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
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(record));
    fs.renameSync(`${file}.tmp`, file);
}

function readRecord(dir, name) {
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'transaction.json'), 'utf8'));
    if (
        record.name !== name ||
        !['prepared', 'applying', 'committed'].includes(record.phase) ||
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

function beginPluginUpdate(pluginsDir, name, preserveConfig) {
    const dir = transactionPath(pluginsDir, name);
    if (fs.existsSync(dir)) throw new Error('A previous plugin update must be recovered first.');
    const pluginDir = path.join(pluginsDir, name);
    if (!fs.lstatSync(pluginDir).isDirectory() || fs.lstatSync(pluginDir).isSymbolicLink())
        throw new Error('Installed plugin must be a real directory.');
    fs.mkdirSync(dir, { recursive: true });
    const record = {
        name,
        phase: 'prepared',
        dependencies: false,
        hadNodeModules: fs.existsSync(path.join(pluginDir, 'node_modules')),
        preserve: Object.fromEntries(Object.entries(preserveConfig).map(([key, values]) => [key, [...values]]))
    };
    try {
        copyCode(pluginDir, path.join(dir, 'code'), preserveConfig);
        writeRecord(dir, record);
    } catch (error) {
        fs.rmSync(dir, { recursive: true, force: true });
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
            restorePluginUpdate(pluginsDir, name);
        },
        commit() {
            record.phase = 'committed';
            writeRecord(dir, record);
            // Failure to delete an old backup must not undo a successfully loaded update.
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch {
                console.warn(`[PLUGINS] Update backup for ${name} will be cleaned on restart.`);
            }
        }
    };
}

function restorePluginUpdate(pluginsDir, name) {
    const dir = transactionPath(pluginsDir, name);
    const record = readRecord(dir, name);
    if (record.phase === 'applying') {
        const pluginDir = path.join(pluginsDir, name);
        if (fs.lstatSync(pluginDir).isSymbolicLink()) throw new Error('Cannot recover a linked plugin directory.');
        const config = configFromRecord(record);
        const backup = path.join(dir, 'code');
        if (!fs.existsSync(path.join(backup, 'plugin.json'))) throw new Error('Plugin update backup is incomplete.');
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
    }
    fs.rmSync(dir, { recursive: true, force: true });
}

function recoverPluginUpdates(pluginsDir) {
    const updates = path.join(pluginsDir, '.updates');
    if (!fs.existsSync(updates)) return;
    if (fs.lstatSync(updates).isSymbolicLink()) {
        console.warn('[PLUGINS] Linked update storage is disabled; plugin backups were not touched.');
        return;
    }
    for (const entry of fs.readdirSync(updates, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
            restorePluginUpdate(pluginsDir, entry.name);
        } catch {
            console.warn(`[PLUGINS] Could not recover update for ${entry.name}; its backup is preserved.`);
        }
    }
}

function hasPendingPluginUpdate(pluginsDir, name) {
    try {
        const dir = transactionPath(pluginsDir, name);
        return fs.existsSync(dir) && readRecord(dir, name).phase !== 'committed';
    } catch {
        return true;
    }
}

module.exports = { isProtectedPluginPath, beginPluginUpdate, recoverPluginUpdates, hasPendingPluginUpdate };
