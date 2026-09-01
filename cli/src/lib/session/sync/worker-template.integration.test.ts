import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHeader, serializeBundle, type BundleRecord } from '../bundle.js';
import { encryptTranscript } from './transcript-crypto.js';
import { renderSessionsWorkerScript } from './worker-template.js';

// The exact emitted module runs inside workerd against Miniflare's real R2
// implementation and calls a real local HTTP identity service. This covers the
// production route, bearer, ETag/CAS, cursor, and quota semantics without a Map
// bucket or a replaced authorization hook.

const USER_A = 'user-a';
const USER_B = 'user-b';
const MAX_BYTES = 5 * 1024 * 1024 * 1024;
const TEST_DEK = Buffer.alloc(32, 7);

function encryptedBundle(sessionId: string, plaintext = '{"role":"user","content":"hello"}\n'): string {
  const record: BundleRecord = {
    agent: 'claude',
    machine: 'mac',
    sessionId,
    relKey: `${sessionId}.jsonl`,
    size: Buffer.byteLength(plaintext),
    hash: 'test-hash',
    encrypted: true,
    body: encryptTranscript(plaintext, TEST_DEK),
  };
  const header = makeHeader({
    origin: 'mac',
    exportedAt: new Date(0).toISOString(),
    encrypted: true,
    redacted: true,
    records: [record],
  });
  return serializeBundle(header, [record]);
}

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
      bindings: {
        PHOENIX_ID_BASE: `http://127.0.0.1:${port}`,
        WRITE_TOKEN: 'operator-secret',
        SESSIONS_NAMESPACE: 'operator',
      },
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

  it('PUT / GET / LIST / DELETE round-trips in the verified owner namespace', async () => {
    const keyA = `${USER_A}/sessions/mac/claude/s1.jsonl`;
    const keyB = `${USER_A}/sessions/mac/codex/s2.jsonl`;
    const bodyA = encryptedBundle('s1');
    const bodyB = encryptedBundle('s2', '{"role":"assistant","content":"world"}\n');
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

    await mf!.dispatchFetch(url(keyB), { method: 'PUT', headers: auth(), body: bodyB });
    const list = await mf!.dispatchFetch(url(`${USER_A}/?list`), { headers: auth() });
    expect(list.status).toBe(200);
    expect((await list.json() as { keys: string[] }).keys).toEqual([
      'sessions/mac/claude/s1.jsonl',
      'sessions/mac/codex/s2.jsonl',
    ]);

    expect((await mf!.dispatchFetch(url(keyA), { method: 'DELETE', headers: auth() })).status).toBe(200);
    expect((await mf!.dispatchFetch(url(keyA), { headers: auth() })).status).toBe(404);
  });

  it('has no public object/list GET and rejects a verified wrong owner', async () => {
    const key = `${USER_A}/sessions/mac/claude/s1.jsonl`;
    expect((await mf!.dispatchFetch(url(''))).status).toBe(401);
    expect((await mf!.dispatchFetch(url(key))).status).toBe(401);
    expect((await mf!.dispatchFetch(url(`${USER_A}/?list`))).status).toBe(401);
    expect((await mf!.dispatchFetch(url(key), { headers: auth('token-b') })).status).toBe(403);
    expect((await mf!.dispatchFetch(url(key), {
      method: 'PUT', headers: auth('token-b'), body: encryptedBundle('s1'),
    })).status).toBe(403);
  });

  it('rejects plaintext and malformed-envelope PUTs on the Phoenix-managed path', async () => {
    const key = `${USER_A}/sessions/mac/claude/plain.jsonl`;
    expect((await mf!.dispatchFetch(url(key), {
      method: 'PUT', headers: auth(), body: '{"role":"user","content":"plaintext"}\n',
    })).status).toBe(400);

    const fake: BundleRecord = {
      agent: 'claude', machine: 'mac', sessionId: 'plain', relKey: 'plain.jsonl',
      size: 9, hash: 'h', encrypted: true, body: 'plaintext',
    };
    const fakeHeader = makeHeader({
      origin: 'mac', exportedAt: new Date(0).toISOString(), encrypted: true,
      redacted: true, records: [fake],
    });
    expect((await mf!.dispatchFetch(url(key), {
      method: 'PUT', headers: auth(), body: serializeBundle(fakeHeader, [fake]),
    })).status).toBe(400);
  });

  it('confines the optional static token to its self-hosted namespace', async () => {
    const operatorAuth = { authorization: 'Bearer operator-secret' };
    const operatorKey = 'operator/sessions/mac/claude/operator.jsonl';
    expect((await mf!.dispatchFetch(url(operatorKey), {
      method: 'PUT', headers: operatorAuth, body: 'self-hosted opaque payload',
    })).status).toBe(200);
    expect((await mf!.dispatchFetch(url(operatorKey), { headers: operatorAuth })).status).toBe(200);
    expect((await mf!.dispatchFetch(url(`${USER_A}/sessions/mac/claude/s1.jsonl`), {
      method: 'PUT', headers: operatorAuth, body: encryptedBundle('s1'),
    })).status).toBe(403);
    expect((await mf!.dispatchFetch(url(`${USER_A}/sessions/mac/claude/s1.jsonl`), {
      headers: operatorAuth,
    })).status).toBe(401);
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
      method: 'PUT', headers: auth(), body: encryptedBundle('s1'),
    });
    const listed = await mf!.dispatchFetch(url(`${USER_A}/?list`), { headers: auth() });
    expect((await listed.json() as { keys: string[] }).keys).toEqual(['sessions/mac/claude/s1.jsonl']);
  });

  it('returns 413 over the real quota ledger and refunds bytes/count on DELETE', async () => {
    const key = `${USER_A}/sessions/mac/claude/a.jsonl`;
    const body = encryptedBundle('a');
    expect((await mf!.dispatchFetch(url(key), { method: 'PUT', headers: auth(), body })).status).toBe(200);

    const bucket = await mf!.getR2Bucket('BUCKET');
    expect(JSON.parse(await (await bucket.get(`__usage/${USER_A}`))!.text())).toEqual({
      bytes: Buffer.byteLength(body), count: 1,
    });
    expect((await mf!.dispatchFetch(url(key), { method: 'DELETE', headers: auth() })).status).toBe(200);
    expect(JSON.parse(await (await bucket.get(`__usage/${USER_A}`))!.text())).toEqual({ bytes: 0, count: 0 });

    await bucket.put(`__usage/${USER_A}`, JSON.stringify({ bytes: MAX_BYTES, count: 0 }));
    const over = await mf!.dispatchFetch(url(`${USER_A}/sessions/mac/claude/over.jsonl`), {
      method: 'PUT', headers: auth(), body: encryptedBundle('over'),
    });
    expect(over.status).toBe(413);
    expect(await over.json()).toMatchObject({ error: 'storage limit reached', maxBytes: MAX_BYTES });
  });

  it('serializes concurrent DELETEs so one object is refunded exactly once', async () => {
    const keyA = `${USER_A}/sessions/mac/claude/concurrent.jsonl`;
    const keyB = `${USER_A}/sessions/mac/claude/keeper.jsonl`;
    const bodyA = encryptedBundle('concurrent');
    const bodyB = encryptedBundle('keeper');
    expect((await mf!.dispatchFetch(url(keyA), { method: 'PUT', headers: auth(), body: bodyA })).status).toBe(200);
    expect((await mf!.dispatchFetch(url(keyB), { method: 'PUT', headers: auth(), body: bodyB })).status).toBe(200);

    const deletes = await Promise.all(Array.from({ length: 8 }, () =>
      mf!.dispatchFetch(url(keyA), { method: 'DELETE', headers: auth() })));
    expect(deletes.some(response => response.status === 200)).toBe(true);
    expect(deletes.every(response => response.status === 200 || response.status === 409)).toBe(true);

    const bucket = await mf!.getR2Bucket('BUCKET');
    expect(JSON.parse(await (await bucket.get(`__usage/${USER_A}`))!.text())).toEqual({
      bytes: Buffer.byteLength(bodyB), count: 1,
    });
    expect(await bucket.head(keyA)).toBeNull();
    expect(await bucket.head(keyB)).not.toBeNull();
  });
});
