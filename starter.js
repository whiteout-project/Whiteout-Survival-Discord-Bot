const readline = require('readline');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

// ============================================================
// DOCKER DETECTION
// Set early so all downstream code can check global.isDocker
// ============================================================
const isDocker = !!(process.env.DOCKER_CONTAINER || (function () {
    try { return fs.existsSync('/.dockerenv'); } catch { return false; }
})());
global.isDocker = isDocker;

// ============================================================
// PARENT / CHILD WRAPPER
// When running as the parent (no STARTER_CHILD env), spawn self
// as a child process. This allows full restarts & self-updates
// without killing the parent — the parent just respawns the child.
// Docker handles restarts via restart policy -- skip the wrapper.
// ============================================================
if (!isDocker && !process.env.STARTER_CHILD) {
    // Detect old parent (pre-1.0.23): it sets FULL_SELF_UPDATE but not STARTER_CHILD.
    // Let the bot start so ready.js can DM the owner, then exit.
    if (process.env.FULL_SELF_UPDATE === '1') {
        process.env.OLD_PARENT_DETECTED = '1';
    } else {
        const isDevMode = process.argv.includes('--dev');
        const userArgs = process.argv.slice(2); // args after "starter.js"

        // Ensure --expose-gc and --max-old-space-size are present
        const nodeFlags = [...process.execArgv];
        if (!nodeFlags.some(f => f.includes('expose-gc'))) nodeFlags.push('--expose-gc');
        if (!nodeFlags.some(f => f.includes('max-old-space-size'))) nodeFlags.push('--max-old-space-size=256');

        function spawnChild() {
            const child = spawn(process.execPath, [...nodeFlags, __filename, ...userArgs], {
                stdio: 'inherit',
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    STARTER_CHILD: '1',
                    FULL_SELF_UPDATE: '1',
                    ...(isDevMode ? { WOSLAND_DEV_MODE: '1' } : {})
                }
            });

            child.on('exit', (code) => {
                if (code === 42) {
                    console.log('[LAUNCHER] Respawning with updated code...\n');
                    spawnChild();
                } else if (code === 43) {
                    // starter.js itself was updated — re-exec the parent so it loads the new file from disk
                    console.log('[LAUNCHER] starter.js updated — re-launching from disk...\n');
                    const freshEnv = { ...process.env };
                    delete freshEnv.STARTER_CHILD;
                    delete freshEnv.FULL_SELF_UPDATE;
                    const fresh = spawn(process.execPath, [...process.execArgv, __filename, ...userArgs], {
                        stdio: 'inherit',
                        cwd: process.cwd(),
                        env: freshEnv
                    });
                    fresh.on('exit', (c) => process.exit(c ?? 1));
                } else {
                    process.exit(code ?? 1);
                }
            });
        }
        spawnChild();
        return;
    }
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
        const depPkgJson = path.join(nodeModulesDir, depName, 'package.json');
        if (!fs.existsSync(depPkgJson)) {
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

    if (needsInstall) {
        const ok = await robustNpmInstall(__dirname, '[PREFLIGHT]', { preferCleanInstall: true });
        if (!ok) {
            console.error('[PREFLIGHT] Failed to install dependencies.');
            console.error('[PREFLIGHT] Please run "npm install --omit=optional" manually.');
            return false;
        }
    } else if (needsRebuild) {
        try {
            const heapMb = npmHeapMb();
            const rebuildEnv = { ...process.env, NODE_OPTIONS: `--max-old-space-size=${heapMb}` };
            await spawnAsync('npm', ['rebuild', 'better-sqlite3'], { cwd: __dirname, stdio: 'inherit', env: rebuildEnv });
            console.log('[PREFLIGHT] Native binaries rebuilt successfully.\n');
        } catch (rebuildError) {
            console.warn(`[PREFLIGHT] Targeted rebuild failed: ${rebuildError.message}`);
            console.log('[PREFLIGHT] Falling back to full npm install...');
            const ok = await robustNpmInstall(__dirname, '[PREFLIGHT]', { preferCleanInstall: true });
            if (!ok) {
                console.error('[PREFLIGHT] Failed to install dependencies.');
                console.error('[PREFLIGHT] Please run "npm install --omit=optional" manually.');
                return false;
            }
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
            body: data.body || '',
            assets: (data.assets || []).map(a => ({ name: a.name, url: a.browser_download_url }))
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
 * @returns {{updated: number, skipped: number, added: number, failed: number, starterChanged: boolean}}
 */
function copyUpdatedFiles(srcDir, destDir, protectedPaths = new Set()) {
    let stats = { updated: 0, skipped: 0, added: 0, failed: 0, starterChanged: false };

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
            stats.failed += subStats.failed;
            if (subStats.starterChanged) stats.starterChanged = true;

        } else if (entry.isFile()) {
            const srcHash = getFileHash(srcPath);
            const destHash = getFileHash(destPath);

            if (!destHash) {
                // New file
                try {
                    fs.copyFileSync(srcPath, destPath);
                    console.log(`[UPDATE] Added: ${relativePath}`);
                    stats.added++;
                    if (entry.name === 'starter.js') stats.starterChanged = true;
                } catch (err) {
                    console.error(`[UPDATE] Failed to add ${relativePath}: ${err.message}`);
                    stats.failed++;
                }
            } else if (srcHash !== destHash) {
                // File changed, update it
                try {
                    fs.copyFileSync(srcPath, destPath);
                    console.log(`[UPDATE] Updated: ${relativePath}`);
                    stats.updated++;
                    if (entry.name === 'starter.js') stats.starterChanged = true;
                } catch (err) {
                    console.error(`[UPDATE] Failed to update ${relativePath}: ${err.message}`);
                    stats.failed++;
                }
            } else {
                // File unchanged, skip
                stats.skipped++;
            }
        }
    }

    return stats;
}

// ============================================================
// ZIP DOWNLOAD & EXTRACTION HELPERS
// ============================================================

const ZIP_MAGIC_BYTES = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
const MIN_ZIP_SIZE = 1024;

/**
 * Verifies that a file is a valid ZIP archive by checking magic bytes and minimum size.
 * @param {string} zipPath - Path to the ZIP file
 * @throws {Error} If the file is not a valid ZIP
 */
function verifyZipIntegrity(zipPath) {
    const stats = fs.statSync(zipPath);
    if (stats.size < MIN_ZIP_SIZE) {
        throw new Error(`Downloaded ZIP is too small (${stats.size} bytes) — likely corrupted or empty`);
    }
    const header = Buffer.alloc(4);
    const fd = fs.openSync(zipPath, 'r');
    try {
        fs.readSync(fd, header, 0, 4, 0);
    } finally {
        fs.closeSync(fd);
    }
    if (!header.subarray(0, 4).equals(ZIP_MAGIC_BYTES)) {
        throw new Error('Downloaded file is not a valid ZIP archive');
    }
}

/**
 * Downloads a file from a URL, following up to maxRedirects HTTP redirects.
 * @param {string} url - URL to download
 * @param {string} destPath - Destination file path
 * @param {number} [maxRedirects=5] - Maximum number of redirects to follow
 * @returns {Promise<void>}
 */
function downloadFile(url, destPath, maxRedirects = 5) {
    const https = require('https');
    return new Promise((resolve, reject) => {
        function follow(currentUrl, redirectsLeft) {
            https.get(currentUrl, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
                    return follow(res.headers.location, redirectsLeft - 1);
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`Download failed with HTTP ${res.statusCode}`));
                }
                const file = fs.createWriteStream(destPath);
                res.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
                file.on('error', (err) => {
                    file.close();
                    try { fs.unlinkSync(destPath); } catch { /* ignore */ }
                    reject(err);
                });
            }).on('error', (err) => {
                try { fs.unlinkSync(destPath); } catch { /* ignore */ }
                reject(err);
            });
        }
        follow(url, maxRedirects);
    });
}

/**
 * Attempts extraction using the bundled 7zip-bin binary via node-7z.
 * @param {string} zipPath - Path to the ZIP file
 * @param {string} extractDir - Directory to extract into
 * @returns {Promise<void>}
 */
async function extractWith7z(zipPath, extractDir) {
    const Seven = require('node-7z');
    const { acquire7z } = require('./src/functions/utility/ensure7zip');
    const { binPath, cleanupPath } = await acquire7z(extractDir);
    if (!binPath) {
        throw new Error('No 7-Zip binary available');
    }
    try {
        await new Promise((resolve, reject) => {
            const stream = Seven.extractFull(zipPath, extractDir, { $bin: binPath });
            stream.on('end', resolve);
            stream.on('error', reject);
        });
    } finally {
        if (cleanupPath) {
            try { fs.unlinkSync(cleanupPath); } catch { /* ignore */ }
        }
    }
}

/**
 * Extracts a ZIP file using the platform-appropriate method.
 * On Linux/macOS, tries unzip first, then falls back to the bundled 7-zip binary.
 * @param {string} zipPath - Path to the ZIP file
 * @param {string} extractDir - Directory to extract into
 * @param {string} [stdio='pipe'] - stdio option for the extraction subprocess
 * @returns {Promise<void>}
 */
async function extractZip(zipPath, extractDir, stdio = 'pipe') {
    if (!fs.existsSync(extractDir)) {
        fs.mkdirSync(extractDir, { recursive: true });
    }
    const platform = os.platform();

    if (platform === 'win32') {
        execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`, {
            cwd: __dirname,
            stdio
        });
        return;
    }

    if (platform === 'darwin' || platform === 'linux') {
        try {
            execSync(`unzip -q "${zipPath}" -d "${extractDir}"`, {
                cwd: __dirname,
                stdio
            });
            return;
        } catch (unzipError) {
            const isNotFound = unzipError.message.includes('unzip') || unzipError.message.includes('not found');
            if (!isNotFound) {
                throw new Error(`Failed to extract update: ${unzipError.message}`);
            }
            // unzip not installed -- fall through to 7-zip
        }

        try {
            await extractWith7z(zipPath, extractDir);
            return;
        } catch (sevenError) {
            throw new Error(
                `ZIP extraction failed. Neither 'unzip' nor the bundled 7-zip binary worked.\n` +
                `  Install unzip: sudo apt-get install unzip\n` +
                `  7-zip error: ${sevenError.message}`
            );
        }
    }

    throw new Error(`Unsupported platform: ${platform}`);
}

/**
 * Finds the root directory inside an extracted GitHub ZIP archive.
 * GitHub creates a single subfolder named "<repo>-<branch>".
 * @param {string} extractDir - Directory where the ZIP was extracted
 * @returns {string} Path to the extracted root directory
 */
function getExtractedRoot(extractDir) {
    const contents = fs.readdirSync(extractDir);
    if (contents.length === 0) {
        throw new Error('Extracted archive is empty');
    }
    return path.join(extractDir, contents[0]);
}

/**
 * Cleans up temporary ZIP and extraction directory files.
 * @param {string[]} paths - Paths to clean up
 */
function cleanupTempFiles(...paths) {
    for (const filePath of paths) {
        try {
            if (!fs.existsSync(filePath)) continue;
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {
                fs.rmSync(filePath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(filePath);
            }
        } catch { /* ignore cleanup errors */ }
    }
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

        const zipUrl = `https://github.com/${GITHUB_REPO}/archive/refs/heads/main.zip`;
        await downloadFile(zipUrl, updateZipPath);
        console.log('[UPDATE] Download complete.');

        verifyZipIntegrity(updateZipPath);
        console.log('[UPDATE] Extracting update...');
        await extractZip(updateZipPath, updateExtractDir);

        const extractedRoot = getExtractedRoot(updateExtractDir);

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
            'temp_update',
            'plugins'
        ]);

        // Copy updated files selectively
        const stats = copyUpdatedFiles(extractedRoot, __dirname, protectedPaths);

        console.log(`\n[UPDATE] Files updated: ${stats.updated}`);
        console.log(`[UPDATE] Files added: ${stats.added}`);
        console.log(`[UPDATE] Files skipped: ${stats.skipped}`);
        if (stats.failed > 0) {
            console.log(`[UPDATE] Files failed: ${stats.failed} (these files may need manual update)`);
        }

        // Check if package.json changed and reinstall dependencies if needed
        const pkgAfter = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, 'utf8') : '';
        if (pkgBefore !== pkgAfter) {
            console.log('\n[UPDATE] Dependencies changed - installing new packages...');
            const ok = await robustNpmInstall(__dirname, '[UPDATE]', { isUpdate: true });
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
        cleanupTempFiles(updateZipPath, updateExtractDir);

        // If starter.js itself was updated and parent supports self-update loop, exit with code 43 to trigger full re-launch
        if (stats.starterChanged) {
            if (process.env.FULL_SELF_UPDATE === '1') {
                console.log('\n[UPDATE] starter.js was updated — full re-launch to apply entry-point changes...');
                setTimeout(() => process.exit(43), 500);
                const failMsg = stats.failed > 0 ? ` ${stats.failed} files failed to update.` : '';
                return {
                    success: true,
                    restartHandled: true,
                    message: `Update applied successfully! ${stats.updated} files updated, ${stats.added} files added.${failMsg} starter.js changed — restarting automatically...`
                };
            } else {
                console.log('\n[UPDATE] starter.js was updated — a full manual restart is required to apply entry-point changes.');
            }
        }

        const failMsg = stats.failed > 0 ? ` ${stats.failed} files failed to update.` : '';
        return {
            success: stats.failed === 0,
            message: `Update applied! ${stats.updated} files updated, ${stats.added} files added.${failMsg} Restart the bot to apply changes.`
        };
    } catch (error) {
        cleanupTempFiles(updateZipPath, updateExtractDir);

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
 * Resolves the cgroup v2 directory path for this process.
 * @returns {string|null} The cgroup path, or null if not on cgroup v2
 */
function getCgroupV2Path() {
    try {
        const cgroupText = fs.readFileSync('/proc/self/cgroup', 'utf8');
        const v2Match = cgroupText.match(/^0::(.*)$/m);
        return v2Match ? `/sys/fs/cgroup${v2Match[1].trim()}` : '/sys/fs/cgroup';
    } catch {
        return null;
    }
}

/**
 * Returns the container's memory limit in MB.
 * On Linux, tries to read the cgroup limit (which reflects the actual
 * container cap) before falling back to os.totalmem() (which reports
 * the host's physical RAM and is therefore useless inside containers).
 */
function getEffectiveTotalMemMb() {
    if (process.platform === 'linux') {
        // cgroup v2: walk up from the process cgroup to find memory.max
        let searchPath = getCgroupV2Path();
        const cgroupBase = '/sys/fs/cgroup';
        while (searchPath && searchPath.length >= cgroupBase.length) {
            try {
                const raw = fs.readFileSync(`${searchPath}/memory.max`, 'utf8').trim();
                if (raw !== 'max') return Math.floor(Number(raw) / 1024 / 1024);
            } catch { /* not at this level, try parent */ }
            const parent = searchPath.substring(0, searchPath.lastIndexOf('/'));
            if (parent === searchPath) break;
            searchPath = parent;
        }

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
        // cgroup v2: read memory.current from process cgroup path
        const cgroupPath = getCgroupV2Path();
        if (cgroupPath) {
            try {
                const used = Math.floor(Number(fs.readFileSync(`${cgroupPath}/memory.current`, 'utf8').trim()) / 1024 / 1024);
                return Math.max(totalMb - used, 0);
            } catch { /* not mounted */ }
            // Fallback: try cgroup root
            try {
                const used = Math.floor(Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim()) / 1024 / 1024);
                return Math.max(totalMb - used, 0);
            } catch { /* not mounted */ }
        }
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

/**
 * Returns available disk space in MB for the given directory.
 * Works on Linux containers (reads df), Windows (wmic), and macOS (df).
 * @param {string} dir - Directory to check disk space for
 * @returns {number|null} Available MB, or null if detection fails
 */
function getAvailableDiskSpaceMb(dir) {
    try {
        if (process.platform === 'win32') {
            const drive = path.resolve(dir).slice(0, 2);
            const output = execSync(`wmic logicaldisk where "DeviceID='${drive}'" get FreeSpace /value`, { encoding: 'utf8' });
            const match = output.match(/FreeSpace=(\d+)/);
            if (match) return Math.floor(parseInt(match[1], 10) / 1024 / 1024);
        } else {
            const output = execSync(`df -Pm "${dir}" 2>/dev/null | tail -1`, { encoding: 'utf8' });
            const columns = output.trim().split(/\s+/);
            if (columns.length >= 4) return parseInt(columns[3], 10);
        }
    } catch {
        // Detection failed -- return null so callers can fall through gracefully
    }
    return null;
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
 * Runs npm install (or npm ci for clean installs) with automatic retry.
 * For updates, uses `npm install` (incremental) to avoid re-downloading everything.
 * For fresh installs, uses `npm ci` when lockfile exists for deterministic installs.
 * If disk space is too low for `npm ci`, falls back to `npm install` automatically.
 * Cleans npm cache after successful install to reclaim disk space.
 * @param {string} cwd     - Working directory (where package.json lives)
 * @param {string} context - Log prefix, e.g. '[PREFLIGHT]'
 * @param {Object} [options]
 * @param {boolean} [options.preferCleanInstall=false] - Use `npm ci` when package-lock.json exists
 * @param {boolean} [options.isUpdate=false] - When true, forces `npm install` (incremental) instead of `npm ci`
 * @returns {Promise<boolean>}
 */
async function robustNpmInstall(cwd, context, { preferCleanInstall = false, isUpdate = false } = {}) {
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

    const hasLockfile = fs.existsSync(path.join(cwd, 'package-lock.json'));

    // Determine npm command: updates always use `install` (incremental).
    // Fresh installs prefer `ci` but fall back to `install` when disk is tight.
    let useCleanInstall = !isUpdate && preferCleanInstall && hasLockfile;

    // Disk space safety: npm ci deletes node_modules and re-downloads everything,
    // needing ~600 MB free. If disk is tight, fall back to npm install (incremental).
    const MIN_DISK_FOR_CI_MB = 600;
    if (useCleanInstall) {
        const availableDiskMb = getAvailableDiskSpaceMb(cwd);
        if (availableDiskMb !== null && availableDiskMb < MIN_DISK_FOR_CI_MB) {
            console.log(`${context} Low disk space detected (${availableDiskMb} MB free). Using incremental npm install instead of npm ci to save space.`);
            useCleanInstall = false;
        }
    }

    const npmCommand = useCleanInstall ? 'ci' : 'install';
    const BASE_FLAGS = [npmCommand, '--omit=optional', '--no-audit', '--no-fund'];
    if (!useCleanInstall) BASE_FLAGS.push('--prefer-offline');

    // For updates (incremental install), prune orphaned packages from previous versions
    // before installing. npm install is supposed to do this but sometimes leaves leftovers.
    if (isUpdate && !useCleanInstall) {
        try {
            console.log(`${context} Pruning orphaned packages...`);
            execSync('npm prune --omit=optional --no-audit --no-fund', { cwd, stdio: 'inherit', env: npmEnv });
        } catch {
            // Prune failure is non-critical -- proceed with install
        }
    }

    if (isLowMemoryEnvironment()) {
        console.log(`${context} Low-memory machine detected (${totalMb} MB total, ${freeMb} MB free, npm heap: ${heapMb} MB). Install may take multiple attempts...`);
    }

    let installSucceeded = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`${context} Running npm ${npmCommand} (attempt ${attempt}/${MAX_RETRIES}, heap: ${heapMb} MB)...`);
            await spawnAsync('npm', BASE_FLAGS, { cwd, stdio: 'inherit', env: npmEnv });
            console.log(`${context} Dependencies installed successfully.`);
            installSucceeded = true;
            break;
        } catch (err) {
            console.warn(`${context} npm ${npmCommand} attempt ${attempt} failed: ${err.message}`);

            if (await checkDepsInstalled(cwd, npmEnv)) {
                console.log(`${context} Install was interrupted but all packages are verified present.`);
                installSucceeded = true;
                break;
            }

            if (attempt < MAX_RETRIES) {
                console.log(`${context} Retrying in ${RETRY_DELAY_MS / 1000}s...`);
                await sleep(RETRY_DELAY_MS);
                if (global.gc) global.gc();
            }
        }
    }

    if (!installSucceeded && await checkDepsInstalled(cwd, npmEnv)) {
        console.log(`${context} Packages verified present after final attempt.`);
        installSucceeded = true;
    }

    // Clean npm cache to reclaim disk space (especially important on small containers)
    try {
        console.log(`${context} Cleaning npm cache to free disk space...`);
        execSync('npm cache clean --force', { cwd, stdio: 'ignore', env: npmEnv });
    } catch {
        // Cache cleanup is best-effort -- don't fail the install over it
    }

    if (installSucceeded) {
        console.log();
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
    const zipUrl = `https://github.com/${GITHUB_REPO}/archive/refs/heads/main.zip`;
    const zipPath = path.join(__dirname, 'repo.zip');
    const extractDir = path.join(__dirname, 'temp_extract');

    console.log('[INSTALLER] Downloading repository from GitHub...');
    await downloadFile(zipUrl, zipPath);
    console.log('[INSTALLER] Download complete.');

    verifyZipIntegrity(zipPath);
    console.log('[INSTALLER] Extracting files...');
    await extractZip(zipPath, extractDir, 'inherit');

    const extractedRoot = getExtractedRoot(extractDir);
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

    console.log('[INSTALLER] Cleaning up temporary files...');
    cleanupTempFiles(zipPath, extractDir);
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
        const ok = await robustNpmInstall(__dirname, '[INSTALLER]', { preferCleanInstall: true });
        if (!ok) {
            console.error('[INSTALLER] Failed to install dependencies.');
            console.error('[INSTALLER] Please run "npm install --omit=optional" manually.');
            process.exit(1);
        }

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('   Installation Complete!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('\n[INSTALLER] Restarting with the installed version...\n');

        // Exit with code 43 so the parent wrapper re-launches from the newly installed starter.js
        if (process.env.FULL_SELF_UPDATE === '1') {
            process.exit(43);
        }

        // No parent wrapper — spawn a fresh process manually
        const freshEnv = { ...process.env };
        delete freshEnv.STARTER_CHILD;
        delete freshEnv.FULL_SELF_UPDATE;
        const child = spawn(process.execPath, [
            '--expose-gc',
            '--max-old-space-size=256',
            ...process.argv.slice(1)
        ], {
            stdio: 'inherit',
            cwd: __dirname,
            env: freshEnv
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
/**
 * Re-registers an array of module paths with a given registration function.
 * @param {string[]} modulePaths  - Absolute paths to re-register
 * @param {Function} registerFn   - e.g. botModule.registerHandler
 * @param {string}   label        - Human-readable type for error messages
 * @returns {{ success: number, fail: number }}
 */
function reregisterModules(modulePaths, registerFn, label) {
    let success = 0;
    let fail = 0;
    for (const modulePath of modulePaths) {
        try {
            registerFn(modulePath);
            success++;
        } catch {
            console.error(`Failed to reload ${label}: ${path.basename(modulePath)}`);
            fail++;
        }
    }
    return { success, fail };
}

/**
 * Re-initializes schedulers after a hot-reload clears cached modules.
 */
async function reinitializeSchedulers() {
    try {
        if (botClient) {
            const { initializeNotificationScheduler } = require(path.join(SRC_DIR, 'functions', 'Notification', 'notificationScheduler'));
            await initializeNotificationScheduler(botClient);
            console.log('Notification scheduler re-initialized');
        }
    } catch (error) {
        console.error('Failed to re-initialize notification scheduler:', error.message);
    }

    try {
        if (botClient) {
            const { initializeBackupScheduler } = require(path.join(SRC_DIR, 'functions', 'Settings', 'backup', 'backupScheduler'));
            initializeBackupScheduler(botClient);
            console.log('Backup scheduler re-initialized');
        }
    } catch (error) {
        console.error('Failed to re-initialize backup scheduler:', error.message);
    }
}

/**
 * Reloads all files without restarting the bot
 */
async function reloadAllFiles() {
    console.log('️Reloading all files...\n');

    let successCount = 0;
    let failCount = 0;

    // Get all handler, event, and command paths before unregistering
    const handlerPaths = botModule.getAllHandlerPaths ? botModule.getAllHandlerPaths() : [];
    const eventPaths = botModule.getAllEventPaths ? botModule.getAllEventPaths() : [];
    const commandPaths = botModule.getAllCommandPaths ? botModule.getAllCommandPaths() : [];

    // Step 1: Cleanup schedulers before cache clear
    cleanupAllSchedulers();

    // Step 2: Unregister everything (uses old cached modules)
    for (const hp of handlerPaths) {
        try { botModule.unregisterHandler(hp); } catch { /* ignore */ }
    }
    for (const ep of eventPaths) {
        try { botModule.unregisterEvent(ep); } catch { /* ignore */ }
    }
    for (const cp of commandPaths) {
        try { botModule.unregisterCommand(cp); } catch { /* ignore */ }
    }

    // Step 3: Clear ALL caches — dependencies MUST be cleared before re-registering
    // so that handlers/events/commands get fresh versions of shared modules
    for (const fullPath of fileMap.values()) {
        clearCache(fullPath);
    }
    for (const hp of handlerPaths) { clearCache(hp); }
    for (const ep of eventPaths) { clearCache(ep); }
    for (const cp of commandPaths) { clearCache(cp); }

    // Also clear plugin dependency files (server.js, tunnel.js, etc.) that are
    // not in handlerPaths/eventPaths/commandPaths but live under plugins/
    const pluginsDir = path.join(__dirname, 'plugins');
    for (const cacheKey of Object.keys(require.cache)) {
        if (cacheKey.startsWith(pluginsDir)) {
            clearCache(cacheKey);
        }
    }

    // Step 4: Reload i18n
    try {
        const i18nPath = path.join(SRC_DIR, 'i18n', 'index.js');
        clearCache(i18nPath);
        const i18nModule = require(i18nPath);
        if (typeof i18nModule.reload === 'function') {
            i18nModule.reload();
        }
        successCount++;
    } catch (error) {
        console.error('Failed to reload i18n files:', error.message);
        failCount++;
    }

    // Step 5: Re-register everything (fresh requires with fresh dependencies)
    for (const { success, fail } of [
        reregisterModules(handlerPaths, botModule.registerHandler, 'handler'),
        reregisterModules(eventPaths, botModule.registerEvent, 'event'),
        reregisterModules(commandPaths, botModule.registerCommand, 'command'),
    ]) {
        successCount += success;
        failCount += fail;
    }

    // Step 6: Re-initialize schedulers with fresh modules
    await reinitializeSchedulers();

    // Step 7: Rebuild plugin map (cache was cleared, loadedPlugins Map is empty)
    try {
        const pluginsLoader = require(path.join(SRC_DIR, 'functions', 'Plugin', 'pluginsLoader'));
        pluginsLoader.rebuildPluginMap();
        const pluginCount = pluginsLoader.getPluginCount();
        if (pluginCount > 0) {
            console.log(`Plugin map rebuilt: ${pluginCount} plugin(s)`);
        }
    } catch (error) {
        console.error('Failed to rebuild plugin map:', error.message);
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
 * Persists a Discord bot token to src/.env and updates process.env.
 * @param {string} token - The Discord bot token to save
 */
function saveTokenToEnv(token) {
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
}

/**
 * Stops all background schedulers safely. Called during restart, reload,
 * and shutdown to prevent orphaned timers and cron jobs.
 */
function cleanupAllSchedulers() {
    try {
        const { notificationScheduler } = require('./src/functions/Notification/notificationScheduler');
        notificationScheduler.cleanup();
    } catch { /* not loaded */ }

    try {
        const { stopAutoCleanScheduler } = require('./src/functions/Notification/autoClean');
        stopAutoCleanScheduler();
    } catch { /* not loaded */ }

    try {
        const { autoCleanScheduler } = require('./src/functions/Players/idChannelAutoClean');
        autoCleanScheduler.cleanup();
    } catch { /* not loaded */ }

    try {
        const { stopBackupScheduler } = require('./src/functions/Settings/backup/backupScheduler');
        stopBackupScheduler();
    } catch { /* not loaded */ }

    try {
        const { stopAutoUpdateScheduler } = require('./src/functions/Settings/autoUpdate');
        stopAutoUpdateScheduler();
    } catch { /* not loaded */ }
}

/**
 * Full restart - destroys client, clears ALL cache, and restarts
 * This fixes issues with cached function references
 */
async function restartBot() {
    try {
        console.log('Restarting bot...\n');

        cleanupAllSchedulers();

        // Destroy the current client
        if (botClient) {
            console.log('Disconnecting client...');
            await botClient.destroy();
            botClient = null;
            botModule = null;
        }

        // If running under the parent wrapper, exit with code 42 for a full respawn.
        // This ensures starter.js changes are picked up from disk.
        if (process.env.FULL_SELF_UPDATE === '1') {
            process.exit(42);
        }

        // Docker: exit with code 1 so all restart policies (including Render, Railway,
        // Fly.io and plain `docker run` without --restart=always) trigger a respawn.
        // Most platforms only restart on non-zero exit; exit(0) is treated as intentional stop.
        if (global.isDocker) {
            process.exit(1);
        }

        // Fallback: in-process restart (direct execution without parent wrapper)
        const cacheKeys = Object.keys(require.cache);
        for (const key of cacheKeys) {
            if (!key.includes('node_modules')) {
                delete require.cache[key];
            }
        }

        console.log('Cleared all module cache');
        await new Promise(resolve => setTimeout(resolve, 1500));
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
 * Performs a graceful shutdown: stops all schedulers, destroys the Discord
 * client, flushes the SQLite WAL, and closes the database connection.
 * @param {number} [exitCode=0] - Process exit code
 */
async function gracefulShutdown(exitCode = 0) {
    console.log('\nPerforming graceful shutdown...');

    cleanupAllSchedulers();

    // 5. Destroy Discord client
    if (botClient) {
        try {
            await botClient.destroy();
        } catch { /* ignore — client may already be destroyed */ }
        botClient = null;
    }

    // 6. Flush WAL to main database file and close the connection.
    //    This prevents leftover .db-wal / .db-shm files and avoids
    //    potential corruption on unclean container shutdowns.
    try {
        const { db } = require('./src/functions/utility/database');
        if (db.open) {
            db.pragma('wal_checkpoint(TRUNCATE)');
            db.close();
            console.log('[SHUTDOWN] Database closed cleanly (WAL checkpointed).');
        }
    } catch { /* database module not loaded or already closed */ }

    // 7. Checkpoint and close the web panel plugin database (WAL mode).
    try {
        const pluginDb = require('./plugins/web-panel/pluginDb');
        pluginDb.close();
        console.log('[SHUTDOWN] Web panel database closed cleanly (WAL checkpointed).');
    } catch { /* plugin not loaded or already closed */ }

    process.exit(exitCode);
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
                    try {
                        saveTokenToEnv(token);
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
                saveTokenToEnv(newToken);
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
                            if (result.success && !result.restartHandled) {
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
            rl.close();
            await gracefulShutdown(0);
        }

        // Unknown command
        console.log(`Unknown command: "${trimmed}"`);
        console.log('Available: reload <file>, reload files, restart, usage, exit\n');
        rl.prompt();
    });

    rl.on('SIGINT', async () => {
        // clear shared prompt before closing
        if (global.promptLine) delete global.promptLine;
        if (global.__sharedReadline) delete global.__sharedReadline;
        rl.close();
        await gracefulShutdown(0);
    });
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

// Handle SIGTERM (Docker/container orchestrators send this to stop containers)
process.on('SIGTERM', async () => {
    await gracefulShutdown(0);
});

// Last-resort synchronous safety net: if process exits without gracefulShutdown
// having closed the database, checkpoint and close it here. better-sqlite3 calls
// are synchronous so this works inside the 'exit' event.
process.on('exit', () => {
    try {
        const { db } = require('./src/functions/utility/database');
        if (db.open) {
            db.pragma('wal_checkpoint(TRUNCATE)');
            db.close();
        }
    } catch { /* already closed or not loaded */ }

    try {
        const pluginDb = require('./plugins/web-panel/pluginDb');
        pluginDb.close();
    } catch { /* plugin not loaded or already closed */ }
});

// Expose functions globally for programmatic use (e.g., settings panel auto-update)
global.starterVersion = 2;
global.restartBot = restartBot;
global.checkForUpdates = checkForUpdates;
global.applyUpdate = applyUpdate;
global.getLocalVersion = getLocalVersion;

// Setup command interface (show commands first so prompts appear underneath)
setupCommandInterface();

// Start the bot after the command UI is ready
startBot();

})(); // end async startup IIFE
