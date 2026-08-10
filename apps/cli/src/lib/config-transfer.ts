/**
 * Primitives for moving an agent config directory across the agents-cli boundary.
 *
 * Both helpers were part of {@link ./uninstall.ts} and are unchanged — teardown was
 * simply the first caller. Other config-transfer paths need the same operations, so
 * they live here rather than being duplicated or imported out of a module named for
 * teardown.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * Move `source` onto `dest` across possibly-different volumes. `renameSync` is
 * atomic but throws EXDEV when `~/.agents` lives on a different filesystem than
 * `$HOME`; fall back to copy-then-remove so the restore still completes. The
 * source is removed only after the copy succeeds, so a mid-copy failure never
 * destroys the sole surviving copy.
 */
export function moveDirCrossDevice(source: string, dest: string): void {
  try {
    fs.renameSync(source, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.cpSync(source, dest, { recursive: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

/**
 * Copy `source` to `dest`, dropping any symlink whose target resolves back into
 * `~/.agents`. Managed resources (skills/commands) are synced into a version home
 * as symlinks into `~/.agents`; copying them verbatim would leave the result full
 * of links that dangle the moment `~/.agents` is disposed. Stripping them yields a
 * clean, self-contained copy — which is the entire point of an export.
 */
export function copyDirStrippingAgentsSymlinks(source: string, dest: string, agentsDir: string): void {
  const inside = agentsDir + path.sep;
  fs.cpSync(source, dest, {
    recursive: true,
    // `force: true` is Node's default, but Bun drops it when a `filter` is supplied —
    // existing files are then silently left alone. `dist/bin/agents` is bun-compiled,
    // so this is a production path, not just a test artifact. State it explicitly.
    force: true,
    filter: (src) => {
      try {
        const st = fs.lstatSync(src);
        if (st.isSymbolicLink()) {
          const tgt = path.resolve(path.dirname(src), fs.readlinkSync(src));
          if (tgt === agentsDir || tgt.startsWith(inside)) return false;
        }
      } catch {
        /* unreadable entry — let cpSync surface it on the real copy */
      }
      return true;
    },
  });
}
