import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rotationFailoverChain,
  shouldArmRotationFailover,
  DEFAULT_ROTATION_FAILOVER_LIMIT,
  pickBalancedCandidate,
  type RotateCandidate,
  type RotateResult,
  type FailoverArmingContext,
} from './rotate.js';
import { runWithFallback } from './exec.js';

/**
 * Build a healthy RotateCandidate (email present, auth valid, no live snapshot
 * => treated as full capacity). Pass overrides — e.g. `usageStatus:
 * 'rate_limited'` — to make it unhealthy.
 */
function candidate(over: Partial<RotateCandidate> & { version: string }): RotateCandidate {
  return {
    agent: 'claude',
    email: `${over.version}@example.com`,
    usageKey: `claude:org=${over.version}`,
    usageStatus: 'available',
    usageSnapshot: null,
    authValid: true,
    lastActive: null,
    ...over,
  };
}

/** A RotateResult with `healthy` in the given order and `picked` = healthy[pickedIdx]. */
function rotation(healthy: RotateCandidate[], pickedIdx = 0): RotateResult {
  return { picked: healthy[pickedIdx], healthy, excluded: [] };
}

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
  // no explicit/profile fallback, and the run is a plain headless prompt run.
  const armable: FailoverArmingContext = {
    hasRotation: true,
    hasVersion: true,
    hasPrompt: true,
    explicitFallback: false,
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

  it('does NOT arm when an explicit or profile fallback is already set', () => {
    expect(shouldArmRotationFailover({ ...armable, explicitFallback: true })).toBe(false);
  });

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
