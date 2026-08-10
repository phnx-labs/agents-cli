// Resolve an executable to an absolute path across the locations a macOS GUI
// app misses.
//
// The VS Code / Cursor / Codium extension host is launched from the Dock, so
// it inherits a minimal PATH that omits Homebrew (/opt/homebrew/bin), nvm, and
// the user's shell rc additions. A bare spawn('ffmpeg') therefore fails with
// ENOENT in production even though `which ffmpeg` works in the user's terminal.
// Resolving to an absolute path up front removes any dependence on the child
// process's PATH-lookup semantics.

import { existsSync, statSync } from 'fs';
import * as path from 'path';
import * as os from 'os';

// Standard bin directories a Dock-launched process can't see, ahead of
// whatever IS already on PATH. Order matters: Homebrew first (where ffmpeg
// usually lives on Apple Silicon), then Intel Homebrew, then system dirs.
export function commonBinDirs(pathEnv: string = process.env.PATH ?? ''): string[] {
  const extras = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    path.join(os.homedir(), '.agents', 'shims'),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [...extras, ...pathEnv.split(':')]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out;
}

// First absolute path where `name` exists as a file, or null if nowhere.
export function resolveExecutable(name: string, dirs: string[] = commonBinDirs()): string | null {
  for (const dir of dirs) {
    const full = path.join(dir, name);
    try {
      if (existsSync(full) && statSync(full).isFile()) return full;
    } catch { /* unreadable dir — skip */ }
  }
  return null;
}
