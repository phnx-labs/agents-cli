/**
 * Benchmark for the agent-execution hot path: env construction (buildExecEnv),
 * argv assembly (buildExecCommand), and process spawn (execAgent -> spawnAgent).
 *
 * No mocking. Runs against this machine's REAL ~/.agents layout — the actual
 * agents.yaml (state.ts:1124 readMeta), the actual installed version homes
 * under ~/.agents/.history/versions/<agent>/ (versions.ts:1284
 * listInstalledVersions), and, for the spawn group, the actual installed
 * `claude` binary. `process.cwd()` during a real `vitest bench` run is this
 * package's directory inside whatever checkout invoked it (typically several
 * levels deep under a git worktree), so the project-version directory walk in
 * versions.ts:2287 getProjectVersion runs its REAL depth here, not a synthetic
 * shallow stub.
 *
 * The dominant, measured cost driver in buildExecEnv turned out to be neither
 * of the two caches below on their own -- it's claude-account-token.ts:51
 * resolveClaudeSetupToken(), called from exec.ts:425 for EVERY resolved claude
 * version (pinned or auto-resolved) whose version home has a signed-in
 * account. Before RUSH-2317 it was uncached: each call re-derived an AES key via
 * `scryptSync` (secrets/filestore.ts:208-210, invoked from
 * decryptForFallback at secrets/filestore.ts:230-240) to decrypt the
 * file-backed `auth` secrets bundle. Measured standalone (a one-off
 * `performance.now()` probe against the real bundle, not part of this
 * benchmark file): ~150-170ms per call, first call and every call after. RUSH-2317
 * added a process-lifetime token cache keyed by version home and the encrypted
 * item file's identity, ctime, mtime, and size, so unchanged follow-up calls pay
 * only file metadata checks. A version home with NO signed-in
 * account short-circuits at claude-account-token.ts:56-57
 * (readClaudeAccountEmail returns null) before ever reaching the decrypt, so
 * the SAME code path costs ~0.07ms or ~150ms purely depending on whether that
 * specific version is logged in — that split, not warm/cold cache state, is
 * the headline finding, so it is what this file isolates directly with two
 * explicit version pins discovered from the real ~/.agents/.history/versions/
 * layout: `loggedInClaudeVersion` and `loggedOutClaudeVersion`.
 *
 * Two cache regimes are ALSO benchmarked, because they cost meaningfully
 * different amounts on top of the above:
 *
 *   - WARM: state.ts:1124 readMeta()'s mtime-keyed cache and actor.ts:163
 *     resolveActor()'s process-lifetime cache are both hot. This is the
 *     steady state inside one long-lived orchestrator process that calls
 *     buildExecEnv many times (loop.ts:214, teams, runner.ts:720).
 *   - COLD: both caches invalidated before every sample, matching the FIRST
 *     buildExecEnv call in a freshly spawned `agents run` process -- the
 *     common case, since every real CLI invocation is its own process.
 *     Measured here it costs about the same as warm (readMeta's re-parse of a
 *     ~5KB agents.yaml and a fresh actor resolve are both sub-millisecond) --
 *     NOT because the invalidation is a no-op, but because this shell's
 *     process.env already carries `AGENTS_ACTOR=UNRESOLVED@zion` (inherited
 *     from the agent harness that launched this session), so actor.ts:149
 *     `inheritedActor(env)` returns immediately and computeActor() never
 *     reaches the SSH branch. A genuinely fresh interactive terminal (no
 *     inherited AGENTS_ACTOR) would instead hit actor.ts:152-154 and, on an
 *     SSH-connected box (SSH_CONNECTION set), pay actor.ts:62 tailscaleWhois()
 *     — a real `spawnSync('tailscale', ['whois', ...])` subprocess capped at
 *     2s (actor.ts:53 WHOIS_TIMEOUT_MS) — on that literal first call. That
 *     cost is real but environment-dependent and not reproduced by this bench
 *     run; it is called out here rather than silently assumed.
 *
 * The execAgent group spawns the REAL installed `claude` binary (real fork+exec,
 * real buildExecEnv/buildExecCommand output) with `passthroughArgs: ['--version']`
 * appended. Claude's own arg parsing short-circuits on `--version` before doing
 * any network/session work (verified: `claude -p "x" --permission-mode plan
 * --version` exits in ~0.2s printing only the version string) — this measures
 * exec.ts's own spawn overhead without paying for (or depending on) a real,
 * non-deterministic, network-bound agent conversation.
 */
import { describe, bench } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildExecEnv, buildExecCommand, execAgent } from './exec.js';
import type { ExecOptions } from './exec.js';
import { resetActorCache } from './actor.js';
import { getUserAgentsDir, getHistoryDir } from './state.js';
import { listInstalledVersions } from './versions.js';

function execOpts(over: Partial<ExecOptions> & { agent: ExecOptions['agent'] }): ExecOptions {
  return { mode: 'plan', effort: 'auto', cwd: process.cwd(), ...over } as ExecOptions;
}

// Discovered from the REAL version-home layout so this bench runs unmodified
// on any dev box (or degrades gracefully when nothing is installed, e.g. a
// bare CI runner -- this file is not wired into `vitest run`, see
// vitest.config.ts:9, so that only matters for a human running it locally).
const installedClaudeVersions = listInstalledVersions('claude');
const installedCodex = listInstalledVersions('codex').at(-1);

/**
 * Whether a claude version's home has a resolvable oauth account email
 * (claude-account-token.ts:29 readClaudeAccountEmail's own check), WITHOUT
 * going through the secrets bundle at all -- this only reads the plaintext
 * `.claude.json` account marker, never a secret value, so it is safe to run
 * as bench setup and never prints anything sensitive.
 */
function hasResolvableAccount(version: string): boolean {
  const home = path.join(getHistoryDir(), 'versions', 'claude', version, 'home');
  for (const p of [path.join(home, '.claude', '.claude.json'), path.join(home, '.claude.json')]) {
    try {
      const email = (JSON.parse(fs.readFileSync(p, 'utf-8')) as {
        oauthAccount?: { emailAddress?: unknown };
      }).oauthAccount?.emailAddress;
      if (typeof email === 'string' && email.trim().length > 0) return true;
    } catch { /* try the next candidate path */ }
  }
  return false;
}

const loggedInClaudeVersion = installedClaudeVersions.find(hasResolvableAccount);
const loggedOutClaudeVersion = installedClaudeVersions.find((v) => !hasResolvableAccount(v));

const metaFile = path.join(getUserAgentsDir(), 'agents.yaml');

/**
 * Force the next buildExecEnv call to pay full cold-start cost: clears the
 * process-lifetime actor cache (actor.ts:157 `cached`) and bumps agents.yaml's
 * mtime so state.ts:1130 readMeta()'s stamp check misses and it re-parses --
 * exactly the "another process touched the file" invalidation path the module
 * doc at state.ts:1120 describes.
 *
 * tinybench's bench-level `setup` hook (the only per-task hook vitest's
 * `bench(name, fn, options)` actually exposes -- `beforeEach`/`afterEach` are
 * tinybench's internal per-Task `FnOptions`, not part of the `Options` shape
 * vitest forwards, and using them here is a type error) fires ONCE before a
 * task's `run()`, not once per sample. So to measure a genuinely cold call
 * rather than one cold sample diluted into a mean with many warm ones, every
 * cold bench() below pairs this `setup` with `{ iterations: 1, time: 1,
 * warmupIterations: 0, warmupTime: 0 }` -- no warmup, and a near-zero time
 * budget so the run loop stops as soon as its 1-sample floor is met.
 */
function invalidateCaches(_task: unknown, mode: 'warmup' | 'run'): void {
  if (mode !== 'run') return;
  resetActorCache();
  try {
    const now = new Date();
    fs.utimesSync(metaFile, now, now);
  } catch {
    // No ~/.agents/agents.yaml on this box -- readMeta() has nothing cached
    // to invalidate either, so the cold/warm distinction collapses; proceed.
  }
}

/** Bench options for a single, genuinely-cold sample — see invalidateCaches doc. */
const COLD_SAMPLE_OPTS = { setup: invalidateCaches, iterations: 1, time: 1, warmupIterations: 0, warmupTime: 0 } as const;

describe.skipIf(!loggedInClaudeVersion || !loggedOutClaudeVersion)(
  'buildExecEnv — resolveClaudeSetupToken cost split (exec.ts:424, claude-account-token.ts:51): same code path, signed-in vs not',
  () => {
    bench('pinned version WITH a signed-in account (first call decrypts; unchanged calls hit the token cache)', () => {
      buildExecEnv(execOpts({ agent: 'claude', version: loggedInClaudeVersion, sessionId: randomUUID() }));
    });

    bench('pinned version WITHOUT a signed-in account (readClaudeAccountEmail short-circuits, claude-account-token.ts:56)', () => {
      buildExecEnv(execOpts({ agent: 'claude', version: loggedOutClaudeVersion, sessionId: randomUUID() }));
    });
  },
);

describe('buildExecEnv — warm cache (steady state: loop.ts/teams/runner calling it repeatedly in one process)', () => {
  bench('claude, auto-resolved version (resolveVersion + isVersionInstalled + resolveClaudeSetupToken chain)', () => {
    buildExecEnv(execOpts({ agent: 'claude', sessionId: randomUUID() }));
  });

  bench('codex, explicit pinned version (no claude-account-token path at all)', () => {
    buildExecEnv(execOpts({ agent: 'codex', version: installedCodex ?? '0.146.0', sessionId: randomUUID() }));
  });

  bench('codex, auto-resolved version', () => {
    buildExecEnv(execOpts({ agent: 'codex', sessionId: randomUUID() }));
  });
});

describe('buildExecEnv — cold cache (single sample: the first call in a fresh `agents run` process)', () => {
  bench('claude, auto-resolved version', () => {
    buildExecEnv(execOpts({ agent: 'claude', sessionId: randomUUID() }));
  }, COLD_SAMPLE_OPTS);

  bench.skipIf(!loggedOutClaudeVersion)('claude, pinned version WITHOUT a signed-in account (isolates readMeta+actor cold cost from the scrypt cost above)', () => {
    buildExecEnv(execOpts({ agent: 'claude', version: loggedOutClaudeVersion, sessionId: randomUUID() }));
  }, COLD_SAMPLE_OPTS);
});

describe('buildExecCommand — argv assembly (runs immediately before spawn in spawnAgent, exec.ts:1745)', () => {
  bench('claude headless, explicit pinned version', () => {
    buildExecCommand(execOpts({
      agent: 'claude', version: loggedOutClaudeVersion ?? installedClaudeVersions.at(-1) ?? '2.1.221', prompt: 'benchmark prompt', sessionId: randomUUID(),
    }));
  });

  bench('claude headless, auto-resolved version + model tier (re-walks resolveVersion a second time, exec.ts:972)', () => {
    buildExecCommand(execOpts({
      agent: 'claude', prompt: 'benchmark prompt', model: 'sonnet', sessionId: randomUUID(),
    }));
  });
});

describe.skipIf(!loggedOutClaudeVersion)('execAgent — real subprocess spawn (real claude binary; --version passthrough keeps it network-free)', () => {
  bench('claude headless spawn, pinned version without a signed-in account (isolates spawn overhead from the scrypt cost above)', async () => {
    await execAgent(execOpts({
      agent: 'claude',
      version: loggedOutClaudeVersion,
      prompt: 'benchmark prompt',
      passthroughArgs: ['--version'],
    }));
  }, { time: 3000, iterations: 15 });
});
