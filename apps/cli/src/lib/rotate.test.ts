import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rotationFailoverChain,
  shouldArmRotationFailover,
  DEFAULT_ROTATION_FAILOVER_LIMIT,
  pickBalancedCandidate,
  pickAvailableCandidate,
  pickHarnessWeighted,
  classifyHarnessCandidates,
  formatHarnessPickBanner,
  formatNoHealthyAccountError,
  formatNoHealthyHarnessError,
  earliestResetAcross,
  readinessFromCandidate,
  matchAccountVersion,
  isUsageVerified,
  capacityWeight,
  PROJECTION_HORIZON_MIN,
  resolveRunVersion,
  type RotateCandidate,
  type RotateResult,
  type FailoverArmingContext,
} from './rotate.js';
import { runWithFallback } from './exec.js';
import type { AgentId } from './types.js';
import type { UsageSnapshot, UsageWindowKey } from './usage.js';

/**
 * Build a healthy RotateCandidate (signed in, no live snapshot
 * => treated as full capacity). Pass overrides — e.g. `usageStatus:
 * 'rate_limited'` — to make it unhealthy.
 */
function candidate(over: Partial<RotateCandidate> & { version: string }): RotateCandidate {
  return {
    agent: 'claude',
    accountKey: `claude:account=${over.version}`,
    accountLabel: `${over.version}@example.com`,
    email: `${over.version}@example.com`,
    usageKey: `claude:org=${over.version}`,
    usageStatus: 'available',
    usageSnapshot: null,
    usageError: null,
    usageMinutesToLimit: null,
    plan: 'Max',
    signedIn: true,
    lastActive: null,
    ...over,
  };
}

/** A RotateResult with `healthy` in the given order and `picked` = healthy[pickedIdx]. */
function rotation(healthy: RotateCandidate[], pickedIdx = 0): RotateResult {
  return { picked: healthy[pickedIdx], healthy, excluded: [] };
}

describe('matchAccountVersion (RUSH-1957 — pin a routine to an account by identity)', () => {
  const gmail = candidate({ version: '2.1.186', email: 'muqsitnawaz@gmail.com' });
  const trp = candidate({ version: '2.1.207', email: 'muqsit@trp.so' });
  const signedOut = candidate({ version: '2.1.180', email: 'stale@example.com', signedIn: false });
  const pool = [gmail, trp, signedOut];

  it('resolves a login email to its installed version slot (case-insensitive)', () => {
    expect(matchAccountVersion(pool, 'muqsit@trp.so')).toBe('2.1.207');
    expect(matchAccountVersion(pool, 'MUQSIT@TRP.SO')).toBe('2.1.207');
    expect(matchAccountVersion(pool, '  muqsitnawaz@gmail.com  ')).toBe('2.1.186');
  });

  it('resolves an account key as well as an email', () => {
    expect(matchAccountVersion(pool, 'claude:account=2.1.207')).toBe('2.1.207');
  });

  it('never returns a signed-out slot even when its identity matches', () => {
    expect(matchAccountVersion(pool, 'stale@example.com')).toBeNull();
  });

  it('returns null for an unknown account or an empty string, so the caller falls back and warns', () => {
    expect(matchAccountVersion(pool, 'nobody@nowhere.dev')).toBeNull();
    expect(matchAccountVersion(pool, '   ')).toBeNull();
    expect(matchAccountVersion([], 'muqsit@trp.so')).toBeNull();
  });
});

describe('rotationFailoverChain (#348 — synthesize a same-agent failover chain)', () => {
  it('turns the other healthy accounts into fallback entries, skipping the picked one', () => {
    const a = candidate({ version: '1.0.0' });
    const b = candidate({ version: '2.0.0' });
    const c = candidate({ version: '3.0.0' });
    // A is the account picked pre-flight; B and C are the healthy alternatives.
    const chain = rotationFailoverChain(rotation([a, b, c], 0), a.version);
    expect(chain).toEqual([
      { agent: 'claude', version: '2.0.0' },
      { agent: 'claude', version: '3.0.0' },
    ]);
  });

  it('preserves rotation.healthy order (freshest account first) and never re-lists the primary', () => {
    const healthy = [
      candidate({ version: '1.0.0' }),
      candidate({ version: '2.0.0' }),
      candidate({ version: '3.0.0' }),
    ];
    // Primary is the middle account; failover keeps the other two in order.
    const chain = rotationFailoverChain(rotation(healthy, 1), '2.0.0');
    expect(chain.map(e => e.version)).toEqual(['1.0.0', '3.0.0']);
    expect(chain.some(e => e.version === '2.0.0')).toBe(false);
  });

  it('bounds the chain to the failover limit', () => {
    const healthy = Array.from({ length: 6 }, (_, i) => candidate({ version: `${i}.0.0` }));
    const chain = rotationFailoverChain(rotation(healthy, 0), '0.0.0');
    expect(chain.length).toBe(DEFAULT_ROTATION_FAILOVER_LIMIT);
    const custom = rotationFailoverChain(rotation(healthy, 0), '0.0.0', 2);
    expect(custom.length).toBe(2);
  });

  it('returns [] for a non-rotation run (pinned strategy => null rotation) — behavior unchanged', () => {
    expect(rotationFailoverChain(null, '1.0.0')).toEqual([]);
  });

  it('returns [] when the picked account is the only healthy one (single-account user)', () => {
    const only = candidate({ version: '1.0.0' });
    expect(rotationFailoverChain(rotation([only], 0), '1.0.0')).toEqual([]);
  });

  it('consumes the healthy set produced by the real pickBalancedCandidate (rate-limited account is never a failover target)', () => {
    const healthyA = candidate({ version: '1.0.0' });
    const healthyB = candidate({ version: '2.0.0' });
    const limited = candidate({ version: '3.0.0', usageStatus: 'rate_limited' });
    const result = pickBalancedCandidate([healthyA, healthyB, limited]);
    expect(result).not.toBeNull();
    const chain = rotationFailoverChain(result, result!.picked.version);
    // Exactly one alternative (the other healthy account); the picked and the
    // already-rate-limited account are both absent.
    expect(chain.length).toBe(1);
    expect(chain[0].version).not.toBe(result!.picked.version);
    expect(chain.some(e => e.version === '3.0.0')).toBe(false);
    expect(['1.0.0', '2.0.0']).toContain(chain[0].version);
  });
});

describe('shouldArmRotationFailover (#348 — arming gate; must not trip --acp/--loop guards)', () => {
  // The eligible baseline: a real rotation picked a version, there is a prompt,
  // and the run is a plain headless prompt run.
  const armable: FailoverArmingContext = {
    hasRotation: true,
    hasVersion: true,
    hasPrompt: true,
    interactive: false,
    acp: false,
    loop: false,
    resumeCheckpoint: false,
  };

  it('arms for a plain headless rotation run with alternatives', () => {
    expect(shouldArmRotationFailover(armable)).toBe(true);
  });

  // The regression this guards: arming injected into `fallback` before the
  // --acp / --loop guards made those runs hard-exit on a flag never passed.
  it('does NOT arm for --acp runs (they reject a non-empty fallback array)', () => {
    expect(shouldArmRotationFailover({ ...armable, acp: true })).toBe(false);
  });

  it('does NOT arm for --loop runs (they reject a non-empty fallback array)', () => {
    expect(shouldArmRotationFailover({ ...armable, loop: true })).toBe(false);
  });

  it('does NOT arm for --resume-checkpoint runs (they take the loop path)', () => {
    expect(shouldArmRotationFailover({ ...armable, resumeCheckpoint: true })).toBe(false);
  });

  it('does NOT arm for interactive or no-prompt runs', () => {
    expect(shouldArmRotationFailover({ ...armable, interactive: true })).toBe(false);
    expect(shouldArmRotationFailover({ ...armable, hasPrompt: false })).toBe(false);
  });

  // An explicit --fallback no longer disarms rotation failover: the same-agent
  // accounts are unshifted ahead of the cross-agent entries (gh-monitor heal
  // bug — `--fallback codex,droid` pinned every run to one capped account).
  // The armable baseline above is the explicit-fallback case too: the gate has
  // no explicitFallback input anymore.

  it('does NOT arm for pinned / non-rotation runs (no rotation or no picked version)', () => {
    expect(shouldArmRotationFailover({ ...armable, hasRotation: false })).toBe(false);
    expect(shouldArmRotationFailover({ ...armable, hasVersion: false })).toBe(false);
  });
});

// End-to-end proof that a synthesized chain actually recovers a 429 through the
// SAME runWithFallback engine: a real child process (no mocking of the code under
// test) 429s on the first ("account A") dispatch and succeeds on the re-dispatch
// ("account B"). A non-rate-limit failure must NOT cascade.
describe('runWithFallback re-dispatch on a mid-run 429 (the reused failover path)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** Write a stateful fake `amp` on a temp PATH; returns its bin dir + state file. */
  function fakeAmp(): { binDir: string; stateFile: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-failover-'));
    tmpDirs.push(root);
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir);
    const stateFile = path.join(root, 'calls');
    const script = `#!/usr/bin/env node
const fs = require('fs');
const stateFile = process.env.AGENTS_TEST_STATE;
const mode = process.env.AGENTS_TEST_MODE;
let n = 0;
try { n = parseInt(fs.readFileSync(stateFile, 'utf8'), 10) || 0; } catch {}
n += 1;
fs.writeFileSync(stateFile, String(n));
if (mode === 'plain-fail') {
  process.stderr.write('Error: compile failure — not a limit\\n');
  process.exit(1);
}
if (mode === 'stdout-spend-limit-then-ok') {
  // Claude prints billing refusals to STDOUT, not stderr — the cascade must
  // still detect them (via the SpawnResult stdout tail).
  if (n === 1) {
    process.stdout.write("You've hit your org's monthly spend limit \\u00b7 run /usage-credits to raise it\\n");
    process.exit(1);
  }
  process.stdout.write('done\\n');
  process.exit(0);
}
if (n === 1) {
  process.stderr.write('API request failed: 429 Too Many Requests (rate limit exceeded)\\n');
  process.exit(1);
}
process.stdout.write('done\\n');
process.exit(0);
`;
    const bin = path.join(binDir, 'amp');
    fs.writeFileSync(bin, script);
    fs.chmodSync(bin, 0o755);
    if (process.platform === 'win32') {
      // cmd.exe can't exec a shebang script. spawnAgent goes through the shell
      // on Windows (needsWindowsShell), which resolves `amp` via PATHEXT — so
      // the runnable fake must be a `.cmd` that hands the script to node.
      fs.writeFileSync(path.join(binDir, 'amp.js'), script);
      fs.writeFileSync(path.join(binDir, 'amp.cmd'), `@node "%~dp0amp.js" %*\r\n`);
    }
    return { binDir, stateFile };
  }

  it('a 429 on the primary account re-dispatches on the next account and succeeds', async () => {
    const { binDir, stateFile } = fakeAmp();
    const code = await runWithFallback({
      agent: 'amp',
      prompt: 'do the task',
      mode: 'edit',
      effort: 'auto',
      headless: true,
      cwd: binDir,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AGENTS_TEST_MODE: 'ratelimit-then-ok',
        AGENTS_TEST_STATE: stateFile,
      },
      // The synthesized "next healthy account" entry (same agent, different account).
      fallback: [{ agent: 'amp' }],
    });
    expect(code).toBe(0);
    // Primary 429'd (call 1), re-dispatched once and succeeded (call 2).
    expect(fs.readFileSync(stateFile, 'utf8')).toBe('2');
  });

  it('a billing refusal on STDOUT (spend limit) also cascades — the gh-monitor heal bug', async () => {
    const { binDir, stateFile } = fakeAmp();
    const code = await runWithFallback({
      agent: 'amp',
      prompt: 'do the task',
      mode: 'edit',
      effort: 'auto',
      headless: true,
      cwd: binDir,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AGENTS_TEST_MODE: 'stdout-spend-limit-then-ok',
        AGENTS_TEST_STATE: stateFile,
      },
      fallback: [{ agent: 'amp' }],
    });
    expect(code).toBe(0);
    expect(fs.readFileSync(stateFile, 'utf8')).toBe('2');
  });

  it('a non-rate-limit failure does NOT re-dispatch (only 429s cascade)', async () => {
    const { binDir, stateFile } = fakeAmp();
    const code = await runWithFallback({
      agent: 'amp',
      prompt: 'do the task',
      mode: 'edit',
      effort: 'auto',
      headless: true,
      cwd: binDir,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AGENTS_TEST_MODE: 'plain-fail',
        AGENTS_TEST_STATE: stateFile,
      },
      fallback: [{ agent: 'amp' }],
    });
    expect(code).toBe(1);
    // Ran the primary exactly once — a plain failure is surfaced, not retried.
    expect(fs.readFileSync(stateFile, 'utf8')).toBe('1');
  });
});

/** Build a UsageSnapshot from `[key, usedPercent]` pairs. */
function snapshot(windows: Array<{ key: UsageWindowKey; usedPercent: number }>): UsageSnapshot {
  return {
    source: 'live',
    sourceLabel: 'live',
    capturedAt: null,
    windows: windows.map((w) => ({
      key: w.key,
      label: w.key,
      shortLabel: w.key,
      usedPercent: w.usedPercent,
      resetsAt: null,
      windowMinutes: null,
    })),
  };
}

describe('readinessFromCandidate (pre-flight warning for version-pinned teammates)', () => {
  it('healthy account (auth ok, no snapshot, cached available) is ready', () => {
    expect(readinessFromCandidate(candidate({ version: '1.0.0' }))).toEqual({ ready: true });
  });

  it('no live snapshot + cached rate_limited => not ready, reason rate_limited', () => {
    expect(
      readinessFromCandidate(candidate({ version: '1.0.0', usageStatus: 'rate_limited' })),
    ).toEqual({ ready: false, reason: 'rate_limited', email: '1.0.0@example.com' });
  });

  it('no live snapshot + cached out_of_credits => not ready, reason out_of_credits', () => {
    expect(
      readinessFromCandidate(candidate({ version: '1.0.0', usageStatus: 'out_of_credits' })),
    ).toEqual({ ready: false, reason: 'out_of_credits', email: '1.0.0@example.com' });
  });

  it('live snapshot with the 5h session window maxed => not ready (session-inclusive, matches the badge)', () => {
    // usageStatus stays the default `available`; the live snapshot must still
    // exclude it — this is the exact drift #757 fixed and the warning must mirror.
    const c = candidate({ version: '1.0.0', usageSnapshot: snapshot([{ key: 'session', usedPercent: 100 }]) });
    expect(readinessFromCandidate(c)).toEqual({ ready: false, reason: 'rate_limited', email: '1.0.0@example.com' });
  });

  it('live snapshot showing capacity WINS over a stale cached out_of_credits => ready', () => {
    // Mirrors hasUsageAvailable: a present live snapshot overrides the coarse
    // cache, so we do not warn about an account that is actually serving.
    const c = candidate({
      version: '1.0.0',
      usageStatus: 'out_of_credits',
      usageSnapshot: snapshot([{ key: 'session', usedPercent: 20 }, { key: 'week', usedPercent: 40 }]),
    });
    expect(readinessFromCandidate(c)).toEqual({ ready: true });
  });

  it('only the Sonnet-weekly window is maxed => ready (sonnet_week never blocks when a real window is present)', () => {
    const c = candidate({
      version: '1.0.0',
      usageSnapshot: snapshot([{ key: 'session', usedPercent: 50 }, { key: 'sonnet_week', usedPercent: 100 }]),
    });
    expect(readinessFromCandidate(c)).toEqual({ ready: true });
  });

  it('opaque signed-in credential without an email remains ready', () => {
    expect(
      readinessFromCandidate(candidate({ version: '1.0.0', email: null })),
    ).toEqual({ ready: true });
  });

  it('signed-out credential is rejected even with usage headroom', () => {
    expect(
      readinessFromCandidate(candidate({ version: '1.0.0', signedIn: false })),
    ).toEqual({ ready: false, reason: 'signed_out', email: '1.0.0@example.com' });
  });
});

/** A snapshot stamped with a real capture time, for the freshness gate. */
function snapshotAt(
  capturedAt: Date,
  windows: Array<{ key: UsageWindowKey; usedPercent: number }>,
): UsageSnapshot {
  return { ...snapshot(windows), capturedAt };
}

describe('routing refuses to decide on usage it cannot verify', () => {
  // The real incident: yosemite-s1's usage cache sat 26h–2.7d old with a
  // failing refresh, so balanced read muqsit@getrush.ai as 48% used and
  // launched into it. The account was actually at its weekly cap and the
  // session answered "You've hit your weekly limit" on its first turn.
  const NOW = Date.UTC(2026, 7, 3, 6, 57);
  const fresh = (usedPercent: number) =>
    snapshotAt(new Date(NOW - 60_000), [{ key: 'week', usedPercent }]);
  const dayOld = (usedPercent: number) =>
    snapshotAt(new Date(NOW - 26 * 3600 * 1000), [{ key: 'week', usedPercent }]);

  it('never picks a day-old candidate while a verified one exists — even when the stale one looks emptier', () => {
    const stale = candidate({ version: '2.1.181', usageSnapshot: dayOld(48) });
    const verified = candidate({ version: '2.1.219', usageSnapshot: fresh(90) });

    const result = pickBalancedCandidate([stale, verified], NOW)!;

    // 48% "used" would outweigh 90% under pure capacity weighting; unverified
    // loses to verified regardless, because the 48% is not evidence.
    expect(result.picked.version).toBe('2.1.219');
    expect(result.usageUnverified).toBe(false);
    // ...but the stale account stays in `healthy`, because that array also feeds
    // rotationFailoverChain. Refusing to PICK it is not the same call as refusing
    // to fail over to it once the primary has already hit a 429.
    expect(result.healthy.map((c) => c.version).sort()).toEqual(['2.1.181', '2.1.219']);
    expect(result.excluded.map((c) => c.version)).not.toContain('2.1.181');
  });

  it('still launches when NOTHING can be verified, and says the pick was unverified', () => {
    // A box with a broken refresh must not become unlaunchable — but the
    // operator has to learn the route was blind, not silently inherit it.
    const a = candidate({ version: '2.1.181', usageSnapshot: dayOld(48) });
    const b = candidate({ version: '2.1.207', usageSnapshot: dayOld(70) });

    const result = pickBalancedCandidate([a, b], NOW)!;

    expect(result.usageUnverified).toBe(true);
    expect(result.healthy.length).toBe(2);
    expect(['2.1.181', '2.1.207']).toContain(result.picked.version);
  });

  it('a verified rate-limited account is still excluded outright, not merely deprioritized', () => {
    const limited = candidate({ version: '2.1.170', usageSnapshot: fresh(100) });
    const ok = candidate({ version: '2.1.219', usageSnapshot: fresh(20) });

    const result = pickBalancedCandidate([limited, ok], NOW)!;

    expect(result.picked.version).toBe('2.1.219');
    expect(result.excluded.map((c) => c.version)).toContain('2.1.170');
  });

  it('isUsageVerified: a snapshot with no capture time is unverified, not assumed current', () => {
    expect(isUsageVerified(candidate({ version: '1.0.0', usageSnapshot: fresh(10) }), NOW)).toBe(true);
    expect(isUsageVerified(candidate({ version: '1.0.0', usageSnapshot: dayOld(10) }), NOW)).toBe(false);
    // snapshot() leaves capturedAt null — an undated number proves nothing.
    expect(isUsageVerified(candidate({ version: '1.0.0', usageSnapshot: snapshot([{ key: 'week', usedPercent: 10 }]) }), NOW)).toBe(false);
    expect(isUsageVerified(candidate({ version: '1.0.0' }), NOW)).toBe(false);
  });
});

describe('--strategy available applies the same freshness rule as balanced', () => {
  // The reviewer's catch: collectRunCandidates caps staleness for EVERY caller,
  // so `available` paid the new live-fetch cost while keeping the exact bug —
  // it sorts by apparent headroom and takes the front, so an unconfirmed "48%
  // used" outranked an accurate "90% used" just as it did under balanced.
  const NOW = Date.UTC(2026, 7, 3, 6, 57);
  const fresh = (usedPercent: number) =>
    snapshotAt(new Date(NOW - 60_000), [{ key: 'week', usedPercent }]);
  const dayOld = (usedPercent: number) =>
    snapshotAt(new Date(NOW - 26 * 3600 * 1000), [{ key: 'week', usedPercent }]);

  it('does not route to the emptier-looking stale account over a verified one', () => {
    const stale = candidate({ version: '2.1.181', usageSnapshot: dayOld(48) });
    const verified = candidate({ version: '2.1.219', usageSnapshot: fresh(90) });

    const result = pickAvailableCandidate([stale, verified], null, NOW)!;

    expect(result.picked.version).toBe('2.1.219');
    expect(result.usageUnverified).toBe(false);
  });

  it('flags the pick when nothing could be verified, and still launches', () => {
    const a = candidate({ version: '2.1.181', usageSnapshot: dayOld(48) });
    const b = candidate({ version: '2.1.207', usageSnapshot: dayOld(70) });

    const result = pickAvailableCandidate([a, b], null, NOW)!;

    expect(result.usageUnverified).toBe(true);
    expect(result.picked.version).toBe('2.1.181'); // still the headroom sort
  });

  it('an explicit version preference is an instruction and still wins', () => {
    const stale = candidate({ version: '2.1.181', usageSnapshot: dayOld(48) });
    const verified = candidate({ version: '2.1.219', usageSnapshot: fresh(90) });

    const result = pickAvailableCandidate([stale, verified], '2.1.181', NOW)!;

    expect(result.picked.version).toBe('2.1.181');
  });
});

describe('capacityWeight — deprioritizes an account projected to cap soon', () => {
  it('is weekly headroom when there is no projection', () => {
    expect(capacityWeight(null, null)).toBe(100);
    expect(capacityWeight(50, null)).toBe(50);
    expect(capacityWeight(90, null)).toBe(10);
  });

  it('keeps full weight for an account comfortably far from its cap', () => {
    // >= the horizon (or unknown) => factor 1, weight unchanged.
    expect(capacityWeight(50, PROJECTION_HORIZON_MIN)).toBe(50);
    expect(capacityWeight(50, PROJECTION_HORIZON_MIN * 3)).toBe(50);
  });

  it('scales the weight down as the projected cap approaches', () => {
    // Half the horizon => half the weight; a few minutes out => near the floor.
    expect(capacityWeight(50, PROJECTION_HORIZON_MIN / 2)).toBeCloseTo(25, 5);
    expect(capacityWeight(50, 3)).toBeCloseTo(5, 5);
    // Projected to cap right now (minutesToLimit 0) => floored at 1, not 0.
    expect(capacityWeight(50, 0)).toBe(1);
  });

  it('makes a fast-burning account strictly less likely than an idle one at the SAME usage', () => {
    // The whole point: two accounts read 50% used, but one is racing toward its
    // 5h cap. It must weigh less so balanced routing avoids it.
    const burningFast = capacityWeight(50, 3);
    const idle = capacityWeight(50, null);
    expect(burningFast).toBeLessThan(idle);
  });
});

/** A candidate for a specific harness (the `candidate` helper above is claude-only). */
function harnessAcct(agent: AgentId, version: string, over: Partial<RotateCandidate> = {}): RotateCandidate {
  return {
    ...candidate({ version, ...over }),
    agent,
    accountKey: `${agent}:account=${version}`,
    accountLabel: `${version}@${agent}.example.com`,
    email: `${version}@${agent}.example.com`,
    usageKey: `${agent}:org=${version}`,
  };
}

describe('pickHarnessWeighted (run auto — the cross-harness layer, RUSH-2132)', () => {
  const NOW = Date.UTC(2026, 7, 3, 7, 0);
  const freshSnap = (usedPercent: number): UsageSnapshot =>
    snapshotAt(new Date(NOW - 60_000), [{ key: 'week', usedPercent }]);

  it('excludes a zero-healthy harness outright — it is never picked, not down-weighted', () => {
    const byHarness = new Map<AgentId, RotateCandidate[]>([
      ['claude', [harnessAcct('claude', '2.1.207', { usageStatus: 'rate_limited' })]],
      ['codex', [harnessAcct('codex', '0.116.0')]],
    ]);
    for (let i = 0; i < 50; i++) {
      const result = pickHarnessWeighted(byHarness, NOW)!;
      expect(result.picked.agent).toBe('codex');
    }
    const result = pickHarnessWeighted(byHarness, NOW)!;
    expect(result.healthy.map((s) => s.agent)).toEqual(['codex']);
    expect(result.excluded.map((s) => s.agent)).toEqual(['claude']);
    expect(result.excluded[0].exclusionReasons).toEqual(['1 rate_limited']);
  });

  it('weights harnesses by their BEST account headroom, sharing the account layer sampler', () => {
    // claude's best account is at 0% used (weight 100), codex's at 90% (weight
    // 10) — claude should win ~91% of rolls. 2000 rolls makes <80% statistically
    // impossible under the correct weighting.
    const byHarness = new Map<AgentId, RotateCandidate[]>([
      ['claude', [harnessAcct('claude', '2.1.207', { usageSnapshot: freshSnap(0) })]],
      ['codex', [harnessAcct('codex', '0.116.0', { usageSnapshot: freshSnap(90) })]],
    ]);
    let claudePicks = 0;
    const ROLLS = 2000;
    for (let i = 0; i < ROLLS; i++) {
      if (pickHarnessWeighted(byHarness, NOW)!.picked.agent === 'claude') claudePicks++;
    }
    expect(claudePicks / ROLLS).toBeGreaterThan(0.8);
  });

  it('capacity comes from the best account (min used), not the average — an exhausted sibling does not drag the harness down', () => {
    const byHarness = new Map<AgentId, RotateCandidate[]>([
      ['claude', [
        harnessAcct('claude', '2.1.207', { usageSnapshot: freshSnap(95) }),
        harnessAcct('claude', '2.1.186', { usageSnapshot: freshSnap(10) }),
      ]],
      ['codex', [harnessAcct('codex', '0.116.0', { usageSnapshot: freshSnap(50) })]],
    ]);
    const summaries = classifyHarnessCandidates(byHarness, NOW);
    const claude = summaries.find((s) => s.agent === 'claude')!;
    expect(claude.best!.version).toBe('2.1.186');
    expect(claude.bestUsedPercent).toBe(10);
    // Weights 90 vs 50 → claude ~64% of rolls.
    let claudePicks = 0;
    const ROLLS = 2000;
    for (let i = 0; i < ROLLS; i++) {
      if (pickHarnessWeighted(byHarness, NOW)!.picked.agent === 'claude') claudePicks++;
    }
    expect(claudePicks / ROLLS).toBeGreaterThan(0.55);
  });

  it('a stale snapshot never becomes the harness representative while a verified account exists', () => {
    const stale = snapshotAt(new Date(NOW - 26 * 3600 * 1000), [{ key: 'week', usedPercent: 5 }]);
    const byHarness = new Map<AgentId, RotateCandidate[]>([
      ['claude', [
        harnessAcct('claude', '2.1.181', { usageSnapshot: stale }),
        harnessAcct('claude', '2.1.219', { usageSnapshot: freshSnap(80) }),
      ]],
    ]);
    const [summary] = classifyHarnessCandidates(byHarness, NOW);
    // The day-old "5% used" is not evidence; the verified 80% account represents.
    expect(summary.best!.version).toBe('2.1.219');
  });

  it('single-harness degenerate case: the only healthy harness is always picked', () => {
    const byHarness = new Map<AgentId, RotateCandidate[]>([
      ['claude', [harnessAcct('claude', '2.1.207')]],
    ]);
    const result = pickHarnessWeighted(byHarness, NOW)!;
    expect(result.picked.agent).toBe('claude');
    expect(result.healthy.length).toBe(1);
    expect(result.excluded.length).toBe(0);
    expect(formatHarnessPickBanner(result)).toBe(
      '[agents] auto picked claude (best account headroom unknown, 1 of 1 harnesses healthy)',
    );
  });

  it('returns null when every harness is exhausted; classify carries the exclusion detail', () => {
    const byHarness = new Map<AgentId, RotateCandidate[]>([
      ['claude', [
        harnessAcct('claude', '2.1.207', { usageStatus: 'rate_limited' }),
        harnessAcct('claude', '2.1.186', { signedIn: false }),
      ]],
      ['codex', [harnessAcct('codex', '0.116.0', { usageStatus: 'out_of_credits' })]],
    ]);
    expect(pickHarnessWeighted(byHarness, NOW)).toBeNull();
    const summaries = classifyHarnessCandidates(byHarness, NOW);
    expect(summaries.every((s) => s.best === null)).toBe(true);
    const claude = summaries.find((s) => s.agent === 'claude')!;
    expect(claude.exclusionReasons).toEqual(['1 rate_limited', '1 signed_out']);
  });

  it('the banner names the picked harness and its best-account headroom', () => {
    const byHarness = new Map<AgentId, RotateCandidate[]>([
      ['claude', [harnessAcct('claude', '2.1.207', { usageStatus: 'rate_limited' })]],
      ['codex', [harnessAcct('codex', '0.116.0', { usageSnapshot: freshSnap(56) })]],
    ]);
    const result = pickHarnessWeighted(byHarness, NOW)!;
    expect(formatHarnessPickBanner(result)).toBe(
      '[agents] auto picked codex (best account 44% headroom, 1 of 2 harnesses healthy)',
    );
  });
});

describe('formatNoHealthyAccountError — the watchdog contract (RUSH-2132)', () => {
  const NOW = Date.UTC(2026, 7, 3, 7, 0);
  const resetAt = new Date(NOW + 2 * 3600 * 1000);
  const cappedSnap: UsageSnapshot = {
    source: 'live',
    sourceLabel: 'live',
    capturedAt: new Date(NOW - 60_000),
    windows: [{ key: 'week', label: 'week', shortLabel: 'week', usedPercent: 100, resetsAt: resetAt, windowMinutes: null }],
  };

  it('matches the exact message contract (literal `no healthy` + `resets <time>` + pinned escape hatch)', () => {
    const limited = candidate({ version: '2.1.207', usageSnapshot: cappedSnap });
    const msg = formatNoHealthyAccountError('claude', 'balanced', [limited], NOW);
    expect(msg).toBe(
      `agents: no healthy claude account under strategy 'balanced' — excluded: 2.1.207 (rate_limited); ` +
      `earliest window resets ${resetAt.toISOString()}. Use --strategy pinned to force the default.`,
    );
  });

  it('picks the earliest FUTURE reset across candidates and ignores past resets', () => {
    const later = new Date(NOW + 5 * 3600 * 1000);
    const past = new Date(NOW - 3600 * 1000);
    const snap = (resetsAt: Date): UsageSnapshot => ({
      ...cappedSnap,
      windows: [{ ...cappedSnap.windows[0], resetsAt }],
    });
    const a = candidate({ version: '1.0.0', usageSnapshot: snap(later) });
    const b = candidate({ version: '2.0.0', usageSnapshot: snap(resetAt) });
    const c = candidate({ version: '3.0.0', usageSnapshot: snap(past) });
    expect(earliestResetAcross([a, b, c], NOW)?.toISOString()).toBe(resetAt.toISOString());
  });

  it('degrades to `resets unknown` when no snapshot carries a reset timestamp', () => {
    const signedOut = candidate({ version: '2.1.207', signedIn: false });
    const msg = formatNoHealthyAccountError('claude', 'available', [signedOut], NOW);
    expect(msg).toContain('no healthy claude account');
    expect(msg).toContain("strategy 'available'");
    expect(msg).toContain('excluded: 2.1.207 (signed_out)');
    expect(msg).toContain('resets unknown');
  });

  it('names every excluded account with its reason', () => {
    const msg = formatNoHealthyAccountError('claude', 'balanced', [
      candidate({ version: '1.0.0', usageStatus: 'rate_limited' }),
      candidate({ version: '2.0.0', usageStatus: 'out_of_credits' }),
      candidate({ version: '3.0.0', signedIn: false }),
    ], NOW);
    expect(msg).toContain('excluded: 1.0.0 (rate_limited), 2.0.0 (out_of_credits), 3.0.0 (signed_out)');
  });

  it('formatNoHealthyHarnessError names each harness exclusion + the reset, and stays parseable', () => {
    const byHarness = new Map<AgentId, RotateCandidate[]>([
      ['claude', [
        harnessAcct('claude', '2.1.207', { usageSnapshot: cappedSnap }),
        harnessAcct('claude', '2.1.186', { signedIn: false }),
      ]],
      ['codex', [harnessAcct('codex', '0.116.0', { usageStatus: 'out_of_credits' })]],
    ]);
    const msg = formatNoHealthyHarnessError(classifyHarnessCandidates(byHarness, NOW), NOW);
    expect(msg).toContain('no healthy');
    expect(msg).toContain('claude (2 accounts: 1 rate_limited, 1 signed_out)');
    expect(msg).toContain('codex (1 account: 1 out_of_credits)');
    expect(msg).toContain(`resets ${resetAt.toISOString()}`);
  });
});

describe('resolveRunVersion — fail-loud signal on zero healthy (RUSH-2132)', () => {
  it('zero healthy accounts → rotation null + the full exhausted set (no silent default launch)', async () => {
    const limited = candidate({ version: '9.9.9', usageStatus: 'rate_limited' });
    const resolved = await resolveRunVersion('claude', 'balanced', process.cwd(), async () => [limited]);
    expect(resolved.rotation).toBeNull();
    expect(resolved.exhausted?.map((c) => c.version)).toEqual(['9.9.9']);
  });

  it('one healthy account → picked, no exhausted marker', async () => {
    const healthy = candidate({ version: '9.9.9' });
    const resolved = await resolveRunVersion('claude', 'balanced', process.cwd(), async () => [healthy]);
    expect(resolved.rotation?.picked.version).toBe('9.9.9');
    expect(resolved.version).toBe('9.9.9');
    expect(resolved.exhausted).toBeUndefined();
  });

  it('pinned never probes accounts and never reports exhausted — behavior unchanged', async () => {
    const resolved = await resolveRunVersion('claude', 'pinned', process.cwd(), async () => {
      throw new Error('pinned must not probe accounts');
    });
    expect(resolved.rotation).toBeNull();
    expect(resolved.exhausted).toBeUndefined();
  });
});
