/**
 * Boots the read-only serve server on an ephemeral loopback port and asserts
 * the real HTTP surface: the HTML page, the JSON snapshot shape, SSE framing,
 * loopback-only binding, and the read-only (GET-only) contract.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Server, IncomingMessage } from 'http';
import net from 'net';
import { startServeServer, SERVE_HOST, isAllowedServeHost } from './server.js';
import type { ServeState } from './data.js';

let server: Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

async function boot(): Promise<string> {
  const started = await startServeServer(0, { cwd: process.cwd(), intervalMs: 50 });
  server = started.server;
  return `http://${SERVE_HOST}:${started.port}`;
}

describe('serve server', () => {
  it('binds loopback only', async () => {
    const started = await startServeServer(0, { cwd: process.cwd() });
    server = started.server;
    const addr = started.server.address();
    expect(typeof addr).toBe('object');
    expect((addr as { address: string }).address).toBe('127.0.0.1');
  });

  it('rejects an explicit non-loopback Host header (DNS-rebind guard)', async () => {
    const base = await boot();
    const port = Number(new URL(base).port);
    // Raw socket so we fully control the Host header (undici forbids overriding it).
    const rawGet = (hostHeader: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write(`GET /api/state HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
        });
        let buf = '';
        sock.on('data', (d) => { buf += d.toString(); });
        sock.on('end', () => {
          const m = buf.match(/^HTTP\/1\.\d (\d{3})/);
          m ? resolve(Number(m[1])) : reject(new Error('no status line: ' + buf.slice(0, 80)));
        });
        sock.on('error', reject);
      });
    // A rebound browser reaches 127.0.0.1 but sends the attacker's hostname.
    expect(await rawGet('attacker.example')).toBe(403);
    // A loopback Host (what a real browser at localhost sends) is served.
    expect(await rawGet('localhost:4477')).toBe(200);
  });

  it('isAllowedServeHost trusts only loopback (or a missing Host)', () => {
    for (const h of ['localhost', 'localhost:4477', '127.0.0.1', '127.0.0.1:4477', '[::1]:4477', undefined]) {
      expect(isAllowedServeHost(h)).toBe(true);
    }
    for (const h of ['attacker.example', 'evil.com:4477', '10.0.0.5', 'foo.localhost']) {
      expect(isAllowedServeHost(h)).toBe(false);
    }
  });

  it('serves the HTML page at /', async () => {
    const base = await boot();
    const res = await fetch(base + '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('agents serve');
    expect(body).toContain('/events');
  });

  it('returns a well-formed JSON snapshot at /api/state', async () => {
    const base = await boot();
    const res = await fetch(base + '/api/state');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const state = await res.json();
    expect(typeof state.generated_at).toBe('string');
    for (const panel of ['teams', 'routines', 'cloud'] as const) {
      expect(state[panel]).toBeDefined();
      expect(typeof state[panel].ok).toBe('boolean');
      if (state[panel].ok) expect(Array.isArray(state[panel].data)).toBe(true);
      else expect(typeof state[panel].error).toBe('string');
    }
  });

  it('rejects non-GET methods (read-only)', async () => {
    const base = await boot();
    const res = await fetch(base + '/api/state', { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it('streams an SSE state event', async () => {
    const base = await boot();
    const res = await fetch(base + '/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain('event: state');
    expect(chunk).toContain('data: ');
    await reader.cancel();
  });

  it('404s unknown paths', async () => {
    const base = await boot();
    const res = await fetch(base + '/nope');
    expect(res.status).toBe(404);
  });

  // Regression: an SSE client that disconnects DURING the first (slow) snapshot
  // must not leak the push interval. The one-shot 'close' has to be registered
  // BEFORE the first `await push()`, and the interval must not arm once closed —
  // otherwise it keeps calling assembleState()/res.write() on a dead socket
  // forever. We reproduce the race deterministically by gating the first
  // snapshot: disconnect, confirm the server observed the close, THEN release
  // the snapshot. A correct server calls the snapshot exactly once (no interval
  // ever fires); the buggy version calls it repeatedly.
  it('does not leak the SSE interval when the client disconnects during the first snapshot', async () => {
    const STATE: ServeState = {
      generated_at: '2026-07-05T00:00:00.000Z',
      teams: { ok: true, data: [] },
      routines: { ok: true, data: [] },
      cloud: { ok: true, data: [] },
    };

    let snapshotCalls = 0;
    let signalEntered!: () => void;
    const enteredFirstSnapshot = new Promise<void>((r) => (signalEntered = r));
    let releaseFirstSnapshot!: () => void;
    const gate = new Promise<void>((r) => (releaseFirstSnapshot = r));

    const snapshot = async (): Promise<ServeState> => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) {
        signalEntered();
        await gate; // hold the first snapshot open so we can disconnect mid-flight
      }
      return STATE;
    };

    const started = await startServeServer(0, { cwd: process.cwd(), intervalMs: 20, snapshot });
    server = started.server;

    // Observe the server-side close independently of the handler under test, so
    // we can wait until the disconnect is truly seen before releasing the gate.
    let serverSawClose = false;
    server.on('request', (req: IncomingMessage) => {
      if ((req.url || '').startsWith('/events')) req.on('close', () => (serverSawClose = true));
    });

    // Raw socket so we control exactly when the client goes away.
    const sock = net.connect(started.port, SERVE_HOST);
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve());
      sock.once('error', reject);
    });
    sock.write(`GET /events HTTP/1.1\r\nHost: ${SERVE_HOST}\r\nConnection: keep-alive\r\n\r\n`);

    // Wait until we're inside the first snapshot, then kill the client.
    await enteredFirstSnapshot;
    sock.destroy();

    // Deterministically wait for the server to register the disconnect before
    // releasing the snapshot — this is what makes the assertion non-flaky.
    const deadline = Date.now() + 2000;
    while (!serverSawClose && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    expect(serverSawClose).toBe(true);

    // Let the (now-orphaned) first snapshot finish, then give any leaked
    // interval many cadences to fire.
    releaseFirstSnapshot();
    await new Promise<void>((r) => setTimeout(r, 200)); // 10x the 20ms interval

    // Exactly one snapshot: the first frame. No interval ever armed, so no
    // write-after-close and no leaked timer.
    expect(snapshotCalls).toBe(1);
  });
});
