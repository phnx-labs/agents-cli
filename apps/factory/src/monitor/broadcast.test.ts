import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MonitorBroadcastClient,
  MonitorBroadcastServer,
} from './broadcast';
import { MonitorEvent } from './broadcastTypes';

// Real Unix sockets over a temp path — no mocks. Each test gets a fresh path so
// parallel runs and leftover files never collide.
let counter = 0;
const created: string[] = [];

function tempSocketPath(): string {
  const p = path.join(
    os.tmpdir(),
    `monitor-broadcast-test-${process.pid}-${counter++}.sock`
  );
  created.push(p);
  return p;
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  label = 'condition'
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

function makeEvent(overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    type: 'test.fact',
    payload: { hello: 'world' },
    ts: Date.now(),
    ...overrides,
  };
}

afterEach(() => {
  for (const p of created.splice(0)) {
    try {
      fs.unlinkSync(p);
    } catch {
      // Server.close() already removed it.
    }
  }
});

describe('MonitorBroadcastServer + MonitorBroadcastClient', () => {
  test('an event reaches all connected followers in <250ms', async () => {
    const socketPath = tempSocketPath();
    const server = new MonitorBroadcastServer({ socketPath });
    await server.start();

    const received: MonitorEvent[][] = [[], [], []];
    const clients = received.map((bucket, i) => {
      const client = new MonitorBroadcastClient({
        socketPath,
        minReconnectDelayMs: 25,
        maxReconnectDelayMs: 100,
      });
      client.subscribe((event) => bucket.push(event));
      client.connect();
      return client;
    });

    try {
      await waitFor(
        () => server.clientCount === clients.length && clients.every((c) => c.connected),
        5000,
        'all clients connected'
      );

      const event = makeEvent({ type: 'snapshot', pid: 4242 });
      const start = Date.now();
      server.broadcast(event);

      await waitFor(
        () => received.every((bucket) => bucket.length === 1),
        250,
        'all followers received the event'
      );
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(250);
      for (const bucket of received) {
        expect(bucket).toHaveLength(1);
        expect(bucket[0].type).toBe('snapshot');
        expect(bucket[0].pid).toBe(4242);
      }
    } finally {
      clients.forEach((c) => c.close());
      await server.close();
    }
  });

  test('a follower auto-reconnects after the server restarts', async () => {
    const socketPath = tempSocketPath();
    let server = new MonitorBroadcastServer({ socketPath });
    await server.start();

    const received: MonitorEvent[] = [];
    const client = new MonitorBroadcastClient({
      socketPath,
      minReconnectDelayMs: 25,
      maxReconnectDelayMs: 100,
    });
    client.subscribe((event) => received.push(event));
    client.connect();

    try {
      await waitFor(() => client.connected, 5000, 'initial connect');

      // Simulate a leader takeover: tear the server down...
      await server.close();
      await waitFor(() => !client.connected, 5000, 'client noticed disconnect');

      // ...then bring a new monitor up on the same socket path.
      server = new MonitorBroadcastServer({ socketPath });
      await server.start();

      await waitFor(() => client.connected, 5000, 'client reconnected');
      expect(client.state).toBe('connected');

      await waitFor(() => server.clientCount === 1, 5000, 'server sees reconnected client');
      server.broadcast(makeEvent({ type: 'post-restart' }));
      await waitFor(
        () => received.some((e) => e.type === 'post-restart'),
        2000,
        'event after reconnect'
      );
    } finally {
      client.close();
      await server.close();
    }
  });

  test('a follower->server request gets a correlated response', async () => {
    const socketPath = tempSocketPath();
    const server = new MonitorBroadcastServer({
      socketPath,
      onRequest: (payload) => {
        const req = payload as { op?: string; pids?: number[] };
        if (req.op === 'register') {
          return { registered: req.pids?.length ?? 0 };
        }
        if (req.op === 'boom') {
          throw new Error('handler failed on purpose');
        }
        return { echo: payload };
      },
    });
    await server.start();

    const client = new MonitorBroadcastClient({
      socketPath,
      minReconnectDelayMs: 25,
      requestTimeoutMs: 2000,
    });
    client.connect();

    try {
      await waitFor(() => client.connected, 5000, 'connect');

      const ok = await client.request({ op: 'register', pids: [1, 2, 3] });
      expect(ok).toEqual({ registered: 3 });

      const echoed = await client.request({ op: 'snapshot', n: 7 });
      expect(echoed).toEqual({ echo: { op: 'snapshot', n: 7 } });

      // Concurrent requests must stay correlated by id.
      const [a, b] = await Promise.all([
        client.request({ op: 'register', pids: [9] }),
        client.request({ op: 'register', pids: [] }),
      ]);
      expect(a).toEqual({ registered: 1 });
      expect(b).toEqual({ registered: 0 });

      // A throwing handler surfaces as a rejected request, not a dropped socket.
      await expect(client.request({ op: 'boom' })).rejects.toThrow(
        'handler failed on purpose'
      );
      expect(client.connected).toBe(true);
    } finally {
      client.close();
      await server.close();
    }
  });
});
