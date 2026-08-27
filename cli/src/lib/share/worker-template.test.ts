import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWorkerScript } from './worker-template.js';

// The Worker source is emitted as a string. Import it as an ES module (temp
// file — the script is past bun's data: URI NameTooLong limit) and drive its
// `fetch` handler against an in-memory BUCKET so the real route logic is
// exercised — no mocking of the listing/format code under test.

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
          // R2 objects expose text()/arrayBuffer(); the Worker reads text() to
          // inject the attribution bar, so the fake must too.
          text: async () => Buffer.from(item.body).toString('utf8'),
          arrayBuffer: async () => Buffer.from(item.body).buffer,
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
  // The Worker source is an ES module. A data: URI used to work, but HMAC
  // cookie helpers pushed it past bun's NameTooLong limit for data URLs.
  const src = renderWorkerScript();
  const dir = mkdtempSync(join(tmpdir(), 'share-worker-'));
  const file = join(dir, `worker-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, src);
  return import(pathToFileURL(file).href);
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

    // Direct URL still works — unlisted, not secret — and GET is noindex.
    const direct = await worker.default.fetch(new Request('https://share.test/octocat/secret-report'), env);
    expect(direct.status).toBe(200);
    expect(direct.headers.get('X-Robots-Tag')).toBe('noindex');
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

describe('Phoenix PUT auth + visibility (RUSH-3135)', () => {
  it('accepts a valid Phoenix bearer, stamps owner, and namespaces the key', async () => {
    const worker = await loadWorker();
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'alice', email: 'alice@example.com' });
    const { env, store } = makeEnv();

    const res = await worker.default.fetch(
      new Request('https://share.test/alice/plan', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer phoenix-token',
          'content-type': 'text/html; charset=utf-8',
          'x-share-visibility': 'public',
        },
        body: '<h1>managed</h1>',
      }),
      env,
    );
    expect(res.status).toBe(200);
    const obj = store.get('alice/plan');
    expect(obj).toBeDefined();
    expect(obj?.customMetadata.owner).toBe('alice');
    expect(obj?.customMetadata.visibility).toBe('public');
  });

  it('401s when the bearer is absent', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    const res = await worker.default.fetch(
      new Request('https://share.test/alice/plan', {
        method: 'PUT',
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<h1>no auth</h1>',
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('401s when the bearer is invalid (Phoenix verify returns nothing, not the WRITE_TOKEN)', async () => {
    const worker = await loadWorker();
    worker.hooks.verifyPhoenixToken = async () => null;
    const { env } = makeEnv();
    const res = await worker.default.fetch(
      new Request('https://share.test/alice/plan', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer not-a-real-token',
          'content-type': 'text/html; charset=utf-8',
        },
        body: '<h1>nope</h1>',
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('403s a Phoenix PUT whose first path segment is not the verified handle', async () => {
    const worker = await loadWorker();
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'alice', email: 'a@b.com' });
    const { env, store } = makeEnv();
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/stolen', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer phoenix-token',
          'content-type': 'text/html; charset=utf-8',
        },
        body: '<h1>stolen</h1>',
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'namespace mismatch', owner: 'a' });
    expect(store.has('octocat/stolen')).toBe(false);
  });

  it('namespaces a Phoenix PUT under the email handle, not the userId UUID (RUSH-3224)', async () => {
    const worker = await loadWorker();
    worker.hooks.verifyPhoenixToken = async () => ({
      userId: '7b28a4b7-1fb0-4abe-948d-32daf2ff7298',
      email: 'muqsitnawaz@gmail.com',
    });
    const { env, store } = makeEnv();
    const res = await worker.default.fetch(
      new Request('https://share.test/muqsitnawaz/plan', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer phoenix-token',
          'content-type': 'text/html; charset=utf-8',
          'x-share-visibility': 'public',
        },
        body: '<h1>ok</h1>',
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(store.get('muqsitnawaz/plan')?.customMetadata.owner).toBe(
      '7b28a4b7-1fb0-4abe-948d-32daf2ff7298',
    );
    expect(store.has('7b28a4b7-1fb0-4abe-948d-32daf2ff7298/plan')).toBe(false);
  });

  it('409s a second Phoenix user whose email local-part collides (handle claim)', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    let who: { userId: string; email: string } = { userId: 'user-1', email: 'john@a.com' };
    worker.hooks.verifyPhoenixToken = async () => who;
    const first = await worker.default.fetch(
      new Request('https://share.test/john/one', {
        method: 'PUT',
        headers: { authorization: 'Bearer t', 'content-type': 'text/html' },
        body: 'one',
      }),
      env,
    );
    expect(first.status).toBe(200);
    who = { userId: 'user-2', email: 'john@b.com' };
    const second = await worker.default.fetch(
      new Request('https://share.test/john/two', {
        method: 'PUT',
        headers: { authorization: 'Bearer t', 'content-type': 'text/html' },
        body: 'two',
      }),
      env,
    );
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: 'handle taken', handle: 'john' });
    expect(store.has('john/two')).toBe(false);
  });

  it('409s a DELETE from the colliding local-part against the claimed handle', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    let who: { userId: string; email: string } = { userId: 'user-1', email: 'john@a.com' };
    worker.hooks.verifyPhoenixToken = async () => who;
    const first = await worker.default.fetch(
      new Request('https://share.test/john/one', {
        method: 'PUT',
        headers: { authorization: 'Bearer t', 'content-type': 'text/html' },
        body: 'one',
      }),
      env,
    );
    expect(first.status).toBe(200);
    who = { userId: 'user-2', email: 'john@b.com' };
    const del = await worker.default.fetch(
      new Request('https://share.test/john/one', {
        method: 'DELETE',
        headers: { authorization: 'Bearer t' },
      }),
      env,
    );
    expect(del.status).toBe(409);
    expect(await del.json()).toMatchObject({ error: 'handle taken', handle: 'john' });
    expect(store.has('john/one')).toBe(true);
  });

  it('404s GET of the internal handle-claim prefix', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    const res = await worker.default.fetch(new Request('https://share.test/__handles/alice'), env);
    expect(res.status).toBe(404);
  });

  it('lets the same Phoenix user DELETE a leftover userId-prefixed P1 object', async () => {
    const worker = await loadWorker();
    worker.hooks.verifyPhoenixToken = async () => ({
      userId: '7b28a4b7-1fb0-4abe-948d-32daf2ff7298',
      email: 'muqsitnawaz@gmail.com',
    });
    const { env, store } = makeEnv();
    store.set('7b28a4b7-1fb0-4abe-948d-32daf2ff7298/old', {
      body: Buffer.from('old'),
      httpMetadata: { contentType: 'text/html' },
      customMetadata: { owner: '7b28a4b7-1fb0-4abe-948d-32daf2ff7298' },
      uploaded: new Date().toISOString(),
      size: 3,
    });
    const res = await worker.default.fetch(
      new Request('https://share.test/7b28a4b7-1fb0-4abe-948d-32daf2ff7298/old', {
        method: 'DELETE',
        headers: { authorization: 'Bearer phoenix-token' },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(store.has('7b28a4b7-1fb0-4abe-948d-32daf2ff7298/old')).toBe(false);
  });

  it('400s org visibility on BYO WRITE_TOKEN PUT (Phoenix identity required)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/plan', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'text/html; charset=utf-8',
          'x-share-visibility': 'org',
        },
        body: '<h1>org</h1>',
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'visibility me/org requires Phoenix identity' });
  });

  it('BYO WRITE_TOKEN path still publishes and stamps owner from the path namespace', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    await put(worker, env, 'octocat/byo-page', '<h1>byo</h1>');
    const obj = store.get('octocat/byo-page');
    expect(obj?.customMetadata.owner).toBe('octocat');
    expect(obj?.customMetadata.visibility).toBe('public');
  });

  it('does not lock the Phoenix handle owner out because a BYO page stamped owner=namespace (PHNX-3291)', async () => {
    // The exact regression: the handle is legitimately claimed by a Phoenix
    // userId, but a later BYO WRITE_TOKEN publish stamps owner = the namespace
    // string. The old page-owner scan then 409'd the rightful claim holder on
    // every subsequent publish. The claim object must stay authoritative.
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'user-1', email: 'octocat@a.com' });
    const first = await worker.default.fetch(
      new Request('https://share.test/octocat/one', {
        method: 'PUT',
        headers: { authorization: 'Bearer phoenix', 'content-type': 'text/html' },
        body: 'one',
      }),
      env,
    );
    expect(first.status).toBe(200);
    // A BYO publish lands under the same namespace, owner = 'octocat' (not a userId).
    await put(worker, env, 'octocat/byo-page', '<h1>byo</h1>');
    expect(store.get('octocat/byo-page')?.customMetadata.owner).toBe('octocat');
    // The rightful Phoenix owner republishes — must succeed, not 409.
    const again = await worker.default.fetch(
      new Request('https://share.test/octocat/two', {
        method: 'PUT',
        headers: { authorization: 'Bearer phoenix', 'content-type': 'text/html' },
        body: 'two',
      }),
      env,
    );
    expect(again.status).toBe(200);
    expect(store.has('octocat/two')).toBe(true);
  });

  it('lets a first Phoenix publish claim a handle used only by BYO WRITE_TOKEN pages (PHNX-3291)', async () => {
    // No claim object yet, only BYO pages (owner = namespace). The fallback
    // page-owner scan must ignore the BYO namespace stamp so the first Phoenix
    // publish can claim its own handle instead of 409ing on its own BYO pages.
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    await put(worker, env, 'octocat/byo-a', '<h1>a</h1>');
    expect(store.get('octocat/byo-a')?.customMetadata.owner).toBe('octocat');
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'user-1', email: 'octocat@a.com' });
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/first', {
        method: 'PUT',
        headers: { authorization: 'Bearer phoenix', 'content-type': 'text/html' },
        body: 'first',
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(store.has('octocat/first')).toBe(true);
  });

  it('unlisted GET carries X-Robots-Tag: noindex; public GET does not', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/public-page', '<h1>public</h1>');
    await put(worker, env, 'octocat/secret-report', '<h1>secret</h1>', {
      'x-share-visibility': 'unlisted',
    });

    const unlisted = await worker.default.fetch(new Request('https://share.test/octocat/secret-report'), env);
    expect(unlisted.status).toBe(200);
    expect(unlisted.headers.get('X-Robots-Tag')).toBe('noindex');

    const listed = await worker.default.fetch(new Request('https://share.test/octocat/public-page'), env);
    expect(listed.status).toBe(200);
    expect(listed.headers.get('X-Robots-Tag')).toBeNull();
  });

  it('honors WRITE_TOKEN equality first when both principals could apply', async () => {
    // Platform endpoint may set both WRITE_TOKEN and PHOENIX_ID_BASE. A bearer
    // that equals WRITE_TOKEN is the BYO/admin principal — it must not be sent
    // to Phoenix.
    const worker = await loadWorker();
    let phoenixCalls = 0;
    worker.hooks.verifyPhoenixToken = async () => {
      phoenixCalls++;
      return { userId: 'alice', email: 'a@b.com' };
    };
    const { env, store } = makeEnv();
    env.PHOENIX_ID_BASE = 'https://phoenix.test';
    await put(worker, env, 'octocat/admin', '<h1>admin</h1>');
    expect(phoenixCalls).toBe(0);
    expect(store.get('octocat/admin')?.customMetadata.owner).toBe('octocat');
  });
});

describe('defaultVerifyPhoenixToken real fetch/parse (RUSH-3135)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(handler: (req: Request) => Response | Promise<Response>): Array<{ url: string; method: string; authorization: string | null }> {
    const seen: Array<{ url: string; method: string; authorization: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      seen.push({ url: req.url, method: req.method, authorization: req.headers.get('authorization') });
      return handler(req);
    }) as typeof fetch;
    return seen;
  }

  it('200 {userId,email} yields claims and GETs ${PHOENIX_ID_BASE}/api/v1/auth/me with the bearer', async () => {
    const worker = await loadWorker();
    const seen = stubFetch(
      () => new Response(JSON.stringify({ userId: 'alice', email: 'alice@example.com' }), { status: 200 }),
    );
    const claims = await worker.hooks.verifyPhoenixToken(
      new Request('https://share.test/alice/plan', { headers: { authorization: 'Bearer pid_alice' } }),
      { PHOENIX_ID_BASE: 'https://phoenix.test/' },
    );
    expect(claims).toEqual({ userId: 'alice', email: 'alice@example.com' });
    expect(seen).toEqual([
      { url: 'https://phoenix.test/api/v1/auth/me', method: 'GET', authorization: 'Bearer pid_alice' },
    ]);
  });

  it('401 / non-ok yields null (does not trust a non-2xx body)', async () => {
    const worker = await loadWorker();
    stubFetch(
      () => new Response(JSON.stringify({ userId: 'attacker', email: 'x@y.z' }), { status: 401 }),
    );
    const claims = await worker.hooks.verifyPhoenixToken(
      new Request('https://share.test/alice/plan', { headers: { authorization: 'Bearer bad' } }),
      { PHOENIX_ID_BASE: 'https://phoenix.test' },
    );
    expect(claims).toBeNull();
  });

  it('malformed body / missing userId yields null', async () => {
    const worker = await loadWorker();
    const env = { PHOENIX_ID_BASE: 'https://phoenix.test' };
    const req = new Request('https://share.test/alice/plan', { headers: { authorization: 'Bearer pid' } });

    stubFetch(() => new Response('not-json', { status: 200 }));
    expect(await worker.hooks.verifyPhoenixToken(req, env)).toBeNull();

    stubFetch(() => new Response(JSON.stringify({ email: 'a@b.com' }), { status: 200 }));
    expect(await worker.hooks.verifyPhoenixToken(req, env)).toBeNull();

    stubFetch(() => new Response(JSON.stringify({ userId: 123 }), { status: 200 }));
    expect(await worker.hooks.verifyPhoenixToken(req, env)).toBeNull();

    stubFetch(() => new Response(JSON.stringify({ userId: '' }), { status: 200 }));
    expect(await worker.hooks.verifyPhoenixToken(req, env)).toBeNull();
  });

  it('PUT through the un-stubbed hook: Phoenix 200 publishes, Phoenix 401 does not', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    (env as { PHOENIX_ID_BASE?: string }).PHOENIX_ID_BASE = 'https://phoenix.test';

    stubFetch(
      () => new Response(JSON.stringify({ userId: 'alice', email: 'alice@example.com' }), { status: 200 }),
    );
    const ok = await worker.default.fetch(
      new Request('https://share.test/alice/plan', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer pid_alice',
          'content-type': 'text/html; charset=utf-8',
        },
        body: '<h1>managed</h1>',
      }),
      env,
    );
    expect(ok.status).toBe(200);
    expect(store.get('alice/plan')?.customMetadata.owner).toBe('alice');

    stubFetch(() => new Response('nope', { status: 401 }));
    const denied = await worker.default.fetch(
      new Request('https://share.test/alice/other', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer pid_alice',
          'content-type': 'text/html; charset=utf-8',
        },
        body: '<h1>nope</h1>',
      }),
      env,
    );
    expect(denied.status).toBe(401);
    expect(store.has('alice/other')).toBe(false);
  });
});

describe('me/org GET identity gate (PHNX-3260)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(handler: (req: Request) => Response | Promise<Response>): Array<{ url: string; method: string; body: string }> {
    const seen: Array<{ url: string; method: string; body: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      seen.push({ url: req.url, method: req.method, body: await req.clone().text() });
      return handler(req);
    }) as typeof fetch;
    return seen;
  }

  async function putAsPhoenix(
    worker: any,
    env: any,
    key: string,
    body: string,
    identity: { userId: string; email: string },
    visibility: 'me' | 'org' | 'public' | 'unlisted',
  ) {
    worker.hooks.verifyPhoenixToken = async () => identity;
    (env as { PHOENIX_ID_BASE?: string }).PHOENIX_ID_BASE = env.PHOENIX_ID_BASE || 'https://phoenix.test';
    const handle = identity.email.split('@')[0].split('+')[0];
    const res = await worker.default.fetch(
      new Request(`https://share.test/${key}`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer phoenix-token',
          'content-type': 'text/html; charset=utf-8',
          'x-share-visibility': visibility,
        },
        body,
      }),
      env,
    );
    expect(res.status, `PUT ${key} as ${handle} vis=${visibility}`).toBe(200);
    return res;
  }

  function setCookieHeader(res: Response): string {
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (cookies.length > 0) return cookies[0]!;
    return res.headers.get('set-cookie') || '';
  }

  it('public and unlisted GET stay anonymous 200', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/public-page', '<h1>public</h1>');
    await put(worker, env, 'octocat/secret-report', '<h1>secret</h1>', {
      'x-share-visibility': 'unlisted',
    });

    const listed = await worker.default.fetch(new Request('https://share.test/octocat/public-page'), env);
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('public, max-age=60');
    expect(listed.headers.get('X-Robots-Tag')).toBeNull();

    const unlisted = await worker.default.fetch(new Request('https://share.test/octocat/secret-report'), env);
    expect(unlisted.status).toBe(200);
    expect(unlisted.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('me GET with no auth 302s to Phoenix login?return=<this url>', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await putAsPhoenix(worker, env, 'alice/secret', '<h1>mine</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'me');
    worker.hooks.verifyPhoenixToken = async () => null;

    const res = await worker.default.fetch(new Request('https://share.test/alice/secret'), env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://phoenix.test/login?return=' + encodeURIComponent('https://share.test/alice/secret'),
    );
  });

  it('me GET with no PHOENIX_ID_BASE 401s loud instead of bouncing', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    store.set('alice/secret', {
      body: Buffer.from('<h1>mine</h1>'),
      httpMetadata: { contentType: 'text/html' },
      customMetadata: { visibility: 'me', owner: 'alice' },
      uploaded: new Date().toISOString(),
      size: 12,
    });
    worker.hooks.verifyPhoenixToken = async () => null;

    const res = await worker.default.fetch(new Request('https://share.test/alice/secret'), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'phoenix login is not configured' });
  });

  it('phoenix_ticket redeem sets HMAC cookie and 302s stripping the ticket (keeps other query)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await putAsPhoenix(worker, env, 'alice/secret', '<h1>mine</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'me');
    worker.hooks.verifyPhoenixToken = async () => null;
    const seen = stubFetch(
      () => new Response(JSON.stringify({ userId: 'alice', email: 'alice@acme.com' }), { status: 200 }),
    );

    const res = await worker.default.fetch(
      new Request('https://share.test/alice/secret?ref=slack&phoenix_ticket=tix-1'),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://share.test/alice/secret?ref=slack');
    expect(seen).toEqual([
      { url: 'https://phoenix.test/api/v1/auth/ticket', method: 'POST', body: JSON.stringify({ ticket: 'tix-1' }) },
    ]);

    const setCookie = setCookieHeader(res);
    expect(setCookie).toContain('__Host-phoenix_share=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=604800');

    const cookieValue = setCookie.split(';')[0]!;
    const follow = await worker.default.fetch(
      new Request('https://share.test/alice/secret', { headers: { cookie: cookieValue } }),
      env,
    );
    expect(follow.status).toBe(200);
    expect(await follow.text()).toContain('mine');
    expect(follow.headers.get('cache-control')).toBe('private, no-store');
    expect(follow.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('me GET by a second identity 404s with the same body as a missing object', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await putAsPhoenix(worker, env, 'alice/secret', '<h1>mine</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'me');
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'bob', email: 'bob@acme.com' });

    const denied = await worker.default.fetch(
      new Request('https://share.test/alice/secret', { headers: { authorization: 'Bearer bob' } }),
      env,
    );
    expect(denied.status).toBe(404);
    expect(denied.headers.get('content-type')).toBe('text/plain');
    expect(await denied.text()).toBe('not found');

    const missing = await worker.default.fetch(new Request('https://share.test/alice/does-not-exist'), env);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('not found');
  });

  it('org GET 200s same-domain and 404s a mismatched domain', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    await putAsPhoenix(worker, env, 'alice/team', '<h1>org</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'org');
    expect(store.get('alice/team')?.customMetadata.org_domain).toBe('acme.com');

    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'carol', email: 'carol@acme.com' });
    const ok = await worker.default.fetch(
      new Request('https://share.test/alice/team', { headers: { authorization: 'Bearer carol' } }),
      env,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect(ok.headers.get('X-Robots-Tag')).toBe('noindex');

    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'dave', email: 'dave@other.com' });
    const denied = await worker.default.fetch(
      new Request('https://share.test/alice/team', { headers: { authorization: 'Bearer dave' } }),
      env,
    );
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe('not found');
  });

  it('org PUT from gmail 400s (public inbox)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    (env as { PHOENIX_ID_BASE?: string }).PHOENIX_ID_BASE = 'https://phoenix.test';
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'alice', email: 'alice@gmail.com' });
    const res = await worker.default.fetch(
      new Request('https://share.test/alice/plan', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer phoenix-token',
          'content-type': 'text/html; charset=utf-8',
          'x-share-visibility': 'org',
        },
        body: '<h1>org</h1>',
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'org visibility cannot use a public email domain',
      domain: 'gmail.com',
    });
  });

  it('valid bearer skips the login redirect on me GET', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await putAsPhoenix(worker, env, 'alice/secret', '<h1>mine</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'me');
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'alice', email: 'alice@acme.com' });

    const res = await worker.default.fetch(
      new Request('https://share.test/alice/secret', { headers: { authorization: 'Bearer phoenix-token' } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('mine');
  });

  it('gallery and JSON listing omit me and org pages', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await putAsPhoenix(worker, env, 'alice/public-page', '<h1>public</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'public');
    await putAsPhoenix(worker, env, 'alice/only-me', '<h1>me</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'me');
    await putAsPhoenix(worker, env, 'alice/team', '<h1>org</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'org');

    const listing = await worker.default.fetch(new Request('https://share.test/alice?format=json'), env);
    const payload = await listing.json();
    expect(payload.objects.map((o: any) => o.slug)).toEqual(['public-page']);
    expect(payload.count).toBe(1);

    const gallery = await worker.default.fetch(new Request('https://share.test/alice'), env);
    const html = await gallery.text();
    expect(html).toContain('public-page');
    expect(html).not.toContain('only-me');
    expect(html).not.toContain('team');
  });

  it('unsigned cookie is not accepted as identity (HMAC required)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await putAsPhoenix(worker, env, 'alice/secret', '<h1>mine</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'me');
    worker.hooks.verifyPhoenixToken = async () => null;

    const exp = Math.floor(Date.now() / 1000) + 604800;
    const payload = `alice|alice@acme.com|${exp}`;
    const unsigned = Buffer.from(payload).toString('base64url');
    const res = await worker.default.fetch(
      new Request('https://share.test/alice/secret', {
        headers: { cookie: `__Host-phoenix_share=${unsigned}.deadbeef` },
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/login?return=');
  });

  it('me ?revisions=json is identity-gated the same way as the page GET', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await putAsPhoenix(worker, env, 'alice/secret', '<h1>v1</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'me');
    await putAsPhoenix(worker, env, 'alice/secret', '<h1>v2</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'me');
    worker.hooks.verifyPhoenixToken = async () => null;

    const anon = await worker.default.fetch(new Request('https://share.test/alice/secret?revisions=json'), env);
    expect(anon.status).toBe(302);
    expect(anon.headers.get('location')).toContain('/login?return=');
    expect(anon.headers.get('location')).toContain(encodeURIComponent('https://share.test/alice/secret?revisions=json'));

    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'bob', email: 'bob@acme.com' });
    const other = await worker.default.fetch(
      new Request('https://share.test/alice/secret?revisions=json', { headers: { authorization: 'Bearer bob' } }),
      env,
    );
    expect(other.status).toBe(404);
    expect(await other.text()).toBe('not found');

    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'alice', email: 'alice@acme.com' });
    const ok = await worker.default.fetch(
      new Request('https://share.test/alice/secret?revisions=json', { headers: { authorization: 'Bearer alice' } }),
      env,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect(ok.headers.get('X-Robots-Tag')).toBe('noindex');
    const payload = await ok.json();
    expect(payload.count).toBe(1);
  });

  it('me PUT without PHOENIX_ID_BASE 400s even with a Phoenix hook', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'alice', email: 'alice@acme.com' });
    const res = await worker.default.fetch(
      new Request('https://share.test/alice/secret', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer phoenix-token',
          'content-type': 'text/html; charset=utf-8',
          'x-share-visibility': 'me',
        },
        body: '<h1>mine</h1>',
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'visibility me/org requires Phoenix identity' });
  });
});

describe('attribution bar injected on served HTML pages', () => {
  it('injects a Public visibility chip + author + agent into a served public page', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/report', '<!doctype html><html><body><h1>the page</h1></body></html>', {
      'x-share-agent': 'Claude',
      'x-share-date': '2026-08-27',
    });
    const res = await worker.default.fetch(new Request('https://share.test/octocat/report'), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('agents-share-bar');
    expect(html).toContain('Public');
    expect(html).toContain('Shared by <strong>octocat</strong>');
    expect(html).toContain('Made with Claude');
    expect(html).toContain('2026-08-27');
    // the bar is prepended INSIDE <body>, before the page's own content
    expect(html.indexOf('agents-share-bar')).toBeGreaterThan(-1);
    expect(html.indexOf('agents-share-bar')).toBeLessThan(html.indexOf('the page'));
    // and the etag is dropped since the body was rewritten
    expect(res.headers.get('etag')).toBeNull();
  });

  it('shows the "Only you" chip on an owner-viewed me page', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    (env as { PHOENIX_ID_BASE?: string }).PHOENIX_ID_BASE = 'https://phoenix.test';
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'u1', email: 'octocat@a.com' });
    const put1 = await worker.default.fetch(
      new Request('https://share.test/octocat/secret', {
        method: 'PUT',
        headers: { authorization: 'Bearer p', 'content-type': 'text/html', 'x-share-visibility': 'me' },
        body: '<html><body>mine</body></html>',
      }),
      env,
    );
    expect(put1.status).toBe(200);
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/secret', { headers: { authorization: 'Bearer p' } }),
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Only you');
    expect(html).toContain('agents-share-bar');
  });

  it('shows "Anyone at <domain>" on an org page for a same-domain viewer', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    (env as { PHOENIX_ID_BASE?: string }).PHOENIX_ID_BASE = 'https://phoenix.test';
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'u1', email: 'octocat@acme.com' });
    const put1 = await worker.default.fetch(
      new Request('https://share.test/octocat/plan', {
        method: 'PUT',
        headers: { authorization: 'Bearer p', 'content-type': 'text/html', 'x-share-visibility': 'org' },
        body: '<html><body>team</body></html>',
      }),
      env,
    );
    expect(put1.status).toBe(200);
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/plan', { headers: { authorization: 'Bearer p' } }),
      env,
    );
    const html = await res.text();
    expect(html).toContain('Anyone at acme.com');
  });

  it('renders as fixed full-viewport-width chrome and pushes page content down (not a floating box)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    // a page whose body is a narrow centered column — the case that previously
    // constrained the bar into a floating box.
    await put(worker, env, 'octocat/narrow', '<html><head><style>body{max-width:600px;margin:40px auto}</style></head><body><h1>x</h1></body></html>');
    const res = await worker.default.fetch(new Request('https://share.test/octocat/narrow'), env);
    const html = await res.text();
    expect(html).toContain('position:fixed');
    expect(html).toContain('width:100%');
    // pushes the page down so the fixed bar never overlaps content
    expect(html).toContain('html{padding-top:');
  });

  it('does NOT inject the bar into a non-HTML asset', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/data', '{"a":1}', { 'content-type': 'application/json' });
    const res = await worker.default.fetch(new Request('https://share.test/octocat/data'), env);
    const body = await res.text();
    expect(body).toBe('{"a":1}');
    expect(body).not.toContain('agents-share-bar');
  });

  it('escapes metadata in the bar — no HTML injection via a stamped value', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/x', '<html><body>y</body></html>', {
      'x-share-agent': '<script>evil()</script>',
    });
    const res = await worker.default.fetch(new Request('https://share.test/octocat/x'), env);
    const html = await res.text();
    expect(html).toContain('&lt;script&gt;evil()&lt;/script&gt;');
    expect(html).not.toContain('<script>evil()</script>');
  });
});

describe('viewer wrapper for non-HTML assets', () => {
  it('wraps an image in a viewer page (with the bar) for a BROWSER navigation', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/pic.png', 'PNGBYTES', { 'content-type': 'image/png', 'x-share-agent': 'Claude' });
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/pic.png', { headers: { accept: 'text/html,application/xhtml+xml' } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('agents-share-bar'); // attribution bar present
    expect(html).toContain('Made with Claude');
    // media element points back at ?raw so it loads the bytes, not the viewer
    expect(html).toContain('<img src="/octocat/pic.png?raw=1"');
    expect(html).toContain('pic.png'); // title/name
  });

  it('serves the RAW bytes to a non-browser fetch (Accept without text/html) — no wrapper', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/pic.png', 'PNGBYTES', { 'content-type': 'image/png' });
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/pic.png', { headers: { accept: 'image/png,*/*' } }),
      env,
    );
    const body = await res.text();
    expect(body).toBe('PNGBYTES');
    expect(body).not.toContain('agents-share-bar');
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('?raw returns bytes even for a browser (the embed/OG escape hatch)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/pic.png', 'PNGBYTES', { 'content-type': 'image/png' });
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/pic.png?raw=1', { headers: { accept: 'text/html' } }),
      env,
    );
    const body = await res.text();
    expect(body).toBe('PNGBYTES');
    expect(body).not.toContain('agents-share-bar');
  });

  it('?raw does NOT strip the bar from an HTML page — the bar is always-on (regression)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/page', '<html><body><h1>hi</h1></body></html>');
    const res = await worker.default.fetch(new Request('https://share.test/octocat/page?raw=1'), env);
    const html = await res.text();
    expect(html).toContain('agents-share-bar'); // ?raw only affects non-HTML assets
  });

  it('escapes a crafted asset filename in the viewer (no attribute break-out)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    // a double-quote in the name would break out of alt="…"/src="…" if unescaped
    await put(worker, env, 'octocat/e"vil.png', 'PNG', { 'content-type': 'image/png' });
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/e%22vil.png', { headers: { accept: 'text/html' } }),
      env,
    );
    const html = await res.text();
    expect(html).toContain('e&quot;vil.png'); // escaped
    expect(html).not.toContain('e"vil.png'); // never the raw, attribute-breaking form
  });

  it('uses <video> for video and <iframe> for pdf', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/clip.mp4', 'MP4', { 'content-type': 'video/mp4' });
    await put(worker, env, 'octocat/doc.pdf', 'PDF', { 'content-type': 'application/pdf' });
    const vid = await (await worker.default.fetch(new Request('https://share.test/octocat/clip.mp4', { headers: { accept: 'text/html' } }), env)).text();
    expect(vid).toContain('<video src="/octocat/clip.mp4?raw=1"');
    const pdf = await (await worker.default.fetch(new Request('https://share.test/octocat/doc.pdf', { headers: { accept: 'text/html' } }), env)).text();
    expect(pdf).toContain('<iframe src="/octocat/doc.pdf?raw=1"');
  });

  it('does not wrap a non-viewable asset (JSON) — served raw', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/data.json', '{"a":1}', { 'content-type': 'application/json' });
    const res = await worker.default.fetch(new Request('https://share.test/octocat/data.json', { headers: { accept: 'text/html' } }), env);
    const body = await res.text();
    expect(body).toBe('{"a":1}');
    expect(body).not.toContain('agents-share-bar');
  });

  it('me/org gate still applies to the viewer — anonymous browser is bounced, not shown', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    (env as { PHOENIX_ID_BASE?: string }).PHOENIX_ID_BASE = 'https://phoenix.test';
    // Respect the bearer so an anonymous request genuinely has no identity.
    worker.hooks.verifyPhoenixToken = async (req: Request) =>
      (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
        ? { userId: 'u1', email: 'octocat@a.com' }
        : null;
    const put1 = await worker.default.fetch(
      new Request('https://share.test/octocat/secret.png', {
        method: 'PUT',
        headers: { authorization: 'Bearer p', 'content-type': 'image/png', 'x-share-visibility': 'me' },
        body: 'PNG',
      }),
      env,
    );
    expect(put1.status).toBe(200);
    // anonymous browser navigation → gate fires (302 login), never the viewer
    const anon = await worker.default.fetch(new Request('https://share.test/octocat/secret.png', { headers: { accept: 'text/html' } }), env);
    expect(anon.status).toBe(302);
    // owner browser → viewer
    const owner = await worker.default.fetch(new Request('https://share.test/octocat/secret.png', { headers: { authorization: 'Bearer p', accept: 'text/html' } }), env);
    expect(owner.status).toBe(200);
    expect(await owner.text()).toContain('agents-share-bar');
  });
});
