/**
 * Vitest `globalSetup` — runs once in the main process before any worker
 * fork spins up, so it is the right place for whole-run housekeeping that
 * per-fork `tests/setup.ts` cannot do cheaply (it re-runs once per test
 * file).
 *
 * RUSH-2639: `tests/setup.ts` mints a fresh `agents-vitest-<random>` temp dir
 * per fork and removes it in `afterAll`. That cleanup is best-effort — a
 * killed worker (CI timeout, OOM, a hung test forcibly terminated) never
 * reaches `afterAll`, so its temp dir is orphaned under the OS temp root
 * forever. Sweep stale ones (older than STALE_AGE_MS, so an in-flight
 * sibling run on the same machine is never touched) before this run starts,
 * so dangling dirs from past crashed runs cannot accumulate indefinitely.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const STALE_AGE_MS = 60 * 60 * 1000; // 1 hour — well past any single test file's runtime.

export default function globalSetup(): void {
  const tmpRoot = os.tmpdir();
  let entries: string[];
  try {
    entries = fs.readdirSync(tmpRoot);
  } catch {
    return;
  }

  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith('agents-vitest-')) continue;
    const full = path.join(tmpRoot, name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs < STALE_AGE_MS) continue; // young enough to be a live sibling run
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // best effort — another process may be racing us for the same cleanup
    }
  }
}
