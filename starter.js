const readline = require('readline');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

// Auto-restart with optimization flags if not present
if (!global.gc) {
    const child = spawn('node', [
        '--expose-gc',
        '--max-old-space-size=256',
        ...process.argv.slice(1)
    ], {
        stdio: 'inherit',
        cwd: process.cwd()
    });

    child.on('exit', (code) => {
        process.exit(code);
    });

    return; // Exit parent process
}

// ============================================================
// NODE VERSION CHECK  (must pass before anything else runs)
// ============================================================

const ALLOWED_NODE_MAJORS = [18, 20, 22];
const _currentNodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (!ALLOWED_NODE_MAJORS.includes(_currentNodeMajor)) {
    console.error(`
❌  Unsupported Node.js version: v${process.versions.node}`);
    console.error(`   This bot requires Node.js 18, 20, or 22 (LTS releases).`);
    console.error(`   Other versions lack prebuilt binaries for native addons`);
    console.error(`   (better-sqlite3, onnxruntime-node) and will OOM or fail`);
    console.error(`   to compile on memory-constrained containers.`);
    console.error(`   Please switch to Node 18, 20, or 22 and restart.\n`);
    process.exit(1);
}

// ============================================================
// PRE-FLIGHT CHECKS: Dependencies, Files, and Version
// ============================================================

const GITHUB_REPO = 'whiteout-project/Whiteout-Survival-Discord-Bot';
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

/**
 * Recursively searches a directory for any .node native addon file.
 * @param {string} dir
 * @returns {boolean}
 */
function hasNodeFile(dir) {
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith('.node')) return true;
            if (entry.isDirectory() && hasNodeFile(path.join(dir, entry.name))) return true;
        }
    } catch { /* ignore permission / missing dir */ }
    return false;
}

/**
 * Returns true when native addon binaries are in place for the packages
 * that require them (specifically better-sqlite3).
 *
 * Called after `checkDependencies` confirms all package directories exist so
 * the bot does not start up with unbuilt native modules after a partial install
 * that was killed before `npm rebuild` ran.
 *
 * @param {string} cwd - Project root
 * @returns {boolean}
 */
function areNativeBinariesPresent(cwd) {
    const bsqlite = path.join(cwd, 'node_modules', 'better-sqlite3');
    if (!fs.existsSync(bsqlite)) return true; // package not installed, nothing to check
    return ['build', 'compiled', 'addon-build'].some(d => hasNodeFile(path.join(bsqlite, d)));
}

/**
 * Checks that all required npm dependencies are installed
 * Automatically runs npm install if any are missing
 * @returns {boolean} True if all dependencies are present
 */
async function checkDependencies() {
    const packageJsonPath = path.join(__dirname, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        console.error('[PREFLIGHT] package.json not found!');
        return false;
    }

    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const deps = pkg.dependencies || {};
    const nodeModulesDir = path.join(__dirname, 'node_modules');
    const missing = [];

    for (const depName of Object.keys(deps)) {
        const depPath = path.join(nodeModulesDir, depName);
        if (!fs.existsSync(depPath)) {
            missing.push(depName);
        }
    }

    const needsInstall = missing.length > 0;
    // Also check native binaries: packages may be present (dirs exist) but binaries
    // missing when a previous install was killed before Phase 2 (npm rebuild) ran.
    const needsRebuild = !needsInstall && !areNativeBinariesPresent(__dirname);

    if (needsInstall) {
        console.log(`[PREFLIGHT] Missing dependencies: ${missing.join(', ')}`);
    } else if (needsRebuild) {
        console.log('[PREFLIGHT] Packages present but native binaries missing. Running npm rebuild...');
    }

    if (needsInstall || needsRebuild) {
        const ok = await robustNpmInstall(__dirname, '[PREFLIGHT]');
        if (!ok) {
            console.error('[PREFLIGHT] Failed to install dependencies.');
            console.error('[PREFLIGHT] Please run "npm install --omit=optional" manually.');
            return false;
        }
    }

    return true;
}

/**
 * Validates that all critical source files and directories exist
 * @returns {boolean} True if all critical files are present
 */
function validateFiles() {
    const criticalFiles = [
        'src/index.js',
        'src/functions/utility/database.js',
        'src/i18n/index.js',
        'src/i18n/en.json',
    ];

    const criticalDirs = [
        'src/events',
        'src/handlers',
        'src/commands',
        'src/functions',
    ];

    let allPresent = true;

    for (const file of criticalFiles) {
        const filePath = path.join(__dirname, file);
        if (!fs.existsSync(filePath)) {
            console.error(`[PREFLIGHT] Missing critical file: ${file}`);
            allPresent = false;
        }
    }

    for (const dir of criticalDirs) {
        const dirPath = path.join(__dirname, dir);
        if (!fs.existsSync(dirPath)) {
            console.error(`[PREFLIGHT] Missing critical directory: ${dir}`);
            allPresent = false;
        }
    }

    // Ensure database directory exists
    const dbDir = path.join(__dirname, 'src', 'database');
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    // Ensure .env exists (will be populated on first run)
    const envPath = path.join(__dirname, 'src', '.env');
    if (!fs.existsSync(envPath)) {
        fs.writeFileSync(envPath, '', 'utf8');
    }

    return allPresent;
}

/**
 * Gets the current local version from package.json
 * @returns {string} Version string (e.g., "1.0.0")
 */
function getLocalVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        return pkg.version || '0.0.0';
    } catch {
        return '0.0.0';
    }
}

/**
 * Checks GitHub releases for available updates (non-blocking)
 * @returns {Promise<{available: boolean, latest: string, current: string, url: string}|null>}
 */
async function checkForUpdates() {
    try {
        const https = require('https');
        const data = await new Promise((resolve, reject) => {
            const req = https.get(GITHUB_API_URL, {
                headers: { 'User-Agent': 'WhiteoutSurvivalBot' }
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        resolve(JSON.parse(body));
                    } else {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(5000, () => { req.destroy(); resolve(null); });
        });

        if (!data || !data.tag_name) return null;

        const latestVersion = data.tag_name.replace(/^v/, '');
        const currentVersion = getLocalVersion();
        const available = compareVersions(latestVersion, currentVersion) > 0;

        return {
            available,
            latest: latestVersion,
            current: currentVersion,
            url: data.html_url || `https://github.com/${GITHUB_REPO}/releases`,
            body: data.body || ''
        };
    } catch {
        return null;
    }
}

/**
 * Compares two semver version strings
 * @param {string} a - Version A
 * @param {string} b - Version B
 * @returns {number} 1 if a > b, -1 if a < b, 0 if equal
 */
function compareVersions(a, b) {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const numA = partsA[i] || 0;
        const numB = partsB[i] || 0;
        if (numA > numB) return 1;
        if (numA < numB) return -1;
    }
    return 0;
}

/**
 * Calculates MD5 hash of a file for comparison
 * @param {string} filePath - Path to the file
 * @returns {string|null} MD5 hash or null if file doesn't exist
 */
function getFileHash(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        const crypto = require('crypto');
        const fileBuffer = fs.readFileSync(filePath);
        return crypto.createHash('md5').update(fileBuffer).digest('hex');
    } catch {
        return null;
    }
}

/**
 * Recursively copies files from source to destination, comparing hashes
 * @param {string} srcDir - Source directory
 * @param {string} destDir - Destination directory
 * @param {Set<string>} protectedPaths - Paths to skip (relative to destDir)
 * @returns {{updated: number, skipped: number, added: number}}
 */
function copyUpdatedFiles(srcDir, destDir, protectedPaths = new Set()) {
    let stats = { updated: 0, skipped: 0, added: 0 };

    if (!fs.existsSync(srcDir)) return stats;

    const entries = fs.readdirSync(srcDir, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);
        const relativePath = path.relative(destDir, destPath).replace(/\\/g, '/');

        // Skip protected paths
        if (protectedPaths.has(relativePath) || protectedPaths.has(entry.name)) {
            console.log(`[UPDATE] Skipping protected: ${relativePath}`);
            stats.skipped++;
            continue;
        }

        if (entry.isDirectory()) {
            // Skip certain directories entirely
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) {
                stats.skipped++;
                continue;
            }

            // Create directory if it doesn't exist
            if (!fs.existsSync(destPath)) {
                fs.mkdirSync(destPath, { recursive: true });
            }

            // Recursively copy directory contents
            const subStats = copyUpdatedFiles(srcPath, destPath, protectedPaths);
            stats.updated += subStats.updated;
            stats.skipped += subStats.skipped;
            stats.added += subStats.added;

        } else if (entry.isFile()) {
            const srcHash = getFileHash(srcPath);
            const destHash = getFileHash(destPath);

            if (!destHash) {
                // New file
                fs.copyFileSync(srcPath, destPath);
                console.log(`[UPDATE] Added: ${relativePath}`);
                stats.added++;
            } else if (srcHash !== destHash) {
                // File changed, update it
                fs.copyFileSync(srcPath, destPath);
                console.log(`[UPDATE] Updated: ${relativePath}`);
                stats.updated++;
            } else {
                // File unchanged, skip
                stats.skipped++;
            }
        }
    }

    return stats;
}

/**
 * Applies an update from the GitHub repository using ZIP download
 * Works without Git - downloads latest release and selectively updates files
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function applyUpdate() {
    const https = require('https');
    const updateZipPath = path.join(__dirname, 'update.zip');
    const updateExtractDir = path.join(__dirname, 'temp_update');

    try {
        // Save package.json hash before updating to detect dependency changes
        const pkgPath = path.join(__dirname, 'package.json');
        const pkgBefore = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, 'utf8') : '';

        console.log('\n[UPDATE] Downloading latest version from GitHub...');

        // Download ZIP file
        const zipUrl = `https://github.com/${GITHUB_REPO}/archive/refs/heads/main.zip`;
        await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(updateZipPath);
            https.get(zipUrl, (res) => {
                if (res.statusCode === 302 || res.statusCode === 301) {
                    // Follow redirect
                    https.get(res.headers.location, (redirectRes) => {
                        redirectRes.pipe(file);
                        file.on('finish', () => {
                            file.close();
                            console.log('[UPDATE] Download complete.');
                            resolve();
                        });
                    }).on('error', reject);
                } else {
                    res.pipe(file);
                    file.on('finish', () => {
                        file.close();
                        console.log('[UPDATE] Download complete.');
                        resolve();
                    });
                }
            }).on('error', (err) => {
                if (fs.existsSync(updateZipPath)) fs.unlinkSync(updateZipPath);
                reject(err);
            });
        });

        console.log('[UPDATE] Extracting update...');

        // Create extraction directory
        if (!fs.existsSync(updateExtractDir)) {
            fs.mkdirSync(updateExtractDir, { recursive: true });
        }

        // Extract using OS-appropriate method
        const platform = os.platform();
        try {
            if (platform === 'win32') {
                execSync(`powershell -Command "Expand-Archive -Path '${updateZipPath}' -DestinationPath '${updateExtractDir}' -Force"`, {
                    cwd: __dirname,
                    stdio: 'pipe'
                });
            } else if (platform === 'darwin' || platform === 'linux') {
                execSync(`unzip -q "${updateZipPath}" -d "${updateExtractDir}"`, {
                    cwd: __dirname,
                    stdio: 'pipe'
                });
            } else {
                throw new Error(`Unsupported platform: ${platform}`);
            }
        } catch (extractError) {
            throw new Error(`Failed to extract update: ${extractError.message}`);
        }

        // Find extracted root directory (GitHub creates a subfolder)
        const extractedContents = fs.readdirSync(updateExtractDir);
        if (extractedContents.length === 0) {
            throw new Error('Update archive is empty');
        }

        const extractedRoot = path.join(updateExtractDir, extractedContents[0]);

        console.log('[UPDATE] Comparing and updating files...');

        // Define protected paths that should never be overwritten
        const protectedPaths = new Set([
            'src/.env',
            'src/database',
            'src/database/database.db',
            '.env',
            'database.db',
            'node_modules',
            '.git',
            'update.zip',
            'temp_update'
        ]);

        // Copy updated files selectively
        const stats = copyUpdatedFiles(extractedRoot, __dirname, protectedPaths);

        console.log(`\n[UPDATE] Files updated: ${stats.updated}`);
        console.log(`[UPDATE] Files added: ${stats.added}`);
        console.log(`[UPDATE] Files skipped: ${stats.skipped}`);

        // Check if package.json changed and reinstall dependencies if needed
        const pkgAfter = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, 'utf8') : '';
        if (pkgBefore !== pkgAfter) {
            console.log('\n[UPDATE] Dependencies changed - installing new packages...');
            const ok = await robustNpmInstall(__dirname, '[UPDATE]');
            if (!ok) {
                console.warn('[UPDATE] Some packages may not have installed correctly. Run "npm install --omit=optional" if issues persist.');
            }
        } else {
            console.log('\n[UPDATE] No dependency changes detected - skipping npm install.');
        }

        try {
            const releaseInfo = await new Promise((resolve) => {
                const req = https.get(GITHUB_API_URL, { headers: { 'User-Agent': 'WhiteoutSurvivalBot' } }, (res) => {
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            try { resolve(JSON.parse(body)); } catch { resolve(null); }
                        } else {
                            resolve(null);
                        }
                    });
                });
                req.on('error', () => resolve(null));
                req.setTimeout(5000, () => { try { req.destroy(); } catch { }; resolve(null); });
            });

            if (releaseInfo && releaseInfo.tag_name) {
                const latestTag = releaseInfo.tag_name.replace(/^v/, '');
                try {
                    const localPkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : null;
                    if (localPkg && compareVersions(latestTag, localPkg.version || '0.0.0') > 0) {
                        localPkg.version = latestTag;
                        fs.writeFileSync(pkgPath, JSON.stringify(localPkg, null, 2) + '\n', 'utf8');
                        console.log(`[UPDATE] package.json version updated to ${latestTag} to reflect latest release tag.`);
                    }
                } catch (e) {
                    // Non-fatal - don't block the update process
                }
            }
        } catch (e) {
            // ignore errors here - this is a best-effort sync
        }

        // Cleanup
        console.log('\n[UPDATE] Cleaning up temporary files...');
        if (fs.existsSync(updateZipPath)) fs.unlinkSync(updateZipPath);
        if (fs.existsSync(updateExtractDir)) {
            fs.rmSync(updateExtractDir, { recursive: true, force: true });
        }

        return {
            success: true,
            message: `Update applied successfully! ${stats.updated} files updated, ${stats.added} files added. Restart the bot to apply changes.`
        };
    } catch (error) {
        // Cleanup on error
        try {
            if (fs.existsSync(updateZipPath)) fs.unlinkSync(updateZipPath);
            if (fs.existsSync(updateExtractDir)) {
                fs.rmSync(updateExtractDir, { recursive: true, force: true });
            }
        } catch (cleanupError) {
            // Ignore cleanup errors
        }

        return { success: false, message: `Update failed: ${error.message}` };
    }
}

// ============================================================
// NODE VERSION CHECK
// ============================================================

/**
 * Warns if the running Node.js version is known to break native modules.
 * better-sqlite3 fails to compile on Node 25+ due to V8 API changes.
 * Recommended: Node 18, 20, or 22 LTS.
 */
function checkNodeVersion() {
    const [major] = process.versions.node.split('.').map(Number);
    if (major >= 23) {
        console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.warn(`[WARNING] Node.js v${process.versions.node} detected.`);
        console.warn('[WARNING] Node 23+ breaks better-sqlite3 native compilation.');
        console.warn('[WARNING] Recommended: Node 18, 20, or 22 LTS.');
        console.warn('[WARNING] Install via: https://nodejs.org or nvm');
        console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        return false;
    }
    return true;
}

// ============================================================
// ROBUST NPM INSTALL
// ============================================================

/** Promisified spawn — child memory is independent of our V8 heap. */
function spawnAsync(cmd, args, opts) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { ...opts, shell: process.platform === 'win32' });
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`"${cmd} ${args.join(' ')}" exited with code ${code}`));
        });
        child.on('error', reject);
    });
}

/**
 * Like spawnAsync but captures stdout + stderr and attaches them to the
 * rejection error. Both pipes are drained continuously to avoid the
 * 64 KB pipe-buffer deadlock that occurs when using stdio:'pipe' with
 * spawn() and not reading the streams.
 */
function spawnCapture(cmd, args, opts) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            ...opts,
            shell: process.platform === 'win32',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else {
                const err = new Error(`"${cmd} ${args.join(' ')}" exited with code ${code}`);
                err.stdout = stdout;
                err.stderr = stderr;
                reject(err);
            }
        });
        child.on('error', reject);
    });
}

/** Simple sleep helper */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns the container's memory limit in MB.
 * On Linux, tries to read the cgroup limit (which reflects the actual
 * container cap) before falling back to os.totalmem() (which reports
 * the host's physical RAM and is therefore useless inside containers).
 */
function getEffectiveTotalMemMb() {
    if (process.platform === 'linux') {
        try {
            const cgroupText = fs.readFileSync('/proc/self/cgroup', 'utf8');
            const v2Match = cgroupText.match(/^0::(.*)$/m);
            const cgroupBase = '/sys/fs/cgroup';
            let searchPath = v2Match ? `${cgroupBase}${v2Match[1].trim()}` : cgroupBase;
            while (searchPath.length >= cgroupBase.length) {
                try {
                    const raw = fs.readFileSync(`${searchPath}/memory.max`, 'utf8').trim();
                    if (raw !== 'max') return Math.floor(Number(raw) / 1024 / 1024);
                } catch { /* not at this level, try parent */ }
                const parent = searchPath.substring(0, searchPath.lastIndexOf('/'));
                if (parent === searchPath) break;
                searchPath = parent;
            }
        } catch { /* /proc/self/cgroup not readable */ }

        // cgroup v1
        try {
            const bytes = Number(fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim());
            // cgroup v1 uses ~9.2 EB as the sentinel for "no limit"
            if (bytes < Number.MAX_SAFE_INTEGER / 2) return Math.floor(bytes / 1024 / 1024);
        } catch { /* not mounted */ }
    }
    return Math.floor(os.totalmem() / 1024 / 1024);
}

/**
 * Returns the container's free memory in MB.
 * Reads cgroup usage on Linux so the value reflects the container's
 * budget, not the host machine's available RAM.
 */
function getEffectiveFreeMemMb() {
    if (process.platform === 'linux') {
        const totalMb = getEffectiveTotalMemMb();
        // cgroup v2: try current-cgroup path first, then root
        try {
            const cgroupText = fs.readFileSync('/proc/self/cgroup', 'utf8');
            const v2Match = cgroupText.match(/^0::(.*)$/m);
            const searchPath = v2Match
                ? `/sys/fs/cgroup${v2Match[1].trim()}`
                : '/sys/fs/cgroup';
            const used = Math.floor(Number(fs.readFileSync(`${searchPath}/memory.current`, 'utf8').trim()) / 1024 / 1024);
            return Math.max(totalMb - used, 0);
        } catch { /* not mounted or process cgroup unreadable */ }
        try {
            const used = Math.floor(Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim()) / 1024 / 1024);
            return Math.max(totalMb - used, 0);
        } catch { /* not mounted */ }
        // cgroup v1
        try {
            const used = Math.floor(Number(fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8').trim()) / 1024 / 1024);
            return Math.max(totalMb - used, 0);
        } catch { /* not mounted */ }
        // Usage data unavailable: cap os.freemem() at the container limit so
        // the heap calculation never exceeds the container's total memory.
        return Math.min(Math.floor(os.freemem() / 1024 / 1024), totalMb);
    }
    return Math.floor(os.freemem() / 1024 / 1024);
}

/**
 * Calculates a safe --max-old-space-size for the npm subprocess.
 * On memory-constrained machines we leave more headroom so the OS
 * and other processes are not crowded out.
 */
function npmHeapMb() {
    const freeMb  = getEffectiveFreeMemMb();
    const totalMb = getEffectiveTotalMemMb();
    // Low-memory containers need a larger safety margin.
    const headroom = totalMb < 1024 ? 160 : 80;
    const min      = totalMb < 1024 ? 128 : 256;
    const max      = totalMb < 1024 ? 384 : 1024;
    return Math.min(Math.max(freeMb - headroom, min), max);
}

/**
 * Returns true when the machine is memory-constrained (< 1 GB total).
 * Used to show an informational log message during install.
 */
function isLowMemoryEnvironment() {
    return getEffectiveTotalMemMb() < 1024;
}


// Config entries written to .npmrc before every install.
// onnxruntime-node reads these to skip the ~500 MB CUDA provider download.
const REQUIRED_NPMRC_ENTRIES = {
    'onnxruntime-node-install': 'skip',       // primary flag (v1.20+)
    'onnxruntime-node-install-cuda': 'skip',  // legacy fallback (v1.24.3)
};

/**
 * Writes REQUIRED_NPMRC_ENTRIES into an .npmrc file, preserving existing keys.
 * @param {string} npmrcPath - Absolute path to the .npmrc file to update
 */
function writeNpmrcEntries(npmrcPath) {
    let lines = [];
    if (fs.existsSync(npmrcPath)) {
        try { lines = fs.readFileSync(npmrcPath, 'utf8').split(/\r?\n/); } catch { /* ignore */ }
    }
    for (const [key, value] of Object.entries(REQUIRED_NPMRC_ENTRIES)) {
        const pattern = new RegExp(`^\\s*${key}\\s*=`, 'i');
        const entry = `${key}=${value}`;
        const idx = lines.findIndex(l => pattern.test(l));
        if (idx >= 0) {
            lines[idx] = entry;
        } else {
            lines.push(entry);
        }
    }
    try {
        fs.writeFileSync(npmrcPath, lines.join('\n'), 'utf8');
    } catch (e) {
        process.stderr.write(`[warn] Could not write ${npmrcPath}: ${e.message}\n`);
    }
}

/**
 * Ensures that the required .npmrc entries are present in both the project
 * .npmrc and the user home .npmrc, so they are read by npm on all platforms.
 * @param {string} cwd - Project root directory (where package.json lives)
 */
function ensureNpmrc(cwd) {
    const projectNpmrc = path.join(cwd, '.npmrc');
    writeNpmrcEntries(projectNpmrc);

    // Also write to the user home .npmrc (~/.npmrc) when the project dir is
    // different from home, so the entries are picked up even when npm resolves
    // config from a different working directory.
    const homeNpmrc = path.join(os.homedir(), '.npmrc');
    if (path.resolve(homeNpmrc) !== path.resolve(projectNpmrc)) {
        writeNpmrcEntries(homeNpmrc);
    }
}

/**
 * Checks whether all top-level dependencies in package.json are already
 * installed in node_modules.  Uses `npm ls --depth=0` which exits 0 only
 * when every listed dep is present and valid.
 *
 * @param {string} cwd - Working directory
 * @param {object} env - Environment variables to pass to npm
 * @returns {Promise<boolean>}
 */
async function checkDepsInstalled(cwd, env) {
    try {
        await spawnCapture('npm', ['ls', '--depth=0', '--prefer-offline', '--no-audit'], { cwd, env });
        return true;
    } catch {
        return false;
    }
}

/**
 * Runs npm install with automatic retry.
 * @param {string} cwd     - Working directory (where package.json lives)
 * @param {string} context - Log prefix, e.g. '[PREFLIGHT]'
 * @returns {Promise<boolean>}
 */
async function robustNpmInstall(cwd, context) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 5000;
    const heapMb = npmHeapMb();
    const totalMb = getEffectiveTotalMemMb();
    const freeMb  = getEffectiveFreeMemMb();

    // Write onnxruntime-node CUDA-skip entries to both the project .npmrc and
    // the user home .npmrc so npm forwards them to lifecycle scripts.
    ensureNpmrc(cwd);

    const npmEnv = {
        ...process.env,
        NODE_OPTIONS: `--max-old-space-size=${heapMb}`,
        // Primary flag (onnxruntime-node v1.20+)
        ONNXRUNTIME_NODE_INSTALL: 'skip',
        npm_config_onnxruntime_node_install: 'skip',
        'npm_config_onnxruntime-node-install': 'skip',
        // Legacy CUDA-specific fallback (still checked in v1.24.3)
        ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip',
        npm_config_onnxruntime_node_install_cuda: 'skip',
        'npm_config_onnxruntime-node-install-cuda': 'skip',
    };

    const BASE_FLAGS = ['install', '--omit=optional', '--prefer-offline', '--no-audit', '--no-fund'];

    if (isLowMemoryEnvironment()) {
        console.log(`${context} Low-memory machine detected (${totalMb} MB total, ${freeMb} MB free, npm heap: ${heapMb} MB). Install may take multiple attempts...`);
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`${context} Running npm install (attempt ${attempt}/${MAX_RETRIES}, heap: ${heapMb} MB)...`);
            await spawnAsync('npm', BASE_FLAGS, { cwd, stdio: 'inherit', env: npmEnv });
            console.log(`${context} Dependencies installed successfully.\n`);
            return true;
        } catch (err) {
            console.warn(`${context} npm install attempt ${attempt} failed: ${err.message}`);

            if (await checkDepsInstalled(cwd, npmEnv)) {
                console.log(`${context} Install was interrupted but all packages are verified present. Continuing...\n`);
                return true;
            }

            if (attempt < MAX_RETRIES) {
                console.log(`${context} Retrying in ${RETRY_DELAY_MS / 1000}s...`);
                await sleep(RETRY_DELAY_MS);
                if (global.gc) global.gc();
            }
        }
    }

    // Final presence check after all retries are exhausted.
    if (await checkDepsInstalled(cwd, npmEnv)) {
        console.log(`${context} Packages verified present after final attempt. Continuing...\n`);
        return true;
    }

    console.error(`${context} Failed to install all dependencies after ${MAX_RETRIES} attempts.`);
    if (isLowMemoryEnvironment()) {
        console.error(`${context} Container has ${totalMb} MB RAM — npm needs ~400 MB peak memory to resolve the full dependency tree.`);
        console.error(`${context} Increase container RAM or run "npm install --omit=optional" manually on a higher-RAM machine.\n`);
    } else {
        console.error(`${context} Please run "npm install --omit=optional" manually to retry.\n`);
    }
    return false;
}




// ============================================================
// INSTALLER MODE: Auto-install from GitHub if only starter.js exists
// ============================================================

/**
 * Checks if the script is in installer mode (no package.json present)
 * @returns {boolean} True if installer mode should be activated
 */
function isInstallerMode() {
    return !fs.existsSync(path.join(__dirname, 'package.json'));
}

/**
 * Downloads the latest release ZIP from GitHub and extracts it
 * @returns {Promise<void>}
 */
async function downloadAndExtractZip() {
    const https = require('https');
    const zipUrl = `https://github.com/${GITHUB_REPO}/archive/refs/heads/main.zip`;
    const zipPath = path.join(__dirname, 'repo.zip');
    const extractDir = path.join(__dirname, 'temp_extract');

    console.log('[INSTALLER] Downloading repository from GitHub...');

    // Download ZIP file
    await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(zipPath);
        https.get(zipUrl, (res) => {
            if (res.statusCode === 302 || res.statusCode === 301) {
                // Follow redirect
                https.get(res.headers.location, (redirectRes) => {
                    redirectRes.pipe(file);
                    file.on('finish', () => {
                        file.close();
                        console.log('[INSTALLER] Download complete.');
                        resolve();
                    });
                }).on('error', reject);
            } else {
                res.pipe(file);
                file.on('finish', () => {
                    file.close();
                    console.log('[INSTALLER] Download complete.');
                    resolve();
                });
            }
        }).on('error', (err) => {
            fs.unlinkSync(zipPath);
            reject(err);
        });
    });

    console.log('[INSTALLER] Extracting files...');

    // Create extraction directory
    if (!fs.existsSync(extractDir)) {
        fs.mkdirSync(extractDir, { recursive: true });
    }

    // Extract using OS-appropriate method
    const platform = os.platform();
    try {
        if (platform === 'win32') {
            // Windows: Use PowerShell's Expand-Archive
            execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`, {
                cwd: __dirname,
                stdio: 'inherit'
            });
        } else if (platform === 'darwin' || platform === 'linux') {
            // macOS and Linux: Use unzip command (pre-installed on most systems)
            execSync(`unzip -q "${zipPath}" -d "${extractDir}"`, {
                cwd: __dirname,
                stdio: 'inherit'
            });
        } else {
            throw new Error(`Unsupported platform: ${platform}`);
        }
    } catch (error) {
        if (error.message.includes('unzip') || error.message.includes('not found')) {
            throw new Error(`ZIP extraction failed. Please install 'unzip' command:\n  - Ubuntu/Debian: sudo apt-get install unzip\n  - macOS: brew install unzip (usually pre-installed)\n  - Or manually extract the repository from: https://github.com/${GITHUB_REPO}`);
        }
        throw new Error(`Failed to extract ZIP: ${error.message}`);
    }

    // Move files from extracted folder to current directory
    const extractedContents = fs.readdirSync(extractDir);
    if (extractedContents.length === 0) {
        throw new Error('Extracted archive is empty');
    }

    // GitHub puts files in a subfolder named "<repo>-<branch>"
    const extractedRoot = path.join(extractDir, extractedContents[0]);
    const files = fs.readdirSync(extractedRoot);

    console.log('[INSTALLER] Moving files to workspace...');

    for (const file of files) {
        const srcPath = path.join(extractedRoot, file);
        const destPath = path.join(__dirname, file);

        // Skip if destination exists and is the same as source (avoid self-overwrite issues)
        if (fs.existsSync(destPath)) {
            fs.rmSync(destPath, { recursive: true, force: true });
        }

        fs.renameSync(srcPath, destPath);
    }

    // Cleanup
    console.log('[INSTALLER] Cleaning up temporary files...');
    fs.unlinkSync(zipPath);
    fs.rmSync(extractDir, { recursive: true, force: true });
}

/**
 * Installs the repository by downloading and extracting from GitHub
 * @returns {Promise<void>}
 */
async function installRepo() {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('   Whiteout Survival Bot - First Time Setup');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('[INSTALLER] No installation detected.');
    console.log('[INSTALLER] This will download and install the bot from GitHub.\n');

    // Check if directory has other files (besides starter.js and common temp files)
    const existingFiles = fs.readdirSync(__dirname).filter(f => {
        return f !== 'starter.js' &&
            f !== 'node_modules' &&
            !f.startsWith('.') &&
            f !== 'package-lock.json';
    });

    if (existingFiles.length > 0) {
        console.error('[INSTALLER] Warning: Directory contains other files:');
        existingFiles.forEach(f => console.error(`  - ${f}`));
        console.error('[INSTALLER] Please run in an empty directory with only starter.js.');
        console.error('[INSTALLER] Installation aborted to prevent data loss.\n');
        process.exit(1);
    }

    try {
        // Download and extract the repository
        await downloadAndExtractZip();

        console.log('\n[INSTALLER] Repository installed successfully!');
        console.log('\n[INSTALLER] Installing dependencies...\n');
        const ok = await robustNpmInstall(__dirname, '[INSTALLER]');
        if (!ok) {
            console.error('[INSTALLER] Failed to install dependencies.');
            console.error('[INSTALLER] Please run "npm install --omit=optional" manually.');
            process.exit(1);
        }

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('   Installation Complete!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('\n[INSTALLER] Restarting with the installed version...\n');

        // Restart the process to use the newly installed starter.js
        const child = spawn('node', [
            '--expose-gc',
            '--max-old-space-size=256',
            ...process.argv.slice(1)
        ], {
            stdio: 'inherit',
            cwd: __dirname
        });

        child.on('exit', (code) => {
            process.exit(code);
        });

        // Exit current process after spawning new one
        return;

    } catch (error) {
        console.error('\n[INSTALLER] Installation failed:', error.message);
        console.error('[INSTALLER] Please check your internet connection and try again.');
        console.error('[INSTALLER] You can also manually clone the repository from:');
        console.error(`[INSTALLER] https://github.com/${GITHUB_REPO}\n`);
        process.exit(1);
    }
}

// Check for installer mode BEFORE pre-flight checks
if (isInstallerMode()) {
    (async () => {
        await installRepo();
        // Process will restart after installation, so this won't continue
    })();
    return; // Exit current execution
}

// Run pre-flight checks and start bot inside an async context
(async () => {

// Run pre-flight checks
console.log('[PREFLIGHT] Running startup checks...');
checkNodeVersion();

if (!await checkDependencies()) {
    console.error('[PREFLIGHT] Dependency check failed. Exiting.');
    process.exit(1);
}

if (!validateFiles()) {
    console.error('[PREFLIGHT] File validation failed. Some files may be missing.');
    console.error('[PREFLIGHT] The bot may not function correctly.');
    // Don't exit - let the bot try to start anyway
}

console.log(`[PREFLIGHT] Version: ${getLocalVersion()}`);
console.log('[PREFLIGHT] All checks passed.\n');

// Load environment variables from src/.env
require('dotenv').config({ path: path.join(__dirname, 'src', '.env') });

/**
 * Discord Bot with Hot Reload System
 * Memory optimized automatically
 * 
 * Commands:
 * - reload <file>   : Hot reload specific file (Tab to autocomplete)
 * - reload files    : Reload all files without bot restart
 * - restart         : Full bot restart (clears all cache)
 * - exit            : Shutdown everything including starter.js
 * - usage           : Show RAM/storage usage and optimization status
 */

const INDEX_PATH = path.join(__dirname, 'src', 'index.js');
const SRC_DIR = path.join(__dirname, 'src');
const WORKSPACE_DIR = __dirname;

let botModule = null;
let botClient = null;
let fileMap = new Map(); // Maps relative paths -> full paths
let allRelativePaths = []; // Array of all relative paths for autocomplete

/**
 * Recursively scans directory and builds file map
 */
function buildFileMap() {
    fileMap.clear();
    allRelativePaths = [];

    function scanDirectory(dir) {
        if (!fs.existsSync(dir)) return;

        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    scanDirectory(fullPath);
                }
            } else if (entry.isFile() && entry.name.endsWith('.js')) {
                const relativePath = path.relative(SRC_DIR, fullPath).replace(/\\/g, '/');
                fileMap.set(relativePath.toLowerCase(), fullPath);
                allRelativePaths.push(relativePath);
            }
        }
    }

    scanDirectory(SRC_DIR);
    allRelativePaths.sort();
}

/**
 * Resolves user input to absolute file path (case-insensitive)
 */
function resolveFileInput(input) {
    const trimmed = input.trim().replace(/^['"]|['"]$/g, '');
    if (!trimmed) return null;

    // Normalize and lowercase for case-insensitive matching
    const normalized = trimmed.replace(/\\/g, '/').toLowerCase();

    // Direct match
    if (fileMap.has(normalized)) {
        return fileMap.get(normalized);
    }

    // Try adding .js extension
    if (!normalized.endsWith('.js')) {
        const withJs = `${normalized}.js`;
        if (fileMap.has(withJs)) {
            return fileMap.get(withJs);
        }
    }

    // Try partial match (user typed part of the path)
    for (const [key, fullPath] of fileMap.entries()) {
        if (key.includes(normalized) || key.endsWith(normalized)) {
            return fullPath;
        }
    }

    return null;
}

/**
 * Tab completion function for file paths
 */
function completer(line) {
    const trimmed = line.trim();

    // Only complete for "reload " commands
    if (!trimmed.startsWith('reload ')) {
        const commands = ['reload ', 'reload files', 'restart', 'exit', 'usage', 'update', 'version', 'token '];
        const hits = commands.filter(cmd => cmd.startsWith(trimmed));
        return [hits.length ? hits : commands, trimmed];
    }

    // Extract the file path part after "reload "
    const input = trimmed.slice(7).toLowerCase();

    if (!input) {
        // Show all files if no input yet
        return [allRelativePaths.slice(0, 20), input];
    }

    // Find matching paths (case-insensitive)
    const hits = allRelativePaths.filter(path =>
        path.toLowerCase().includes(input)
    );

    // If single exact match, return it with trailing space
    if (hits.length === 1) {
        return [[hits[0] + ' '], input];
    }

    return [hits.length ? hits : allRelativePaths, input];
}

/**
 * Clears require cache for a specific file
 */
function clearCache(filePath) {
    try {
        const resolved = require.resolve(filePath);
        if (require.cache[resolved]) {
            delete require.cache[resolved];
        }
    } catch (error) {
        // File not in cache, ignore
    }
}

/**
 * Hot reloads a specific file
 */
function hotReloadFile(filePath) {
    const relativePath = path.relative(SRC_DIR, filePath).replace(/\\/g, '/');
    console.log(`Reloading: ${relativePath}`);

    try {
        const isEvent = filePath.includes(path.join('src', 'events'));
        const isHandler = filePath.includes(path.join('src', 'handlers'));
        const isCommand = filePath.includes(path.join('src', 'commands'));

        if (isEvent) {
            botModule.unregisterEvent(filePath);
            clearCache(filePath);
            botModule.registerEvent(filePath);
        } else if (isHandler) {
            botModule.unregisterHandler(filePath);
            clearCache(filePath);
            botModule.registerHandler(filePath);
        } else if (isCommand) {
            botModule.unregisterCommand(filePath);
            clearCache(filePath);
            botModule.registerCommand(filePath);
        } else {
            clearCache(filePath);
            require(filePath);
        }

        console.log(`Successfully reloaded: ${relativePath}\n`);
    } catch (error) {
        console.error(`Failed to reload ${relativePath}:`, error.message);
        if (error.stack) {
            console.error(error.stack);
        }
        console.log('');
    }
}

/**
 * Reloads all files without restarting the bot
 */
async function reloadAllFiles() {
    console.log('️Reloading all files...\n');

    let successCount = 0;
    let failCount = 0;

    // Get all handler, event, and command paths
    const handlerPaths = botModule.getAllHandlerPaths ? botModule.getAllHandlerPaths() : [];
    const eventPaths = botModule.getAllEventPaths ? botModule.getAllEventPaths() : [];
    const commandPaths = botModule.getAllCommandPaths ? botModule.getAllCommandPaths() : [];

    // Reload handlers
    for (const handlerPath of handlerPaths) {
        try {
            botModule.unregisterHandler(handlerPath);
            clearCache(handlerPath);
            botModule.registerHandler(handlerPath);
            successCount++;
        } catch (error) {
            console.error(`Failed to reload handler: ${path.basename(handlerPath)}`);
            failCount++;
        }
    }

    // Reload events
    for (const eventPath of eventPaths) {
        try {
            botModule.unregisterEvent(eventPath);
            clearCache(eventPath);
            botModule.registerEvent(eventPath);
            successCount++;
        } catch (error) {
            console.error(`Failed to reload event: ${path.basename(eventPath)}`);
            failCount++;
        }
    }

    // Reload commands
    for (const commandPath of commandPaths) {
        try {
            botModule.unregisterCommand(commandPath);
            clearCache(commandPath);
            botModule.registerCommand(commandPath);
            successCount++;
        } catch (error) {
            console.error(`Failed to reload command: ${path.basename(commandPath)}`);
            failCount++;
        }
    }

    // Reload i18n files BEFORE clearing cache
    try {
        const i18nPath = path.join(SRC_DIR, 'i18n', 'index.js');
        const i18nModule = require(i18nPath);
        if (typeof i18nModule.reload === 'function') {
            i18nModule.reload();
            successCount++;
        }
    } catch (error) {
        console.error('Failed to reload i18n files:', error.message);
        failCount++;
    }

    // Clear cache for all other files in src
    for (const fullPath of fileMap.values()) {
        clearCache(fullPath);
    }

    // Re-initialize notification scheduler after reload
    try {
        if (botClient) {
            const { initializeNotificationScheduler } = require(path.join(SRC_DIR, 'functions', 'Notification', 'notificationScheduler'));
            await initializeNotificationScheduler(botClient);
            console.log('Notification scheduler re-initialized');
        }
    } catch (error) {
        console.error('Failed to re-initialize notification scheduler:', error.message);

        // Re-initialize backup scheduler after reload
        try {
            if (botClient) {
                const { initializeBackupScheduler } = require(path.join(SRC_DIR, 'functions', 'settings', 'DBManager', 'backupScheduler'));
                initializeBackupScheduler(botClient);
                console.log('Backup scheduler re-initialized');
            }
        } catch (error) {
            console.error('Failed to re-initialize backup scheduler:', error.message);
        }
    }

    console.log(`\nReload complete: ${successCount} files reloaded, ${failCount} failed\n`);
}

/**
 * Starts the bot by requiring index.js
 */
function startBot() {
    try {
        // Clear the cache for index.js
        if (require.cache[INDEX_PATH]) {
            delete require.cache[INDEX_PATH];
        }

        // Require the bot module
        botModule = require(INDEX_PATH);
        botClient = botModule.client;

        // Build file map after bot loads
        buildFileMap();

    } catch (error) {
        console.error('Failed to start bot:', error);
        process.exit(1);
    }
}

/**
 * Full restart - destroys client, clears ALL cache, and restarts
 * This fixes issues with cached function references
 */
async function restartBot() {
    try {
        console.log('Restarting bot (full cache clear)...\n');

        // Cancel any pending notification timeouts before destroying the client.
        try {
            const { notificationScheduler } = require('./src/functions/Notification/notificationScheduler');
            notificationScheduler.cleanup();
        } catch { /* ignore — scheduler may not be loaded yet */ }

        // Cancel any pending auto-clean intervals before destroying the client.
        try {
            const { autoCleanScheduler } = require('./src/functions/Players/idChannelAutoClean');
            autoCleanScheduler.cleanup();
        } catch { /* ignore — scheduler may not be loaded yet */ }

        // Destroy the current client
        if (botClient) {
            console.log('Disconnecting client...');
            await botClient.destroy();
            botClient = null;
            botModule = null;
        }

        // Clear ALL cached modules (not just src directory)
        const cacheKeys = Object.keys(require.cache);
        for (const key of cacheKeys) {
            // Don't clear starter.js itself or node_modules
            if (!key.includes('node_modules') && key !== __filename) {
                delete require.cache[key];
            }
        }

        console.log('Cleared all module cache');

        // Wait for cleanup
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Restart the bot
        startBot();

        console.log('Restart complete\n');
    } catch (error) {
        console.error('Failed to restart:', error);
        console.log('Attempting emergency restart...\n');

        try {
            startBot();
        } catch (startError) {
            console.error('Emergency restart failed:', startError);
            process.exit(1);
        }
    }
}

/**
 * Shows storage and RAM usage
 */
function showUsage() {
    console.log('\nResource Usage');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // RAM Usage
    const processMemory = process.memoryUsage();
    const totalSystemMem = os.totalmem();
    const usedMB = (processMemory.rss / 1024 / 1024).toFixed(1);
    const heapUsedMB = (processMemory.heapUsed / 1024 / 1024).toFixed(1);
    const heapTotalMB = (processMemory.heapTotal / 1024 / 1024).toFixed(1);
    const totalMB = (totalSystemMem / 1024 / 1024).toFixed(0);

    console.log(`\nRAM: ${usedMB}MB / ${totalMB}MB`);
    console.log(`Heap: ${heapUsedMB}MB used / ${heapTotalMB}MB allocated`);

    // GC Status
    const gcEnabled = global.gc ? 'Enabled' : 'Disabled';
    const gcHint = global.gc ? '' : ' (restart with --expose-gc)';
    console.log(`Manual GC: ${gcEnabled}${gcHint}`);

    // Heap limit display
    const heapLimitHint = !global.gc ? ' (use --max-old-space-size=256 to limit)' : '';
    console.log(`Heap Limit: ~${heapTotalMB}MB${heapLimitHint}`);

    // Storage Usage - Calculate total workspace size
    console.log('\nCalculating workspace storage...');

    let totalSize = 0;

    function calculateSize(dirPath, excludeNodeModules = false) {
        if (!fs.existsSync(dirPath)) return 0;

        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        let size = 0;

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);

            try {
                if (entry.isDirectory()) {
                    // Skip node_modules if flag is set
                    if (excludeNodeModules && entry.name === 'node_modules') {
                        continue;
                    }
                    // Skip hidden directories
                    if (!entry.name.startsWith('.')) {
                        size += calculateSize(fullPath, excludeNodeModules);
                    }
                } else if (entry.isFile()) {
                    size += fs.statSync(fullPath).size;
                }
            } catch (err) {
                // Skip inaccessible files/folders
            }
        }

        return size;
    }

    // Calculate total workspace size (including everything)
    totalSize = calculateSize(WORKSPACE_DIR, false);
    const totalSizeMB = (totalSize / 1024 / 1024).toFixed(1);

    console.log(`Total Workspace: ${totalSizeMB}MB`);

    // Database size if exists (shown separately for reference)
    const dbPath = path.join(__dirname, 'src', 'database', 'database.db');
    if (fs.existsSync(dbPath)) {
        const dbStats = fs.statSync(dbPath);
        const dbMB = (dbStats.size / 1024 / 1024).toFixed(1);
        console.log(`Database: ${dbMB}MB`);
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

/**
 * Sets up the command interface with tab completion
 */
function setupCommandInterface() {
    if (!process.stdin.isTTY) {
        console.log('Not running in a TTY, commands disabled');
        return;
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
        completer: completer,
        prompt: '> '
    });

    // Expose a shared prompt function so other modules can reuse the same readline
    // This prevents multiple readline interfaces from interfering with each other
    global.__sharedReadline = rl;
    global.promptLine = function (question) {
        return new Promise((resolve) => {
            rl.question(question, (answer) => resolve(answer));
        });
    };

    console.log('Discord Bot - Hot Reload System');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Commands:');
    console.log('  reload <file>   - Hot reload file (Tab to autocomplete)');
    console.log('  reload files    - Reload all files without restart');
    console.log('  restart         - Full bot restart (clears all cache)');
    console.log('  usage           - Show RAM/storage usage and GC status');
    console.log('  token [TOKEN]   - Update saved Discord token and restart bot');
    console.log('  update          - Check for and apply updates from GitHub');
    console.log('  version         - Show current bot version');
    console.log('  exit            - Shutdown everything');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Non-blocking update check on startup
    checkForUpdates().then(updateInfo => {
        if (updateInfo && updateInfo.available) {
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log(`[UPDATE] New version available: v${updateInfo.latest} (current: v${updateInfo.current})`);
            console.log(`[UPDATE] Run "update" to apply, or visit: ${updateInfo.url}`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
            rl.prompt();
        }
    }).catch(() => { });

    rl.prompt();

    rl.on('line', async (line) => {
        const trimmed = line.trim();

        if (!trimmed) {
            rl.prompt();
            return;
        }

        const lower = trimmed.toLowerCase();

        // Handle token command or bare token input
        const tokenCmdMatch = trimmed.match(/^token(?:\s+(.+))?$/i);
        const bareTokenMatch = !trimmed.includes(' ') && /^[A-Za-z0-9_\-.]{20,}$/.test(trimmed);
        if (tokenCmdMatch || bareTokenMatch) {
            let newToken = null;
            if (tokenCmdMatch) {
                newToken = tokenCmdMatch[1] ? tokenCmdMatch[1].trim() : null;
            } else if (bareTokenMatch) {
                newToken = trimmed;
            }

            if (!newToken) {
                // Print the instruction on its own line — container consoles
                // (Pterodactyl, Docker) often don't echo typed characters,
                // so the prompt must be visible above the input field.
                console.log('');
                console.log('Paste your Discord bot token below and press Enter:');
                rl.question('> ', async (answer) => {
                    const token = answer && answer.trim();
                    if (!token) {
                        console.log('No token provided.');
                        rl.prompt();
                        return;
                    }
                    // Persist token to src/.env
                    try {
                        const envPath = path.join(__dirname, 'src', '.env');
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
                        process.env.TOKEN = token;
                        console.log('Token saved. Restarting bot...');
                        await restartBot();
                    } catch (e) {
                        console.error('Failed to save token:', e.message);
                    }
                    rl.prompt();
                });
                return;
            }

            // We have newToken string - persist and restart
            try {
                const envPath = path.join(__dirname, 'src', '.env');
                let content = '';
                if (fs.existsSync(envPath)) content = fs.readFileSync(envPath, 'utf8');
                const lines = content.split(/\r?\n/);
                let found = false;
                for (let i = 0; i < lines.length; i++) {
                    if (/^\s*TOKEN\s*=/.test(lines[i])) {
                        lines[i] = `TOKEN=${newToken}`;
                        found = true;
                        break;
                    }
                }
                if (!found) lines.unshift(`TOKEN=${newToken}`);
                fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
                process.env.TOKEN = newToken;
                console.log('Token saved. Restarting bot...');
                await restartBot();
            } catch (e) {
                console.error('Failed to save token:', e.message);
            }

            rl.prompt();
            return;
        }

        // Handle "reload files" command
        if (lower === 'reload files') {
            reloadAllFiles();
            rl.prompt();
            return;
        }

        // Handle "reload <file>" command
        if (lower.startsWith('reload ')) {
            const target = trimmed.slice(7).trim();

            if (!target) {
                console.log('Specify a file to reload\n');
                rl.prompt();
                return;
            }

            const resolvedPath = resolveFileInput(target);

            if (!resolvedPath) {
                console.log(`File not found: "${target}"`);
                console.log('Use Tab to autocomplete file paths\n');
                rl.prompt();
                return;
            }

            hotReloadFile(resolvedPath);
            rl.prompt();
            return;
        }

        // Handle "restart" command
        if (lower === 'restart') {
            await restartBot();
            rl.prompt();
            return;
        }

        // Handle "usage" command
        if (lower === 'usage') {
            showUsage();
            rl.prompt();
            return;
        }

        // Handle "version" command
        if (lower === 'version') {
            console.log(`\nBot Version: v${getLocalVersion()}\n`);
            rl.prompt();
            return;
        }

        // Handle "update" command
        if (lower === 'update') {
            console.log('\nChecking for updates...');
            try {
                const updateInfo = await checkForUpdates();
                if (!updateInfo) {
                    console.log('Could not check for updates (no internet or GitHub API unavailable).\n');
                } else if (!updateInfo.available) {
                    console.log(`Already on the latest version (v${updateInfo.current}).\n`);
                } else {
                    console.log(`New version available: v${updateInfo.latest} (current: v${updateInfo.current})`);
                    rl.question('Apply update now? (y/n): ', async (answer) => {
                        if (answer.trim().toLowerCase() === 'y') {
                            const result = await applyUpdate();
                            console.log(`\n${result.message}`);
                            if (result.success) {
                                console.log('Restarting bot...\n');
                                await restartBot();
                            }
                        } else {
                            console.log('Update skipped.\n');
                        }
                        rl.prompt();
                    });
                    return;
                }
            } catch (error) {
                console.log(`Update check failed: ${error.message}\n`);
            }
            rl.prompt();
            return;
        }

        // Handle "exit" command
        if (lower === 'exit' || lower === 'quit') {
            console.log('\nShutting down...\n');
            if (botClient) {
                await botClient.destroy();
            }
            rl.close();
            process.exit(0);
        }

        // Unknown command
        console.log(`Unknown command: "${trimmed}"`);
        console.log('Available: reload <file>, reload files, restart, usage, exit\n');
        rl.prompt();
    });

    rl.on('SIGINT', async () => {
        console.log('\nShutting down...\n');
        if (botClient) {
            await botClient.destroy();
        }
        // clear shared prompt before closing
        if (global.promptLine) delete global.promptLine;
        if (global.__sharedReadline) delete global.__sharedReadline;
        rl.close();
        process.exit(0);
    });
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

// Expose functions globally for programmatic use (e.g., settings panel auto-update)
global.restartBot = restartBot;
global.checkForUpdates = checkForUpdates;
global.applyUpdate = applyUpdate;
global.getLocalVersion = getLocalVersion;

// Setup command interface (show commands first so prompts appear underneath)
setupCommandInterface();

// Start the bot after the command UI is ready
startBot();

})(); // end async startup IIFE