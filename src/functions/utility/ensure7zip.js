const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Try to acquire a usable 7-Zip binary.
 * - Prefer the bundled `7zip-bin` binary (try chmod; copy+chmod if needed).
 * - Fallback to system `7z` / `7za` on PATH.
 *
 * Returns an object: { binPath: string|null, cleanupPath: string|null }
 * - binPath: path to an executable 7z/7za or null if none found
 * - cleanupPath: path to a copied temporary binary that should be removed by the caller (or null)
 *
 * @param {string} tempDir - writable temporary directory (used when copying bundled binary)
 * @returns {Promise<{binPath: string|null, cleanupPath: string|null}>}
 */
async function acquire7z(tempDir) {
  const isWindows = process.platform === 'win32';
  let cleanupPath = null;

  // Helper to test & make executable (POSIX only)
  async function makeExecutableOrCopy(originalPath) {
    if (!originalPath || !fs.existsSync(originalPath)) return null;
    if (!isWindows) {
      try {
        await fs.promises.access(originalPath, fs.constants.X_OK);
        return originalPath; // already executable
      } catch (_) {
        // try chmod in-place
        try {
          await fs.promises.chmod(originalPath, 0o755);
          return originalPath;
        } catch (_) {
          // try copying to tempDir and chmod the copy
          if (!tempDir) return null;
          try {
            await fs.promises.mkdir(tempDir, { recursive: true });
            const copyTarget = path.join(tempDir, `7za_copy_${Date.now()}_${Math.random().toString(36).slice(2,6)}`);
            await fs.promises.copyFile(originalPath, copyTarget);
            await fs.promises.chmod(copyTarget, 0o755);
            cleanupPath = copyTarget;
            return copyTarget;
          } catch (err) {
            return null;
          }
        }
      }
    }

    // Windows: assume existing executable is fine
    return originalPath;
  }

  // 1) try bundled `7zip-bin`
  try {
    const sevenBin = require('7zip-bin');
    const bundled = sevenBin && sevenBin.path7za ? sevenBin.path7za : null;
    if (bundled && fs.existsSync(bundled)) {
      const usable = await makeExecutableOrCopy(bundled);
      if (usable) return { binPath: usable, cleanupPath };
    }
  } catch (_) {
    // ignore — package might not be installed
  }

  // 2) try system `7z`/`7za`
  const names = isWindows ? ['7z.exe', '7za.exe', '7z'] : ['7z', '7za'];
  for (const name of names) {
    try {
      const whichCmd = isWindows ? 'where' : 'which';
      const res = spawnSync(whichCmd, [name], { encoding: 'utf8' });
      if (res.status === 0 && res.stdout) {
        const p = res.stdout.split(/\r?\n/)[0].trim();
        if (p && fs.existsSync(p)) return { binPath: p, cleanupPath: null };
      }
    } catch (e) {
      // ignore and continue
    }
  }

  return { binPath: null, cleanupPath: null };
}

module.exports = { acquire7z };
