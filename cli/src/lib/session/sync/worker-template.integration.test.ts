import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderSessionsWorkerScript } from './worker-template.js';

// The exact emitted module runs inside workerd against Miniflare's real R2
// implementation and calls a real local HTTP identity service. This covers the
// production route, bearer, ETag/CAS, cursor, and quota semantics without a Map
// bucket or a replaced authorization hook.

const USER_A = 'user-a';
const USER_B = 'user-b';
const MAX_BYTES = 5 * 1024 * 1024 * 1024;

describe('managed sessions Worker in real workerd', () => {
  let mf: Miniflare | undefined;
  let identity: Server | undefined;

  beforeEach(async () => {
    identity = createServer((request, response) => {
      if (request.url !== '/api/v1/auth/me') {
        response.writeHead(404).end();
        return;
      }
      const token = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const userId = token === 'token-a' ? USER_A : token === 'token-b' ? USER_B : null;
      if (!userId) {
        response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ userId, email: `${userId}@example.com` }));
    });
    await new Promise<void>((resolve, reject) => {
      identity!.once('error', reject);
      identity!.listen(0, '127.0.0.1', resolve);
    });
    const port = (identity.address() as AddressInfo).port;
    mf = new Miniflare({
      modules: [{ type: 'ESModule', path: 'worker.js', contents: renderSessionsWorkerScript() }],
      r2Buckets: ['BUCKET'],
      bindings: { PHOENIX_ID_BASE: `http://127.0.0.1:${port}` },
    });
    await mf.ready;
  });

  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
    await new Promise<void>(resolve => identity?.close(() => resolve()) ?? resolve());
    identity = undefined;
  });

  const url = (path: string) => `https://sessions.test/${path}`;
  const auth = (token = 'token-a') => ({ authorization: `Bearer ${token}` });
  // A well-formed ENCRYPTED bundle wire — NDJSON: a header line claiming
  // encryption + one record whose body is an AES-256-GCM transcript envelope
  // ({ v, alg, iv, ct, tag }). This is the exact shape the CLI uploads on the
  // managed path; the Worker requires it and rejects a plaintext PUT 422 so
  // readable transcript content can never land in the bucket (SES-51).
  const encBody = (marker: string) => {
    const env = JSON.stringify({ v: 1, alg: 'aes-256-gcm', iv: 'AAAAAAAAAAAAAAAA', ct: Buffer.from(marker).toString('base64'), tag: 'AAAAAAAAAAAAAAAAAAAAAA==' });
    const header = JSON.stringify({ encrypted: true, redacted: true, count: 1, sessions: 1 });
    const record = JSON.stringify({ encrypted: true, body: env });
    return `${header}\n${record}\n`;
  };

  it('PUT / GET / LIST / DELETE round-trips in the verified owner namespace', async () => {
    const keyA = `${USER_A}/sessions/mac/claude/s1.jsonl`;
    const keyB = `${USER_A}/sessions/mac/codex/s2.jsonl`;
    const bodyA = encBody('s1');
    const put = await mf!.dispatchFetch(url(keyA), {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: bodyA,
    });
    expect(put.status).toBe(200);

    const get = await mf!.dispatchFetch(url(keyA), { headers: auth() });
    expect(get.status).toBe(200);
    expect(await get.text()).toBe(bodyA);
    expect(get.headers.get('cache-control')).toBe('private, no-store');

    await mf!.dispatchFetch(url(keyB), { method: 'PUT', headers: auth(), body: encBody('s2') });
    const list = await mf!.dispatchFetch(url(`${USER_A}/?list`), { headers: auth() });
    expect(list.status).toBe(200);
    expect((await list.json() as { keys: string[] }).keys).toEqual([
      'sessions/mac/claude/s1.jsonl',
      'sessions/mac/codex/s2.jsonl',
    ]);

    expect((await mf!.dispatchFetch(url(keyA), { method: 'DELETE', headers: auth() })).status).toBe(200);
    expect((await mf!.dispatchFetch(url(keyA), { headers: auth() })).status).toBe(404);
  });

  it('rejects a plaintext (non-envelope) body with 422', async () => {
    const key = `${USER_A}/sessions/mac/claude/plain.jsonl`;
    // Plaintext JSON that is NOT an encryption envelope, and a raw byte string.
    for (const body of ['{"env":"v1"}', 'x']) {
      const put = await mf!.dispatchFetch(url(key), { method: 'PUT', headers: auth(), body });
      expect(put.status).toBe(422);
    }
    // Nothing was stored: the store stays empty for this owner.
    const list = await mf!.dispatchFetch(url(`${USER_A}/?list`), { headers: auth() });
    expect((await list.json() as { keys: string[] }).keys).toEqual([]);
  });

  it('has no public object/list GET and rejects a verified wrong owner', async () => {
    const key = `${USER_A}/sessions/mac/claude/s1.jsonl`;
    expect((await mf!.dispatchFetch(url(''))).status).toBe(401);
    expect((await mf!.dispatchFetch(url(key))).status).toBe(401);
    expect((await mf!.dispatchFetch(url(`${USER_A}/?list`))).status).toBe(401);
    expect((await mf!.dispatchFetch(url(key), { headers: auth('token-b') })).status).toBe(403);
    // A wrong-owner write is rejected on ownership (403) before the body is read.
    expect((await mf!.dispatchFetch(url(key), {
      method: 'PUT', headers: auth('token-b'), body: encBody('x'),
    })).status).toBe(403);
  });

  it('keeps __key/__usage out of LIST and makes the backup DEK immutable', async () => {
    const escrow = `${USER_A}/__key/backup-dek`;
    const first = await mf!.dispatchFetch(url(escrow), {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json', 'if-none-match': '*' },
      body: '{"v":1,"userId":"user-a","dek":"first"}',
    });
    expect(first.status).toBe(200);
    const overwrite = await mf!.dispatchFetch(url(escrow), {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json', 'if-none-match': '*' },
      body: '{"v":1,"userId":"user-a","dek":"second"}',
    });
    expect(overwrite.status).toBe(409);
    expect((await mf!.dispatchFetch(url(escrow), {
      method: 'DELETE', headers: auth(),
    })).status).toBe(403);
    expect((await mf!.dispatchFetch(url(`${USER_A}/__key/unbounded`), {
      method: 'PUT', headers: auth(), body: 'hidden payload',
    })).status).toBe(403);
    expect(await (await mf!.dispatchFetch(url(escrow), { headers: auth() })).text()).toContain('"dek":"first"');

    const bucket = await mf!.getR2Bucket('BUCKET');
    await bucket.put(`${USER_A}/__usage/decoy`, '{}');
    await mf!.dispatchFetch(url(`${USER_A}/sessions/mac/claude/s1.jsonl`), {
      method: 'PUT', headers: auth(), body: encBody('s1'),
    });
    const listed = await mf!.dispatchFetch(url(`${USER_A}/?list`), { headers: auth() });
    expect((await listed.json() as { keys: string[] }).keys).toEqual(['sessions/mac/claude/s1.jsonl']);
  });

  it('returns 413 over the real quota ledger and refunds bytes/count on DELETE', async () => {
    const key = `${USER_A}/sessions/mac/claude/a.jsonl`;
    const body = encBody('a');
    const charged = Buffer.byteLength(body);
    expect((await mf!.dispatchFetch(url(key), { method: 'PUT', headers: auth(), body })).status).toBe(200);

    const bucket = await mf!.getR2Bucket('BUCKET');
    expect(JSON.parse(await (await bucket.get(`__usage/${USER_A}`))!.text())).toEqual({ bytes: charged, count: 1 });
    expect((await mf!.dispatchFetch(url(key), { method: 'DELETE', headers: auth() })).status).toBe(200);
    // DELETE refunds the object's bytes/count via a delta CAS applied before the
    // object is removed.
    expect(JSON.parse(await (await bucket.get(`__usage/${USER_A}`))!.text())).toEqual({ bytes: 0, count: 0 });

    await bucket.put(`__usage/${USER_A}`, JSON.stringify({ bytes: MAX_BYTES, count: 0 }));
    const over = await mf!.dispatchFetch(url(`${USER_A}/sessions/mac/claude/over.jsonl`), {
      method: 'PUT', headers: auth(), body: encBody('over'),
    });
    expect(over.status).toBe(413);
    expect(await over.json()).toMatchObject({ error: 'storage limit reached', maxBytes: MAX_BYTES });
  });

  it('refunds only once when the same key is DELETEd again sequentially', async () => {
    const k1 = `${USER_A}/sessions/mac/claude/x1.jsonl`;
    const k2 = `${USER_A}/sessions/mac/claude/x2.jsonl`;
    const b1 = encBody('x1');
    const b2 = encBody('x2');
    await mf!.dispatchFetch(url(k1), { method: 'PUT', headers: auth(), body: b1 });
    await mf!.dispatchFetch(url(k2), { method: 'PUT', headers: auth(), body: b2 });

    const bucket = await mf!.getR2Bucket('BUCKET');
    expect(JSON.parse(await (await bucket.get(`__usage/${USER_A}`))!.text()))
      .toEqual({ bytes: Buffer.byteLength(b1) + Buffer.byteLength(b2), count: 2 });

    // Delete k1, then delete it again: the second DELETE finds no object
    // (head → null) so it refunds nothing, leaving the ledger at the true
    // remaining object (k2). Refund is applied before the object is removed.
    expect((await mf!.dispatchFetch(url(k1), { method: 'DELETE', headers: auth() })).status).toBe(200);
    expect((await mf!.dispatchFetch(url(k1), { method: 'DELETE', headers: auth() })).status).toBe(200);
    expect(JSON.parse(await (await bucket.get(`__usage/${USER_A}`))!.text()))
      .toEqual({ bytes: Buffer.byteLength(b2), count: 1 });
  });
});
