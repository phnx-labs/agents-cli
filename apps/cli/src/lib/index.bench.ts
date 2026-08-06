/**
 * Benchmark for the CLI entry hot path: `checkForUpdates()` (index.ts:755) and
 * `spawnDetachedSync()` (index.ts:1330), both of which run on EVERY ordinary
 * `agents` invocation except pure `--help`/`--version` (index.ts:1319-1331 guards
 * them behind `!helpOrVersionRequested`). The comment at index.ts:51 flags this
 * same pair as the reason the secrets-broker sync commands are intercepted
 * above commander registration, before `checkForUpdates()`/`spawnDetachedSync()`
 * would otherwise fire on every cache-hit read.
 *
 * `checkForUpdates` (index.ts:755-779) and its helper `maybeWarnMultiInstall`
 * (index.ts:535-575) are NOT exported -- they are private to index.ts, and
 * index.ts cannot be imported directly: it has top-level `await`, reads
 * `process.argv`, and (outside the two early-intercept blocks at index.ts:38 and
 * index.ts:71) eventually calls `program.parse()`, so importing the module as
 * ESM would run the real CLI bootstrap as a side effect of loading this bench
 * file. Instead this benchmarks the exact exported functions `checkForUpdates`
 * calls, with the same real arguments (this machine's real PATH, its real
 * ~/.agents/.cache/.update-check file):
 *
 *   maybeWarnMultiInstall (index.ts:535-575)
 *     -> resolveRunningPackageRoot (self-update.ts:177)
 *     -> findAgentsCliInstalls(process.env.PATH)      (self-update.ts:509)
 *     -> buildMultiInstallInventory(...)              (self-update.ts:401)
 *   checkForUpdates body (index.ts:755-779)
 *     -> readUpdateCache(UPDATE_CHECK_FILE)           (self-update.ts:79)
 *     -> shouldFetchLatest(cache)                     (index.ts:578, PRIVATE -- see note below)
 *     -> shouldPromptUpgrade(cache, VERSION)           (self-update.ts:128)
 *
 * `shouldFetchLatest` (index.ts:578) is itself private to index.ts (not
 * self-update.ts, despite living right beside the exported update-cache
 * helpers there) -- it is NOT benched directly for the same reason
 * `checkForUpdates` itself isn't: nothing can import it without importing all
 * of index.ts. It is one pure comparison (`Date.now() - cache.lastCheck >
 * UPDATE_CHECK_INTERVAL_MS`), immaterial next to the real fs/PATH work
 * measured below -- readUpdateCache's real fs.readFileSync + JSON.parse
 * dominates it by construction, and readUpdateCache is exported and benched.
 *
 * `refreshUpdateCacheInBackground` (index.ts:739-752) and the interactive
 * `promptUpgrade` path are NOT benched: the former is a fire-and-forget network
 * fetch (`fetch(...).then(...)`, never awaited by the caller) and the latter is
 * an interactive TTY prompt -- neither is on the synchronous hot path this file
 * measures, and neither fires on a plain terminal `agents <cmd>` run against a
 * fresh cache.
 *
 * `spawnDetachedSync` (auto-pull.ts:46-72) IS exported and is benched directly,
 * but with one twist: it resolves its worker script relative to
 * `fileURLToPath(import.meta.url)` (auto-pull.ts:51), i.e. relative to wherever
 * the RUNNING copy of this module lives. Importing it the normal bench way (via
 * './auto-pull.js', vitest's TS-source resolution) would put that module at
 * src/lib/auto-pull.ts, where only auto-pull-worker.TS exists -- so
 * `fs.existsSync(workerPath)` (auto-pull.ts:53) would ALWAYS be false and the
 * function would always take the early-return guard path, never actually
 * spawning anything. That is real behavior for an unbuilt checkout, but it is
 * not what a real user's installed copy does (npm ships dist/lib/auto-pull-
 * worker.js). To measure the real spawn this file imports the ACTUAL BUILT
 * ARTIFACT at ../../dist/lib/auto-pull.js (produced by `bun run build` /
 * `bun install`'s `prepare` hook) so `import.meta.url` resolves inside dist/lib/
 * and the real dist/lib/auto-pull-worker.js is found. Both regimes are benched
 * explicitly below so the guard-path cost and the real fork+exec cost are never
 * conflated.
 *
 * No mocking: every call below hits the real filesystem (real PATH, real
 * ~/.agents/.cache files) and, in the "real spawn" group, a real
 * child_process.spawn of the real dist/lib/auto-pull-worker.js -- which itself
 * does a real `git fetch` against this machine's real ~/.agents repos in the
 * background (detached, unref'd, so it does not block this process or this
 * benchmark's timing; see auto-pull-worker.ts). That group is therefore bounded
 * to a small iteration count, mirroring exec.bench.ts's execAgent group.
 *
 * Lives at src/lib/index.bench.ts, not src/index.bench.ts, so that
 * `typecheck:bench` (package.json:58, globs `src/lib/*.bench.ts
 * src/lib/**\/*.bench.ts`) actually type-checks it -- a prior version at
 * src/index.bench.ts silently sat outside that glob and shipped a stale
 * `@ts-expect-error` (TS2578, unused directive) that no gate caught.
 */
import { describe, bench } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readUpdateCache,
  shouldPromptUpgrade,
  buildMultiInstallInventory,
  findAgentsCliInstalls,
  resolveRunningPackageRoot,
} from './self-update.js';
import { getUpdateCheckPath } from './state.js';
// Real built artifact (see docblock above) -- NOT './auto-pull.js', which
// would resolve to the unbuilt TS source and always miss the worker script.
// dist/lib/auto-pull.d.ts exists (tsconfig.json declaration:true), so this
// resolves and type-checks normally -- no @ts-expect-error needed here.
import { spawnDetachedSync } from '../../dist/lib/auto-pull.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPDATE_CHECK_FILE = getUpdateCheckPath();
const REAL_PATH = process.env.PATH || '';

describe('checkForUpdates — maybeWarnMultiInstall (index.ts:535-575): the PATH + known-install-root scan', () => {
  bench('resolveRunningPackageRoot(__dirname) — real path math, no fs walk when not a bunfs virtual path (self-update.ts:177)', () => {
    resolveRunningPackageRoot(__dirname);
  });

  bench(`findAgentsCliInstalls(process.env.PATH) — real PATH scan (${REAL_PATH.split(path.delimiter).filter(Boolean).length} real entries on this box) + known nvm/fnm/volta/bun/npx roots (self-update.ts:509)`, () => {
    findAgentsCliInstalls(REAL_PATH);
  });

  bench('maybeWarnMultiInstall end-to-end: resolveRunningPackageRoot + findAgentsCliInstalls + buildMultiInstallInventory (index.ts:539-550) -- dominated by the PATH scan above; the Map-based aggregation itself (self-update.ts:401) is negligible over the small install list it runs on', () => {
    const runningRoot = resolveRunningPackageRoot(__dirname);
    const installs = findAgentsCliInstalls(REAL_PATH);
    buildMultiInstallInventory(runningRoot, '0.0.0-bench', installs);
  });
});

describe('checkForUpdates — cache read + prompt decision (index.ts:755-779)', () => {
  bench(`readUpdateCache(UPDATE_CHECK_FILE) — real ~/.agents/.cache/.update-check read (self-update.ts:79)`, () => {
    readUpdateCache(UPDATE_CHECK_FILE);
  });

  bench('shouldPromptUpgrade — pure comparison against the real cached value, incl. compareVersions (self-update.ts:128)', () => {
    const cache = readUpdateCache(UPDATE_CHECK_FILE);
    shouldPromptUpgrade(cache, '0.0.0-bench');
  });
});

describe('spawnDetachedSync (index.ts:1330, auto-pull.ts:46-72) — guard-path only (AGENTS_NO_AUTOPULL=1, no spawn)', () => {
  bench('early return: env check only (auto-pull.ts:47)', () => {
    process.env.AGENTS_NO_AUTOPULL = '1';
    spawnDetachedSync();
  });
});

describe('spawnDetachedSync — real detached child_process.spawn against the built dist/lib/auto-pull-worker.js', () => {
  bench('fileURLToPath + path.join + fs.existsSync + spawn().unref() (auto-pull.ts:51-68) — forks a real process, real background git fetch', () => {
    delete process.env.AGENTS_NO_AUTOPULL;
    spawnDetachedSync();
  }, { time: 2000, iterations: 10 });
});
