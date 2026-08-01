// WatchdogDetector — version-poll tests (no mocks for the merge logic; the
// `agents view` fetcher is injected so the test never spawns the CLI).
//
// Stall detection was retired (the CLI daemon watchdog is the sole injector),
// so the detector's only job is polling `agents view <agentKey> --json` once
// per armed agent key for the auto-rotate exhaustion check.

import { describe, expect, test } from 'bun:test';
import { WatchdogDetector } from './watchdogDetector';
import { WatchdogVersionsPayload, WatchdogWatch } from './protocol';
import { AgentsViewJsonAgent } from '../core/resumeInBest';

function watch(over: Partial<WatchdogWatch> & { sessionId: string }): WatchdogWatch {
  return { ...over };
}

describe('WatchdogDetector', () => {
  test('polls the injected agents view fetcher once per due agent key', async () => {
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
      emitVersions: (f) => views.push(f),
      viewPollMs: 0,
      fetchView: async (agentKey) => {
        calls.push(agentKey);
        return fakeView;
      },
    });
    try {
      detector.setWatches('winA', [watch({ sessionId: 'sid-v', rotateAgentKey: 'claude' })]);
      expect(detector.watchedSessionCount).toBe(1);
      await detector.tick();
      expect(calls).toEqual(['claude']);
      expect(views).toHaveLength(1);
      expect(views[0].agentKey).toBe('claude');
      expect(views[0].view.versions[0].version).toBe('opus');
    } finally {
      detector.stop();
    }
  });

  test('does not poll when no watch arms a rotate agent key', async () => {
    const calls: string[] = [];
    const views: WatchdogVersionsPayload[] = [];
    const detector = new WatchdogDetector({
      emitVersions: (f) => views.push(f),
      viewPollMs: 0,
      fetchView: async (agentKey) => {
        calls.push(agentKey);
        return null;
      },
    });
    try {
      detector.setWatches('winA', [watch({ sessionId: 'sid-noroll' })]);
      await detector.tick();
      expect(calls).toEqual([]);
      expect(views).toHaveLength(0);
    } finally {
      detector.stop();
    }
  });

  test('merges two windows watching the same session into one entry', async () => {
    const calls: string[] = [];
    const detector = new WatchdogDetector({
      emitVersions: () => {},
      viewPollMs: 0,
      fetchView: async (agentKey) => {
        calls.push(agentKey);
        return null;
      },
    });
    try {
      detector.setWatches('winA', [watch({ sessionId: 'shared', rotateAgentKey: 'claude' })]);
      detector.setWatches('winB', [watch({ sessionId: 'shared', rotateAgentKey: 'claude' })]);
      expect(detector.watchedSessionCount).toBe(1);
      await detector.tick();
      // Deduped to one agent key -> one poll.
      expect(calls).toEqual(['claude']);
    } finally {
      detector.stop();
    }
  });
});
