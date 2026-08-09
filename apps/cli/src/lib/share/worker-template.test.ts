import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWorkerScript } from './worker-template.js';

// The Worker source is emitted as a string. Import it as an ES module via a
// data: URI (same technique as publish.test.ts) and drive its `fetch` handler
// against an in-memory BUCKET so the real route logic is exercised — no mocking
// of the listing/format code under test.

interface StoredObject {
  body: Buffer;
  httpMetadata: { contentType?: string };
  customMetadata: Record<string, string>;
  uploaded: string;
  size: number;
}

function makeEnv() {
  const store = new Map<string, StoredObject>();
  const env = {
    WRITE_TOKEN: 'secret',
    BUCKET: {
      put: async (
        key: string,
        body: BodyInit | null,
        opts: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
      ) => {
        // The Worker forwards request.body (a ReadableStream) — consume it so the
        // fake records a real byte size, exactly as R2 would.
        const buf = body == null ? Buffer.alloc(0) : Buffer.from(await new Response(body as BodyInit).arrayBuffer());
        store.set(key, {
          body: buf,
          httpMetadata: opts.httpMetadata ?? {},
          customMetadata: opts.customMetadata ?? {},
          uploaded: new Date().toISOString(),
          size: buf.length,
        });
      },
      get: async (key: string) => {
        const item = store.get(key);
        if (!item) return null;
        return {
          body: item.body,
          customMetadata: item.customMetadata,
          httpEtag: '"etag"',
          writeHttpMetadata(headers: Headers) {
            if (item.httpMetadata.contentType) headers.set('content-type', item.httpMetadata.contentType);
          },
        };
      },
      delete: async (key: string) => {
        store.delete(key);
      },
      list: async (opts: { prefix?: string; limit?: number; include?: string[] }) => {
        const objects = Array.from(store.entries())
          .filter(([k]) => !opts.prefix || k.startsWith(opts.prefix))
          .map(([key, value]) => ({
            key,
            uploaded: value.uploaded,
            httpMetadata: value.httpMetadata,
            customMetadata: value.customMetadata,
            size: value.size,
          }));
        return { objects: opts.limit ? objects.slice(0, opts.limit) : objects };
      },
    },
  };
  return { env, store };
}

async function loadWorker() {
  const src = renderWorkerScript();
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}#${Date.now()}`);
}

async function put(worker: any, env: any, key: string, body: string, headers: Record<string, string> = {}) {
  const res = await worker.default.fetch(
    new Request(`https://share.test/${key}`, {
      method: 'PUT',
      headers: { authorization: 'Bearer secret', 'content-type': 'text/html; charset=utf-8', ...headers },
      body,
    }),
    env,
  );
  expect(res.status).toBe(200);
}

describe('worker JSON listing route (GET /<user>?format=json)', () => {
  afterEach(() => vi.useRealTimers());

  it('returns the active shares as JSON with slug/url/size/contentType/publishedAt/expiresAt', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();

    await put(worker, env, 'octocat/plan-one', '<h1>one</h1>');
    await put(worker, env, 'octocat/plan-two', '<h1>two is longer</h1>');
    // A non-HTML asset keeps its own content type.
    await put(worker, env, 'octocat/data-json', '{"a":1}', { 'content-type': 'application/json' });

    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);

    const payload = await res.json();
    expect(payload.user).toBe('octocat');
    expect(payload.count).toBe(3);
    const bySlug = Object.fromEntries(payload.objects.map((o: any) => [o.slug, o]));
    expect(Object.keys(bySlug).sort()).toEqual(['data-json', 'plan-one', 'plan-two']);
    expect(bySlug['plan-one'].url).toBe('https://share.test/octocat/plan-one');
    expect(bySlug['plan-one'].contentType).toBe('text/html; charset=utf-8');
    expect(bySlug['data-json'].contentType).toBe('application/json');
    expect(bySlug['plan-two'].size).toBeGreaterThan(bySlug['plan-one'].size);
    expect(bySlug['plan-one'].expiresAt).toBeNull();
    expect(typeof bySlug['plan-one'].publishedAt).toBe('string');
    expect(() => new Date(bySlug['plan-one'].publishedAt).toISOString()).not.toThrow();
  });

  it('omits the sibling .png OG covers and expired pages, like the gallery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T00:00:00.000Z'));
    const worker = await loadWorker();
    const { env } = makeEnv();

    await put(worker, env, 'octocat/live', '<h1>live</h1>');
    await put(worker, env, 'octocat/live.png', 'PNGDATA', { 'content-type': 'image/png' });
    await put(worker, env, 'octocat/stale', '<h1>stale</h1>', { 'x-share-expires-at': '2026-08-07T00:00:00.000Z' });

    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await res.json();
    expect(payload.objects.map((o: any) => o.slug)).toEqual(['live']);
    expect(payload.count).toBe(1);
  });

  it('reports expiresAt for a page published with an expiry', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/temp', '<h1>temp</h1>', { 'x-share-expires-at': '2099-01-01T00:00:00.000Z' });

    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await res.json();
    expect(payload.objects[0].expiresAt).toBe('2099-01-01T00:00:00.000Z');
  });

  it('serves a legacy flat-slug page even with ?format=json — never a fake empty listing (regression)', async () => {
    // A legacy flat slug (pre per-user namespaces) is an object at a bare
    // single-segment key. GET /<slug>?format=json must serve the real page, not
    // hijack it into an empty JSON listing — the `?format=json` branch must gate
    // on the same "namespace has objects" check as the gallery. (publish.test.ts
    // covers the plain legacy GET; this adds the ?format=json query param.)
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'legacy-plan-a1b2', '<h1>legacy page</h1>');

    const res = await worker.default.fetch(new Request('https://share.test/legacy-plan-a1b2?format=json'), env);
    expect(res.status).toBe(200);
    // The real HTML page, NOT a JSON listing.
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const text = await res.text();
    expect(text).toContain('legacy page');
    expect(text).not.toContain('"count"');
  });

  it('404s a single-segment path with nothing under it (empty/nonexistent namespace)', async () => {
    // With no objects under `nobody/` and no legacy object at the bare key, the
    // path falls through to a 404 — the CLI reads this (on a current template) as
    // "nothing published", not a missing route.
    const worker = await loadWorker();
    const { env } = makeEnv();
    const res = await worker.default.fetch(new Request('https://share.test/nobody?format=json'), env);
    expect(res.status).toBe(404);
  });

  it('answers HEAD with JSON content type and no body', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/plan', '<h1>plan</h1>');
    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json', { method: 'HEAD' }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.text()).toBe('');
  });

  it('leaves the HTML gallery untouched — no ?format=json still renders HTML', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/plan', '<h1>plan</h1>');

    const gallery = await worker.default.fetch(new Request('https://share.test/octocat'), env);
    expect(gallery.status).toBe(200);
    expect(gallery.headers.get('content-type')).toMatch(/text\/html/);
    expect(await gallery.text()).toContain('@octocat');
  });

  it('omits unlisted pages from the JSON listing and HTML gallery, but still serves the direct URL (RUSH-2443)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();

    await put(worker, env, 'octocat/public-page', '<h1>public</h1>');
    await put(worker, env, 'octocat/secret-report', '<h1>secret</h1>', {
      'x-share-visibility': 'unlisted',
    });

    // Direct URL still works — unlisted, not secret.
    const direct = await worker.default.fetch(new Request('https://share.test/octocat/secret-report'), env);
    expect(direct.status).toBe(200);
    expect(await direct.text()).toContain('secret');

    // Listing and gallery hide it.
    const listing = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await listing.json();
    expect(payload.objects.map((o: any) => o.slug)).toEqual(['public-page']);
    expect(payload.count).toBe(1);

    const gallery = await worker.default.fetch(new Request('https://share.test/octocat'), env);
    const html = await gallery.text();
    expect(html).toContain('public-page');
    expect(html).not.toContain('secret-report');
  });
});
