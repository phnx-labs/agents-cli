/**
 * Unit tests for the keychain-helper reaper planner.
 *
 * The planner is pure: it accepts a `ps`-like snapshot and previous candidate
 * state, and returns which PIDs to kill plus the next candidate map. These tests
 * run on every platform; the impure `ps` driver is exercised separately in a
 * darwin-gated integration test.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  planKeychainReap,
  reapOrphanedKeychainProcesses,
  ORPHAN_GRACE_SEC,
  STUCK_GRACE_SEC,
  resetKeychainReaperCandidatesForTest,
  type KeychainProcessSnapshot,
  type StuckParentCandidate,
} from './reaper.js';
// Imported statically, NOT via an inline require(): these are local TS modules,
// and a CommonJS `require('./install-helper.js')` inside a vitest ESM test cannot
// resolve the `.js` specifier to its `.ts` source — it throws MODULE_NOT_FOUND at
// runtime, which failed the darwin leg of the release CI matrix and blocked every
// release until it was fixed. Node BUILTIN requires (child_process/os/path/fs)
// resolve fine, which is why only these two broke.
import { setInstallRootForTest } from './install-helper.js';

function snap(overrides: Partial<KeychainProcessSnapshot> & Pick<KeychainProcessSnapshot, 'pid'>): KeychainProcessSnapshot {
  return {
    ppid: 1,
    elapsedSec: ORPHAN_GRACE_SEC + 1,
    startTime: `st-${overrides.pid}`,
    isHelper: true,
    ...overrides,
  };
}

function candidatesFrom(entries: [number, StuckParentCandidate][]): Map<number, StuckParentCandidate> {
  return new Map(entries);
}

beforeEach(() => {
  resetKeychainReaperCandidatesForTest();
});

describe('planKeychainReap — orphaned helper class (PPID==1)', () => {
  it('reaps an old helper whose parent is init/launchd', () => {
    const snapshots = [snap({ pid: 101, ppid: 1, elapsedSec: ORPHAN_GRACE_SEC + 5 })];
    const plan = planKeychainReap(snapshots, 1_000, new Map());
    expect(plan.kill).toEqual([101]);
    expect(plan.nextCandidates.size).toBe(0);
  });

  it('never reaps an orphaned helper still inside the grace window', () => {
    const snapshots = [snap({ pid: 102, ppid: 1, elapsedSec: ORPHAN_GRACE_SEC - 1 })];
    const plan = planKeychainReap(snapshots, 1_000, new Map());
    expect(plan.kill).toEqual([]);
  });

  it('never reaps when the start-time fingerprint cannot be captured (fail closed)', () => {
    const snapshots = [snap({ pid: 103, ppid: 1, elapsedSec: ORPHAN_GRACE_SEC + 5, startTime: null })];
    const plan = planKeychainReap(snapshots, 1_000, new Map());
    expect(plan.kill).toEqual([]);
  });

  it('never reaps a non-helper process even if PPID==1 and old', () => {
    const snapshots = [snap({ pid: 104, ppid: 1, isHelper: false })];
    const plan = planKeychainReap(snapshots, 1_000, new Map());
    expect(plan.kill).toEqual([]);
  });
});

describe('planKeychainReap — stuck agents parent class (live helper child)', () => {
  const parentPid = 500;
  const helperPid = 501;
  const parentStart = 'st-500';
  const helperStart = 'st-501';

  const stuckPair = (): KeychainProcessSnapshot[] => [
    snap({ pid: parentPid, ppid: 1, elapsedSec: 200, isHelper: false, startTime: parentStart }),
    snap({ pid: helperPid, ppid: parentPid, elapsedSec: STUCK_GRACE_SEC + 10, startTime: helperStart }),
  ];

  it('records a candidate on the first sweep but does NOT reap', () => {
    const plan = planKeychainReap(stuckPair(), 1_000, new Map());
    expect(plan.kill).toEqual([]);
    expect(plan.nextCandidates.has(parentPid)).toBe(true);
    const c = plan.nextCandidates.get(parentPid)!;
    expect(c.helperPid).toBe(helperPid);
    expect(c.helperStartTime).toBe(helperStart);
    expect(c.startTime).toBe(parentStart);
    expect(c.stage).toBe('watch');
  });

  it('kills the helper child on the second consecutive sweep', () => {
    const first = planKeychainReap(stuckPair(), 1_000, new Map());
    const second = planKeychainReap(stuckPair(), 2_000, first.nextCandidates);
    expect(second.kill).toEqual([helperPid]);
    // Parent is now staged for escalation if it is still stuck next sweep.
    expect(second.nextCandidates.get(parentPid)?.stage).toBe('escalate');
  });

  it('kills the parent on the third sweep if the helper child is still present', () => {
    const first = planKeychainReap(stuckPair(), 1_000, new Map());
    const second = planKeychainReap(stuckPair(), 2_000, first.nextCandidates);
    const third = planKeychainReap(stuckPair(), 3_000, second.nextCandidates);
    expect(third.kill).toEqual([parentPid]);
    expect(third.nextCandidates.has(parentPid)).toBe(false);
  });

  it('drops the candidate once the helper child disappears', () => {
    const first = planKeychainReap(stuckPair(), 1_000, new Map());
    const resolved = [snap({ pid: parentPid, ppid: 1, elapsedSec: 200, isHelper: false, startTime: parentStart })];
    const next = planKeychainReap(resolved, 2_000, first.nextCandidates);
    expect(next.kill).toEqual([]);
    expect(next.nextCandidates.has(parentPid)).toBe(false);
  });

  it('never reaps a helper whose parent is missing from the snapshot', () => {
    const snapshots = [snap({ pid: helperPid, ppid: parentPid, elapsedSec: STUCK_GRACE_SEC + 10, startTime: helperStart })];
    const plan = planKeychainReap(snapshots, 1_000, new Map());
    expect(plan.kill).toEqual([]);
    expect(plan.nextCandidates.size).toBe(0);
  });

  it('resets the debounce when the parent pid is reused (startTime changed)', () => {
    const first = planKeychainReap(stuckPair(), 1_000, new Map());
    const reusedParent = stuckPair().map((s) =>
      s.pid === parentPid ? { ...s, startTime: 'st-500-reused' } : s,
    );
    const second = planKeychainReap(reusedParent, 2_000, first.nextCandidates);
    // A reused pid is a different process; start over as a watch candidate.
    expect(second.kill).toEqual([]);
    expect(second.nextCandidates.get(parentPid)?.startTime).toBe('st-500-reused');
  });

  it('resets the debounce when the helper pid is reused (startTime changed)', () => {
    const first = planKeychainReap(stuckPair(), 1_000, new Map());
    const reusedHelper = stuckPair().map((s) =>
      s.pid === helperPid ? { ...s, startTime: 'st-501-reused' } : s,
    );
    const second = planKeychainReap(reusedHelper, 2_000, first.nextCandidates);
    expect(second.kill).toEqual([]);
    expect(second.nextCandidates.get(parentPid)?.helperStartTime).toBe('st-501-reused');
  });

  it('fails closed when the helper startTime cannot be captured', () => {
    const snapshots = [
      snap({ pid: parentPid, ppid: 1, elapsedSec: 200, isHelper: false, startTime: parentStart }),
      snap({ pid: helperPid, ppid: parentPid, elapsedSec: STUCK_GRACE_SEC + 10, startTime: null }),
    ];
    const plan = planKeychainReap(snapshots, 1_000, new Map());
    expect(plan.kill).toEqual([]);
    expect(plan.nextCandidates.size).toBe(0);
  });

  it('fails closed when the parent startTime cannot be captured', () => {
    const snapshots = [
      snap({ pid: parentPid, ppid: 1, elapsedSec: 200, isHelper: false, startTime: null }),
      snap({ pid: helperPid, ppid: parentPid, elapsedSec: STUCK_GRACE_SEC + 10, startTime: helperStart }),
    ];
    const plan = planKeychainReap(snapshots, 1_000, new Map());
    expect(plan.kill).toEqual([]);
    expect(plan.nextCandidates.size).toBe(0);
  });
});

describe('planKeychainReap — mixed snapshots', () => {
  it('handles orphans and stuck parents in the same pass', () => {
    const snapshots = [
      snap({ pid: 1, ppid: 0, elapsedSec: 1_000_000, isHelper: false, startTime: 'st-1' }),
      snap({ pid: 200, ppid: 1, elapsedSec: ORPHAN_GRACE_SEC + 5, startTime: 'st-200' }),
      snap({ pid: 300, ppid: 1, elapsedSec: 1_000, isHelper: false, startTime: 'st-300' }),
      snap({ pid: 301, ppid: 300, elapsedSec: STUCK_GRACE_SEC + 5, startTime: 'st-301' }),
    ];
    const prev = candidatesFrom([
      [
        300,
        {
          pid: 300,
          startTime: 'st-300',
          helperPid: 301,
          helperStartTime: 'st-301',
          firstSeenAt: 1,
          stage: 'watch',
        },
      ],
    ]);
    const plan = planKeychainReap(snapshots, 2_000, prev);
    expect(plan.kill).toContain(200); // orphan
    expect(plan.kill).toContain(301); // stuck helper child on second sweep
    expect(plan.nextCandidates.get(300)?.stage).toBe('escalate');
  });
});

describe('reapOrphanedKeychainProcesses (darwin integration)', () => {
  it.skipIf(process.platform !== 'darwin')('reaps a real orphaned sleeper that matches the helper path', () => {
    const { spawn, execFileSync } = require('child_process');
    const os = require('os');
    const path = require('path');
    const fs = require('fs');

    // Build a fake installed helper at the exact path getKeychainHelperPath()
    // resolves to under the test install root. The reaper does an exact
    // path-match against this string, so the sleeper's argv[0] must equal it.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-reaper-'));
    const fakeHelper = path.join(
      tmpDir,
      'Library',
      'Application Support',
      'agents-cli',
      'Agents CLI.app',
      'Contents',
      'MacOS',
      'Agents CLI',
    );
    fs.mkdirSync(path.dirname(fakeHelper), { recursive: true });
    fs.writeFileSync(fakeHelper, '#!/bin/sh\nsleep 300\n', { mode: 0o755 });

    // Launch through a disposable shell that exits immediately, so the sleeper
    // is reparented to init (PPID 1).
    const launcher = spawn('sh', ['-c', `${JSON.stringify(fakeHelper)} &`], {
      detached: true,
      stdio: 'ignore',
    });
    launcher.unref();

    // Wait long enough to exceed the orphan grace window.
    const deadline = Date.now() + 2_000 + (ORPHAN_GRACE_SEC * 1_000);
    while (Date.now() < deadline) { /* spin synchronously to stay inside the test */ }

    // Confirm the sleeper is actually orphaned before the reaper runs.
    let sleeperPid = 0;
    try {
      const psOut = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,etimes=,command='], { encoding: 'utf-8' });
      for (const line of psOut.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith(fakeHelper) || trimmed.includes(fakeHelper)) {
          const pid = parseInt(trimmed.match(/^(\d+)/)?.[1] ?? '0', 10);
          if (pid > 0) { sleeperPid = pid; break; }
        }
      }
    } catch { /* ignore */ }

    try {
      const prevRoot = setInstallRootForTest(tmpDir);
      try {
        const result = reapOrphanedKeychainProcesses();
        expect(result.reaped).toBeGreaterThanOrEqual(1);
        expect(result.details.some((d: string) => d.includes(String(sleeperPid)))).toBe(true);
      } finally {
        setInstallRootForTest(prevRoot);
      }
    } finally {
      if (sleeperPid) {
        try { process.kill(sleeperPid, 'SIGKILL'); } catch { /* may already be reaped */ }
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);
});
