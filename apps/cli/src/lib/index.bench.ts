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
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
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
import { loadDoctor, loadVersions, loadPrune, loadSessions } from './startup/command-registry.js';

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

/**
 * ============================================================================
 * Command registration hot path: registerEagerForRequest / COMMAND_LOADERS
 * (index.ts:1007-1063, lib/startup/command-registry.ts) and the
 * program.parseAsync() call it feeds (index.ts:1440).
 *
 * Every ordinary `agents <cmd>` invocation resolves `requestedCommand` from
 * argv (index.ts:1232), looks it up in COMMAND_LOADERS
 * (command-registry.ts:155-274), dynamically imports the one-or-two command
 * modules that name maps to, and calls the returned registrar(program)
 * (index.ts:1010-1012 `reg`) BEFORE program.parseAsync() ever runs
 * (index.ts:1440) -- unconditionally, regardless of `--help`/`--version`
 * (index.ts:1271-1280 has no helpOrVersionRequested guard). An unrecognized
 * top-level name (typo, or the brand-disabled path) instead falls back to
 * registerAllEagerCommands() (index.ts:1072-1161), which imports and
 * registers EVERY command module in the CLI so the Levenshtein "did you mean"
 * spellcheck (index.ts:1184-1226) has the full candidate set.
 *
 * index.ts cannot be imported directly (see the docblock at the top of this
 * file -- top-level await, process.argv reads, eventual program.parse()), and
 * neither `reg` nor `registerEagerForRequest` nor `registerAllEagerCommands`
 * is exported, so there is no way to call them in-process without duplicating
 * their dispatch/ordering logic -- exactly the real coupling command-
 * registry.ts's own docblock (command-registry.ts:141-153) says not to
 * re-derive. Two complementary regimes are benched instead:
 *
 *   1. REAL SPAWNED PROCESS (below): `spawnSync` the actual built
 *      dist/index.js with a handful of representative top-level names, each a
 *      fresh Node process -- i.e. a genuinely COLD run of the entire dispatch
 *      path above, exactly as a user's shell invokes it. `--help` is appended
 *      to every invocation so each run exits fast and deterministically
 *      (commander prints help and exits 0) without touching stdin. `--help`
 *      does skip checkForUpdates/spawnDetachedSync (benched above) and
 *      ensureInitialized/runMigration (index.ts:1373-1381, both DO carry a
 *      `!helpOrVersionRequested` guard -- the sibling migration-triad bench in
 *      PR #2277 covers that path), so this isolates the registration/import
 *      cost from those other two hot-path pieces instead of conflating them.
 *   2. WARM IN-PROCESS REGISTRATION (further below): call the real, exported
 *      command-registry.ts loaders directly -- `(await loadX())(new
 *      Command())` -- for a representative subset. Node's ESM loader caches a
 *      module after its first import in this process, so after the first
 *      sample every further call pays ONLY the registrar function's own
 *      synchronous commander-construction work (.command/.option/.action
 *      calls), not disk read + parse + top-level module evaluation. Compared
 *      against group 1's real cold-process numbers for the SAME command, the
 *      gap approximates how much of the real-world cost is "importing the
 *      module and its dependency graph" versus "building the commander
 *      command tree" -- the same decomposition PR #2277 used to show
 *      ensureInitialized's hot-path body is a single syscall dwarfed by its
 *      eager unconditional import.
 *
 * No mocking: group 1 runs the real built dist/index.js against this
 * machine's real ~/.agents (same real filesystem/PATH every other group in
 * this file uses); group 2 calls the real, unmodified command registrars
 * exported from command-registry.ts.
 */
const CLI_ENTRY = path.join(__dirname, '../../dist/index.js');

function runCli(args: string[]): void {
  // spawnSync (not execFileSync) so a non-zero exit never throws inside the
  // timed callback -- every arg list below is verified to exit 0 on this
  // machine, but the bench must stay robust to environment drift.
  spawnSync(process.execPath, [CLI_ENTRY, ...args], { stdio: 'ignore' });
}

describe('registerEagerForRequest / COMMAND_LOADERS — real cold `node dist/index.js <cmd> --help` process spawn (index.ts:1007-1063, 1271-1280)', () => {
  bench('baseline: `agents --help` — requestedCommand undefined, ZERO command loaders run (index.ts:1281-1284)', () => {
    runCli(['--help']);
  }, { time: 4000, iterations: 15 });

  bench('`agents doctor --help` — 1 loader (loadDoctor), single COMMAND_LOADERS entry (command-registry.ts:201)', () => {
    runCli(['doctor', '--help']);
  }, { time: 4000, iterations: 15 });

  bench('`agents prune --help` — 2 loaders in sequence (loadVersions, loadPrune — command-registry.ts:177, ordering comment at 148-149)', () => {
    runCli(['prune', '--help']);
  }, { time: 4000, iterations: 15 });

  bench('`agents sessions --help` — lazy-tree command, the SQLite-backed session module (index.ts:1290-1291, LAZY_COMMAND_NAMES)', () => {
    runCli(['sessions', '--help']);
  }, { time: 4000, iterations: 15 });

  bench('`agents <unknown> --help` — registerAllEagerCommands() fallback, EVERY command module in the CLI (index.ts:1072-1161, 1271-1280)', () => {
    runCli(['zzzznotarealcommand', '--help']);
  }, { time: 6000, iterations: 12 });
});

describe('command-registry.ts loaders — warm in-process registration only (module import cached after the first sample; see docblock above)', () => {
  bench('loadDoctor()(new Command()) — registerDoctorCommand body only, no import cost after first sample', async () => {
    (await loadDoctor())(new Command());
  });

  bench('loadVersions()(new Command()) then loadPrune()(...) — the real `prune` two-loader sequence, in order', async () => {
    const program = new Command();
    (await loadVersions())(program);
    (await loadPrune())(program);
  });

  bench('loadSessions()(new Command()) — registerSessionsCommands body only, no import cost after first sample', async () => {
    (await loadSessions())(new Command());
  });
});
