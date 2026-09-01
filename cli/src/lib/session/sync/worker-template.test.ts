import { describe, expect, it } from 'vitest';
import { renderSessionsWorkerScript } from './worker-template.js';

// Pure deployment-artifact checks live here; real route, auth, quota, and R2
// behavior run in worker-template.integration.test.ts under workerd.

describe('renderSessionsWorkerScript', () => {
  const source = renderSessionsWorkerScript();

  it('emits the complete private blob-store route surface', () => {
    expect(source).toContain("request.method === 'PUT'");
    expect(source).toContain("request.method === 'GET' || request.method === 'HEAD'");
    expect(source).toContain("request.method === 'DELETE'");
    expect(source).toContain("url.searchParams.has('list')");
    expect(source).toContain('env.BUCKET.list(');
  });

  it('verifies Phoenix bearers through the canonical identity route', () => {
    expect(source).toContain("base + '/api/v1/auth/me'");
    expect(source).toContain("headers: { Authorization: 'Bearer ' + presented }");
    expect(source).toContain("ownerId !== claims.userId");
  });

  it('keeps opaque encrypted objects out of the traces aggregate path', () => {
    expect(source).not.toContain('mergeIndexShards');
    expect(source).not.toContain("segments[1] === 'all'");
  });

  it('ships immutable DEK escrow and CAS quota enforcement in the artifact', () => {
    expect(source).toContain("rel === '__key/backup-dek'");
    expect(source).toContain("onlyIf: { etagDoesNotMatch: '*' }");
    expect(source).toContain("function usageKey(owner) { return '__usage/' + owner; }");
    expect(source).toContain('onlyIf = { etagMatches: prevEtag }');
    expect(source).toContain("reject: json({ error: 'storage limit reached'");
    expect(source).toContain('if (!refunded) return json({ error: \'usage refund contended; retry or reconcile\' }, 503)');
    expect(source).toContain('if (!state.etag) return true');
    expect(source).toContain('return false;');
    expect(source).toContain("const key = '__delete/' + owner + '/' + hex");
    expect(source).toContain('auth.kind === \'phoenix\' ? await acquireDeleteClaim(env, owner, path) : null');
  });

  it('rejects non-envelope bodies at the managed Worker boundary', () => {
    expect(source).toContain("!rel.startsWith('sessions/') || !isEncryptedSessionBundle(body)");
    expect(source).toContain("header.kind !== 'agents-session-bundle'");
    expect(source).toContain("value.alg === 'aes-256-gcm'");
  });
});
