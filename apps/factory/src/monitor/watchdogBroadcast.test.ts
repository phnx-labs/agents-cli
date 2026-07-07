// End-to-end watchdog stall broadcast (no mocks).
//
// A real MonitorHost with the watchdog detector enabled, two real
// MonitorFollowers over a real Unix socket, and a real (aged) session file.
// Proves the #70 acceptance: detection is centralized — the leader stats the
// session once and broadcasts a `watchdog/stall` fact — while delivery stays
// per-window — the follower that OWNS the session resolves the fact to its own
// terminal (and would deliver the nudge), and the window that does NOT own it
// resolves nothing and ignores the fact.

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MonitorHost } from './host';
import { MonitorFollower } from './follower';
import {
  isWatchdogStall,
  WatchdogStallPayload,
  WatchdogWatch,
} from './protocol';
import { MonitorEvent } from './broadcastTypes';

const tmpPaths: string[] = [];
let counter = 0;

function tempSocketPath(): string {
  const p = path.join(os.tmpdir(), `wd-rb-${process.pid}-${counter++}.sock`);
  tmpPaths.push(p);
  return p;
}

function agedSessionFile(name: string, msAgo: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-rb-session-'));
  tmpPaths.push(dir);
  const p = path.join(dir, name);
  fs.writeFileSync(p, '{"type":"assistant"}\n');
  const t = (Date.now() - msAgo) / 1000;
  fs.utimesSync(p, t, t);
  return p;
}

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

afterEach(() => {
  for (const p of tmpPaths.splice(0)) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
});

describe('watchdog stall broadcast round-trip', () => {
  test('leader broadcasts a stall fact; the owning window resolves it, a non-owner ignores it', async () => {
    const socketPath = tempSocketPath();
    const sessionId = 'a1b2c3d4-0000-0000-0000-000000000000';
    const sessionFile = agedSessionFile(`${sessionId}.jsonl`, 10_000); // 10s idle

    const host = new MonitorHost({
      socketPath,
      detectors: {
        readiness: false,
        session: false,
        // Tick fast and never poll `agents view` (no rotateAgentKey armed).
        watchdogTickMs: 50,
      },
    });
    await host.start();

    // winA owns the stalled session -> resolves to a local terminal handle.
    // winB owns nothing on that session -> resolver returns undefined.
    const ownedByA = new Map<string, string>([[sessionId, 'termA']]);
    const ownedByB = new Map<string, string>(); // winB owns nothing on this session
    const stallsA: WatchdogStallPayload[] = [];
    const stallsB: WatchdogStallPayload[] = [];

    // Each follower's resolver maps a broadcast sessionId back to THIS window's
    // own terminal — the per-window resolution the real wiring performs.
    const resolveA = ({ sessionId: sid }: { sessionId?: string | null }) =>
      (sid ? ownedByA.get(sid) : undefined);
    const resolveB = ({ sessionId: sid }: { sessionId?: string | null }) =>
      (sid ? ownedByB.get(sid) : undefined);

    const followerA = new MonitorFollower<string>({
      windowId: 'winA',
      socketPath,
      clientOptions: { minReconnectDelayMs: 25, maxReconnectDelayMs: 100 },
      resolver: resolveA,
    });
    const followerB = new MonitorFollower<string>({
      windowId: 'winB',
      socketPath,
      clientOptions: { minReconnectDelayMs: 25, maxReconnectDelayMs: 100 },
      resolver: resolveB,
    });
    const subA = followerA.onMonitorEvent((e: MonitorEvent) => {
      if (isWatchdogStall(e)) stallsA.push(e.payload);
    });
    const subB = followerB.onMonitorEvent((e: MonitorEvent) => {
      if (isWatchdogStall(e)) stallsB.push(e.payload);
    });

    try {
      followerA.start();
      followerB.start();
      await waitFor(
        () => followerA.connected && followerB.connected && host.clientCount === 2,
        5000,
        'both followers connected',
      );

      // Only winA arms the watch for the session it owns.
      const watch: WatchdogWatch = {
        sessionId,
        agentType: 'claude',
        sessionFilePath: sessionFile,
        stallMs: 1000,
        dormantMs: 60 * 60 * 1000,
      };
      expect(await followerA.setWatchdogWatches([watch])).toBe(true);
      await waitFor(() => host.watchedSessionCount === 1, 2000, 'leader registered the watch');

      // The leader's single detector stats the file and broadcasts the stall to
      // BOTH followers.
      await waitFor(
        () => stallsA.some((f) => f.sessionId === sessionId) && stallsB.some((f) => f.sessionId === sessionId),
        4000,
        'stall fact reached both followers',
      );

      const factA = stallsA.find((f) => f.sessionId === sessionId)!;
      expect(factA.agentType).toBe('claude');
      expect(factA.idleMs).toBeGreaterThanOrEqual(1000);

      // Delivery is per-window: the OWNING window resolves the session to its
      // terminal; the non-owner resolves nothing and would do nothing.
      expect(resolveA({ sessionId: factA.sessionId })).toBe('termA');
      expect(resolveB({ sessionId: factA.sessionId })).toBeUndefined();
    } finally {
      subA();
      subB();
      followerA.stop();
      followerB.stop();
      await host.stop();
    }
  }, 12000);
});
