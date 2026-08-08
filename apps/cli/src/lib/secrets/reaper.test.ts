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
  parseEtimeToSeconds,
  isReapableHelperCommand,
  isWatchLockHelperCommand,
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

const HELPER_PATH = '/Users/x/Library/Application Support/agents-cli/Agents CLI.app/Contents/MacOS/Agents CLI';

function snap(overrides: Partial<KeychainProcessSnapshot> & Pick<KeychainProcessSnapshot, 'pid'>): KeychainProcessSnapshot {
  return {
    ppid: 1,
    elapsedSec: ORPHAN_GRACE_SEC + 1,
    startTime: `st-${overrides.pid}`,
    isHelper: true,
    isWatchLock: false,
    ...overrides,
  };
}

function candidatesFrom(entries: [number, StuckParentCandidate][]): Map<number, StuckParentCandidate> {
  return new Map(entries);
}

beforeEach(() => {
  resetKeychainReaperCandidatesForTest();
});

describe('parseEtimeToSeconds — macOS BSD etime format', () => {
  // Regression for RUSH-2268: the reaper shelled `ps -o etimes` (a GNU/Linux
  // procps keyword), which macOS `ps` rejects with a non-zero exit, so
  // execFileSync threw and the reaper reaped nothing on its only platform.
  // The portable keyword is `etime` in `[[dd-]hh:]mm:ss` form.
  it('parses mm:ss', () => {
    expect(parseEtimeToSeconds('00:04')).toBe(4);
    expect(parseEtimeToSeconds('32:10')).toBe(32 * 60 + 10);
  });
  it('parses hh:mm:ss', () => {
    expect(parseEtimeToSeconds('01:02:03')).toBe(3723);
  });
  it('parses dd-hh:mm:ss', () => {
    expect(parseEtimeToSeconds('14-04:10:52')).toBe(((14 * 24 + 4) * 60 + 10) * 60 + 52);
  });
  it('returns null for a bare integer (the Linux etimes shape it no longer emits)', () => {
    expect(parseEtimeToSeconds('42')).toBeNull();
  });
  it('returns null for garbage', () => {
    expect(parseEtimeToSeconds('')).toBeNull();
    expect(parseEtimeToSeconds('abc')).toBeNull();
    expect(parseEtimeToSeconds('1:2:3:4')).toBeNull();
  });
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
  // RUSH-2268. This was quarantined (it.skip) while the fixture was diagnosed.
  // The real bug was NOT the fixture: `reaper.ts` shelled `ps -o etimes` (a
  // GNU/Linux procps keyword) which macOS `ps` rejects with exit 1, so
  // execFileSync threw and the reaper returned `reaped: 0` no matter what the
  // fixture did — which is exactly why the symlink fixture (correct all along)
  // still read as reaped:0 during diagnosis. With `reaper.ts` switched to the
  // portable `etime`, the fixture below reaps a real orphaned sleeper. Verified
  // on macOS 15.4.1: 20/20 reaper tests pass, this one reaping the sleeper.
  //
  // Fixture notes (all measured on an arm64 Mac):
  //   - `require('./install-helper.js')` inline fails under vitest's ESM runtime
  //     (a CJS require of a local TS module → MODULE_NOT_FOUND); use the static
  //     imports at the top of the file.
  //   - a `#!/bin/sh` script fixture: the kernel execs the INTERPRETER, so ps
  //     reports `/bin/sh <helperPath>` and argv[0] never equals the helper path.
  //   - a COPY of /bin/sleep loses its code signature and Apple Silicon SIGKILLs
  //     it on exec (exit 137). A SYMLINK keeps the signature (the kernel execs
  //     /bin/sleep) while argv[0] stays the symlink path — which is what the
  //     reaper's exact match (`command === helperPath ||
  //     command.startsWith(helperPath + ' ')`) requires.
  it.skipIf(process.platform !== 'darwin')('reaps a real orphaned sleeper that matches the helper path', async () => {
    const { spawn, execFileSync } = require('child_process');
    const os = require('os');
    const path = require('path');
    const fs = require('fs');

    // Build a fake installed helper at the exact path getKeychainHelperPath()
    // resolves to under the test install root.
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
    fs.symlinkSync('/bin/sleep', fakeHelper);

    // Launch through a disposable shell that exits immediately, so the sleeper
    // is reparented to init (PPID 1).
    const launcher = spawn('sh', ['-c', `${JSON.stringify(fakeHelper)} 600 &`], {
      detached: true,
      stdio: 'ignore',
    });
    launcher.unref();

    // Wait past the orphan grace window (async — do NOT busy-spin: a synchronous
    // 30s spin pegs a core and blocks the event loop for the whole window).
    await new Promise((resolve) => setTimeout(resolve, (ORPHAN_GRACE_SEC + 3) * 1_000));

    // Locate the sleeper and confirm it is actually orphaned (PPID 1). The
    // ppid assertion is OUTSIDE the try/catch so a broken reparenting assumption
    // fails loud rather than being swallowed.
    let sleeperPid = 0;
    let sleeperPpid = -1;
    try {
      const psOut = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,etime=,command='], { encoding: 'utf-8' });
      for (const line of psOut.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+\S+\s+(.*)$/);
        if (!m) continue;
        const command = m[3];
        if (command === fakeHelper || command.startsWith(`${fakeHelper} `)) {
          sleeperPid = parseInt(m[1], 10);
          sleeperPpid = parseInt(m[2], 10);
          break;
        }
      }
    } catch { /* fall through to the assertions below */ }
    expect(sleeperPid).toBeGreaterThan(0);
    expect(sleeperPpid).toBe(1); // reparented to init/launchd

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
      // Belt-and-braces: kill anything still running out of THIS test's temp dir,
      // scoped to `tmpDir` so a concurrent run's sleeper is never touched.
      try { execFileSync('pkill', ['-f', tmpDir], { stdio: 'ignore' }); } catch { /* none left */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('isReapableHelperCommand — never target the long-lived watch-lock watcher', () => {
  it('excludes the watch-lock watcher (the auto-lock-on-sleep child)', () => {
    expect(isReapableHelperCommand(`${HELPER_PATH} watch-lock`, HELPER_PATH)).toBe(false);
  });

  it('includes the short-lived keychain verbs a wedged coreauthd can hang', () => {
    for (const verb of ['get', 'has', 'list', 'set', 'delete', 'migrate-acl', 'get-batch']) {
      expect(isReapableHelperCommand(`${HELPER_PATH} ${verb} some-item user`, HELPER_PATH)).toBe(true);
    }
  });

  it('includes a bare helper exec with no verb (still not watch-lock)', () => {
    expect(isReapableHelperCommand(HELPER_PATH, HELPER_PATH)).toBe(true);
  });

  it('excludes any non-helper command', () => {
    expect(isReapableHelperCommand('/usr/bin/node index.js', HELPER_PATH)).toBe(false);
    // A different binary whose name merely CONTAINS the helper path as a substring
    // must not match — the guard requires the exact path as a prefix + a space.
    expect(isReapableHelperCommand(`${HELPER_PATH}-evil watch-lock`, HELPER_PATH)).toBe(false);
  });
});

describe('isWatchLockHelperCommand', () => {
  it('matches only the watch-lock verb on the helper path', () => {
    expect(isWatchLockHelperCommand(`${HELPER_PATH} watch-lock`, HELPER_PATH)).toBe(true);
    expect(isWatchLockHelperCommand(`${HELPER_PATH} get item user`, HELPER_PATH)).toBe(false);
    expect(isWatchLockHelperCommand(HELPER_PATH, HELPER_PATH)).toBe(false);
    expect(isWatchLockHelperCommand(`${HELPER_PATH}-evil watch-lock`, HELPER_PATH)).toBe(false);
  });
});

describe('planKeychainReap — the watch-lock regression (RUSH-2232 follow-up)', () => {
  // A watch-lock watcher is a helper child of a LIVE parent (the broker/daemon),
  // long-lived (days). The driver marks it isHelper=false via isReapableHelperCommand,
  // so the stuck-helper path must never record or kill it, even across many sweeps.
  // RUSH-2419 adds a SEPARATE orphan path — see the next describe block.
  const brokerPid = 400;
  const watchLockPid = 401;
  const parent = snap({ pid: brokerPid, ppid: 1, elapsedSec: 1_000_000, isHelper: false, startTime: 'st-broker' });
  const watchLock = snap({
    pid: watchLockPid,
    ppid: brokerPid,
    elapsedSec: STUCK_GRACE_SEC + 100_000, // far past the stuck threshold
    isHelper: false, // excluded by isReapableHelperCommand
    isWatchLock: true,
    startTime: 'st-watchlock',
  });

  it('never kills or records a LIVE-parent watch-lock watcher across three sweeps', () => {
    let candidates = new Map<number, StuckParentCandidate>();
    for (let sweep = 0; sweep < 3; sweep++) {
      const plan = planKeychainReap([parent, watchLock], Date.now() + sweep * 300_000, candidates);
      expect(plan.kill).toEqual([]);
      expect(plan.nextCandidates.size).toBe(0);
      candidates = plan.nextCandidates;
    }
  });

  it('still kills a genuinely stuck read verb on the second sweep (fix does not weaken reaping)', () => {
    // Same shape, but this helper child IS reap-eligible (a stuck `get`).
    const stuckGet = snap({ pid: 402, ppid: brokerPid, elapsedSec: STUCK_GRACE_SEC + 50, isHelper: true, startTime: 'st-get' });
    const sweep1 = planKeychainReap([parent, stuckGet], 1_000, new Map());
    expect(sweep1.kill).toEqual([]);
    expect(sweep1.nextCandidates.size).toBe(1);
    const sweep2 = planKeychainReap([parent, stuckGet], 2_000, sweep1.nextCandidates);
    expect(sweep2.kill).toContain(402);
  });
});

describe('planKeychainReap — orphaned watch-lock when owning daemon is dead (RUSH-2419)', () => {
  // After an OOM / SIGKILL / killTree on the daemon, POSIX leave the watch-lock
  // child reparented to init (ppid=1). isReapableHelperCommand still returns
  // false, so the old orphan-helper path never touched it. The new path reaps
  // only when the owning daemon is provably gone.

  it('reaps an orphaned watch-lock reparented to init (owning daemon dead)', () => {
    const orphanedWatchLock = snap({
      pid: 901,
      ppid: 1, // reparented after daemon death
      elapsedSec: ORPHAN_GRACE_SEC + 10,
      isHelper: false, // still excluded from stuck/orphan helper path
      isWatchLock: true,
      startTime: 'st-orphaned-watchlock',
    });
    const plan = planKeychainReap([orphanedWatchLock], 1_000, new Map());
    expect(plan.kill).toEqual([901]);
  });

  it('never reaps a watch-lock still tied to a LIVE daemon (parent in snapshot)', () => {
    // Simulates: spawn watch-lock, leave the owning daemon pid alive.
    const daemonPid = 800;
    const watchLockPid = 801;
    const daemon = snap({
      pid: daemonPid,
      ppid: 1,
      elapsedSec: 1_000_000,
      isHelper: false,
      isWatchLock: false,
      startTime: 'st-daemon-live',
    });
    const liveWatchLock = snap({
      pid: watchLockPid,
      ppid: daemonPid,
      elapsedSec: ORPHAN_GRACE_SEC + 100_000,
      isHelper: false,
      isWatchLock: true,
      startTime: 'st-watchlock-live',
    });
    const plan = planKeychainReap([daemon, liveWatchLock], 1_000, new Map());
    expect(plan.kill).toEqual([]);
    expect(plan.nextCandidates.size).toBe(0);
  });

  it('reaps a watch-lock whose parent pid is gone from the snapshot (daemon dead, pre-reparent race)', () => {
    // Parent pid still listed as ppid but the parent process is not in the
    // snapshot — owner is dead. Start-time fingerprint still required.
    const watchLock = snap({
      pid: 902,
      ppid: 99999, // former daemon pid, no longer in table
      elapsedSec: ORPHAN_GRACE_SEC + 5,
      isHelper: false,
      isWatchLock: true,
      startTime: 'st-pre-reparent',
    });
    const plan = planKeychainReap([watchLock], 1_000, new Map());
    expect(plan.kill).toEqual([902]);
  });

  it('never reaps an orphaned watch-lock still inside the grace window', () => {
    const watchLock = snap({
      pid: 903,
      ppid: 1,
      elapsedSec: ORPHAN_GRACE_SEC - 1,
      isHelper: false,
      isWatchLock: true,
      startTime: 'st-young',
    });
    const plan = planKeychainReap([watchLock], 1_000, new Map());
    expect(plan.kill).toEqual([]);
  });

  it('fails closed when the orphaned watch-lock has no start-time fingerprint', () => {
    const watchLock = snap({
      pid: 904,
      ppid: 1,
      elapsedSec: ORPHAN_GRACE_SEC + 10,
      isHelper: false,
      isWatchLock: true,
      startTime: null,
    });
    const plan = planKeychainReap([watchLock], 1_000, new Map());
    expect(plan.kill).toEqual([]);
  });

  it('does not weaken isReapableHelperCommand exclusion for a live-parent watch-lock', () => {
    // Explicit safety property: even if isWatchLock were somehow false, a
    // live-parent process marked isHelper=false is never killed by the helper
    // path — and with isWatchLock=true + live parent it is also never killed.
    expect(isReapableHelperCommand(`${HELPER_PATH} watch-lock`, HELPER_PATH)).toBe(false);
    const daemon = snap({ pid: 700, ppid: 1, isHelper: false, startTime: 'st-700' });
    const watchLock = snap({
      pid: 701,
      ppid: 700,
      elapsedSec: STUCK_GRACE_SEC + 1_000,
      isHelper: false,
      isWatchLock: true,
      startTime: 'st-701',
    });
    const plan = planKeychainReap([daemon, watchLock], 1_000, new Map());
    expect(plan.kill).not.toContain(701);
    expect(plan.kill).toEqual([]);
  });
});

/**
 * Build a tiny always-sleep binary at `fakeHelper` that accepts any argv
 * (including `watch-lock`). A symlink to /bin/sleep cannot be used here:
 * BSD sleep rejects a non-numeric first arg, but isWatchLockHelperCommand
 * requires the first arg to be exactly `watch-lock`.
 */
function buildWatchLockFixture(tmpDir: string): string {
  const { execFileSync } = require('child_process');
  const path = require('path');
  const fs = require('fs');
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
  const src = path.join(tmpDir, 'watchlock-sleeper.c');
  fs.writeFileSync(
    src,
    '#include <unistd.h>\nint main(void){ for(;;) sleep(60); return 0; }\n',
  );
  execFileSync('cc', ['-O0', '-o', fakeHelper, src], { stdio: 'ignore' });
  // Ad-hoc sign so Apple Silicon will exec an unsigned build artifact.
  try {
    execFileSync('codesign', ['-s', '-', fakeHelper], { stdio: 'ignore' });
  } catch { /* non-darwin or codesign missing — cc binary may still run */ }
  return fakeHelper;
}

function findWatchLockPid(fakeHelper: string): { pid: number; ppid: number } {
  const { execFileSync } = require('child_process');
  const psOut = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,etime=,command='], { encoding: 'utf-8' });
  for (const line of psOut.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+\S+\s+(.*)$/);
    if (!m) continue;
    const command = m[3];
    if (command === `${fakeHelper} watch-lock` || command.startsWith(`${fakeHelper} watch-lock `)) {
      return { pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10) };
    }
  }
  return { pid: 0, ppid: -1 };
}

describe('reapOrphanedKeychainProcesses — orphaned watch-lock integration (RUSH-2419)', () => {
  // Real process: spawn helperPath watch-lock, kill the owning parent so the
  // child is reparented to init, then confirm the new reaper path cleans it up.
  it.skipIf(process.platform !== 'darwin')(
    'reaps a real orphaned watch-lock after the owning daemon pid dies',
    async () => {
      const { spawn, execFileSync } = require('child_process');
      const os = require('os');
      const fs = require('fs');

      const tmpDir = fs.mkdtempSync(require('path').join(os.tmpdir(), 'agents-reaper-wl-'));
      let sleeperPid = 0;
      try {
        const fakeHelper = buildWatchLockFixture(tmpDir);

        // Parent shell spawns the watch-lock child then exits → child reparented
        // to init. That is the ungraceful-daemon-death shape (OOM/SIGKILL/killTree).
        const launcher = spawn('sh', ['-c', `${JSON.stringify(fakeHelper)} watch-lock &`], {
          detached: true,
          stdio: 'ignore',
        });
        launcher.unref();

        await new Promise((resolve) => setTimeout(resolve, (ORPHAN_GRACE_SEC + 3) * 1_000));

        const found = findWatchLockPid(fakeHelper);
        sleeperPid = found.pid;
        expect(sleeperPid).toBeGreaterThan(0);
        expect(found.ppid).toBe(1); // owning parent is dead; reparented to init

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
        try { execFileSync('pkill', ['-f', tmpDir], { stdio: 'ignore' }); } catch { /* none left */ }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it.skipIf(process.platform !== 'darwin')(
    'never reaps a real watch-lock while its owning daemon parent is still live',
    async () => {
      const { spawn, execFileSync } = require('child_process');
      const os = require('os');
      const fs = require('fs');

      const tmpDir = fs.mkdtempSync(require('path').join(os.tmpdir(), 'agents-reaper-wl-live-'));
      let sleeperPid = 0;
      let parent: ReturnType<typeof spawn> | null = null;
      try {
        const fakeHelper = buildWatchLockFixture(tmpDir);

        // Parent shell stays alive holding the child — owning daemon is live.
        parent = spawn(
          'sh',
          ['-c', `${JSON.stringify(fakeHelper)} watch-lock & wait`],
          { stdio: 'ignore' },
        );
        await new Promise((resolve) => setTimeout(resolve, 500));

        const found = findWatchLockPid(fakeHelper);
        sleeperPid = found.pid;
        expect(sleeperPid).toBeGreaterThan(0);
        expect(found.ppid).not.toBe(1); // still has a live parent
        expect(parent.pid).toBeTruthy();

        // Inside ORPHAN_GRACE so the driver would not reap on elapsed alone;
        // assert the stronger live-parent property: details never name this pid.
        const prevRoot = setInstallRootForTest(tmpDir);
        try {
          const result = reapOrphanedKeychainProcesses();
          expect(result.details.some((d: string) => d.includes(String(sleeperPid)))).toBe(false);
          expect(() => process.kill(sleeperPid, 0)).not.toThrow();
        } finally {
          setInstallRootForTest(prevRoot);
        }
      } finally {
        try { parent?.kill('SIGKILL'); } catch { /* gone */ }
        if (sleeperPid) {
          try { process.kill(sleeperPid, 'SIGKILL'); } catch { /* gone */ }
        }
        try { execFileSync('pkill', ['-f', tmpDir], { stdio: 'ignore' }); } catch { /* none */ }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
