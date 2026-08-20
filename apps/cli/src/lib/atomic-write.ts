/**
 * Atomic JSON write, shared by every registry/store that must never leave a
 * torn, unparseable file behind a killed process.
 *
 * Writes to a unique sibling tmp file, then `rename(2)`s it over the target.
 * rename(2) is atomic on POSIX, so a process killed mid-write leaves either
 * the previous valid file or the new one, never a half-written one that a
 * downstream `JSON.parse` would reject (RUSH-2429).
 *
 * This consolidates four near-identical private copies that had already
 * started to drift (RUSH-2840): `feed/feed.ts`, `devices/registry.ts`,
 * `teams/registry.ts`, and `teams/agents.ts`. All three real call sites
 * (`devices/registry.ts`, `teams/registry.ts`, `teams/agents.ts`) were async
 * and already unlinked the tmp file on a failed rename — that is the
 * behavior this module standardizes on. `feed/feed.ts`'s copy was
 * synchronous, had no failure cleanup, and — per `grep -rn atomicWriteJson
 * src/` — had zero callers, so there was no caller ordering to preserve; it
 * has been deleted rather than migrated.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

/**
 * Atomically write `data` as pretty-printed JSON to `targetPath`.
 *
 * Ensures the parent directory exists (idempotent — a no-op when it already
 * does, so this is safe even for callers that already `mkdir` themselves).
 * On a failed rename, the tmp file is removed (best-effort) and the original
 * error is rethrown; the target is left untouched.
 */
export async function atomicWriteJson(targetPath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp.${process.pid}.${randomUUID()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  try {
    await fs.rename(tmp, targetPath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}
