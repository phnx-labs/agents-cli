// WatchdogDetector — real-file tests (no mocks).
//
// Writes real session files, ages their mtime with fs.utimes, and asserts the
// detector emits a stall fact exactly when a file is idle past its threshold
// (and stays silent for fresh or dormant files). The `agents view` poll is
// driven through an injected fetcher so the test never spawns the CLI.

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WatchdogDetector } from './watchdogDetector';
import { WatchdogStallPayload, WatchdogVersionsPayload, WatchdogWatch } from './protocol';
import { AgentsViewJsonAgent } from '../core/resumeInBest';

const tmpDirs: string[] = [];

function tmpSessionFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-detect-'));
  tmpDirs.push(dir);
  const p = path.join(dir, name);
  fs.writeFileSync(p, '{"type":"assistant"}\n');
  return p;
}

function ageFile(p: string, msAgo: number): void {
  const t = (Date.now() - msAgo) / 1000;
  fs.utimesSync(p, t, t);
}

function watch(over: Partial<WatchdogWatch> & { sessionFilePath: string }): WatchdogWatch {
  return {
    sessionId: 'sid',
    agentType: 'claude',
    stallMs: 1000,
    dormantMs: 60 * 60 * 1000,
    ...over,
  };
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
});

describe('WatchdogDetector', () => {
  test('emits a stall fact for a session idle past its stall threshold', async () => {
    const file = tmpSessionFile('a.jsonl');
    ageFile(file, 10_000); // 10s idle, threshold 1s

    const stalls: WatchdogStallPayload[] = [];
    const detector = new WatchdogDetector({
      emitStall: (f) => stalls.push(f),
      emitVersions: () => {},
    });
    try {
      detector.setWatches('winA', [watch({ sessionId: 'sid-stale', sessionFilePath: file })]);
      expect(detector.watchedSessionCount).toBe(1);
      await detector.tick();

      expect(stalls).toHaveLength(1);
      expect(stalls[0].sessionId).toBe('sid-stale');
      expect(stalls[0].agentType).toBe('claude');
      expect(stalls[0].idleMs).toBeGreaterThanOrEqual(1000);
    } finally {
      detector.stop();
    }
  });

  test('stays silent for a fresh session and for a dormant one', async () => {
    const fresh = tmpSessionFile('fresh.jsonl'); // mtime ~now
    const dormant = tmpSessionFile('dormant.jsonl');
    ageFile(dormant, 2 * 60 * 60 * 1000); // 2h idle, dormant > 1h

    const stalls: WatchdogStallPayload[] = [];
    const detector = new WatchdogDetector({
      emitStall: (f) => stalls.push(f),
      emitVersions: () => {},
    });
    try {
      detector.setWatches('winA', [
        watch({ sessionId: 'sid-fresh', sessionFilePath: fresh, stallMs: 5000 }),
        watch({ sessionId: 'sid-dormant', sessionFilePath: dormant }),
      ]);
      await detector.tick();
      expect(stalls).toHaveLength(0);
    } finally {
      detector.stop();
    }
  });

  test('merges two windows watching the same session into one stat', async () => {
    const file = tmpSessionFile('shared.jsonl');
    ageFile(file, 10_000);

    const stalls: WatchdogStallPayload[] = [];
    const detector = new WatchdogDetector({
      emitStall: (f) => stalls.push(f),
      emitVersions: () => {},
    });
    try {
      detector.setWatches('winA', [watch({ sessionId: 'shared', sessionFilePath: file, stallMs: 5000 })]);
      detector.setWatches('winB', [watch({ sessionId: 'shared', sessionFilePath: file, stallMs: 1000 })]);
      expect(detector.watchedSessionCount).toBe(1);
      await detector.tick();
      // One emission for the shared session, using the tightest (1s) threshold.
      expect(stalls).toHaveLength(1);
      expect(stalls[0].sessionId).toBe('shared');
    } finally {
      detector.stop();
    }
  });

  test('polls the injected agents view fetcher once per due agent key', async () => {
    const file = tmpSessionFile('v.jsonl'); // fresh — no stall, isolates the view poll
    const fakeView: AgentsViewJsonAgent = {
      agent: 'claude',
      versions: [
        {
          version: 'opus',
          isDefault: true,
          signedIn: true,
          email: null,
          plan: null,
          usageStatus: 'available',
          windows: [],
          lastActive: null,
          path: '/x',
        },
      ],
    };

    const calls: string[] = [];
    const views: WatchdogVersionsPayload[] = [];
    const detector = new WatchdogDetector({
      emitStall: () => {},
      emitVersions: (f) => views.push(f),
      viewPollMs: 0,
      fetchView: async (agentKey) => {
        calls.push(agentKey);
        return fakeView;
      },
    });
    try {
      detector.setWatches('winA', [
        watch({ sessionId: 'sid-v', sessionFilePath: file, stallMs: 60_000, rotateAgentKey: 'claude' }),
      ]);
      await detector.tick();
      expect(calls).toEqual(['claude']);
      expect(views).toHaveLength(1);
      expect(views[0].agentKey).toBe('claude');
      expect(views[0].view.versions[0].version).toBe('opus');
    } finally {
      detector.stop();
    }
  });
});
