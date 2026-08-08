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
import { describe, bench, afterAll } from 'vitest';
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
import {
  getAgentsDir,
  getLegacySystemAgentsDir,
  getMigratedSentinelPath,
  getUpdateCheckPath,
  readMeta,
} from './state.js';
import { isGitRepo } from './git.js';
import { installMenubarLaunchAgentOnUpgrade } from './menubar/install-menubar.js';
import {
  resolveBrandName,
  activeBrandName,
  isBranded,
  disabledCommandsForActiveBrand,
} from './brand.js';
// Real built artifact (see docblock above) -- NOT './auto-pull.js', which
// would resolve to the unbuilt TS source and always miss the worker script.
// dist/lib/auto-pull.d.ts exists (tsconfig.json declaration:true), so this
// resolves and type-checks normally -- no @ts-expect-error needed here.
import { spawnDetachedSync } from '../../dist/lib/auto-pull.js';
import { loadDoctor, loadVersions, loadPrune, loadSessions } from './startup/command-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPDATE_CHECK_FILE = getUpdateCheckPath();
const REAL_PATH = process.env.PATH || '';
const SYSTEM_DIR = getAgentsDir();
const LEGACY_SYSTEM_DIR = getLegacySystemAgentsDir();
const MIGRATED_SENTINEL_FILE = getMigratedSentinelPath();
// Mirrors `sentinelValue` in index.ts — keep in sync or the bench measures the
// non-short-circuiting path that a real (already-migrated) install never takes.
const MIGRATION_SENTINEL_VALUE = 'v19';

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
 *      does skip checkForUpdates/spawnDetachedSync (benched above, guarded by
 *      `!helpOrVersionRequested` at index.ts:1322) and ensureInitialized
 *      (index.ts:1373-1381, the only member of the migration triad that
 *      carries that guard -- the sibling migration-triad bench in PR #2277
 *      covers that path), so this isolates the registration/import cost from
 *      those pieces instead of conflating them. It does NOT skip
 *      foldLegacySystemRepo (index.ts:1366-1369) or runMigration
 *      (index.ts:1389-1391): both are gated only by the AGENTS_SKIP_MIGRATION
 *      env var, so a `--help` row still pays their `await import(
 *      './lib/migrate.js')`. An earlier revision of this docblock claimed
 *      runMigration was skipped too; it is not.
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

function runCli(args: string[]): number | null {
  // spawnSync (not execFileSync) so a non-zero exit never throws inside the
  // timed callback -- every arg list below is verified to exit 0 on this
  // machine, but the bench must stay robust to environment drift. The status
  // is RETURNED rather than swallowed so a caller whose row depends on
  // reaching a specific code path can assert it (see expectExit below);
  // callers that only need "a real cold process ran" ignore it.
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], { stdio: 'ignore' }).status;
}

/**
 * Assert a `runCli` row actually reached the code path it claims to measure.
 *
 * Without this, a row is only ever "a cold node process ran": if the argv
 * intercept it targets were moved or renamed, commander would take over,
 * print "unknown command" and exit 1, and the row would keep posting a
 * plausible number for entirely different work. Same reason coldEval throws.
 *
 * Takes a SET of acceptable codes, not one: the intercepted token's exit code
 * legitimately differs by machine (see the `__secrets-ping` row), and the
 * property being defended is "the intercept answered", not "it answered with
 * this specific number".
 */
function expectExit(status: number | null, allowed: readonly number[], label: string): void {
  if (status === null || !allowed.includes(status)) {
    throw new Error(
      `${label}: expected exit in {${allowed.join(', ')}}, got ${status} — this row is measuring the wrong path`,
    );
  }
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
/** Derived from CLI_ENTRY (declared above) so the two can never disagree. */
const DIST_ROOT = path.dirname(CLI_ENTRY);

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
 *
 * Three things keep the link from becoming a hazard, and they are
 * complementary rather than alternatives:
 *   - Named per-pid, so two concurrent runs of this file (two worktrees on one
 *     box, or CI beside a local run) cannot collide on the same path. A fixed
 *     name raced them into an EEXIST at MODULE scope, which kills the whole
 *     file rather than one row.
 *   - Removed in afterAll, so a normal run leaves nothing in tmpdir.
 *   - Unlinked before creation anyway, because afterAll does NOT run when a
 *     module-scope throw happens after it is registered (verified in review:
 *     the hook is skipped and the file exits 1). A leaked link would then make
 *     `symlinkSync` throw EEXIST for whichever later worker lands on that pid,
 *     killing that run at module scope for an unrelated reason. `force: true`
 *     unlinks the link itself without following it, and is a no-op when absent.
 */
const SHIM_LINK = path.join(os.tmpdir(), `agents-cli-bench-shim-agents-${process.pid}`);
fs.rmSync(SHIM_LINK, { force: true });
fs.symlinkSync(CLI_ENTRY, SHIM_LINK);
afterAll(() => {
  fs.rmSync(SHIM_LINK, { force: true });
});

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
    detectDevBuild(CLI_ENTRY, REAL_VERSION);
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
 * The throw on a non-zero exit stops a dead child from posting a good number: a
 * mistyped or moved specifier makes the child exit in LESS time than the
 * bare-spawn floor, so a swallowed failure would read as the fastest row in the
 * table. Be precise about how loud that throw actually is, though — measured
 * under this repo's pinned vitest, a throw inside a `bench` callback does NOT
 * fail the run: tinybench catches it and the row reports no result (the summary
 * prints `NaNx faster than …`). So the throw alone buys "no false number", not
 * "the run fails". `preflightColdImports()` below is what makes it genuinely
 * loud: it runs each spec list ONCE at module scope, where a throw aborts the
 * whole bench file before a single sample is taken.
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

const SYNC_COMMANDS_SPEC = distUrl('lib/secrets/sync-commands.js');
const SECRETS_AGENT_SPEC = distUrl('lib/secrets/agent.js');
const DEV_BUILD_SPEC = distUrl('lib/startup/dev-build.js');
const SELF_UPDATE_SPEC = distUrl('lib/self-update.js');
const COMMAND_REGISTRY_SPEC = distUrl('lib/startup/command-registry.js');
const HELP_SPEC = distUrl('lib/help.js');
const WHATS_NEW_SPEC = distUrl('lib/whats-new.js');
const PLATFORM_SPEC = distUrl('lib/platform/index.js');
const CLI_ENTRY_SPEC = distUrl('lib/cli-entry.js');
const EVENTS_SPEC = distUrl('lib/events.js');
const EVENT_PROVENANCE_SPEC = distUrl('lib/event-provenance.js');
const FORMAT_SPEC = distUrl('lib/format.js');
const VIEW_COMMAND_SPEC = distUrl('commands/view.js');
const DOCTOR_COMMAND_SPEC = distUrl('commands/doctor.js');
const SESSIONS_COMMAND_SPEC = distUrl('commands/sessions.js');
const MENUBAR_INSTALL_SPEC = distUrl('lib/menubar/install-menubar.js');
const BRAND_SPEC = distUrl('lib/brand.js');
const AGENTS_REGISTRY_SPEC = distUrl('lib/agents.js');
const VERSIONS_SPEC = distUrl('lib/versions.js');
const PRIMITIVES_SPEC = distUrl('lib/agent-spec/primitives.js');
const STATE_SPEC = distUrl('lib/state.js');
const TYPES_SPEC = distUrl('lib/types.js');

/**
 * index.ts's own eager local-module imports, EXCLUDING brand.js — by line:
 * dev-build (16), sync-commands (36), self-update (86), command-registry
 * (124), help (208), whats-new (209), platform/index (211), cli-entry (212),
 * events (213), event-provenance (214), format (215), state (513). types.js
 * (210) is type-only and erased at compile, so it is not a runtime edge and
 * is excluded here (it gets its own row in the group above instead).
 */
const EAGER_MINUS_BRAND = [
  DEV_BUILD_SPEC,
  SYNC_COMMANDS_SPEC,
  SELF_UPDATE_SPEC,
  COMMAND_REGISTRY_SPEC,
  HELP_SPEC,
  WHATS_NEW_SPEC,
  PLATFORM_SPEC,
  CLI_ENTRY_SPEC,
  EVENTS_SPEC,
  EVENT_PROVENANCE_SPEC,
  FORMAT_SPEC,
  STATE_SPEC,
];
const EAGER_WITH_BRAND = [...EAGER_MINUS_BRAND, BRAND_SPEC];

/**
 * The two exit codes that mean `__secrets-ping` reached the intercept at
 * index.ts:71-84 and answered: 0 = a live broker replied (darwin, unlocked),
 * 3 = nothing was listening (agent.ts:1094-1097 returns one or the other).
 * Anything else — notably commander's unknown-command exit — means the
 * intercept was missed and the row is timing the wrong path.
 */
const PING_EXIT_CODES = [0, 3] as const;

/**
 * Prove every cold-import spec resolves, and that the token intercept still
 * answers, BEFORE any row is timed. Module scope, not a bench callback, so a
 * bad or moved specifier throws where vitest actually reports it — the file
 * fails (exit 1, a real Failed Suite) instead of quietly posting `NaN` for the
 * row that measured nothing. The in-row checks below are the same assertions
 * one layer down; they stop a false number, this is what makes it loud.
 */
(function preflightColdImports(): void {
  for (const spec of [
    SYNC_COMMANDS_SPEC,
    SECRETS_AGENT_SPEC,
    DEV_BUILD_SPEC,
    SELF_UPDATE_SPEC,
    COMMAND_REGISTRY_SPEC,
    HELP_SPEC,
    WHATS_NEW_SPEC,
    PLATFORM_SPEC,
    CLI_ENTRY_SPEC,
    EVENTS_SPEC,
    EVENT_PROVENANCE_SPEC,
    FORMAT_SPEC,
    VIEW_COMMAND_SPEC,
    DOCTOR_COMMAND_SPEC,
    SESSIONS_COMMAND_SPEC,
    MENUBAR_INSTALL_SPEC,
    BRAND_SPEC,
    AGENTS_REGISTRY_SPEC,
    VERSIONS_SPEC,
    PRIMITIVES_SPEC,
    STATE_SPEC,
    TYPES_SPEC,
  ])
    coldEval([spec]);
  // The multi-spec rows (EAGER_MINUS_BRAND / EAGER_WITH_BRAND) get their own
  // preflight since coldEval takes the whole list per sample there, not one
  // spec at a time.
  coldEval(EAGER_MINUS_BRAND);
  coldEval(EAGER_WITH_BRAND);
  coldEval([EVENTS_SPEC, EVENT_PROVENANCE_SPEC, FORMAT_SPEC]);
  coldEval([...EAGER_WITH_BRAND, VIEW_COMMAND_SPEC]);
  // Same reasoning for the one runCli row whose number is only meaningful if
  // the index.ts:71-84 intercept was actually reached.
  expectExit(runCli([SYNC_PING_CMD]), PING_EXIT_CODES, '__secrets-ping preflight');
  expectExit(runCli(['--version']), [0], '--version preflight');
})();

describe('the secrets-broker intercept (index.ts:36, 71-84) — what the leaf module buys, measured on both sides', () => {
  bench('FLOOR: bare `node --input-type=module -e ""` — the spawn cost every row below also pays; subtract it', () => {
    coldEval([]);
  }, COLD_OPTS);

  bench('lib/secrets/sync-commands.js — the leaf actually imported at index.ts:36. Three exported string constants, zero imports (sync-commands.ts:19-21)', () => {
    coldEval([SYNC_COMMANDS_SPEC]);
  }, COLD_OPTS);

  bench('lib/secrets/agent.js — the graph index.ts:58-61 says binding the tokens from agent.ts would drag in on EVERY invocation. agent.ts:27-44 declares 18 static imports; 17 survive into dist/lib/secrets/agent.js:26-42 (the type-only one at agent.ts:38 is elided), reaching ../state.js, ./install-helper.js, ./session-store.js, ../version.js, ../cli-entry.js, ./lease.js and ./audit.js. NOT on the eager path today; this row is the counterfactual that prices that decision', () => {
    coldEval([SECRETS_AGENT_SPEC]);
  }, COLD_OPTS);

  bench('the dispatch itself: real cold `node dist/index.js __secrets-ping` (index.ts:71-84). index.ts:44-47 calls this "the hot read path" — readAndResolveBundleEnv is synchronous all the way down, so it cannot await a socket and spawns one of these per read instead, reading the exit code. What this row measures is MACHINE-DEPENDENT past the bootstrap: runAgentPingSync (agent.ts:1094-1097) has no darwin gate (the onDarwin check at agent.ts:937-939 is a different function), it just connects — so with no broker listening the connect fails ENOENT, request() resolves null (agent.ts:906-911) and it exits 3 having done no broker work, which is the pure-bootstrap case reported here; on darwin with a live broker the same row exits 0 and additionally carries a real socket round-trip, bounded by SOCKET_PING_TIMEOUT_MS = 700 (agent.ts:113)', () => {
    expectExit(runCli([SYNC_PING_CMD]), PING_EXIT_CODES, '__secrets-ping');
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
  bench('`agents --version` — pays the full eager module graph (index.ts:10-215, 513-524), detectDevBuild (index.ts:113), the program chain (index.ts:243-251), AND the two migration hops that carry no help/version guard: foldLegacySystemRepo (index.ts:1366-1369) and runMigration (index.ts:1389-1391), both gated only by AGENTS_SKIP_MIGRATION, so `await import("./lib/migrate.js")` is inside this number. It skips only checkForUpdates + spawnDetachedSync (index.ts:1322) and ensureInitialized (index.ts:1373-1381)', () => {
    expectExit(runCli(['--version']), [0], '--version');
  }, { time: 4000, iterations: 15 });

  bench('FLOOR: bare `node --input-type=module -e ""` — same Node startup, no CLI. The gap is everything agents-cli adds to `--version`', () => {
    coldEval([]);
  }, { time: 4000, iterations: 15 });
});

/**
 * ============================================================================
 * The menu-bar startup self-heal (index.ts:1421-1425):
 *
 *   if (process.platform === 'darwin' && process.env.AGENTS_SKIP_MIGRATION !== '1') {
 *     try {
 *       const { installMenubarLaunchAgentOnUpgrade } = await import('./lib/menubar/install-menubar.js');
 *       installMenubarLaunchAgentOnUpgrade();
 *     } catch { }
 *   }
 *
 * Unlike checkForUpdates/spawnDetachedSync (index.ts:1322, guarded by
 * `!helpOrVersionRequested`) this block has NO help/version guard, so on
 * darwin it runs on every `agents <cmd>`, `agents --help`, and
 * `agents --version` alike -- it sits between the migration triad
 * (index.ts:1389-1411, benched in PR #2277) and the bare-invocation help
 * branch (index.ts:1433).
 *
 * THIS BOX IS LINUX (yosemite-s1), so `process.platform === 'darwin'` is
 * false and in real production this whole block -- import included -- never
 * executes here. Two things are still truthfully measurable on Linux and are
 * benched below; nothing about the macOS decision path is inferred or
 * invented from them:
 *
 *   1. THE MODULE IMPORT ITSELF (index.ts:1423) is plain ESM module
 *      resolution/evaluation with no platform branch at module scope in
 *      install-menubar.ts or any of its static imports (fs-atomic.ts,
 *      state.ts, version.ts, app-bundle-install.ts, agent-spec/primitives.ts
 *      -- verified by reading each for `^import`/`process.platform` before
 *      writing this bench). The bytes evaluated and the syscalls issued to
 *      resolve them are the same on darwin and Linux; only wall-clock speed
 *      differs by machine, which is why this whole file is dispatched on a
 *      fixed box rather than compared across boxes. So a cold-process import
 *      of dist/lib/menubar/install-menubar.js on this box IS the real cost
 *      index.ts:1423 pays before installMenubarLaunchAgentOnUpgrade() can
 *      even be called, on any platform.
 *   2. CALLING installMenubarLaunchAgentOnUpgrade() ITSELF, in-process, on
 *      this real Linux box. install-menubar.ts:630-632:
 *
 *        export function installMenubarLaunchAgentOnUpgrade(): void {
 *          try {
 *            if (!onDarwin()) return;
 *
 *      `onDarwin()` (install-menubar.ts:49-51) is `process.platform ===
 *      'darwin'`, so on THIS box the call returns after one property read --
 *      that is what the row below actually measures, honestly, for Linux.
 *
 * What is explicitly NOT benched, because it cannot be invoked truthfully on
 * a non-darwin box (the task's own instruction): everything past the
 * `!onDarwin()` guard -- menubarDisabledByUser() (existsSync on
 * disabledSentinelPath), menubarServiceInstalled() (existsSync on
 * servicePlistPath), menubarSetupStale() (existsSync + readFileSync on the
 * installed version marker), menubarSetupNeedsRepoint() (readFileSync +
 * regex match on the plist XML), installedNeedsDevIdHeal() (existsSync +
 * codesign spawnSync via hasDeveloperIdSignature), and mayHealMenubar()'s
 * cooldown read (install-menubar.ts:633-654). Those are the "two existsSync
 * checks then return" the index.ts:1418 comment describes, and the docblock
 * at install-menubar.ts:616-628 names them as running "on every darwin CLI
 * invocation" -- but on Linux `onDarwin()` returns before a single one of
 * them executes, so their real filesystem cost is UNVERIFIED here. No
 * darwin timings are invented for them; the pure decision functions among
 * them (isMenubarStale, menubarPlistNeedsRepoint, mayInstallMenubarHelper)
 * are unit-tested in install-menubar.test.ts, not benched, since they take
 * no I/O and are not where the described cost lives.
 *
 * No mocking: both groups run the real built dist/lib/menubar/install-
 * menubar.js and the real exported installMenubarLaunchAgentOnUpgrade().
 */
describe('menu-bar startup self-heal (index.ts:1421-1425) — cold module import, the real cost paid before the darwin gate can even run', () => {
  bench('FLOOR: bare `node --input-type=module -e ""` — same spawn cost every row below also pays; subtract it', () => {
    coldEval([]);
  }, COLD_OPTS);

  bench('lib/menubar/install-menubar.js — the exact specifier dynamically imported at index.ts:1423, its static graph incl. state.js (1382 lines), version.js, app-bundle-install.js, fs-atomic.js, agent-spec/primitives.js', () => {
    coldEval([MENUBAR_INSTALL_SPEC]);
  }, COLD_OPTS);
});

describe('installMenubarLaunchAgentOnUpgrade() — warm in-process call on THIS Linux box (install-menubar.ts:630-658)', () => {
  bench('real call on Linux: returns at the `!onDarwin()` guard (install-menubar.ts:632) after one process.platform read — NOT representative of the darwin decision path (menubarServiceInstalled/menubarSetupStale/mayHealMenubar fs checks), which is unverified on this box; see docblock above', () => {
    installMenubarLaunchAgentOnUpgrade();
  });
});

/**
 * ============================================================================
 * White-label bootstrap: `resolveBrandName()` (index.ts:241) and
 * `disabledCommandsForActiveBrand()` (index.ts:1244), both from
 * `./lib/brand.js` (statically imported at index.ts:514). Unlike every other
 * group above, this import is a plain top-level `import { ... } from
 * './lib/brand.js'` — ESM hoists it, so it is evaluated at module-load time
 * regardless of where the line sits textually, and it runs on EVERY
 * invocation: `resolveBrandName()` at index.ts:241 fires unconditionally
 * before `program = new Command()`, and `disabledCommandsForActiveBrand()` at
 * index.ts:1244 fires unconditionally before command registration, gated by
 * neither `--help`/`--version` nor a `requestedCommand` check. This includes
 * the plain, unbranded `agents` CLI — brand.ts's docblock says brands make
 * "everything below ... byte-identical to before" for the unbranded case, but
 * that claim is about *behavior*, not *import cost*: the module graph brand.ts
 * pulls in at load time is paid before `resolveBrandName()` can tell you which
 * case you are in.
 *
 * brand.ts:20 imports `{ ALL_AGENT_IDS, AGENTS }` from `./agents.js` (3290
 * lines, verified: `wc -l src/lib/agents.ts`) for exactly two functions,
 * `reservedBrandNames()` (brand.ts:52-56) and `validateBrandName()`
 * (brand.ts:59-67) — both reachable only from `agents mine init <name>` /
 * `agents setup mine`, never from `resolveBrandName()` or
 * `disabledCommandsForActiveBrand()`. Grepping the earlier eager imports in
 * index.ts (commander, chalk, fs/os/path/url, dev-build.js, secrets/sync-
 * commands.js, self-update.js, startup/command-registry.js, help.js, whats-
 * new.js, types.js, platform/index.js, cli-entry.js, events.js, event-
 * provenance.js, format.js, state.js — everything above index.ts:514) for
 * `from '../agents.js'` / `from './agents.js'` and their own static import
 * lists turns up none of them importing agents.js, so brand.js is genuinely
 * the FIRST thing on the eager path that drags it in — nothing upstream of
 * index.ts:514 already paid this cost.
 *
 * agents.ts:26 in turn imports `{ resolveVersion, getVersionHomePath,
 * getBinaryPath }` from `./versions.js` — a 3738-line file (`wc -l
 * src/lib/versions.ts`) that is itself the single largest static-import
 * fan-out in this package: resources.ts, resource-profiles.ts, permissions.ts,
 * mcp.ts, convert.ts, import.ts, subagents.ts, workflows.ts, hooks.ts,
 * capabilities.ts, plugins.ts, rules/compose.ts, staleness/index.ts,
 * staleness/registry.ts, memory.ts, project-resources.ts, and
 * `@inquirer/prompts` (versions.ts:17-68) — AND versions.ts:35 imports back
 * from `./agents.js`, so agents.ts <-> versions.ts is a circular pair; Node's
 * ESM loader still evaluates the whole reachable graph once, cycle or not.
 * The three rows below decompose exactly how much of brand.js's real cost is
 * "load brand.ts's own 134 lines" versus "drag in agents.js" versus "drag in
 * versions.js and everything under it" — each row's (row - FLOOR) isolates
 * one layer, since FLOOR cancels identically in every row (same coldEval
 * spawn shape, see the coldEval docblock above).
 *
 * No mocking: every row spawns a real cold `node --input-type=module`
 * process and imports the real built dist/lib/*.js artifact — the same files
 * `node dist/index.js` loads on a real invocation.
 */
describe('brand.js eager import (index.ts:514) — cold module import, the graph paid before resolveBrandName()/disabledCommandsForActiveBrand() can even run, on EVERY invocation incl. the unbranded fast path', () => {
  bench('FLOOR: bare `node --input-type=module -e ""` — same spawn cost every row below also pays; subtract it', () => {
    coldEval([]);
  }, COLD_OPTS);

  bench('lib/brand.js alone — the exact specifier statically imported at index.ts:514 (brand.ts is 134 lines; this row is dominated by its own static imports, not its own body)', () => {
    coldEval([BRAND_SPEC]);
  }, COLD_OPTS);

  bench('lib/agents.js alone — the graph brand.ts:20 imports `{ ALL_AGENT_IDS, AGENTS }` from, for reservedBrandNames()/validateBrandName() (brand.ts:52-67), functions the unbranded fast path never calls. agents.ts is 3290 lines and itself imports versions.ts, capabilities.ts, fs-walk.ts, fuzzy.ts (agents.ts:12-27)', () => {
    coldEval([AGENTS_REGISTRY_SPEC]);
  }, COLD_OPTS);

  bench('lib/versions.js alone — the graph agents.ts:26 imports back from (circular with agents.ts, versions.ts:35), 3738 lines, the largest static-import fan-out in this package: resources.ts, resource-profiles.ts, permissions.ts, mcp.ts, convert.ts, import.ts, subagents.ts, workflows.ts, hooks.ts, capabilities.ts, plugins.ts, rules/compose.ts, staleness/*, memory.ts, project-resources.ts, @inquirer/prompts (versions.ts:17-68)', () => {
    coldEval([VERSIONS_SPEC]);
  }, COLD_OPTS);

  bench('lib/state.js alone — brand.ts\'s other real import (types.js is type-only, erased at compile). Already paid separately at index.ts:513 regardless of the brand edge, so this row is the baseline the marginal-cost group below needs', () => {
    coldEval([STATE_SPEC]);
  }, COLD_OPTS);

  bench('lib/types.js alone — the third brand.ts import (brand.ts:21 `import type { BrandConfig } from \'./types.js\'`), erased at compile so this row prices only its OWN static value imports, not a type-only reference', () => {
    coldEval([TYPES_SPEC]);
  }, COLD_OPTS);
});

/**
 * The rows above measure each module ISOLATED — a fresh process importing
 * ONLY that one specifier. That answers "how much does brand.js cost on its
 * own", but not "how much does brand.js cost ON TOP OF what a real `agents`
 * invocation already loaded by the time it reaches index.ts:514" — and those
 * two numbers are very different, because self-update.js (index.ts:86-95,
 * BEFORE brand.js) already imports versions.js (self-update.ts:20), which
 * pulls in agents.js via the versions.ts<->agents.ts circular pair verified
 * above. By the time index.ts:514's `import ... from './lib/brand.js'`
 * evaluates, agents.js may already be warm in the SAME process's module
 * cache from self-update.js's own import — cold-import isolation cannot see
 * that sharing, because each isolated row above starts from a bare process
 * with nothing preloaded.
 *
 * This group measures the two real invocation shapes back to back in the
 * SAME kind of fresh process: index.ts's 12 other eager local-module imports
 * (dev-build, sync-commands, self-update, command-registry, help, whats-new,
 * platform/index, cli-entry, events, event-provenance, format, state — every
 * eager local import EXCEPT brand.js) with and without brand.js appended.
 * The delta between the two rows is brand.js's TRUE marginal cost inside a
 * real invocation, net of whatever self-update.js already shared with it —
 * which the isolated numbers above cannot show.
 */
describe('brand.js MARGINAL cost on top of the rest of the eager graph — does self-update.js already pay for what brand.js needs?', () => {
  bench('EAGER_MINUS_BRAND: the 12 other index.ts eager local imports (index.ts:16,36,86-95,124,208,209,211-215,513), no brand.js edge', () => {
    coldEval(EAGER_MINUS_BRAND);
  }, COLD_OPTS);

  bench('EAGER_WITH_BRAND: same 12 + lib/brand.js (index.ts:514) — the delta vs the row above is brand.js\'s real marginal startup cost once self-update.js\'s own versions.js->agents.js edge has already run in this process', () => {
    coldEval(EAGER_WITH_BRAND);
  }, COLD_OPTS);
});

/**
 * The call-time cost, warm in-process, on THIS real machine's real
 * ~/.agents/agents.yaml — contrasted against the import-time cost measured
 * above. resolveBrandName() (brand.ts:34-38) is one env-var read plus a
 * regex test; disabledCommandsForActiveBrand() (brand.ts:102-105) calls
 * getActiveBrandConfig() (brand.ts:84-90), which short-circuits at
 * `if (!name) return null` the moment activeBrandName() reports unbranded —
 * so on the unbranded fast path it NEVER calls readMeta() (state.ts:1124),
 * i.e. zero filesystem syscalls. Only when AGENTS_BRAND names something (real
 * or not) does getBrandConfig() -> listBrands() -> readMeta() actually touch
 * disk. readMeta() caches its parsed result keyed to a file-content stamp
 * (state.ts:1127-1134: "reduces N readMeta calls per CLI invocation to ~2 stat
 * syscalls"), so after the very first sample in a bench loop every further
 * iteration measures that warm 2-stat cache-hit path, not a genuinely cold
 * single-process disk read — an honest caveat, not a claim of a cold read.
 * This box's real ~/.agents/agents.yaml (verified: `ls -la ~/.agents/agents.yaml`)
 * has no `brands:` key configured, so the third row exercises a real,
 * unconfigured brand name rather than a fabricated meta.brands entry.
 *
 * The point these rows make together with the group above: on the unbranded
 * fast path, the CALL is free (no readMeta) but the IMPORT is not — the
 * entire cost this file's brand.js group measures is paid at module-load
 * time regardless of which branch resolveBrandName() ends up reporting.
 */
describe('resolveBrandName() / disabledCommandsForActiveBrand() — warm in-process calls (index.ts:241, 1244), real ~/.agents/agents.yaml on this box', () => {
  const ORIGINAL_AGENTS_BRAND = process.env.AGENTS_BRAND;
  afterAll(() => {
    if (ORIGINAL_AGENTS_BRAND === undefined) delete process.env.AGENTS_BRAND;
    else process.env.AGENTS_BRAND = ORIGINAL_AGENTS_BRAND;
  });

  bench('resolveBrandName() unbranded (AGENTS_BRAND unset) — index.ts:241, one env read + DEFAULT_CLI_NAME return, no regex test on the unset path (brand.ts:34-38)', () => {
    delete process.env.AGENTS_BRAND;
    resolveBrandName();
  });

  bench('activeBrandName() unbranded — resolveBrandName() + one string compare, returns null (brand.ts:41-44)', () => {
    delete process.env.AGENTS_BRAND;
    activeBrandName();
  });

  bench('isBranded() unbranded — activeBrandName() + one null check (brand.ts:47-49)', () => {
    delete process.env.AGENTS_BRAND;
    isBranded();
  });

  bench('disabledCommandsForActiveBrand() unbranded — index.ts:1244, short-circuits at getActiveBrandConfig (brand.ts:86: `if (!name) return null`) BEFORE readMeta() ever runs. This is the real cost every unbranded invocation on this fleet pays today: zero fs syscalls', () => {
    delete process.env.AGENTS_BRAND;
    disabledCommandsForActiveBrand();
  });

  bench('resolveBrandName() branded — AGENTS_BRAND set to a real-shaped name, regex-validated and returned as-is (brand.ts:36)', () => {
    process.env.AGENTS_BRAND = 'agents-cli-bench-nonexistent-brand';
    resolveBrandName();
  });

  bench('disabledCommandsForActiveBrand() with AGENTS_BRAND set to a real-shaped but unconfigured name — the branded-invocation floor: getBrandConfig (brand.ts:75) -> listBrands (brand.ts:70) -> readMeta() (state.ts:1124), a real ~/.agents/agents.yaml stat+read+parse (warm-cached after the first sample; see docblock), even though the brand does not exist in this box\'s real meta.brands and cfg ends up undefined', () => {
    process.env.AGENTS_BRAND = 'agents-cli-bench-nonexistent-brand';
    disabledCommandsForActiveBrand();
  });

  bench('readMeta() alone, warm — the exact hop the branded row above pays (state.ts:1124), isolated from brand.ts\'s own dispatch so its warm cache-hit cost (state.ts:1127-1134) can be read on its own', () => {
    readMeta();
  });
});

/**
 * Startup package metadata (index.ts:30-34). These top-level statements run
 * before either argv intercept can exit. The in-process rows decompose the real
 * read and parse; the existing cold `__secrets-ping` and `--version` rows above
 * are the end-to-end process anchors, and both assert their child exit status.
 */
const PACKAGE_JSON_PATH = path.join(CLI_ROOT, 'package.json');
const PACKAGE_JSON_RAW = fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8');

describe('startup package.json read + parse (index.ts:30-34)', () => {
  bench('fs.readFileSync(packageJsonPath, "utf-8") — the real apps/cli/package.json', () => {
    fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8');
  });

  bench('JSON.parse(already-read package.json) — parse cost without the filesystem read', () => {
    JSON.parse(PACKAGE_JSON_RAW);
  });

  bench('readFileSync + JSON.parse + .version — the complete top-level metadata statement', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as { version?: unknown };
    void pkg.version;
  });
});

/**
 * The settled-install work represented by index.ts:1394-1446, without invoking
 * either mutating entry point. Calling foldLegacySystemRepo() could rename or
 * remove the live legacy tree; calling ensureInitialized() can prompt, exit, or
 * run setup. The rows therefore execute only the exact non-mutating probes those
 * functions use on the steady path, against paths from state.ts.
 */
function probeLegacySystemRepo(): void {
  try {
    fs.lstatSync(LEGACY_SYSTEM_DIR);
  } catch {
    // An absent legacy directory is the normal post-fold state.
  }
}

function probeMigrationSentinel(): void {
  if (
    fs.existsSync(MIGRATED_SENTINEL_FILE) &&
    fs.readFileSync(MIGRATED_SENTINEL_FILE, 'utf-8').trim() === MIGRATION_SENTINEL_VALUE
  ) {
    // needRun = false; the mutating migration sweep stays outside this bench.
  }
}

describe('settled init/migration probes (index.ts:1394-1446) — non-mutating startup work', () => {
  bench('legacy fold probe — lstat(getLegacySystemAgentsDir()) + ENOENT catch (index.ts:1401-1405)', () => {
    probeLegacySystemRepo();
  });

  bench('system-repo readiness probe — isGitRepo(getAgentsDir()), the settled branch used before setup (index.ts:1408-1416)', () => {
    isGitRepo(SYSTEM_DIR);
  });

  bench('v19 migration sentinel gate — existsSync + readFileSync + trim, without runMigration (index.ts:1421-1443)', () => {
    probeMigrationSentinel();
  });

  bench('all settled probes — legacy lstat + system-repo existsSync + v18 sentinel read', () => {
    probeLegacySystemRepo();
    isGitRepo(SYSTEM_DIR);
    probeMigrationSentinel();
  });
});

/**
 * Individual eager imports complement EAGER_MINUS_BRAND/EAGER_WITH_BRAND above.
 * Every row uses coldEval, so a fresh Node process pays real module evaluation;
 * every spec is also exercised once by preflightColdImports at module scope.
 */
describe('eager startup module graph — selected cold import contributors', () => {
  bench('FLOOR: bare Node ESM process', () => {
    coldEval([]);
  }, COLD_OPTS);

  bench('startup/dev-build.js — index.ts:16', () => {
    coldEval([DEV_BUILD_SPEC]);
  }, COLD_OPTS);

  bench('startup/command-registry.js — index.ts eager loader table', () => {
    coldEval([COMMAND_REGISTRY_SPEC]);
  }, COLD_OPTS);

  bench('events.js + event-provenance.js + format.js — eager hook support graph', () => {
    coldEval([EVENTS_SPEC, EVENT_PROVENANCE_SPEC, FORMAT_SPEC]);
  }, COLD_OPTS);

  bench('commands/view.js — representative command module after eager bootstrap', () => {
    coldEval([VIEW_COMMAND_SPEC]);
  }, COLD_OPTS);

  bench('commands/doctor.js — representative diagnostics module after eager bootstrap', () => {
    coldEval([DOCTOR_COMMAND_SPEC]);
  }, COLD_OPTS);

  bench('commands/sessions.js — representative SQLite-backed command module', () => {
    coldEval([SESSIONS_COMMAND_SPEC]);
  }, COLD_OPTS);

  bench('eager graph then commands/view.js — real shared-cache shape for one command', () => {
    coldEval([...EAGER_WITH_BRAND, VIEW_COMMAND_SPEC]);
  }, COLD_OPTS);
});

/**
 * self-update.js is a static index.ts import. Its compareVersions dependency is
 * owned by the zero-dependency agent-spec/primitives.js leaf but can also arrive
 * through versions.js. These rows price the real built graphs; they do not
 * infer a production refactor or duplicate a child-process helper.
 */
describe('eager self-update import graph — cold module evaluation', () => {
  bench('FLOOR: bare Node ESM process', () => {
    coldEval([]);
  }, COLD_OPTS);

  bench('agent-spec/primitives.js — compareVersions owner', () => {
    coldEval([PRIMITIVES_SPEC]);
  }, COLD_OPTS);

  bench('platform/index.js — self-update platform dependency', () => {
    coldEval([PLATFORM_SPEC]);
  }, COLD_OPTS);

  bench('self-update.js — exact eager module imported by index.ts', () => {
    coldEval([SELF_UPDATE_SPEC]);
  }, COLD_OPTS);

  bench('versions.js — heavy comparison graph reached by the legacy re-export edge', () => {
    coldEval([VERSIONS_SPEC]);
  }, COLD_OPTS);
});
