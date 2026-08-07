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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { detectDevBuild } from './startup/dev-build.js';
import { SYNC_PING_CMD } from './secrets/sync-commands.js';
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

/**
 * ============================================================================
 * The core bootstrap block: everything index.ts evaluates and RUNS before the
 * first argv fast path can return — `detectDevBuild()` (index.ts:113), the
 * secrets-broker token dispatch (index.ts:71-84), and the root commander
 * program (index.ts:243-251). Paid by `--version` and `--help` too: the
 * `!helpOrVersionRequested` guard is at index.ts:1322, ~1200 lines below all of
 * it, and it only gates `checkForUpdates()` + `spawnDetachedSync()`.
 *
 * The groups below measure the WORK these lines do, not the cost of loading
 * their modules. The module-graph question — what `import { Command } from
 * 'commander'` (index.ts:10) and `import chalk from 'chalk'` (index.ts:11) cost
 * to evaluate — is the subject of the open sibling PR #2280, which adds a
 * per-import cold-child group to this same file. These groups deliberately do
 * not restate those rows; where a number here needs the import cost to be
 * interpretable it uses the whole-invocation anchor at the bottom instead.
 *
 * Two of these ARE in scope here and are not in that PR, because they are
 * counterfactuals rather than inventory:
 *   - lib/secrets/agent.js, the graph the leaf lib/secrets/sync-commands.js
 *     (index.ts:36) exists to keep OFF the eager path. index.ts:58-61 asserts
 *     that binding the tokens from agent.js "would pull the whole secrets graph
 *     into every invocation". That is an unmeasured claim in the source; the
 *     group below measures both sides of it.
 *   - the real cold `node dist/index.js --version`, the denominator every
 *     other row in this file is a fraction of.
 *
 * No mocking anywhere below: real syscalls against this checkout and this
 * machine's real filesystem, real cold `node` processes importing the real
 * built dist/ artifacts, and the real unmodified `commander` package.
 *
 * `detectDevBuild` is imported from the TS source (`./startup/dev-build.js` ->
 * src/lib/startup/dev-build.ts under vitest), unlike `spawnDetachedSync` above
 * which had to come from dist/. The distinction is `import.meta.url`:
 * spawnDetachedSync resolves a sibling worker script relative to its own module
 * location (auto-pull.ts:51), so the source copy takes a different branch;
 * detectDevBuild reads nothing but its two arguments (dev-build.ts:25-38), so
 * source and dist are the same code doing the same syscalls.
 */

/** Repo root of THIS checkout — dirname³ of src/lib/, i.e. apps/cli/../.. */
const REPO_ROOT = path.resolve(__dirname, '../../../..');
/** apps/cli of THIS checkout. */
const CLI_ROOT = path.resolve(__dirname, '../..');
const DIST_ROOT = path.join(CLI_ROOT, 'dist');

/**
 * A real symlink to the built entry, modelling the npm-global bin shim
 * (`<prefix>/bin/agents -> <prefix>/lib/node_modules/@phnx-labs/agents-cli/dist
 * /index.js`) that is `process.argv[1]` on a real user's invocation. It exists
 * so the `fs.realpathSync` hop at dev-build.ts:28 is measured on a genuine
 * symlink, which is the input the whole function was rewritten for: without
 * resolving it, `dirname(dirname())` walks to the npm prefix, and on Homebrew
 * that prefix is itself a git repo, so every Homebrew-node user was misread as
 * a dev build (dev-build.ts:13-23). A real link, not a fixture: the readlink is
 * a real syscall on a real inode.
 */
const SHIM_LINK = path.join(os.tmpdir(), 'agents-cli-bench-shim-agents');
fs.rmSync(SHIM_LINK, { force: true });
fs.symlinkSync(path.join(DIST_ROOT, 'index.js'), SHIM_LINK);

/**
 * A real file two levels under a real git repo root — `<repo>/scripts/release.sh`.
 * `dirname(dirname())` of it is REPO_ROOT, which carries both `.git` and a
 * `package.json`, so this is the only one of these inputs that reaches the end
 * of detectDevBuild: realpath -> existsSync(.git) HIT -> existsSync(package.json)
 * HIT -> readFileSync -> JSON.parse -> name compare (dev-build.ts:28-34). The
 * name there is `agents-cli-monorepo`, not `@phnx-labs/agents-cli`, so it
 * returns false — this is exactly the false-positive the guard at dev-build.ts:34
 * was added to reject, priced end to end.
 */
const GIT_ROOT_TWO_LEVELS_DOWN = path.join(REPO_ROOT, 'scripts', 'release.sh');

/**
 * The real installed version string, read from this checkout's package.json the
 * same way index.ts:31-34 does. Using a literal here would silently take the
 * `0.0.0-dev` fast path (dev-build.ts:26) and measure nothing.
 */
const REAL_VERSION: string = JSON.parse(
  fs.readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf-8'),
).version;

describe('detectDevBuild(process.argv[1], VERSION) — runs unconditionally at index.ts:113, before --version/--help can return (dev-build.ts:25-38)', () => {
  bench(`version fast path: a 0.0.0-dev stamp returns at dev-build.ts:26 with ZERO syscalls — what scripts/install.sh dev installs hit (real version here is ${REAL_VERSION}, which does NOT take this branch)`, () => {
    detectDevBuild(SHIM_LINK, '0.0.0-dev.deadbeef');
  });

  bench('npm-global shim (the real production input): realpathSync through a real symlink + ONE existsSync(.git) miss -> false (dev-build.ts:28-30)', () => {
    detectDevBuild(SHIM_LINK, REAL_VERSION);
  });

  bench('`node apps/cli/dist/index.js` from this working tree: realpathSync (no link) + ONE existsSync(.git) miss -> false. dirname(dirname(dist/index.js)) is apps/cli, and .git is TWO levels above that, so index.ts:106 case 2 ("running node dist/index.js from a working tree") does not fire in the monorepo layout', () => {
    detectDevBuild(path.join(DIST_ROOT, 'index.js'), REAL_VERSION);
  });

  bench('full path — realpath + existsSync(.git) HIT + existsSync(package.json) HIT + readFileSync + JSON.parse + name compare (dev-build.ts:28-34). The Homebrew-shaped false positive the rewrite rejects', () => {
    detectDevBuild(GIT_ROOT_TWO_LEVELS_DOWN, REAL_VERSION);
  });
});

/**
 * Cold-import `specs` in a fresh Node process; empty list = the bare spawn floor.
 *
 * Node caches an ESM module for the life of a process, so a second in-process
 * `import()` of the same specifier measures a Map lookup, not a module load.
 * An honest module-load number only comes from a fresh process. Every row in
 * the group below spawns the identical shape, so the constant Node floor
 * cancels between rows and (row - FLOOR) is that graph's own load cost.
 *
 * Fails loud on a non-zero exit rather than posting a number for a child that
 * died: a mistyped or moved specifier makes the child exit in less time than
 * the bare-spawn floor, so a swallowed failure would read as the FASTEST row in
 * the table. That is the repo's fail-loud-at-boundaries rule applied to a
 * benchmark — a row that measured nothing must say so.
 */
function coldEval(specs: string[]): void {
  const src = specs.map((s) => `await import(${JSON.stringify(s)});`).join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (r.status !== 0) {
    throw new Error(
      `cold import failed (status ${r.status}, signal ${r.signal}): ${String(r.stderr).slice(0, 400)}`,
    );
  }
}

const distUrl = (rel: string): string => pathToFileURL(path.join(DIST_ROOT, rel)).href;
const COLD_OPTS = { time: 3000, iterations: 12 } as const;

describe('the secrets-broker intercept (index.ts:36, 71-84) — what the leaf module buys, measured on both sides', () => {
  bench('FLOOR: bare `node --input-type=module -e ""` — the spawn cost every row below also pays; subtract it', () => {
    coldEval([]);
  }, COLD_OPTS);

  bench('lib/secrets/sync-commands.js — the leaf actually imported at index.ts:36. Three exported string constants, zero imports (sync-commands.ts:19-21)', () => {
    coldEval([distUrl('lib/secrets/sync-commands.js')]);
  }, COLD_OPTS);

  bench('lib/secrets/agent.js — the graph index.ts:58-61 says binding the tokens from agent.ts would drag in on EVERY invocation. agent.ts:27-44 declares 18 static imports; 17 survive into dist/lib/secrets/agent.js:26-42 (the type-only one at agent.ts:38 is elided), reaching ../state.js, ./install-helper.js, ./session-store.js, ../version.js, ../cli-entry.js, ./lease.js and ./audit.js. NOT on the eager path today; this row is the counterfactual that prices that decision', () => {
    coldEval([distUrl('lib/secrets/agent.js')]);
  }, COLD_OPTS);

  bench('the dispatch itself: real cold `node dist/index.js __secrets-ping` (index.ts:71-84). index.ts:44-47 calls this "the hot read path" — readAndResolveBundleEnv is synchronous all the way down, so it cannot await a socket and spawns one of these per read instead, reading the exit code. Off darwin the broker no-ops (agent.ts:23-24) and it exits 3, so this row is the BOOTSTRAP the token dispatch pays before answering, not broker work', () => {
    runCli([SYNC_PING_CMD]);
  }, { time: 4000, iterations: 15 });
});

describe('root program construction (index.ts:243-251) — commander work every invocation does before parse, warm in-process', () => {
  bench('new Command() alone (index.ts:243)', () => {
    new Command();
  });

  bench('the real chain: new Command() + .name().description().version().option().helpOption().addHelpCommand(false) (index.ts:243-251), with the real VERSION and the unbranded name', () => {
    new Command()
      .name('agents')
      .description('Environment manager for AI agents')
      .version(REAL_VERSION)
      .option('--verbose', 'Show startup self-heal details on stderr')
      .helpOption('-h, --help', 'Show help')
      .addHelpCommand(false);
  });
});

describe('whole-invocation anchor — real cold `node dist/index.js --version` (the denominator for every row above)', () => {
  bench('`agents --version` — pays the full eager module graph (index.ts:10-215, 513-524), detectDevBuild (index.ts:113) and the program chain (index.ts:243-251); skips checkForUpdates + spawnDetachedSync via index.ts:1322 and ensureInitialized + runMigration via index.ts:1377', () => {
    runCli(['--version']);
  }, { time: 4000, iterations: 15 });

  bench('FLOOR: bare `node --input-type=module -e ""` — same Node startup, no CLI. The gap is everything agents-cli adds to `--version`', () => {
    coldEval([]);
  }, { time: 4000, iterations: 15 });
});
