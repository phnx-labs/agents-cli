/**
 * Filesystem linking, platform-aware.
 *
 * POSIX symlinks have no portable equivalent on Windows: directory symlinks and
 * file symlinks both require either Administrator or Developer Mode, while
 * *junctions* (directories only) need no elevation. `createLink` picks the form
 * that works without privilege — junction for directories — and falls back to a
 * copy for file links when the OS refuses the symlink.
 */
import * as fs from 'fs';

/**
 * Create a link at `dst` pointing to `src`, portable across platforms.
 *
 * - **Directory** target: junction on Windows (no Developer Mode needed), plain
 *   symlink on POSIX.
 * - **File** target: symlink, falling back to `copyFileSync` when Windows
 *   refuses the symlink (`EPERM`/`ENOSYS` — no Developer Mode). The copy is a
 *   point-in-time snapshot, not a live link; acceptable for the immutable
 *   targets we link (binaries, config files).
 *
 * `dst` must not already exist. Callers that replace atomically should link to a
 * temp name and `rename` over the destination, exactly as before — the copy
 * fallback is non-atomic, so the temp+rename stays the caller's responsibility.
 */
export function createLink(src: string, dst: string): void {
  const win = process.platform === 'win32';
  const isDir = fs.statSync(src).isDirectory();
  // Type is ignored on POSIX; on Windows, junction (dir) avoids the elevation a
  // dir symlink would need, and 'file' is the explicit file-symlink form.
  const type: fs.symlink.Type | undefined = win ? (isDir ? 'junction' : 'file') : undefined;
  try {
    fs.symlinkSync(src, dst, type);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (win && !isDir && (code === 'EPERM' || code === 'ENOSYS')) {
      fs.copyFileSync(src, dst);
      return;
    }
    throw err;
  }
}
