/**
 * Atomic JSON write, shared by every registry/store that must never leave a
 * torn, unparseable file behind a killed process.
 *
 * Writes to a unique sibling tmp file, then `rename(2)`s it over the target.
 * rename(2) is atomic on POSIX, so a process killed mid-write leaves either
 * the previous valid file or the new one, never a half-written one that a
 * downstream `JSON.parse` would reject (RUSH-2429).
 *
 * This consolidates five near-identical private copies that had already
 * started to drift (RUSH-2840): the named private `atomicWriteJson` in
 * `feed/feed.ts`, `devices/registry.ts`, `teams/registry.ts`, and
 * `teams/agents.ts`, plus a sixth, unnamed inline copy inside `feed/feed.ts`'s
 * own `publishBlock()` (the only one of the six that was actually called).
 *
 * All three real ASYNC call sites (`devices/registry.ts`, `teams/registry.ts`,
 * `teams/agents.ts`) already unlinked the tmp file on a failed rename — that
 * is the behavior `atomicWriteJson` standardizes on.
 *
 * `feed/feed.ts`'s named `atomicWriteJson` copy was synchronous, had no
 * failure cleanup, and — per `grep -rn atomicWriteJson src/` — had zero
 * callers, so there was no caller ordering to preserve; it was deleted
 * rather than migrated.
 *
 * `publishBlock()` is a different story: it IS called, synchronously, from
 * six other exported sync functions in the same file plus external callers
 * (`commands/feed.ts`, `watchdog/runner.ts`) that never `await` it. Making it
 * async would force every one of those callers async too — out of scope for
 * a behavior-preserving refactor and a real ordering risk. `atomicWriteJsonSync`
 * exists so `publishBlock()` can route through the shared primitive without
 * changing its signature or any caller.
 */
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
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

/**
 * Synchronous twin of {@link atomicWriteJson}, for a caller that cannot
 * become async without changing its own callers' ordering (see
 * `feed/feed.ts`'s `publishBlock()`). Same guarantee, same tmp-naming and
 * error-handling behavior, just blocking.
 */
export function atomicWriteJsonSync(targetPath: string, data: unknown): void {
  fsSync.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp.${process.pid}.${randomUUID()}`;
  fsSync.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try {
    fsSync.renameSync(tmp, targetPath);
  } catch (err) {
    try {
      fsSync.unlinkSync(tmp);
    } catch {
      // best-effort cleanup, mirrors the async .catch(() => {})
    }
    throw err;
  }
}
