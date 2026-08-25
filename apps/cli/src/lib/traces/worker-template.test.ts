import { describe, expect, it } from 'vitest';
import { renderTracesWorkerScript } from './worker-template.js';

// Minimal Miniflare-style worker harness for unit tests.
// We evaluate the worker script in a fresh JS context to get the fetch handler.

function makeWorker(opts: {
  verifyResult: { userId: string; email: string } | null;
  bucket?: Map<string, { body: string; httpMetadata?: Record<string, string> }>;
}) {
  const bucket = opts.bucket ?? new Map();
  const env = {
    PHOENIX_ID_BASE: 'https://id.test',
    BUCKET: {
      async get(key: string) {
        const item = bucket.get(key);
        if (!item) return null;
        return {
          body: item.body,
          httpMetadata: item.httpMetadata ?? {},
        };
      },
      async put(
        key: string,
        body: ReadableStream | string,
        meta: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> },
      ) {
        let text = '';
        if (typeof body === 'string') {
          text = body;
        } else {
          const chunks: Uint8Array[] = [];
          const reader = (body as ReadableStream).getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value as Uint8Array);
          }
          text = new TextDecoder().decode(Buffer.concat(chunks));
        }
        bucket.set(key, { body: text, httpMetadata: meta.httpMetadata });
      },
    },
  };

  // Evaluate the generated worker JS.
  const src = renderTracesWorkerScript();
  // Inject a stub verifyPhoenixToken so we don't need real HTTP.
  const patched = src.replace(
    'export const hooks = {\n  verifyPhoenixToken: defaultVerifyPhoenixToken,\n};',
    `export const hooks = {\n  verifyPhoenixToken: async () => (${JSON.stringify(opts.verifyResult)}),\n};`,
  );

  // Evaluate using Function constructor so we can extract the default export.
  let handler: { fetch: (req: Request, env: unknown) => Promise<Response> } | null = null;
  const mod = new Function('exports', patched + '\nexports.default = exports.default ?? null;');
  const exports: Record<string, unknown> = {};
  mod(exports);
  // The generated module uses `export default { async fetch... }` — not CommonJS.
  // We need to parse it differently: grab the fetch handler from the source.
  // Simpler: re-evaluate as a function that returns the default export.
  const fn = new Function(
    'fetchImpl',
    src
      .replace(/export const hooks.*?};/s, `const hooks = { verifyPhoenixToken: async () => (${JSON.stringify(opts.verifyResult)}) };`)
      .replace(/export default \{/, 'return {')
      .replace(/^export /gm, 'const '),
  );
  handler = fn(null);

  return {
    async fetch(url: string, init?: RequestInit) {
      const req = new Request(url, init);
      return handler!.fetch(req, env);
    },
    bucket,
  };
}

const userId = 'usr-abc123';
const otherUserId = 'usr-xyz999';

describe('traces worker — auth on every route', () => {
  it('GET without any bearer → 401', async () => {
    const w = makeWorker({ verifyResult: null });
    const res = await w.fetch(`https://traces/${userId}/index.json`);
    expect(res.status).toBe(401);
  });

  it('GET with wrong owner bearer → 403', async () => {
    const bucket = new Map([
      [`${userId}/index.json`, { body: '{"sessionCount":1}' }],
    ]);
    const w = makeWorker({ verifyResult: { userId: otherUserId, email: '' }, bucket });
    const res = await w.fetch(`https://traces/${userId}/index.json`, {
      headers: { authorization: `Bearer tok` },
    });
    expect(res.status).toBe(403);
  });

  it('GET with correct owner bearer → 200 with private no-store', async () => {
    const bucket = new Map([
      [`${userId}/index.json`, { body: '{"sessionCount":1}' }],
    ]);
    const w = makeWorker({ verifyResult: { userId, email: '' }, bucket });
    const res = await w.fetch(`https://traces/${userId}/index.json`, {
      headers: { authorization: `Bearer tok` },
    });
    expect(res.status).toBe(200);
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toBe('private, no-store');
    expect(cc).not.toContain('public');
    expect(cc).not.toMatch(/max-age/i);
  });

  it('GET non-existent path → 404 (not a 200 with empty body)', async () => {
    const w = makeWorker({ verifyResult: { userId, email: '' } });
    const res = await w.fetch(`https://traces/${userId}/sessions/does-not-exist.json`, {
      headers: { authorization: `Bearer tok` },
    });
    expect(res.status).toBe(404);
  });

  it('PUT without bearer → 401', async () => {
    const w = makeWorker({ verifyResult: null });
    const res = await w.fetch(`https://traces/${userId}/index.json`, {
      method: 'PUT',
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('PUT with correct phoenix bearer to own prefix → 200', async () => {
    const w = makeWorker({ verifyResult: { userId, email: '' } });
    const res = await w.fetch(`https://traces/${userId}/device1/index.json`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionCount: 5 }),
    });
    expect(res.status).toBe(200);
    expect(w.bucket.has(`${userId}/device1/index.json`)).toBe(true);
  });

  it('PUT with correct phoenix bearer to wrong prefix → 403', async () => {
    const w = makeWorker({ verifyResult: { userId, email: '' } });
    const res = await w.fetch(`https://traces/${otherUserId}/device1/index.json`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('PUT response always sets private no-store', async () => {
    const w = makeWorker({ verifyResult: { userId, email: '' } });
    const res = await w.fetch(`https://traces/${userId}/index.json`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok' },
      body: '{}',
    });
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toBe('private, no-store');
    expect(cc).not.toContain('public');
  });

  it('root path → 200 text description (no data exposure)', async () => {
    const w = makeWorker({ verifyResult: null });
    const res = await w.fetch('https://traces/');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('agents traces');
    expect(body).not.toContain('{');
  });

  it('unsupported method → 405', async () => {
    const w = makeWorker({ verifyResult: { userId, email: '' } });
    const res = await w.fetch(`https://traces/${userId}/index.json`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(405);
  });
});

describe('traces worker — no public cache header anywhere', () => {
  it('error responses never set public cache-control', async () => {
    const w = makeWorker({ verifyResult: null });
    const res = await w.fetch(`https://traces/${userId}/index.json`);
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).not.toContain('public');
    expect(cc).not.toMatch(/max-age=(?!0)/i);
  });
});
