/**
 * Path classification + normalization, platform-aware.
 */
import * as os from 'os';

/** Windows drive-letter absolute path: `C:\` or `C:/`. */
const WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/;

/**
 * Does this positional argument look like a filesystem path (vs a search term)?
 *
 * POSIX markers (`.`, `./`, `../`, `/`, `~`) are recognized on every platform —
 * identical to the long-standing behavior. Windows-only shapes (drive-letter
 * `C:\…`, UNC `\\…`, backslash-relative `.\` / `..\`) are recognized ONLY on
 * win32, so a literal `C:\repo` typed on macOS/Linux still resolves as a search
 * term — i.e. no behavior change off Windows.
 */
export function looksLikePath(query: string, platform: NodeJS.Platform = process.platform): boolean {
  if (
    query === '.' ||
    query.startsWith('./') ||
    query.startsWith('../') ||
    query.startsWith('/') ||
    query.startsWith('~')
  ) {
    return true;
  }
  if (platform === 'win32') {
    return (
      WIN_DRIVE_RE.test(query) ||
      query.startsWith('\\\\') ||
      query.startsWith('.\\') ||
      query.startsWith('..\\')
    );
  }
  return false;
}

/**
 * Normalize a path for comparison/prefix-matching: backslashes folded to forward
 * slashes and lowercased on Windows (its filesystem is case-insensitive). On
 * POSIX the input is returned unchanged, so callers behave exactly as before.
 */
export function toComparablePath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return p.replace(/\\/g, '/').toLowerCase();
  return p;
}

/**
 * Canonical home directory. Use this instead of `process.env.HOME`, which is
 * unset on Windows (where the home is `USERPROFILE`); `os.homedir()` resolves
 * correctly on all three platforms.
 */
export function homeDir(): string {
  return os.homedir();
}

/**
 * Is this a Windows absolute path — a drive-letter root (`C:\`, `C:/`) or a UNC
 * share (`\\server\share`)? Used by local-source parsing to recognize a native
 * Windows path that the POSIX `/`, `./`, `../` prefixes miss. Caller decides
 * whether to apply it (typically gated on win32).
 */
export function isWindowsAbsolutePath(p: string): boolean {
  return WIN_DRIVE_RE.test(p) || p.startsWith('\\\\');
}

/**
 * Fold backslashes to forward slashes. Use when a path is going into a string
 * that must read the same on every OS — a doc-comparable display path, a regex
 * subject, a forward-slash-keyed lookup. Pure string transform; on POSIX input
 * (no backslashes) it returns the value unchanged.
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Derive a filesystem-safe key/slug from an absolute path. Drops the Windows
 * drive colon (`:` is illegal in NTFS filenames / is the ADS separator) and
 * folds path separators and spaces to `_`. For a POSIX path this produces the
 * exact historical slug (`/a/b c` -> `_a_b_c`), so existing on-disk keys are
 * unchanged; on Windows `C:\a\b` -> `C_a_b` instead of an unusable name.
 *
 * Shell mirror (keep byte-identical in any bash shim that recomputes this key):
 *   printf '%s' "$P" | tr -d ':' | tr '\\/ ' '_'
 */
export function toPortableKey(p: string): string {
  return p.replace(/^([a-zA-Z]):/, '$1').replace(/[\\/ ]/g, '_');
}
