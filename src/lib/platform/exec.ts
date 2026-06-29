/**
 * Executable resolution, platform-aware.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

/** PATH-search command for the platform: `where` on Windows, else `which`. */
export function whichCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'where' : 'which';
}

/**
 * Does spawning `binary` require `shell: true` on this platform?
 *
 * On Windows a `.cmd`/`.bat` wrapper (npm.cmd, bun.cmd, the agent shims) cannot
 * be exec'd directly — `spawn`/`execFile` look for a literal executable and miss
 * the PATHEXT/cmd-interpreter step, surfacing as `ENOENT`/`EINVAL`. A bare
 * command name (not an absolute path) needs the same PATHEXT resolution. Both
 * cases require the shell. Always false off Windows, where direct exec is right.
 */
export function needsWindowsShell(binary: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  // path.win32.isAbsolute, not path.isAbsolute: the latter uses the HOST's rules,
  // so a Windows path would read as relative when this runs on a Linux CI host.
  return !path.win32.isAbsolute(binary) || /\.(cmd|bat)$/i.test(binary);
}

/**
 * Resolve an executable name to its absolute path via the OS PATH search, or
 * `null` if not found. On Windows `where` can return several lines (one per
 * PATHEXT match, e.g. `agents.cmd` and `agents.ps1`) — the first is the one the
 * shell would actually run, matching `which` semantics on POSIX.
 */
export function findExecutable(name: string, platform: NodeJS.Platform = process.platform): string | null {
  try {
    const out = execFileSync(whichCommand(platform), [name], { encoding: 'utf-8' });
    const first = out.trim().split(/\r?\n/)[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}
