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

  it('stores and returns provenance + label metadata (RUSH-2683)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/plan', '<h1>plan</h1>', {
      'x-share-agent': 'claude',
      'x-share-session': 'sess-1',
      'x-share-host': 'zion',
      'x-share-repo': 'agents-cli',
      'x-share-date': '2026-08-14',
      'x-share-label': 'Fleet Plan',
      'x-share-label-source': 'explicit',
    });

    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await res.json();
    expect(payload.objects[0]).toMatchObject({
      slug: 'plan',
      label: 'Fleet Plan',
      agent: 'claude',
      session: 'sess-1',
      host: 'zion',
      repo: 'agents-cli',
      revisionCount: 0,
    });
  });

  it('leaves provenance/label null when the CLI sent none (a human publish outside git)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/plain', '<h1>plain</h1>');
    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await res.json();
    expect(payload.objects[0]).toMatchObject({ label: null, agent: null, session: null, host: null, repo: null });
  });

  it('strips a same-named --meta key even when the CLI sent NO provenance header at all (RUSH-2683 review fix)', async () => {
    // Regression guard: the reserved-key merge used to be
    // `customMetadata = { ...extraMeta }` followed by `if (agent)
    // customMetadata.agent = agent` — an overwrite that only fires when the
    // real provenance header is PRESENT. A human publishing outside an agent
    // session and outside a git checkout sends no x-share-agent/session/host/
    // repo/date headers at all, so a smuggled --meta agent=… (or session=…,
    // host=…, repo=…, date=…) previously survived untouched into public
    // customMetadata. The fix strips every reserved key unconditionally
    // before re-applying the real headers, so this must come back null/absent
    // regardless of whether the CLI sent any provenance.
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/no-provenance', '<h1>no provenance</h1>', {
      'x-share-meta': JSON.stringify({
        kind: 'plan',
        agent: 'smuggled-agent',
        session: 'smuggled-session',
        host: 'smuggled-host',
        repo: 'smuggled-repo',
        date: 'smuggled-date',
        label: 'smuggled-label',
        'label-source': 'smuggled-source',
      }),
    });
    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await res.json();
    expect(payload.objects[0]).toMatchObject({
      label: null, agent: null, session: null, host: null, repo: null,
    });
  });

  it('accepts arbitrary --meta entries via x-share-meta, and a real provenance header always wins over a same-named --meta key', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/meta', '<h1>meta</h1>', {
      'x-share-agent': 'claude',
      'x-share-meta': JSON.stringify({ kind: 'plan', ticket: 'RUSH-2683', agent: 'someone-else' }),
    });
    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await res.json();
    // The CLI already rejects a --meta collision client-side (parseMetaEntries);
    // this pins the Worker's independent defense — reserved fields are applied
    // AFTER meta, so a genuine x-share-agent header always wins.
    expect(payload.objects[0].agent).toBe('claude');
  });

  it('returns arbitrary --meta entries under objects[].meta, with reserved keys excluded (RUSH-2683 review fix)', async () => {
    // --meta was write-only before this fix: stored in customMetadata but never
    // returned by any read route, so a value published with `--meta kind=plan
    // --meta ticket=RUSH-2683` couldn't be read back via `share list --list-json`.
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/meta-visible', '<h1>meta</h1>', {
      'x-share-agent': 'claude',
      'x-share-label': 'Fleet Plan',
      'x-share-meta': JSON.stringify({ kind: 'plan', ticket: 'RUSH-2683' }),
    });
    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await res.json();
    expect(payload.objects[0].meta).toEqual({ kind: 'plan', ticket: 'RUSH-2683' });
    // Reserved keys never leak into the meta map even though they live in the
    // same customMetadata object under the hood.
    expect(payload.objects[0].meta.agent).toBeUndefined();
    expect(payload.objects[0].meta.label).toBeUndefined();
  });

  it('meta is {} when no --meta entries were sent', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/no-meta', '<h1>plain</h1>');
    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await res.json();
    expect(payload.objects[0].meta).toEqual({});
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

describe('revision retention (RUSH-2683 — R2 has no native object versioning)', () => {
  it('creates no revision on a FIRST publish', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    await put(worker, env, 'octocat/first', '<h1>v1</h1>');
    expect(Array.from(store.keys())).toEqual(['octocat/first']);
  });

  it('republishing an EXISTING slug copies the prior version to <slug>/rev-<ts>-<rand> and leaves the canonical key at the new content', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    await put(worker, env, 'octocat/plan', '<h1>v1</h1>', { 'x-share-label': 'v1' });
    await put(worker, env, 'octocat/plan', '<h1>v2</h1>', { 'x-share-label': 'v2' });

    const keys = Array.from(store.keys());
    expect(keys).toContain('octocat/plan');
    const revKeys = keys.filter((k) => k.startsWith('octocat/plan/rev-'));
    expect(revKeys).toHaveLength(1);

    // Canonical key is the LATEST content.
    const canonical = await worker.default.fetch(new Request('https://share.test/octocat/plan'), env);
    expect(await canonical.text()).toContain('v2');

    // The revision key holds the OLD content and its own metadata.
    const rev = await worker.default.fetch(new Request(`https://share.test/${revKeys[0]}`), env);
    expect(await rev.text()).toContain('v1');
  });

  it('--no-revision overwrites in place with no backup copy', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    await put(worker, env, 'octocat/plan', '<h1>v1</h1>');
    await put(worker, env, 'octocat/plan', '<h1>v2</h1>', { 'x-share-no-revision': '1' });
    expect(Array.from(store.keys())).toEqual(['octocat/plan']);
    const canonical = await worker.default.fetch(new Request('https://share.test/octocat/plan'), env);
    expect(await canonical.text()).toContain('v2');
  });

  it('two rapid republishes each get their own revision key (no collision)', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    await put(worker, env, 'octocat/plan', '<h1>v1</h1>');
    await put(worker, env, 'octocat/plan', '<h1>v2</h1>');
    await put(worker, env, 'octocat/plan', '<h1>v3</h1>');
    const revKeys = Array.from(store.keys()).filter((k) => k.startsWith('octocat/plan/rev-'));
    expect(revKeys).toHaveLength(2);
    expect(new Set(revKeys).size).toBe(2);
  });

  it('revisions never appear in the JSON listing or gallery — only as a revisionCount', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/plan', '<h1>v1</h1>');
    await put(worker, env, 'octocat/plan', '<h1>v2</h1>');

    const listing = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await listing.json();
    expect(payload.objects.map((o: any) => o.slug)).toEqual(['plan']);
    expect(payload.objects[0].revisionCount).toBe(1);

    const gallery = await worker.default.fetch(new Request('https://share.test/octocat'), env);
    const html = await gallery.text();
    expect(html).not.toContain('/rev-');
  });

  it('GET /<user>/<slug>?revisions=json returns the retained versions newest-first with their metadata', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-10T00:00:00.000Z'));
      const worker = await loadWorker();
      const { env } = makeEnv();
      await put(worker, env, 'octocat/plan', '<h1>v1</h1>', { 'x-share-agent': 'claude', 'x-share-label': 'v1' });
      vi.setSystemTime(new Date('2026-08-11T00:00:00.000Z'));
      await put(worker, env, 'octocat/plan', '<h1>v2</h1>', { 'x-share-agent': 'codex', 'x-share-label': 'v2' });
      vi.setSystemTime(new Date('2026-08-12T00:00:00.000Z'));
      await put(worker, env, 'octocat/plan', '<h1>v3</h1>', { 'x-share-agent': 'claude', 'x-share-label': 'v3' });

      const res = await worker.default.fetch(new Request('https://share.test/octocat/plan?revisions=json'), env);
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.key).toBe('octocat/plan');
      expect(payload.count).toBe(2);
      // Newest revision (the one that replaced v2, carrying v2's own metadata) leads.
      expect(payload.revisions[0].label).toBe('v2');
      expect(payload.revisions[1].label).toBe('v1');
      expect(payload.revisions.every((r: any) => typeof r.uploadedAt === 'string')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns arbitrary --meta entries under revisions[].meta, with reserved keys excluded (RUSH-2683 review fix)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/plan-meta', '<h1>v1</h1>', {
      'x-share-agent': 'claude',
      'x-share-meta': JSON.stringify({ kind: 'plan', ticket: 'RUSH-2683' }),
    });
    await put(worker, env, 'octocat/plan-meta', '<h1>v2</h1>');

    const res = await worker.default.fetch(new Request('https://share.test/octocat/plan-meta?revisions=json'), env);
    const payload = await res.json();
    expect(payload.revisions[0].meta).toEqual({ kind: 'plan', ticket: 'RUSH-2683' });
    expect(payload.revisions[0].meta.agent).toBeUndefined();
  });

  it('returns an empty revisions array for a slug that was only ever published once', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/solo', '<h1>only</h1>');
    const res = await worker.default.fetch(new Request('https://share.test/octocat/solo?revisions=json'), env);
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.count).toBe(0);
    expect(payload.revisions).toEqual([]);
  });

  it('a retained revision honors its OWN expiry independently of the canonical page', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
      const worker = await loadWorker();
      const { env } = makeEnv();
      await put(worker, env, 'octocat/plan', '<h1>v1</h1>', { 'x-share-expires-at': '2026-08-02T00:00:00.000Z' });
      await put(worker, env, 'octocat/plan', '<h1>v2</h1>');

      const res = await worker.default.fetch(new Request('https://share.test/octocat/plan?revisions=json'), env);
      const payload = await res.json();
      expect(payload.revisions[0].expiresAt).toBe('2026-08-02T00:00:00.000Z');

      vi.setSystemTime(new Date('2026-08-03T00:00:00.000Z'));
      const revUrl = 'https://share.test/' + payload.revisions[0].key;
      const gone = await worker.default.fetch(new Request(revUrl), env);
      expect(gone.status).toBe(410);
    } finally {
      vi.useRealTimers();
    }
  });
});
