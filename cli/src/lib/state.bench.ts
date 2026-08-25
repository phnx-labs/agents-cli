/**
 * Benchmark: the state.ts module-graph bootstrap every `agents` invocation pays,
 * and the runtime cost of the four path helpers index.ts calls during startup.
 *
 * `index.ts:532` imports `{ getUpdateCheckPath, getMigratedSentinelPath,
 * getUserAgentsDir, getRuntimeStateDir }` from `./lib/state.js` EAGERLY —
 * top-level, before commander parses argv. `events.bench.ts` already measured
 * this eager import as a "BASELINE: lib/state.js alone" row (mean 45.76ms,
 * hz 21.85, on this machine — see the run pasted in the PR body) using
 * `spawnSync(process.execPath, ['--input-type=module', '-e', src])` per
 * sample: a fresh OS process (fork+exec+dynamic-link+V8-bootstrap) for every
 * cold import. Its own FLOOR row (bare `node -e ""`) measured mean 17.18ms —
 * a process-spawn cost of the same order of magnitude as the ~46ms signal
 * being measured, so a meaningful slice of that number is spawn noise, not
 * state.js's own graph-evaluation cost.
 *
 * THIS FILE isolates the marginal cost with a cheaper, lower-noise floor:
 * a `node:worker_threads` Worker instead of a new OS process. A Worker gets
 * its own V8 isolate and its own ESM module registry (so `import()` inside
 * it is genuinely cold, same guarantee spawnSync gave), but skips fork(),
 * exec(), and reloading the node binary + its dynamic libraries — only
 * thread + isolate creation. A NEW worker is spawned per sample (not one
 * worker reused across samples) because Node caches an ESM module for the
 * life of whatever registry loaded it; a second `import()` of the same URL
 * in one worker would time a Map lookup, not a cold load. "Fixed-worker"
 * here means the harness (this vitest process, and the worker-spawning
 * mechanism) is fixed and warm across every sample — only the module
 * registry is fresh per sample, unlike spawnSync's fresh-OS-process-per-
 * sample.
 *
 * NO MOCKING. Group A spawns real Worker threads importing the real BUILT
 * `dist/lib/*.js` artifacts (the module graph a shipped install evaluates,
 * incl. the third-party edges `yaml` (state.ts:29) and `proper-lockfile` via
 * fs-atomic.ts (state.ts:31)). Group B calls the real exported getters
 * in-process against the real machine's actual `$HOME/.agents` layout (no
 * fixture, no stub) — these are pure string getters over module-scope
 * `path.join` constants (state.ts:56,150,160,161), so no sessions.db or any
 * other on-disk state is on their call path to fake.
 */
import { describe, bench } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  getUpdateCheckPath,
  getMigratedSentinelPath,
  getUserAgentsDir,
  getRuntimeStateDir,
} from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** dist/ of THIS checkout — src/lib/ is two levels under cli, dist is a sibling of src. */
const DIST_ROOT = path.resolve(__dirname, '../../dist');
const distUrl = (rel: string): string => pathToFileURL(path.join(DIST_ROOT, rel)).href;

const STATE_SPEC = distUrl('lib/state.js');
const EVENTS_SPEC = distUrl('lib/events.js');
const PROVENANCE_SPEC = distUrl('lib/event-provenance.js');

/**
 * Import `specs` (in order) inside a freshly created worker thread and resolve
 * once every import has settled. Throws (rejecting the bench sample instead of
 * silently posting a fast wrong number) on a worker error or a rejected import
 * — a moved/mistyped specifier exits fast and would otherwise read as the
 * quickest row, exactly the failure mode `events.bench.ts`'s `coldEval` guards
 * against for its spawnSync equivalent.
 */
function workerColdEval(specs: string[]): Promise<void> {
  const importLines = specs.map((s) => `await import(${JSON.stringify(s)});`).join('\n');
  const src = `
    const { parentPort } = require('node:worker_threads');
    (async () => {
      ${importLines}
      parentPort.postMessage({ ok: true });
    })().catch((err) => {
      parentPort.postMessage({ ok: false, error: String((err && err.stack) || err) });
    });
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(src, { eval: true });
    const cleanup = (fn: () => void) => {
      worker.terminate().finally(fn);
    };
    worker.once('message', (msg: { ok: boolean; error?: string }) => {
      if (msg.ok) cleanup(resolve);
      else cleanup(() => reject(new Error(msg.error)));
    });
    worker.once('error', (err) => cleanup(() => reject(err)));
  });
}

const COLD_OPTS = { time: 3000, iterations: 12 } as const;

/**
 * Prove every spec resolves — a throw here aborts the file where vitest
 * reports it as a real Failed Suite, before any row is timed. A throw inside
 * a `bench` callback is swallowed by tinybench and merely posts `NaN` for
 * that row, so this preflight is what makes a stale/missing dist build loud.
 */
await (async function preflightColdImports(): Promise<void> {
  await workerColdEval([]);
  await workerColdEval([STATE_SPEC]);
  await workerColdEval([STATE_SPEC, EVENTS_SPEC, PROVENANCE_SPEC]);
})();

describe('cold module-graph evaluation, worker-thread isolated — index.ts:532 eager import of state.js, paid before parse on EVERY invocation incl. --version/--help', () => {
  bench('FLOOR: empty worker thread, no import — the thread-creation cost every row below also pays; subtract it', () => {
    return workerColdEval([]);
  }, COLD_OPTS);

  bench('lib/state.js alone (index.ts:532). Pulls yaml (state.ts:29) + fs-atomic -> proper-lockfile (state.ts:31)', () => {
    return workerColdEval([STATE_SPEC]);
  }, COLD_OPTS);

  bench('CROSS-CHECK: state.js + events.js + event-provenance.js — same three-module set events.bench.ts times via spawnSync, timed here via worker thread instead', () => {
    return workerColdEval([STATE_SPEC, EVENTS_SPEC, PROVENANCE_SPEC]);
  }, COLD_OPTS);
});

// ─── Group B: runtime cost of the four getters index.ts calls during startup ──
//
// In-process (already-loaded) calls against the REAL machine $HOME/.agents —
// no fixture dir, no AGENTS_* override. All four are pure getters over
// module-scope `path.join` constants computed once at import time
// (state.ts:56 USER_AGENTS_DIR, state.ts:150 RUNTIME_STATE_DIR, state.ts:160
// UPDATE_CHECK_FILE, state.ts:161 MIGRATED_SENTINEL_FILE); none of them touch
// disk, so there is no sessions.db or agents.yaml on their call path to
// exercise with real data — the realistic-data instruction is satisfied by
// Group A running against the real, unfaked `dist/` build these getters ship
// in, not by fabricating I/O these functions don't perform.
describe('runtime cost of the four state.ts getters index.ts:532 imports and calls at startup (index.ts:544,555,1372,1429)', () => {
  bench("getUpdateCheckPath() — index.ts:544, called at module scope on every invocation", () => {
    getUpdateCheckPath();
  });

  bench("getUserAgentsDir() — index.ts:1372, called at module scope on every invocation (firstRun/metaFilePath check)", () => {
    getUserAgentsDir();
  });

  bench("getMigratedSentinelPath() — index.ts:1429, called at module scope unless AGENTS_SKIP_MIGRATION=1", () => {
    getMigratedSentinelPath();
  });

  bench("getRuntimeStateDir() — index.ts:555, called inside maybeWarnMultiInstall() (gated, not module-scope)", () => {
    getRuntimeStateDir();
  });

  bench('all four in sequence — the actual per-invocation call pattern index.ts exercises', () => {
    getUpdateCheckPath();
    getUserAgentsDir();
    getMigratedSentinelPath();
    getRuntimeStateDir();
  });
});
