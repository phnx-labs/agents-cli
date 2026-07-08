// Follower runtime — real-socket end-to-end tests (no mocks).
//
// Mirrors broadcast.test.ts: a real `MonitorHost` (which owns a real
// `MonitorBroadcastServer`) over a temp Unix socket, with real
// `MonitorFollower` instances driving real `MonitorBroadcastClient`
// connections. Proves the #67 acceptance round-trip:
//
//   - two followers report their terminal tuples to the monitor;
//   - the monitor aggregates the union and pushes it back as a fact;
//   - the fact reaches BOTH followers and each resolves only ITS OWN
//     terminals (pid/sessionId -> local handle), never the peer's.

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MonitorHost } from './host';
import { MonitorFollower, ResolvedFact } from './follower';
import { TerminalTuple } from './protocol';

let counter = 0;
const created: string[] = [];

function tempSocketPath(): string {
  const p = path.join(
    os.tmpdir(),
    `monitor-follower-test-${process.pid}-${counter++}.sock`,
  );
  created.push(p);
  return p;
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  label = 'condition',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Timed out waiting for ${label}`));
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

function tuple(over: Partial<TerminalTuple>): TerminalTuple {
  return {
    windowId: 'win',
    terminalId: 'CC-1',
    pid: null,
    sessionId: null,
    workspacePath: null,
    agentType: null,
    ...over,
  };
}

afterEach(() => {
  for (const p of created.splice(0)) {
    try {
      fs.unlinkSync(p);
    } catch {
      // host.stop() already removed it.
    }
  }
});

describe('MonitorHost + MonitorFollower', () => {
  test('two followers report tuples; merged fact reaches both, each resolves only its own terminal', async () => {
    const socketPath = tempSocketPath();
    const host = new MonitorHost({ socketPath });
    await host.start();

    // Each window owns exactly one terminal; resolver returns a local handle
    // only for the pid this window actually has open.
    const ownA = new Map<number, string>([[1001, 'termA']]);
    const ownB = new Map<number, string>([[2002, 'termB']]);
    const factsA: ResolvedFact<string>[][] = [];
    const factsB: ResolvedFact<string>[][] = [];

    const followerA = new MonitorFollower<string>({
      windowId: 'winA',
      socketPath,
      clientOptions: { minReconnectDelayMs: 25, maxReconnectDelayMs: 100 },
      resolver: ({ pid }) => (pid != null ? ownA.get(pid) : undefined),
      onFacts: (resolved) => factsA.push(resolved),
    });
    const followerB = new MonitorFollower<string>({
      windowId: 'winB',
      socketPath,
      clientOptions: { minReconnectDelayMs: 25, maxReconnectDelayMs: 100 },
      resolver: ({ pid }) => (pid != null ? ownB.get(pid) : undefined),
      onFacts: (resolved) => factsB.push(resolved),
    });

    try {
      followerA.start();
      followerB.start();
      await waitFor(
        () =>
          host.clientCount === 2 && followerA.connected && followerB.connected,
        5000,
        'both followers connected',
      );

      const tupleA = tuple({
        windowId: 'winA',
        terminalId: 'CC-A',
        pid: 1001,
        sessionId: 'sid-a',
        agentType: 'claude',
      });
      const tupleB = tuple({
        windowId: 'winB',
        terminalId: 'CX-B',
        pid: 2002,
        sessionId: 'sid-b',
        agentType: 'codex',
      });

      expect(await followerA.reportTuples([tupleA])).toBe(true);
      expect(await followerB.reportTuples([tupleB])).toBe(true);

      // The monitor holds the union of both windows' slices.
      await waitFor(
        () => host.snapshot().length === 2,
        2000,
        'host aggregated both slices',
      );
      const snapshot = host.snapshot();
      expect(snapshot.map((t) => t.pid).sort()).toEqual([1001, 2002]);

      // The latest fact (broadcast after B's report) carried BOTH tuples to
      // BOTH followers; each resolved only the pid it actually owns.
      await waitFor(
        () =>
          factsA.length > 0 &&
          factsA[factsA.length - 1].length === 1 &&
          factsB.length > 0 &&
          factsB[factsB.length - 1].length === 1,
        2000,
        'both followers received a resolvable fact',
      );

      const lastA = factsA[factsA.length - 1];
      const lastB = factsB[factsB.length - 1];
      expect(lastA.map((r) => r.terminal)).toEqual(['termA']);
      expect(lastA[0].tuple.pid).toBe(1001);
      expect(lastB.map((r) => r.terminal)).toEqual(['termB']);
      expect(lastB[0].tuple.pid).toBe(2002);
    } finally {
      followerA.stop();
      followerB.stop();
      await host.stop();
    }
  });

  test('reportTuples returns false while disconnected (registry-file fallback path)', async () => {
    const socketPath = tempSocketPath(); // no host ever bound here
    const follower = new MonitorFollower<string>({
      windowId: 'lonely',
      socketPath,
      clientOptions: { minReconnectDelayMs: 25, maxReconnectDelayMs: 50 },
      resolver: () => undefined,
    });
    try {
      follower.start();
      // Connect attempt fails (nothing listening); never becomes connected.
      expect(follower.connected).toBe(false);
      expect(await follower.reportTuples([tuple({ pid: 7 })])).toBe(false);
    } finally {
      follower.stop();
    }
  });

  test('a follower reconnects after a leader takeover and reports to the new monitor', async () => {
    const socketPath = tempSocketPath();
    let host = new MonitorHost({ socketPath });
    await host.start();

    const follower = new MonitorFollower<string>({
      windowId: 'winC',
      socketPath,
      clientOptions: { minReconnectDelayMs: 25, maxReconnectDelayMs: 100 },
      resolver: ({ pid }) => (pid === 3003 ? 'termC' : undefined),
    });

    try {
      follower.start();
      await waitFor(() => follower.connected, 5000, 'initial connect');

      // Simulate a leader handoff: old monitor stops, a new one binds the same
      // socket path (exactly what the gate does on a leadership flip).
      await host.stop();
      await waitFor(() => !follower.connected, 5000, 'noticed disconnect');

      host = new MonitorHost({ socketPath });
      await host.start();
      await waitFor(() => follower.connected, 5000, 'reconnected to new monitor');

      expect(await follower.reportTuples([tuple({ windowId: 'winC', pid: 3003 })])).toBe(true);
      await waitFor(
        () => host.snapshot().some((t) => t.pid === 3003),
        2000,
        'new monitor received post-takeover report',
      );
    } finally {
      follower.stop();
      await host.stop();
    }
  });
});
