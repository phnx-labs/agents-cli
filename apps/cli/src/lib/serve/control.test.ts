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
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startControlServer, spawnDetached } from './control.js';
import type { ControlOptions, RunRequest } from './control.js';
import type { ServeState } from './data.js';

let server: Server | null = null;
let tmpStreamDir: string | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
  if (tmpStreamDir) {
    fs.rmSync(tmpStreamDir, { recursive: true, force: true });
    tmpStreamDir = null;
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

describe('control server — GET /api/session/:id/stream (SSE event bridge)', () => {
  // Point the route at a temp capture file via the streamLogPathFor seam so the
  // test never touches the real ~/.agents cache.
  function bootStream(file: string): Promise<string> {
    return boot({ streamPollMs: 15, streamLogPathFor: () => file });
  }

  async function readFrames(res: Response, until: (buf: string) => boolean): Promise<string> {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (!until(buf)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    await reader.cancel();
    return buf;
  }

  it('streams captured NDJSON events and closes on the terminal event', async () => {
    tmpStreamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ctl-stream-'));
    const file = path.join(tmpStreamDir, 'run.ndjson');
    fs.writeFileSync(file, '{"type":"assistant","t":"hi"}\n{"type":"result"}\n');

    const base = await bootStream(file);
    const res = await fetch(base + '/api/session/sid-x/stream', { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const buf = await readFrames(res, (b) => b.includes('event: end'));
    expect(buf).toContain('event: assistant');
    expect(buf).toContain('"t":"hi"');
    expect(buf).toContain('event: result');
    expect(buf).toContain('event: end');
    // Each data frame carries a byte-offset id for resume.
    expect(buf).toMatch(/\nid: \d+\n/);
  });

  it('resumes from ?offset= and does not replay earlier events', async () => {
    tmpStreamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ctl-stream-'));
    const file = path.join(tmpStreamDir, 'run.ndjson');
    const l1 = '{"type":"assistant","t":"first"}\n';
    fs.writeFileSync(file, l1 + '{"type":"result"}\n');

    const base = await bootStream(file);
    const res = await fetch(base + `/api/session/sid-x/stream?offset=${Buffer.byteLength(l1)}`, {
      headers: auth,
    });
    const buf = await readFrames(res, (b) => b.includes('event: end'));
    expect(buf).not.toContain('first'); // earlier event skipped
    expect(buf).toContain('event: result');
  });

  it('requires the bearer token', async () => {
    tmpStreamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ctl-stream-'));
    const file = path.join(tmpStreamDir, 'run.ndjson');
    fs.writeFileSync(file, '{"type":"result"}\n');
    const base = await bootStream(file);
    const res = await fetch(base + '/api/session/sid-x/stream');
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it('does not hang on a negative/garbage offset — clamps to 0 and replays', async () => {
    // Regression for the prix-cloud finding: Buffer.subarray(negative) indexes
    // from the end, so an unclamped negative offset read nothing forever. The
    // stream must clamp to 0, emit every event, and close on the terminal event.
    tmpStreamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ctl-stream-'));
    const file = path.join(tmpStreamDir, 'run.ndjson');
    fs.writeFileSync(file, '{"type":"assistant","t":"one"}\n{"type":"result"}\n');
    const base = await bootStream(file);
    const res = await fetch(base + '/api/session/sid-x/stream?offset=-1', { headers: auth });
    const buf = await readFrames(res, (b) => b.includes('event: end'));
    expect(buf).toContain('event: assistant');
    expect(buf).toContain('event: result');
    expect(buf).toContain('event: end'); // reaching here proves it did not hang
  });

  it('advances the cursor past trailing non-JSON lines (no re-scan stall)', async () => {
    tmpStreamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ctl-stream-'));
    const file = path.join(tmpStreamDir, 'run.ndjson');
    // A real event, then trailing noise AFTER it, then (later) the terminal.
    fs.writeFileSync(file, '{"type":"assistant","t":"x"}\nsome banner noise\n');
    const base = await bootStream(file);
    const res = await fetch(base + '/api/session/sid-x/stream', { headers: auth });
    // Append the terminal after the stream is already tailing past the noise.
    setTimeout(() => fs.appendFileSync(file, '{"type":"result"}\n'), 60);
    const buf = await readFrames(res, (b) => b.includes('event: end'));
    expect(buf).toContain('event: assistant');
    expect(buf).toContain('event: result');
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

  it('captures child stdout to an inherited fd (the defaultRunner capture path)', async () => {
    tmpStreamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ctl-cap-'));
    const file = path.join(tmpStreamDir, 'cap.ndjson');
    const fd = fs.openSync(file, 'a');
    try {
      await spawnDetached(process.execPath, ['-e', 'process.stdout.write(\'{"type":"result"}\\n\')'], [
        'ignore',
        fd,
        fd,
      ]);
    } finally {
      fs.closeSync(fd);
    }
    // The detached child writes async; poll briefly for the line to land.
    let contents = '';
    for (let i = 0; i < 40 && !contents.includes('result'); i++) {
      await new Promise((r) => setTimeout(r, 25));
      contents = fs.readFileSync(file, 'utf-8');
    }
    expect(contents).toContain('{"type":"result"}');
  });
});
