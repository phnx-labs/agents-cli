/**
 * Boots the authenticated control server on an ephemeral port and asserts the
 * real HTTP surface: bearer gating on every route, the reused read-only GET
 * surface, and the two mutation routes (run dispatch + message) through their
 * DI seams — so no real agent is ever spawned. Real server, real sockets, fake
 * side effects (matches the repo's "real services, injected side effects" line
 * for the parts that would otherwise shell out).
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'http';
import { startControlServer, spawnDetached } from './control.js';
import type { ControlOptions, RunRequest } from './control.js';
import type { ServeState } from './data.js';

let server: Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

const STATE: ServeState = {
  generated_at: '2026-07-16T00:00:00.000Z',
  teams: { ok: true, data: [] },
  routines: { ok: true, data: [] },
  cloud: { ok: true, data: [] },
};

const TOKEN = 'good-token';

async function boot(extra: Partial<ControlOptions> = {}): Promise<string> {
  const started = await startControlServer(0, '127.0.0.1', {
    cwd: process.cwd(),
    intervalMs: 50,
    snapshot: async () => STATE,
    verifyToken: (t) => t === TOKEN,
    runner: async (req: RunRequest) => ({ sessionId: `sid-${req.agent}`, name: 'ios-test' }),
    messenger: async () => {},
    ...extra,
  });
  server = started.server;
  return `http://127.0.0.1:${started.port}`;
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe('control server — auth', () => {
  it('401s without a token', async () => {
    const base = await boot();
    const res = await fetch(base + '/api/state');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('401s with a wrong token', async () => {
    const base = await boot();
    const res = await fetch(base + '/api/state', { headers: { authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });

  it('accepts the x-agents-token header form', async () => {
    const base = await boot();
    const res = await fetch(base + '/api/state', { headers: { 'x-agents-token': TOKEN } });
    expect(res.status).toBe(200);
  });
});

describe('control server — reused read-only surface', () => {
  it('serves the JSON snapshot when authed', async () => {
    const base = await boot();
    const res = await fetch(base + '/api/state', { headers: auth });
    expect(res.status).toBe(200);
    const state = await res.json();
    expect(state.generated_at).toBe(STATE.generated_at);
  });

  it('streams an SSE state event when authed', async () => {
    const base = await boot();
    const res = await fetch(base + '/events', { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('event: state');
    await reader.cancel();
  });
});

describe('control server — POST /api/run', () => {
  it('dispatches through the runner and returns its ids', async () => {
    let seen: RunRequest | null = null;
    const base = await boot({
      runner: async (req) => {
        seen = req;
        return { sessionId: 'sid-xyz', name: 'ios-abc' };
      },
    });
    const res = await fetch(base + '/api/run', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'claude', prompt: 'do a thing', mode: 'edit', host: 'yosemite-s0' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ sessionId: 'sid-xyz', name: 'ios-abc' });
    expect(seen!).toMatchObject({ agent: 'claude', prompt: 'do a thing', mode: 'edit', host: 'yosemite-s0' });
  });

  it('400s when the runner rejects a bad request', async () => {
    const base = await boot({
      runner: async () => {
        throw new Error('agent is required');
      },
    });
    const res = await fetch(base + '/api/run', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'no agent' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('agent is required');
  });

  it('400s on invalid JSON', async () => {
    const base = await boot();
    const res = await fetch(base + '/api/run', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('control server — POST /api/session/:id/message', () => {
  it('routes to the messenger with the decoded id and text', async () => {
    const calls: Array<{ id: string; text: string; from?: string }> = [];
    const base = await boot({
      messenger: async (id, text, from) => {
        calls.push({ id, text, from });
      },
    });
    const res = await fetch(base + '/api/session/abc-123/message', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'stop and summarize', from: 'muqsit' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: 'abc-123' });
    expect(calls).toEqual([{ id: 'abc-123', text: 'stop and summarize', from: 'muqsit' }]);
  });

  it('400s when text is missing', async () => {
    const base = await boot();
    const res = await fetch(base + '/api/session/abc/message', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'x' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('control server — unknown routes', () => {
  it('404s an unknown authed path', async () => {
    const base = await boot();
    const res = await fetch(base + '/api/nope', { headers: auth });
    expect(res.status).toBe(404);
  });
});

describe('spawnDetached — crash safety on spawn failure', () => {
  // Regression for the prix-cloud finding: a detached spawn with no 'error'
  // listener throws an unhandled 'error' (ENOENT) and takes down the whole
  // anchor. This must REJECT (a clean 400 upstream), and — critically — the
  // process must survive. If the listener were missing this test run itself
  // would crash rather than fail.
  it('rejects instead of crashing when the binary does not exist', async () => {
    await expect(spawnDetached('/definitely/not/a/real/binary-xyz-123', [])).rejects.toThrow();
    // Reaching here at all proves the unhandled-error crash did not happen.
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('resolves when the process spawns successfully', async () => {
    await expect(spawnDetached(process.execPath, ['-e', ''])).resolves.toBeUndefined();
  });
});
