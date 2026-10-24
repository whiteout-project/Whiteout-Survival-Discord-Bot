const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const vm = require('vm');
const Module = require('module');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { crc32 } = require('adm-zip/util');
const semver = require('semver');
const loader = require('./pluginsLoader');
const { isGitMetadataPath } = require('./pluginGitMetadata');

const LIMITS = Object.freeze({ archive: 10 * 1024 * 1024, expanded: 40 * 1024 * 1024, file: 4 * 1024 * 1024, entries: 500, ratio: 100 });
const STAGING_DIR = path.resolve(__dirname, '../../temp/plugin-uploads');
const MARKER = '.wosland-upload.json';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const INSPECTION_TIMEOUT_MS = 10000;
let inspectionQueue = Promise.resolve();

class PluginUploadError extends Error {
    constructor(code, detail = '') {
        super(code);
        this.code = code;
        this.detail = detail;
    }
}
const fail = (code, detail) => { throw new PluginUploadError(code, detail); };

function safePath(name) {
    if (!name || name.length > 240 || /[\\:\x00-\x1f\x7f]/.test(name) || name.startsWith('/')) fail('unsafePath');
    const parts = name.replace(/\/$/, '').split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
        /[<>"|?*]/.test(part) || /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part))) fail('unsafePath');
    return parts.join('/');
}

// Parse only the checked directory; signatures in comments cannot select another header.
function checkZipDirectory(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > LIMITS.archive) fail('archiveLimit');
    let end = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
    }
    if (end < 0) fail('invalidZip');
    const count = buffer.readUInt16LE(end + 10);
    const offset = buffer.readUInt32LE(end + 16);
    const size = buffer.readUInt32LE(end + 12);
    if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || buffer.readUInt16LE(end + 8) !== count ||
        count === 0xffff || offset === 0xffffffff || size === 0xffffffff || offset + size !== end) fail('unsupportedZip');
    if (!count || count > LIMITS.entries) fail('entryLimit');
    const entries = [];
    const nodes = new Set();
    let cursor = offset;
    for (let index = 0; index < count; index++) {
        if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) fail('invalidZip');
        const nameLength = buffer.readUInt16LE(cursor + 28);
        const extraLength = buffer.readUInt16LE(cursor + 30);
        const next = cursor + 46 + nameLength + extraLength + buffer.readUInt16LE(cursor + 32);
        if (next > end) fail('invalidZip');
        if (!nameLength || nameLength > 960) fail('unsafePath');
        const rawEntryName = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
        let name;
        try { name = new TextDecoder('utf-8', { fatal: true }).decode(rawEntryName); } catch { fail('unsafePath'); }
        const relative = safePath(name);
        const parts = relative.split('/');
        for (let i = 1; i <= parts.length; i++) nodes.add(parts.slice(0, i).join('/'));
        if (nodes.size > LIMITS.entries) fail('entryLimit');
        const extraEnd = cursor + 46 + nameLength + extraLength;
        for (let at = cursor + 46 + nameLength; at < extraEnd;) {
            if (at + 4 > extraEnd) fail('invalidZip');
            if (buffer.readUInt16LE(at) === 1) fail('unsupportedZip');
            at += 4 + buffer.readUInt16LE(at + 2);
            if (at > extraEnd) fail('invalidZip');
        }
        const flags = buffer.readUInt16LE(cursor + 8);
        entries.push({ rawEntryName, relative, isDirectory: name.endsWith('/'), attr: buffer.readUInt32LE(cursor + 38),
            header: { version: buffer.readUInt16LE(cursor + 6), flags, encrypted: Boolean(flags & 1),
                method: buffer.readUInt16LE(cursor + 10), crc: buffer.readUInt32LE(cursor + 16),
                compressedSize: buffer.readUInt32LE(cursor + 20), size: buffer.readUInt32LE(cursor + 24),
                diskNumStart: buffer.readUInt16LE(cursor + 34), offset: buffer.readUInt32LE(cursor + 42) } });
        cursor = next;
    }
    if (cursor !== end) fail('invalidZip');
    return { offset, entries };
}

function readArchive(buffer) {
    const directory = checkZipDirectory(buffer);
    const seen = new Set();
    let total = 0;
    const files = [];
    for (const entry of directory.entries) {
        const relative = entry.relative;
        const key = relative.normalize('NFC').toLowerCase();
        if (seen.has(key)) fail('duplicatePath');
        seen.add(key);
        const header = entry.header;
        const type = (entry.attr >>> 16) & 0xf000;
        if ((type && type !== (entry.isDirectory ? 0x4000 : 0x8000)) || (entry.attr & 0x400)) fail('unsafeFile');
        if (header.encrypted || (header.flags & 64) || header.version >= 45 || header.diskNumStart || ![0, 8].includes(header.method)) fail('unsupportedZip');
        if (!Number.isSafeInteger(header.compressedSize) || header.compressedSize < 0 || header.compressedSize > buffer.length ||
            !Number.isSafeInteger(header.offset) || header.offset < 0) fail('invalidZip');
        if (!Number.isSafeInteger(header.size) || header.size > LIMITS.file ||
            header.size > Math.max(1, header.compressedSize) * LIMITS.ratio) fail('expandedLimit');
        total += header.size;
        if (total > LIMITS.expanded) fail('expandedLimit');
        const offset = header.offset;
        if (offset + 30 > directory.offset || buffer.readUInt32LE(offset) !== 0x04034b50) fail('invalidZip');
        const nameLength = buffer.readUInt16LE(offset + 26);
        const start = offset + 30 + nameLength + buffer.readUInt16LE(offset + 28);
        if (start + header.compressedSize > directory.offset ||
            !buffer.subarray(offset + 30, offset + 30 + nameLength).equals(entry.rawEntryName) ||
            buffer.readUInt16LE(offset + 8) !== header.method || buffer.readUInt16LE(offset + 6) !== header.flags) fail('invalidZip');
        if (entry.isDirectory) {
            if (header.size) fail('invalidZip');
            continue;
        }
        let data;
        try {
            const compressed = buffer.subarray(start, start + header.compressedSize);
            data = header.method === 0 ? compressed : zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, Math.min(LIMITS.file, header.size + 1)) });
            if (data.length !== header.size || crc32(data) !== header.crc) fail('invalidZip');
        } catch (error) {
            if (error instanceof PluginUploadError) throw error;
            fail('invalidZip');
        }
        files.push({ path: relative, data });
    }
    // A file cannot also be the parent directory of another entry.
    const filePaths = new Set(files.map(file => file.path.toLowerCase()));
    for (const file of files) {
        const parts = file.path.split('/');
        for (let i = 1; i < parts.length; i++) {
            if (filePaths.has(parts.slice(0, i).join('/').toLowerCase())) fail('duplicatePath');
        }
    }
    return files;
}

function assertNotInstalled(name, pluginsDir = loader.PLUGINS_DIR) {
    const key = name.toLowerCase();
    if ([...loader.loadedPlugins.keys()].some(id => id.toLowerCase() === key) ||
        (fs.existsSync(pluginsDir) && fs.readdirSync(pluginsDir).some(id => id.toLowerCase() === key))) fail('duplicatePlugin');
    if (fs.existsSync(pluginsDir)) for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
            const manifest = JSON.parse(fs.readFileSync(path.join(pluginsDir, entry.name, 'plugin.json'), 'utf8'));
            if (String(manifest.name).toLowerCase() === key) fail('duplicatePlugin');
        } catch (error) { if (error instanceof PluginUploadError) throw error; }
    }
}

const RISK_PATTERNS = [
    ['shell', /child_process|\b(?:execSync|execFile|spawnSync|spawn)\s*\(/],
    ['dynamic', /\b(?:eval|Function|import|runInContext|runInNewContext|runInThisContext|compileFunction)\s*\(|\bvm\s*\.|require\s*\(\s*['"](?:node:)?vm['"]|process\s*\.\s*(?:binding|dlopen)/],
    ['credentials', /process\s*\.\s*env|\.env\b|(?:readFile|readFileSync)[^\n]{0,256}(?:token|credential|password|secret)/i],
    ['network', /\b(?:fetch|WebSocket)\s*\(|require\s*\(\s*['"](?:node:)?(?:https?|net|tls|dgram)['"]|https?:\/\//]
];

function assessFiles(files, manifest, botVersion, nodeVersion) {
    const blockers = [];
    const findings = [];
    const addBlocker = (code, file = '') => blockers.push({ code, file });
    const entrypoints = files.filter(file => /^(commands|events|handlers)\/[^/]+\.js$/.test(file.path));
    if (!entrypoints.length || manifest.main !== undefined || manifest.entrypoint !== undefined) addBlocker('entrypoint');
    const reserved = new Set(['__proto__', 'prototype', 'constructor', 'content', 'buttons', 'upload']);
    if (manifest.name.length > 64 || reserved.has(manifest.name.toLowerCase()) || !semver.valid(manifest.version)) addBlocker('manifest');
    for (const [field, max] of [['description', 1000], ['author', 120]]) {
        if (manifest[field] !== undefined && (typeof manifest[field] !== 'string' || manifest[field].length > max)) addBlocker('manifest');
    }
    const engines = manifest.engines;
    const compatibility = { bot: engines?.bot || null, node: engines?.node || null };
    if (engines !== undefined && (!engines || typeof engines !== 'object' || Array.isArray(engines))) addBlocker('compatibility');
    for (const [engine, version] of [['bot', botVersion], ['node', nodeVersion]]) {
        if (engines?.[engine] !== undefined && (typeof engines[engine] !== 'string' || engines[engine].length > 120 || !semver.validRange(engines[engine]) || !semver.satisfies(version, engines[engine]))) addBlocker('compatibility');
    }
    for (const file of files) {
        if (/^(commands|events|handlers|locales)$/.test(file.path) || /^(commands|events|handlers)\/[^/]+\.js\//.test(file.path)) addBlocker('structure', file.path);
        if (isGitMetadataPath(file.path.toLowerCase()) || file.path.split('/').some(part => /^node_modules$|^\.env(?:\.|$)/i.test(part)) ||
            file.path.toLowerCase() === MARKER || /\.(?:exe|dll|so|dylib|node|msi|com|bat|cmd|ps1|psm1|sh|bash|zsh|vbs|(?:db|sqlite)(?:-wal|-shm)?)$/i.test(file.path)) addBlocker('forbiddenFile', file.path);
        if (/\.(?:js|cjs|mjs|json|html|ts)$/i.test(file.path)) {
            const text = file.data.toString('utf8');
            for (const [code, pattern] of RISK_PATTERNS) {
                const match = pattern.exec(text);
                if (match) findings.push({ code, file: file.path, line: text.slice(0, match.index).split('\n').length });
            }
            if (/\.js$/.test(file.path)) try { new vm.Script(Module.wrap(text.replace(/^\uFEFF/, '').replace(/^#![^\r\n]*/, '')), { filename: file.path }); } catch { addBlocker('syntax', file.path); }
        }
        if (/^locales\/[^/]+\.json$/.test(file.path)) try { JSON.parse(file.data); } catch { addBlocker('manifest', file.path); }
        if (/^(commands|events|handlers)\/package\.json$/.test(file.path)) {
            try { if (JSON.parse(file.data).type === 'module') addBlocker('entrypoint', file.path); }
            catch { addBlocker('manifest', file.path); }
        }
    }
    const packageFile = files.find(file => file.path === 'package.json');
    if (packageFile && packageFile.data.length > 32768) addBlocker('manifest', 'package.json');
    else if (packageFile) {
        let pkg;
        try { pkg = JSON.parse(packageFile.data); } catch { addBlocker('manifest', 'package.json'); }
        if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) addBlocker('manifest', 'package.json');
        else {
            if (pkg.dependencies !== undefined && (!pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies))) addBlocker('manifest', 'package.json');
            compatibility.node ||= pkg.engines?.node || null;
            if (pkg.type && pkg.type !== 'commonjs') addBlocker('entrypoint', 'package.json');
            if (pkg.scripts && Object.keys(pkg.scripts).some(key => /^(?:preinstall|install|postinstall|prepare|prepublish)$/.test(key))) findings.push({ code: 'scripts', file: 'package.json' });
            if (pkg.engines?.node && (typeof pkg.engines.node !== 'string' || pkg.engines.node.length > 120 || !semver.validRange(pkg.engines.node) || !semver.satisfies(nodeVersion, pkg.engines.node))) addBlocker('compatibility', 'package.json');
            const dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies) ? Object.entries(pkg.dependencies) : [];
            if (dependencies.length > 100) addBlocker('dependencies', 'package.json');
            for (const [name, range] of dependencies.slice(0, 100)) {
                try {
                    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error('Invalid dependency');
                    const installed = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../node_modules', name, 'package.json'), 'utf8'));
                    if (typeof range !== 'string' || !semver.validRange(range) || !semver.satisfies(installed.version, range)) addBlocker('dependencies', 'package.json');
                } catch { addBlocker('dependencies', 'package.json'); }
            }
        }
    }
    return { blockers, findings, compatibility, restartRequired: entrypoints.some(file => file.path.startsWith('commands/')) };
}

function createWorkspace(stagingDir) {
    fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(stagingDir).isSymbolicLink()) fail('unsafePath');
    const workDir = fs.mkdtempSync(path.join(stagingDir, 'upload-'));
    const workspace = { workDir, stagingDir, stagingRealDir: fs.realpathSync(stagingDir) };
    try {
        fs.writeFileSync(path.join(workDir, '.inspection.json'), JSON.stringify({ format: 'wosland-plugin-upload-v1', expiresAt: Date.now() + 5 * 60000 }), { flag: 'wx', mode: 0o600 });
        return workspace;
    } catch (error) { cleanupInspection(workspace); throw error; }
}

function inspectPluginArchive(buffer, options = {}) {
    let files = readArchive(buffer);
    const manifestFiles = files.filter(file => /(^|\/)plugin\.json$/.test(file.path));
    if (manifestFiles.length !== 1 || manifestFiles[0].data.length > 32768) fail('manifest');
    const prefix = manifestFiles[0].path.slice(0, -'plugin.json'.length);
    if (prefix && prefix.split('/').length !== 2) fail('structure');
    if (files.some(file => !file.path.startsWith(prefix))) fail('structure');
    files = files.map(file => ({ ...file, path: file.path.slice(prefix.length) }));
    let manifest;
    try { manifest = JSON.parse(manifestFiles[0].data); } catch { fail('manifest'); }
    if (!loader.validateManifest(manifest, 'upload').valid) fail('manifest');
    safePath(manifest.name);
    for (const key of ['dirs', 'files']) for (const entry of manifest.preserveOnUpdate?.[key] || []) safePath(entry);
    if (prefix && prefix !== `${manifest.name}/`) fail('structure');
    const pluginsDir = options.pluginsDir || loader.PLUGINS_DIR;
    assertNotInstalled(manifest.name, pluginsDir);
    const botVersion = options.botVersion || require('../../../package.json').version;
    const nodeVersion = options.nodeVersion || process.versions.node;
    const assessment = assessFiles(files, manifest, botVersion, nodeVersion);
    const workspace = options.workspace || createWorkspace(options.stagingDir || STAGING_DIR);
    assertInspectionLocation(workspace);
    const inspection = { ...workspace, pluginsDir, manifest, botVersion, nodeVersion, ...assessment, digest: hash(buffer), files: [], expandedBytes: files.reduce((sum, f) => sum + f.data.length, 0) };
    try {
        fs.writeFileSync(path.join(workspace.workDir, 'archive.zip'), buffer, { flag: 'wx', mode: 0o600 });
        for (const file of files) {
            const target = path.join(workspace.workDir, 'payload', file.path);
            fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
            fs.writeFileSync(target, file.data, { flag: 'wx', mode: 0o600 });
            inspection.files.push({ path: file.path, size: file.data.length, digest: hash(file.data) });
        }
        return inspection;
    } catch (error) { cleanupInspection(inspection); throw error; }
}

async function inspectInWorker(buffer, options) {
    if (!Buffer.isBuffer(buffer) || buffer.length > LIMITS.archive) fail('archiveLimit');
    const workspace = createWorkspace(options.stagingDir || STAGING_DIR);
    let worker;
    let timeout;
    try {
        // Keep security/runtime flags, but let the worker use its own smaller V8 heap.
        const memoryFlag = /^--max[-_]old[-_]space[-_]size(?:=|$)/;
        const execArgv = process.execArgv.filter((arg, i, args) => !memoryFlag.test(arg) &&
            !/^--expose[-_]gc(?:=|$)/.test(arg) && !(i > 0 && /^--max[-_]old[-_]space[-_]size$/.test(args[i - 1])));
        worker = new Worker(__filename, { execArgv,
            workerData: { pluginInspection: true, buffer, options: { ...options, workspace } },
            resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 } });
        const inspection = await new Promise((resolve, reject) => {
            timeout = setTimeout(() => reject(new PluginUploadError('inspectionLimit')), INSPECTION_TIMEOUT_MS);
            worker.once('message', result => result.error ? reject(new PluginUploadError(result.error)) : resolve(result.inspection));
            worker.once('error', error => reject(new PluginUploadError(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'inspectionLimit' : 'inspectionFailed')));
            worker.once('exit', () => reject(new PluginUploadError('inspectionFailed')));
        });
        assertNotInstalled(inspection.manifest.name, options.pluginsDir || loader.PLUGINS_DIR);
        return inspection;
    } catch (error) {
        // Stop writes before removing the workspace, including on timeout or heap exhaustion.
        if (worker) await worker.terminate();
        cleanupInspection(workspace);
        throw error;
    } finally {
        clearTimeout(timeout);
        if (worker) await worker.terminate();
    }
}

function inspectPluginArchiveAsync(buffer, options = {}) {
    // Bound peak memory when several owners submit ZIPs at once.
    const inspection = inspectionQueue.then(() => inspectInWorker(buffer, options));
    inspectionQueue = inspection.then(() => undefined, () => undefined);
    return inspection;
}

function assertInspectionLocation(inspection) {
    const relative = path.relative(path.resolve(inspection.stagingDir), path.resolve(inspection.workDir));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !/^upload-[^/\\]+$/.test(relative)) fail('changed');
    if (fs.realpathSync(inspection.stagingDir) !== inspection.stagingRealDir) fail('changed');
}

function cleanupInspection(inspection) {
    assertInspectionLocation(inspection);
    fs.rmSync(inspection.workDir, { recursive: true, force: true });
}

function cleanupExpiredInspections(stagingDir = STAGING_DIR, now = Date.now()) {
    if (!fs.existsSync(stagingDir) || fs.lstatSync(stagingDir).isSymbolicLink()) return;
    for (const entry of fs.readdirSync(stagingDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^upload-[a-zA-Z0-9]{6}$/.test(entry.name)) continue;
        try {
            const workDir = path.join(stagingDir, entry.name);
            const descriptor = path.join(workDir, '.inspection.json');
            const stat = fs.lstatSync(descriptor);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) continue;
            const lease = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
            if (lease.format === 'wosland-plugin-upload-v1' && Number.isFinite(lease.expiresAt) && lease.expiresAt <= now) {
                cleanupInspection({ stagingDir, stagingRealDir: fs.realpathSync(stagingDir), workDir });
            }
        } catch { /* A locked or unrecognized directory is left intact. */ }
    }
}

function verifyInspection(inspection) {
    assertInspectionLocation(inspection);
    const root = path.join(inspection.workDir, 'payload');
    const expected = new Map(inspection.files.map(file => [file.path, file]));
    const archivePath = path.join(inspection.workDir, 'archive.zip');
    const archiveStat = fs.lstatSync(archivePath);
    if (fs.lstatSync(inspection.workDir).isSymbolicLink() || !archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.size > LIMITS.archive ||
        hash(fs.readFileSync(archivePath)) !== inspection.digest) fail('changed');
    let count = 0;
    const visit = dir => {
        if (fs.lstatSync(dir).isSymbolicLink()) fail('changed');
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) fail('changed');
            if (entry.isDirectory()) visit(file);
            else {
                const relative = path.relative(root, file).replace(/\\/g, '/');
                const record = expected.get(relative);
                if (!entry.isFile() || !record || fs.statSync(file).size !== record.size || hash(fs.readFileSync(file)) !== record.digest) fail('changed');
                count++;
            }
        }
    };
    visit(root);
    if (count !== expected.size) fail('changed');
}

function installUploadedPlugin(inspection, registrar, client) {
    if (inspection.blockers.length) fail('blocked');
    verifyInspection(inspection);
    assertNotInstalled(inspection.manifest.name, inspection.pluginsDir);
    const dest = path.join(inspection.pluginsDir, inspection.manifest.name);
    fs.mkdirSync(inspection.pluginsDir, { recursive: true });
    fs.mkdirSync(dest); // Exclusive directory creation prevents replacing any existing installation.
    const identity = fs.lstatSync(dest);
    const listeners = new Map(client.eventNames().map(event => [event, new Set(client.rawListeners(event))]));
    try {
        const marker = { source: 'third-party', status: 'pending', archiveSha256: inspection.digest };
        fs.writeFileSync(path.join(dest, MARKER), JSON.stringify(marker), { flag: 'wx' });
        fs.cpSync(path.join(inspection.workDir, 'payload'), dest, { recursive: true, force: false, errorOnExist: true });
        const guardedRegistrar = {
            ...registrar,
            registerCommand: file => {
                const command = require(file);
                if (client.commands.has(command?.data?.name)) fail('commandConflict');
                if (!command || typeof command.execute !== 'function' || typeof command.data?.toJSON !== 'function' ||
                    typeof command.data.name !== 'string' || command.data.toJSON()?.name !== command.data.name) fail('loadFailed');
                registrar.registerCommand(file);
            },
            registerHandler: file => {
                const handler = require(file);
                if (typeof handler !== 'function' || handler.constructor.name === 'AsyncFunction') fail('loadFailed');
                registrar.registerHandler(file);
            }
        };
        loader.registerPluginModules(dest, inspection.manifest, guardedRegistrar);
        const loaded = loader.loadedPlugins.get(inspection.manifest.name);
        if (!loaded || loaded.dir !== dest) fail('loadFailed');
        fs.writeFileSync(path.join(dest, MARKER), JSON.stringify({ ...marker, status: 'installed' }));
        return { success: true, loaded: true, restartRequired: inspection.restartRequired, name: inspection.manifest.name };
    } catch (error) {
        if (loader.loadedPlugins.has(inspection.manifest.name)) loader.unloadPlugin(inspection.manifest.name, registrar);
        // A handler may attach a listener and throw before returning its cleanup function.
        for (const event of client.eventNames()) for (const listener of client.rawListeners(event)) {
            if (!listeners.get(event)?.has(listener)) client.removeListener(event, listener);
        }
        const current = fs.lstatSync(dest, { throwIfNoEntry: false });
        if (current) {
            if (current.isSymbolicLink() || current.ino !== identity.ino || current.dev !== identity.dev) fail('cleanupUnverified');
            try { fs.rmSync(dest, { recursive: true, force: true }); } catch {
                try {
                    const retained = fs.lstatSync(dest);
                    if (retained.isSymbolicLink() || retained.ino !== identity.ino || retained.dev !== identity.dev) fail('cleanupUnverified');
                    const markerPath = path.join(dest, MARKER);
                    const markerStat = fs.lstatSync(markerPath, { throwIfNoEntry: false });
                    if (markerStat && (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink > 1)) fail('cleanupUnverified');
                    fs.writeFileSync(markerPath, JSON.stringify({ source: 'third-party', status: 'pending', archiveSha256: inspection.digest }));
                } catch { fail('cleanupUnverified'); }
                fail('cleanupFailed');
            }
        }
        if (error instanceof PluginUploadError) throw error;
        if (error?.code === 'PLUGIN_COMMAND_CONFLICT') fail('commandConflict');
        fail('loadFailed');
    }
}

module.exports = { LIMITS, MARKER, PluginUploadError, inspectPluginArchive, inspectPluginArchiveAsync, verifyInspection, cleanupInspection, cleanupExpiredInspections, installUploadedPlugin };

if (!isMainThread && workerData?.pluginInspection === true) {
    try {
        const input = workerData.buffer;
        parentPort.postMessage({ inspection: inspectPluginArchive(Buffer.from(input.buffer, input.byteOffset, input.byteLength), workerData.options) });
    } catch (error) {
        parentPort.postMessage({ error: error instanceof PluginUploadError ? error.code : 'inspectionFailed' });
    } finally { parentPort.close(); }
}
