// Follower replay round-trip (no mocks).
//
// A real MonitorHost, a real child process standing in for `agents sessions
// watch --json`, a real MonitorFollower over a real Unix socket.
//
// Regression: the host registered its request handler as `(payload) =>
// handleRequest(payload)`, dropping the `socket` the broadcast server passes
// (broadcast.ts). `handleRequest`'s replay is guarded by `if (socket)`, so a
// follower that reported in was ACKed but never received the retained
// session-cli `reset`. The stream emits `reset` ONCE at startup and only deltas
// after, so any window that connected later rendered zero sessions forever —
// the Fleet panel reporting "0 agents running" while agents were running.

import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, ChildProcess, ChildProcessWithoutNullStreams } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { MonitorHost } from './host';
import { MonitorFollower } from './follower';
import { MONITOR_FACT } from './protocol';
import { MonitorEvent } from './broadcastTypes';

const spawned: ChildProcess[] = [];
const hosts: MonitorHost[] = [];
const followers: MonitorFollower<unknown>[] = [];
let counter = 0;

function tempSocketPath(): string {
  return path.join(os.tmpdir(), `monitor-host-${process.pid}-${counter++}.sock`);
}

/**
 * A real child process that speaks the watch protocol: one `reset` carrying a
 * row, then it idles (exactly like the CLI once it has emitted its snapshot).
 */
function spawnFakeWatch(): ChildProcessWithoutNullStreams {
  const reset = JSON.stringify({
    version: 1,
    type: 'reset',
    streamId: 'test-stream',
    sequence: 1,
    capturedAt: 1,
    scope: 'testbox',
    rows: [{ rowKey: 'row-1', sessionId: 'sess-1', status: 'running' }],
  });
  const child = spawn(
    process.execPath,
    ['-e', `process.stdout.write(${JSON.stringify(reset + '\n')}); setInterval(() => {}, 1e9)`],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;
  spawned.push(child);
  return child;
}

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

afterEach(async () => {
  for (const f of followers.splice(0)) f.stop();
  for (const h of hosts.splice(0)) await h.stop();
  for (const c of spawned.splice(0)) c.kill();
});

describe('MonitorHost replays session state to a late follower', () => {
  test('a follower that reports tuples receives the retained reset', async () => {
    const socketPath = tempSocketPath();
    const host = new MonitorHost({
      socketPath,
      detectors: { readiness: false, sessionCli: true, spawnSessionWatch: spawnFakeWatch },
    });
    hosts.push(host);
    await host.start();

    // The stream emits its only `reset` now — before the follower exists. This
    // is the real-world ordering: the leader has been up for hours.
    await waitFor(() => host.clientCount === 0, 1000, 'host listening');
    await new Promise((r) => setTimeout(r, 200));

    const received: MonitorEvent[] = [];
    const follower = new MonitorFollower<unknown>({
      windowId: 'late-window',
      resolver: () => undefined,
      socketPath,
    });
    followers.push(follower as MonitorFollower<unknown>);
    follower.onMonitorEvent((event) => received.push(event));
    follower.start();

    await waitFor(() => follower.connected, 2000, 'follower connected');
    expect(await follower.reportTuples([])).toBe(true);

    await waitFor(
      () => received.some((e) => e.type === MONITOR_FACT.sessionCli
        && (e.payload as { type?: string })?.type === 'reset'),
      2000,
      'replayed reset',
    );

    const reset = received
      .filter((e) => e.type === MONITOR_FACT.sessionCli)
      .map((e) => e.payload as { type?: string; scope?: string; rows?: unknown[] })
      .find((p) => p.type === 'reset');
    expect(reset?.scope).toBe('testbox');
    expect(reset?.rows).toHaveLength(1);
  });
});
