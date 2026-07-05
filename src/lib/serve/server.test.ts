/**
 * Boots the read-only serve server on an ephemeral loopback port and asserts
 * the real HTTP surface: the HTML page, the JSON snapshot shape, SSE framing,
 * loopback-only binding, and the read-only (GET-only) contract.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'http';
import { startServeServer, SERVE_HOST } from './server.js';

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
});
