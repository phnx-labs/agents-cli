import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Miniflare, type R2Bucket } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import { renderWorkerScript } from './worker-template.js';
import { toHeaderValue, toPercentHeaderValue } from './publish.js';

// PHNX-3278 review blocker #4: worker-template.test.ts drives the real route
// logic but against an in-memory Map standing in for R2 — a Map has no
// concept of ETags or write preconditions, so it cannot exercise (or catch a
// regression in) the PATCH handler's conditional put. This file runs the
// exact same Worker source against Miniflare's R2 implementation, which is
// the real Cloudflare Workers runtime (workerd) with real R2 semantics —
// no mocking of the thing under test. It caught a real bug on first run:
// the PATCH handler was passing the QUOTED `httpEtag` to `onlyIf.etagMatches`,
// which a real R2 binding rejects with a 500 ("Conditional ETag should not
// be wrapped in quotes") — every edit would have 500'd in production. A Map
// fake, which just compares whatever string it's given, could never surface
// that; only a real R2 backend enforces the actual wire contract.

interface R2GetLike {
  body: unknown;
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
  uploaded: Date;
  etag: string;
  httpEtag: string;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Load the emitted Worker source as a real ES module (a data: URI is past bun's NameTooLong limit). */
async function loadWorker() {
  const src = renderWorkerScript();
  const dir = mkdtempSync(join(tmpdir(), 'share-worker-int-'));
  const file = join(dir, `worker-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, src);
  return import(pathToFileURL(file).href);
}

/**
 * Calling the Worker's exported `fetch` directly from Node (rather than
 * through `Miniflare#dispatchFetch`) crosses realms: the module runs in
 * Node's realm using Node's native Headers/Request, while `mf.getR2Bucket()`
 * is an RPC proxy into workerd's separate isolate. Passing a Node `Headers`
 * into a proxied `R2Object#writeHttpMetadata()` fails devalue serialization,
 * and handing a Node ReadableStream straight to a real `put()` fails R2's
 * "known length" check. This wrapper re-shapes get/put at the boundary only
 * — plain data in, plain data out — so the REAL bucket still makes every
 * accept/reject decision (etag matching, precondition failure); nothing
 * about the R2 write contract is reimplemented here.
 */
function wrapBucketForDirectFetch(bucket: R2Bucket, opts: { onFirstGet?: (key: string, obj: R2GetLike) => Promise<void> } = {}) {
  let getCalls = 0;
  return {
    head: bucket.head.bind(bucket),
    delete: bucket.delete.bind(bucket),
    list: bucket.list.bind(bucket),
    get: async (key: string) => {
      const obj = (await bucket.get(key)) as unknown as R2GetLike | null;
      if (!obj) return null;
      getCalls += 1;
      if (getCalls === 1 && opts.onFirstGet) await opts.onFirstGet(key, obj);
      return {
        // Lazy: eagerly reading `obj.body` here locks the single-use R2 stream, so
        // a later obj.text() (the HTML GET-render path) throws "Body already used".
        // Non-HTML responses read `.body`; HTML reads `.text()` — never both.
        get body() {
          return obj.body;
        },
        customMetadata: obj.customMetadata,
        uploaded: obj.uploaded,
        etag: obj.etag,
        httpEtag: obj.httpEtag,
        text: () => obj.text(),
        arrayBuffer: () => obj.arrayBuffer(),
        writeHttpMetadata(headers: Headers) {
          if (obj.httpMetadata?.contentType) headers.set('content-type', obj.httpMetadata.contentType);
        },
      };
    },
    put: async (
      key: string,
      body: BodyInit | null,
      opts2?: { httpMetadata?: Headers | { contentType?: string }; customMetadata?: Record<string, string>; onlyIf?: { etagMatches?: string } },
    ) => {
      const value = body && typeof (body as ReadableStream).getReader === 'function'
        ? await new Response(body as BodyInit).arrayBuffer()
        : body;
      const httpMetadata = opts2?.httpMetadata instanceof Headers
        ? { contentType: opts2.httpMetadata.get('content-type') ?? undefined }
        : opts2?.httpMetadata;
      return bucket.put(key, value as ArrayBuffer | string, { ...opts2, httpMetadata });
    },
  };
}

describe('worker PATCH route against real R2 (miniflare, PHNX-3278 blocker #4)', () => {
  let mf: Miniflare | undefined;

  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
  });

  async function setup() {
    mf = new Miniflare({
      modules: true,
      // A no-op script — this instance is only used for its real R2Bucket
      // binding; the Worker under test is invoked directly (see loadWorker).
      script: 'export default { fetch() { return new Response("noop"); } };',
      r2Buckets: ['BUCKET'],
    });
    const realBucket = await mf.getR2Bucket('BUCKET');
    const worker = await loadWorker();
    return { realBucket, worker };
  }

  it('PATCH rewrites metadata and preserves the exact body over a real R2 round trip', async () => {
    const { realBucket, worker } = await setup();
    const env = { WRITE_TOKEN: 'secret', BUCKET: wrapBucketForDirectFetch(realBucket) };

    const putRes = await worker.default.fetch(new Request('https://share.test/octocat/plan', {
      method: 'PUT',
      headers: { authorization: 'Bearer secret', 'content-type': 'text/html; charset=utf-8' },
      body: 'exact-body',
    }), env);
    expect(putRes.status).toBe(200);

    const patchRes = await worker.default.fetch(new Request('https://share.test/octocat/plan', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Renamed', meta: { status: 'final' } }),
    }), env);
    expect(patchRes.status).toBe(200);
    expect(await patchRes.json()).toMatchObject({ ok: true, label: 'Renamed', meta: { status: 'final' } });

    const final = await realBucket.get('octocat/plan');
    expect(final).not.toBeNull();
    expect(await final!.text()).toBe('exact-body');
    expect(final!.httpMetadata.contentType).toBe('text/html; charset=utf-8');
    expect(final!.customMetadata).toMatchObject({ label: 'Renamed', 'label-source': 'explicit', status: 'final' });
  });

  it('PATCH returns a real 409 (not a silent overwrite) when a concurrent PUT republishes first', async () => {
    const { realBucket, worker } = await setup();
    const setupEnv = { WRITE_TOKEN: 'secret', BUCKET: wrapBucketForDirectFetch(realBucket) };

    const putRes = await worker.default.fetch(new Request('https://share.test/octocat/plan', {
      method: 'PUT',
      headers: { authorization: 'Bearer secret', 'content-type': 'text/html; charset=utf-8' },
      body: 'v1-body',
    }), setupEnv);
    expect(putRes.status).toBe(200);

    // Race the PATCH's own internal GET: land a genuine concurrent republish
    // (a real write via the real binding) between PATCH's read and its write.
    const racedEnv = {
      WRITE_TOKEN: 'secret',
      BUCKET: wrapBucketForDirectFetch(realBucket, {
        onFirstGet: async (key, obj) => {
          await realBucket.put(key, 'v2-race-body', { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata });
        },
      }),
    };
    const patchRes = await worker.default.fetch(new Request('https://share.test/octocat/plan', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ meta: { status: 'final' } }),
    }), racedEnv);

    // The real R2 binding rejects the stale conditional put; the handler
    // MUST surface that as a loud conflict, not a 200 that rolled v2 back.
    expect(patchRes.status).toBe(409);
    expect(await patchRes.json()).toMatchObject({ error: 'conflict' });

    const final = await realBucket.get('octocat/plan');
    expect(await final!.text()).toBe('v2-race-body');
  });

  it('decodes the full-Unicode companion headers into stored metadata (PHNX-2786)', async () => {
    const { realBucket, worker } = await setup();
    const env = { WRITE_TOKEN: 'secret', BUCKET: wrapBucketForDirectFetch(realBucket) };

    const label = '会話の記録 🚀'; // all-CJK + emoji: the fold degrades this to (unnamed)
    const meta = { mood: 'shipped 🚀', title: '会話' }; // full-Unicode --meta VALUES
    // Build the PUT headers exactly as publish.ts's authHeaders does: latin1 floor
    // + percent companion + the opt-in flag. This is the real CLI wire format.
    const headers: Record<string, string> = {
      authorization: 'Bearer secret',
      'content-type': 'text/html; charset=utf-8',
      'x-share-label': toHeaderValue(label),
      'x-share-label-u': toPercentHeaderValue(label),
      'x-share-meta': JSON.stringify(Object.fromEntries(Object.entries(meta).map(([k, v]) => [toHeaderValue(k), toHeaderValue(v)]))),
      'x-share-meta-u': encodeURIComponent(JSON.stringify(meta)),
      'x-share-encoding': 'percent',
    };
    // The floor is genuinely lossy for this input — proving the companion is what carries it.
    expect(headers['x-share-label']).toBe('(unnamed)');

    const putRes = await worker.default.fetch(new Request('https://share.test/octocat/jp', {
      method: 'PUT',
      headers,
      body: 'exact-body',
    }), env);
    expect(putRes.status).toBe(200);

    const stored = await realBucket.get('octocat/jp');
    expect(stored).not.toBeNull();
    expect(await stored!.text()).toBe('exact-body');
    // The Worker preferred the decoded companions over the folded floor.
    expect(stored!.customMetadata!.label).toBe('会話の記録 🚀');
    expect(stored!.customMetadata!.mood).toBe('shipped 🚀');
    expect(stored!.customMetadata!.title).toBe('会話');
  });

  it('mints a self-signed login ticket that becomes the __share cookie and unlocks the owner control (PHNX-3370)', async () => {
    const { realBucket, worker } = await setup();
    const env = { WRITE_TOKEN: 'secret', BUCKET: wrapBucketForDirectFetch(realBucket) };
    // The CLI authenticates the mint with the owner's Phoenix bearer, which the
    // Worker verifies via hooks.verifyPhoenixToken (stubbed here instead of a live
    // /auth/me call — the identity resolution is not what this test exercises).
    worker.hooks.verifyPhoenixToken = async (req) => (/^Bearer phoenix-bearer/i.test(req.headers.get('authorization') || '') ? { userId: 'u-octocat', email: 'octocat@example.com' } : null);

    // Publish a page in octocat's namespace (WRITE_TOKEN owner-write).
    const put = await worker.default.fetch(new Request('https://share.test/octocat/plan', {
      method: 'PUT',
      headers: { authorization: 'Bearer secret', 'content-type': 'text/html; charset=utf-8' },
      body: '<html><head><title>Plan</title></head><body>ok</body></html>',
    }), env);
    expect(put.status).toBe(200);

    // Anonymous GET: the visibility chip is a STATIC cue (no owner control).
    const anon = await worker.default.fetch(new Request('https://share.test/octocat/plan'), env);
    const anonHtml = await anon.text();
    expect(anonHtml).toContain('agents-share-bar');
    expect(anonHtml).not.toContain('ash-chip-own');

    // CLI mint: POST /__ticket with the owner's bearer (anything != WRITE_TOKEN, so
    // the Phoenix path runs) returns a self-signed ticket.
    const mint = await worker.default.fetch(new Request('https://share.test/__ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer phoenix-bearer-xyz' },
    }), env);
    expect(mint.status).toBe(200);
    const ticket = (await mint.json() as { ticket: string }).ticket;
    expect(typeof ticket).toBe('string');
    expect(ticket.length).toBeGreaterThan(0);

    // Opening the page WITH the ticket 302s and sets the __share identity cookie,
    // stripping the ticket from the redirect target.
    const redeem = await worker.default.fetch(new Request('https://share.test/octocat/plan?phoenix_ticket=' + encodeURIComponent(ticket)), env);
    expect(redeem.status).toBe(302);
    expect(redeem.headers.get('location')).toBe('https://share.test/octocat/plan');
    const setCookie = redeem.headers.get('set-cookie') || '';
    expect(setCookie).toContain('__Host-phoenix_share=');
    const cookie = setCookie.split(';')[0]; // "__Host-phoenix_share=<value>"

    // GET carrying that cookie: the viewer is the owner, so the chip is now the
    // interactive control (ash-chip-own + data-ash-chip).
    const owner = await worker.default.fetch(new Request('https://share.test/octocat/plan', {
      headers: { cookie },
    }), env);
    const ownerHtml = await owner.text();
    expect(ownerHtml).toContain('ash-chip-own');
    expect(ownerHtml).toContain('data-ash-chip');
  });

  it('redeems a login ticket only ONCE — a replay within its TTL is spent (PHNX-3370)', async () => {
    const { realBucket, worker } = await setup();
    const env = { WRITE_TOKEN: 'secret', BUCKET: wrapBucketForDirectFetch(realBucket) };
    worker.hooks.verifyPhoenixToken = async (req: Request) => (/^Bearer phoenix-bearer/i.test(req.headers.get('authorization') || '') ? { userId: 'u-octocat', email: 'octocat@example.com' } : null);
    await worker.default.fetch(new Request('https://share.test/octocat/plan', {
      method: 'PUT',
      headers: { authorization: 'Bearer secret', 'content-type': 'text/html; charset=utf-8' },
      body: '<html><head><title>Plan</title></head><body>ok</body></html>',
    }), env);
    const mint = await worker.default.fetch(new Request('https://share.test/__ticket', {
      method: 'POST', headers: { authorization: 'Bearer phoenix-bearer-xyz' },
    }), env);
    const ticket = (await mint.json() as { ticket: string }).ticket;
    const u = 'https://share.test/octocat/plan?phoenix_ticket=' + encodeURIComponent(ticket);

    // First redemption: 302 + cookie.
    const first = await worker.default.fetch(new Request(u), env);
    expect(first.status).toBe(302);
    expect(first.headers.get('set-cookie') || '').toContain('__Host-phoenix_share=');

    // Second redemption of the SAME ticket: spent — no cookie, no owner control.
    const second = await worker.default.fetch(new Request(u), env);
    expect(second.status).toBe(200);
    expect(second.headers.get('set-cookie')).toBeNull();
    expect(await second.text()).not.toContain('ash-chip-own');
  });

  it('rejects a tampered login ticket rather than trusting it (PHNX-3370)', async () => {
    const { realBucket, worker } = await setup();
    const env = { WRITE_TOKEN: 'secret', BUCKET: wrapBucketForDirectFetch(realBucket) };
    worker.hooks.verifyPhoenixToken = async (req) => (/^Bearer phoenix-bearer/i.test(req.headers.get('authorization') || '') ? { userId: 'u-octocat', email: 'octocat@example.com' } : null);
    await worker.default.fetch(new Request('https://share.test/octocat/plan', {
      method: 'PUT',
      headers: { authorization: 'Bearer secret', 'content-type': 'text/html; charset=utf-8' },
      body: '<html><head><title>Plan</title></head><body>ok</body></html>',
    }), env);
    const mint = await worker.default.fetch(new Request('https://share.test/__ticket', {
      method: 'POST', headers: { authorization: 'Bearer phoenix-bearer-xyz' },
    }), env);
    const ticket = (await mint.json() as { ticket: string }).ticket;
    // Flip the signature: verifySelfTicket must reject it (no cookie, no redirect).
    const tampered = ticket.slice(0, -1) + (ticket.endsWith('a') ? 'b' : 'a');
    const res = await worker.default.fetch(new Request('https://share.test/octocat/plan?phoenix_ticket=' + encodeURIComponent(tampered)), env);
    // A public page serves anonymously on a bad ticket (never 302/owner) — the
    // forged ticket grants nothing.
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).not.toContain('ash-chip-own');
  });

  it('a real R2 onlyIf.etagMatches wants the bare etag, not the quoted httpEtag (regression guard)', async () => {
    const { realBucket } = await setup();
    await realBucket.put('k', 'v1');
    const head = await realBucket.head('k');

    // The quoted HTTP form must be rejected as malformed by the real binding
    // — this is the exact shape the PATCH handler must never pass again.
    await expect(realBucket.put('k', 'v2', { onlyIf: { etagMatches: head!.httpEtag } })).rejects.toThrow(/quotes/i);

    // The bare hash is what a real conditional put expects.
    const ok = await realBucket.put('k', 'v3', { onlyIf: { etagMatches: head!.etag } });
    expect(ok).not.toBeNull();
  });
});
