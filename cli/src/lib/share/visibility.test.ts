import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderWorkerScript } from './worker-template.js';
import { SHARE_BACKEND_ENV } from './backend.js';
import { runShareEdit } from '../../commands/share.js';

// `agents artifacts share visibility` re-uses the metadata-edit PATCH route
// (visibility is metadata) via runShareEdit. These tests drive the REAL Worker
// route in-process — the Worker source is emitted as a string, imported as an ES
// module, and its `fetch` handler runs against an in-memory BUCKET (the
// worker-template.test.ts harness) — with runShareEdit wired to it through its
// `fetchEdit` seam. No mocking of the route under test.

interface StoredObject {
  body: Buffer;
  httpMetadata: { contentType?: string };
  customMetadata: Record<string, string>;
  uploaded: string;
  size: number;
}

function makeEnv() {
  const store = new Map<string, StoredObject>();
  const env: Record<string, unknown> = {
    WRITE_TOKEN: 'secret',
    PHOENIX_ID_BASE: 'https://phoenix.test',
    BUCKET: {
      put: async (
        key: string,
        body: BodyInit | null,
        opts: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string>; onlyIf?: { etagMatches?: string } },
      ) => {
        // Honor onlyIf.etagMatches like R2 — the metadata-edit route relies on it
        // for optimistic concurrency (returns null on mismatch, which is a 409).
        if (opts.onlyIf?.etagMatches) {
          const current = store.get(key);
          if (current && current.customMetadata['__etag'] !== opts.onlyIf.etagMatches) return null;
        }
        const buf = body == null ? Buffer.alloc(0) : Buffer.from(await new Response(body as BodyInit).arrayBuffer());
        const prior = store.get(key);
        store.set(key, {
          body: buf,
          httpMetadata: opts.httpMetadata ?? {},
          customMetadata: { ...(opts.customMetadata ?? {}), __etag: prior?.customMetadata['__etag'] ?? 'etag-0' },
          uploaded: new Date().toISOString(),
          size: buf.length,
        });
        return {};
      },
      get: async (key: string) => {
        const item = store.get(key);
        if (!item) return null;
        const { __etag, ...customMetadata } = item.customMetadata;
        return {
          body: item.body,
          customMetadata,
          etag: __etag,
          httpEtag: `"${__etag}"`,
          uploaded: item.uploaded,
          text: async () => Buffer.from(item.body).toString('utf8'),
          arrayBuffer: async () => item.body.buffer.slice(item.body.byteOffset, item.body.byteOffset + item.body.byteLength),
          writeHttpMetadata(headers: Headers) {
            if (item.httpMetadata.contentType) headers.set('content-type', item.httpMetadata.contentType);
          },
        };
      },
      delete: async (key: string) => {
        store.delete(key);
      },
      list: async (opts: { prefix?: string; limit?: number }) => {
        const objects = Array.from(store.entries())
          .filter(([k]) => !opts.prefix || k.startsWith(opts.prefix))
          .map(([key, value]) => ({ key, uploaded: value.uploaded, httpMetadata: value.httpMetadata, customMetadata: value.customMetadata, size: value.size }));
        return { objects: opts.limit ? objects.slice(0, opts.limit) : objects };
      },
    },
  };
  return { env, store };
}

async function loadWorker() {
  const src = renderWorkerScript();
  const dir = mkdtempSync(join(tmpdir(), 'share-vis-worker-'));
  const file = join(dir, `worker-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, src);
  return import(pathToFileURL(file).href);
}

function asPhoenix(worker: any, identity: { userId: string; email: string }) {
  worker.hooks.verifyPhoenixToken = async () => identity;
}

async function putPage(worker: any, env: any, key: string, body: string, visibility = 'public') {
  const res = await worker.default.fetch(
    new Request(`https://share.agents-cli.sh/${key}`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer phoenix-token',
        'content-type': 'text/html; charset=utf-8',
        'x-share-visibility': visibility,
        'x-share-label': 'Q3 plan',
        'x-share-agent': 'claude',
      },
      body,
    }),
    env,
  );
  expect(res.status).toBe(200);
}

/** A `fetch`-shaped seam that routes runShareEdit's PATCH at the in-process Worker. */
function workerFetch(worker: any, env: any): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) =>
    worker.default.fetch(new Request(url as any, init), env)) as unknown as typeof fetch;
}

const OCTOCAT = { userId: 'octocat-uid', email: 'octocat@example.com' };
const OCTOCAT_SESSION = { access_token: 'phoenix-token', email: 'octocat@example.com', userId: 'octocat-uid' } as any;

describe('share visibility (metadata-edit PATCH route, in-process Worker)', () => {
  beforeEach(() => {
    delete process.env[SHARE_BACKEND_ENV];
  });
  afterEach(() => {
    delete process.env[SHARE_BACKEND_ENV];
  });

  it('flips public → me in place, preserving the slug/URL and the body — no revision', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    asPhoenix(worker, OCTOCAT);
    await putPage(worker, env, 'octocat/q3-plan', '<html><body><h1>Q3</h1></body></html>', 'public');
    const bodyBefore = store.get('octocat/q3-plan')!.body.toString('utf8');

    const result = await runShareEdit('q3-plan', {
      visibility: 'me',
      session: OCTOCAT_SESSION,
      fetchEdit: workerFetch(worker, env),
    });

    expect(result.url).toBe('https://share.agents-cli.sh/octocat/q3-plan');
    expect(result.visibility).toBe('me');
    expect(result.previousVisibility).toBe('public');

    const after = store.get('octocat/q3-plan')!;
    expect(after.customMetadata.visibility).toBe('me');
    expect(after.customMetadata.label).toBe('Q3 plan');
    expect(after.customMetadata.agent).toBe('claude');
    expect(after.body.toString('utf8')).toBe(bodyBefore);
    // Metadata-only change (like label/meta edit): no revision.
    expect([...store.keys()].filter((k) => k.includes('/rev-'))).toHaveLength(0);
  });

  it('clears org_domain when moving org → public', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    asPhoenix(worker, { userId: 'corp-uid', email: 'dev@corp.example' });
    await putPage(worker, env, 'dev/plan', '<html><body>x</body></html>', 'public');
    const corpSession = { access_token: 'phoenix-token', email: 'dev@corp.example', userId: 'corp-uid' } as any;

    await runShareEdit('dev/plan', { visibility: 'org', session: corpSession, fetchEdit: workerFetch(worker, env) });
    expect(store.get('dev/plan')!.customMetadata.org_domain).toBe('corp.example');

    await runShareEdit('dev/plan', { visibility: 'public', session: corpSession, fetchEdit: workerFetch(worker, env) });
    expect(store.get('dev/plan')!.customMetadata.visibility).toBe('public');
    expect(store.get('dev/plan')!.customMetadata.org_domain).toBeUndefined();
  });

  it('surfaces the server 400 plainly when org uses a public-inbox domain', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    asPhoenix(worker, { userId: 'gm-uid', email: 'someone@gmail.com' });
    await putPage(worker, env, 'someone/plan', '<html><body>x</body></html>', 'public');

    await expect(
      runShareEdit('someone/plan', {
        visibility: 'org',
        session: { access_token: 'phoenix-token', email: 'someone@gmail.com', userId: 'gm-uid' } as any,
        fetchEdit: workerFetch(worker, env),
      }),
    ).rejects.toThrow(/public email domain/);
  });

  it('refuses a non-owner Phoenix caller (handle-ownership guard) with 403', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    asPhoenix(worker, OCTOCAT);
    await putPage(worker, env, 'octocat/q3-plan', '<html><body>x</body></html>', 'public');

    // A different Phoenix identity must not be able to flip octocat's page.
    asPhoenix(worker, { userId: 'mallory-uid', email: 'mallory@example.com' });
    await expect(
      runShareEdit('octocat/q3-plan', {
        visibility: 'me',
        session: { access_token: 'phoenix-token', email: 'mallory@example.com', userId: 'mallory-uid' } as any,
        githubUser: 'octocat',
        fetchEdit: workerFetch(worker, env),
      }),
    ).rejects.toThrow(/403|forbidden|namespace mismatch/);
    // Unchanged.
    expect(store.get('octocat/q3-plan')!.customMetadata.visibility).toBe('public');
  });

  it('404s loudly when the target page does not exist', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    asPhoenix(worker, OCTOCAT);

    await expect(
      runShareEdit('octocat/missing', {
        visibility: 'unlisted',
        session: OCTOCAT_SESSION,
        fetchEdit: workerFetch(worker, env),
      }),
    ).rejects.toThrow(/\(404\)/);
  });

  it('rejects a me/org change when signed out with a clear login hint (no network call)', async () => {
    let called = false;
    const fetchEdit = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      runShareEdit('octocat/q3-plan', {
        visibility: 'me',
        session: null,
        writeToken: 'byo-token',
        config: { baseUrl: 'https://share.example.com', workerName: 'w', bucketName: 'b', accountId: 'a' } as any,
        fetchEdit,
      }),
    ).rejects.toThrow(/requires a Phoenix session.*agents auth login/);
    expect(called).toBe(false);
  });

  it('fails loud instead of silently no-op when the endpoint template predates visibility edits', async () => {
    // An old Worker ignores the visibility field and 200s without echoing it.
    const fetchEdit = (async () =>
      new Response(JSON.stringify({ ok: true, url: 'https://share.example.com/octocat/plan', label: null, meta: {} }), {
        status: 200,
      })) as unknown as typeof fetch;

    await expect(
      runShareEdit('octocat/plan', {
        visibility: 'unlisted',
        writeToken: 'byo-token',
        config: { baseUrl: 'https://share.example.com', workerName: 'w', bucketName: 'b', accountId: 'a' } as any,
        session: null,
        fetchEdit,
      }),
    ).rejects.toThrow(/doesn't support in-place visibility changes.*share update/);
  });
});
