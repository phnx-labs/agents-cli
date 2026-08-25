import { describe, expect, it } from 'vitest';
import { deleteObject, deleteShare, resolveDeleteTarget, type CheckFn, type DeleteFn, type RevisionsFetchFn } from './delete.js';
import { DEFAULT_SHARE_DOMAIN } from './config.js';

const CFG = {
  baseUrl: 'https://share.example',
  accountId: 'acct',
  workerName: 'worker',
  bucketName: 'bucket',
};

/** No revisions — every existing test that doesn't care about revision
 * purging passes this explicitly rather than relying on the real (network)
 * default failing fast against the fake `share.example` host. */
const NO_REVISIONS: RevisionsFetchFn = async () => ({ status: 404, contentType: '', body: '' });

/** An in-memory stand-in for the R2-backed Worker: idempotent DELETE (always
 * `ok:true`, even for a key that was never there), 404 for anything absent. */
function fakeStore(initialUrls: string[] = []) {
  const store = new Set(initialUrls);
  const deletedUrls: string[] = [];
  const checker: CheckFn = async (url) => ({ status: store.has(url) ? 200 : 404 });
  const deleter: DeleteFn = async (url) => {
    deletedUrls.push(url);
    store.delete(url); // idempotent — succeeds whether or not it was present
    return { ok: true, status: 200 };
  };
  return { store, deletedUrls, checker, deleter };
}

describe('resolveDeleteTarget', () => {
  it('parses a full share URL into its <user>/<slug> key', async () => {
    const r = await resolveDeleteTarget('https://share.agents-cli.sh/octocat/my-plan-a1b2');
    expect(r.key).toBe('octocat/my-plan-a1b2');
    expect(r.coverKey).toBe('octocat/my-plan-a1b2.png');
  });

  it('parses a bare <user>/<slug> the same way', async () => {
    const r = await resolveDeleteTarget('octocat/my-plan-a1b2');
    expect(r.key).toBe('octocat/my-plan-a1b2');
  });

  it('resolves a bare slug against the caller namespace, exactly like publish', async () => {
    const r = await resolveDeleteTarget('My Plan', { githubUser: 'Octocat' });
    // buildShareKey sanitizes both the username and the slug part the same way
    // publishToEndpoint does at publish time.
    expect(r.key).toBe('octocat/my-plan');
  });

  it('all three target forms resolve to the identical key for the same page', async () => {
    const fromUrl = await resolveDeleteTarget('https://share.example/octocat/my-plan');
    const fromPair = await resolveDeleteTarget('octocat/my-plan');
    const fromSlug = await resolveDeleteTarget('my-plan', { githubUser: 'octocat' });
    expect(fromUrl.key).toBe('octocat/my-plan');
    expect(fromPair.key).toBe('octocat/my-plan');
    expect(fromSlug.key).toBe('octocat/my-plan');
  });

  it('rejects a URL with fewer than <user>/<slug> segments', async () => {
    await expect(resolveDeleteTarget('https://share.example/octocat')).rejects.toThrow(/expected/i);
  });

  it('rejects a <user>/<slug> string with the wrong segment count', async () => {
    await expect(resolveDeleteTarget('octocat/a/b')).rejects.toThrow(/expected/i);
  });

  // Regression: sanitizeSlugPart (publish.ts) rewrites '.', so a cover can never be
  // reached by passing `--slug <slug>.png` — it would land at `<slug>-png`, not
  // `<slug>.png`. The cover key must be built by literal string concatenation on
  // the already-resolved key, never by round-tripping through buildShareKey.
  it('builds the cover key by literal concatenation, not by re-sanitizing through buildShareKey', async () => {
    const r = await resolveDeleteTarget('my-plan', { githubUser: 'octocat' });
    expect(r.coverKey).toBe('octocat/my-plan.png');
    expect(r.coverKey).not.toBe('octocat/my-plan-png');
  });
});

describe('deleteObject', () => {
  const endpoint = { baseUrl: 'https://share.example', token: 'secret' };

  it('reports existedBefore + verified404 on a clean delete', async () => {
    const { checker, deleter, deletedUrls } = fakeStore(['https://share.example/octocat/plan']);
    const r = await deleteObject(endpoint, 'octocat/plan', { checker, deleter });
    expect(r.existedBefore).toBe(true);
    expect(r.deleted).toBe(true);
    expect(r.verified404).toBe(true);
    expect(deletedUrls).toEqual(['https://share.example/octocat/plan']);
  });

  it('reports existedBefore:false for a key that was never there (idempotent delete)', async () => {
    const { checker, deleter } = fakeStore([]);
    const r = await deleteObject(endpoint, 'octocat/plan', { checker, deleter });
    expect(r.existedBefore).toBe(false);
    expect(r.deleted).toBe(true);
    expect(r.verified404).toBe(true);
  });

  it('surfaces verified404:false when the object still resolves after the DELETE — the postcondition check, not the ok:true response, decides success', async () => {
    const checker: CheckFn = async () => ({ status: 200 }); // never actually goes away
    const deleter: DeleteFn = async () => ({ ok: true, status: 200 });
    const r = await deleteObject(endpoint, 'octocat/plan', { checker, deleter });
    expect(r.deleted).toBe(true);
    expect(r.verified404).toBe(false);
  });

  it('throws when the Worker rejects the DELETE (e.g. bad token)', async () => {
    const checker: CheckFn = async () => ({ status: 200 });
    const deleter: DeleteFn = async () => ({ ok: false, status: 401 });
    await expect(deleteObject(endpoint, 'octocat/plan', { checker, deleter })).rejects.toThrow(/401/);
  });
});

describe('deleteShare', () => {
  it('deletes the page and its cover by default, verifying both 404', async () => {
    const { checker, deleter, deletedUrls } = fakeStore([
      'https://share.example/octocat/plan',
      'https://share.example/octocat/plan.png',
    ]);
    const r = await deleteShare('octocat/plan', { config: CFG, writeToken: 't', checker, deleter, fetchRevisions: NO_REVISIONS });
    expect(r.existedBefore).toBe(true);
    expect(r.verified404).toBe(true);
    expect(r.cover?.existedBefore).toBe(true);
    expect(r.cover?.verified404).toBe(true);
    expect(deletedUrls).toEqual([
      'https://share.example/octocat/plan',
      'https://share.example/octocat/plan.png',
    ]);
  });

  it('--keep-cover skips the cover entirely — it is never checked or deleted', async () => {
    const { checker, deleter, deletedUrls } = fakeStore([
      'https://share.example/octocat/plan',
      'https://share.example/octocat/plan.png',
    ]);
    const r = await deleteShare('octocat/plan', {
      config: CFG,
      writeToken: 't',
      keepCover: true,
      checker,
      deleter,
      fetchRevisions: NO_REVISIONS,
    });
    expect(r.cover).toBeUndefined();
    expect(deletedUrls).toEqual(['https://share.example/octocat/plan']);
  });

  it('a cover that was never published (no existedBefore) is not an error', async () => {
    const { checker, deleter } = fakeStore(['https://share.example/octocat/plan']); // no .png
    const r = await deleteShare('octocat/plan', { config: CFG, writeToken: 't', checker, deleter, fetchRevisions: NO_REVISIONS });
    expect(r.cover?.existedBefore).toBe(false);
    expect(r.cover?.verified404).toBe(true);
  });

  it('throws "nothing to delete" for an already-missing target by default', async () => {
    const { checker, deleter, deletedUrls } = fakeStore([]);
    await expect(deleteShare('octocat/gone', { config: CFG, writeToken: 't', checker, deleter })).rejects.toThrow(
      /nothing to delete/i,
    );
    // The DI delete is idempotent so this alone can't prove it, but a rejected
    // call should not report a cover or partial success either — deletedUrls
    // having been touched is fine (idempotent), what matters is the thrown error.
    expect(deletedUrls.length).toBeLessThanOrEqual(1);
  });

  it('--if-exists treats an already-missing target as a no-op success', async () => {
    const { checker, deleter } = fakeStore([]);
    const r = await deleteShare('octocat/gone', {
      config: CFG,
      writeToken: 't',
      ifExists: true,
      checker,
      deleter,
    });
    expect(r.skipped).toBe(true);
    expect(r.existedBefore).toBe(false);
  });

  it('throws when the page delete cannot be verified 404, even though the Worker returned ok', async () => {
    const checker: CheckFn = async () => ({ status: 200 }); // always resolves — a stuck delete
    const deleter: DeleteFn = async () => ({ ok: true, status: 200 });
    await expect(deleteShare('octocat/plan', { config: CFG, writeToken: 't', checker, deleter })).rejects.toThrow(
      /not verified/i,
    );
  });

  it('throws a cover-specific error when the page verifies gone but the cover does not', async () => {
    const store = new Map<string, boolean>([
      ['https://share.example/octocat/plan', true],
      ['https://share.example/octocat/plan.png', true],
    ]);
    const checker: CheckFn = async (url) => ({ status: store.get(url) ? 200 : 404 });
    const deleter: DeleteFn = async (url) => {
      // The page comes down for real; the cover "delete" is a no-op bug that
      // leaves the object resolvable — exactly the incident this ticket fixes.
      if (!url.endsWith('.png')) store.set(url, false);
      return { ok: true, status: 200 };
    };
    await expect(deleteShare('octocat/plan', { config: CFG, writeToken: 't', checker, deleter, fetchRevisions: NO_REVISIONS })).rejects.toThrow(
      /cover delete.*not verified/i,
    );
  });

  describe('revision purge (RUSH-2683 follow-up)', () => {
    function revisionsResponse(keys: string[]): RevisionsFetchFn {
      return async () => ({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ key: 'octocat/plan', count: keys.length, revisions: keys.map((key) => ({ key })) }),
      });
    }

    it('deletes retained revisions of the target by default, verifying each 404', async () => {
      const { checker, deleter, deletedUrls } = fakeStore([
        'https://share.example/octocat/plan',
        'https://share.example/octocat/plan/rev-1-aaa',
        'https://share.example/octocat/plan/rev-2-bbb',
      ]);
      const r = await deleteShare('octocat/plan', {
        config: CFG,
        writeToken: 't',
        keepCover: true,
        checker,
        deleter,
        fetchRevisions: revisionsResponse(['octocat/plan/rev-1-aaa', 'octocat/plan/rev-2-bbb']),
      });
      expect(r.revisions).toHaveLength(2);
      expect(r.revisions?.every((rev) => rev.existedBefore && rev.verified404)).toBe(true);
      expect(deletedUrls).toEqual([
        'https://share.example/octocat/plan',
        'https://share.example/octocat/plan/rev-1-aaa',
        'https://share.example/octocat/plan/rev-2-bbb',
      ]);
    });

    it('--keep-revisions never even fetches the revisions list', async () => {
      const { checker, deleter, deletedUrls } = fakeStore(['https://share.example/octocat/plan']);
      let fetched = false;
      const r = await deleteShare('octocat/plan', {
        config: CFG,
        writeToken: 't',
        keepCover: true,
        keepRevisions: true,
        checker,
        deleter,
        fetchRevisions: async () => {
          fetched = true;
          return { status: 200, contentType: 'application/json', body: '{"revisions":[]}' };
        },
      });
      expect(r.revisions).toBeUndefined();
      expect(fetched).toBe(false);
      expect(deletedUrls).toEqual(['https://share.example/octocat/plan']);
    });

    it('a target with no retained revisions omits `revisions` from the result entirely', async () => {
      const { checker, deleter } = fakeStore(['https://share.example/octocat/plan']);
      const r = await deleteShare('octocat/plan', {
        config: CFG, writeToken: 't', keepCover: true, checker, deleter, fetchRevisions: NO_REVISIONS,
      });
      expect(r.revisions).toBeUndefined();
    });

    it('a revisions-list fetch failure (old endpoint, network blip) never fails the primary delete', async () => {
      const { checker, deleter, deletedUrls } = fakeStore(['https://share.example/octocat/plan']);
      const r = await deleteShare('octocat/plan', {
        config: CFG,
        writeToken: 't',
        keepCover: true,
        checker,
        deleter,
        fetchRevisions: async () => { throw new Error('ECONNRESET'); },
      });
      expect(r.verified404).toBe(true);
      expect(r.revisions).toBeUndefined();
      expect(deletedUrls).toEqual(['https://share.example/octocat/plan']);
    });

    it('throws when a retained revision reports success but still resolves', async () => {
      const store = new Map<string, boolean>([
        ['https://share.example/octocat/plan', true],
        ['https://share.example/octocat/plan/rev-1-aaa', true],
      ]);
      const checker: CheckFn = async (url) => ({ status: store.get(url) ? 200 : 404 });
      const deleter: DeleteFn = async (url) => {
        // The page comes down for real; the revision "delete" is a no-op bug
        // that leaves the object resolvable.
        if (!url.includes('/rev-')) store.set(url, false);
        return { ok: true, status: 200 };
      };
      await expect(
        deleteShare('octocat/plan', {
          config: CFG,
          writeToken: 't',
          keepCover: true,
          checker,
          deleter,
          fetchRevisions: revisionsResponse(['octocat/plan/rev-1-aaa']),
        }),
      ).rejects.toThrow(/retained revision.*not verified/i);
    });
  });
});

describe('deleteShare managed backend (RUSH-3135)', () => {
  it('signed-in with no BYO config deletes against the managed endpoint namespace', async () => {
    const base = `https://${DEFAULT_SHARE_DOMAIN}`;
    const { checker, deleter, deletedUrls } = fakeStore([
      `${base}/alice/plan`,
      `${base}/alice/plan.png`,
    ]);
    const r = await deleteShare('plan', {
      session: { access_token: 'pid_alice', userId: 'alice', email: 'alice@example.com' },
      checker,
      deleter,
      fetchRevisions: NO_REVISIONS,
    });
    expect(r.key).toBe('alice/plan');
    expect(r.url).toBe(`${base}/alice/plan`);
    expect(r.existedBefore).toBe(true);
    expect(r.verified404).toBe(true);
    expect(deletedUrls[0]).toBe(`${base}/alice/plan`);
    expect(deletedUrls[1]).toBe(`${base}/alice/plan.png`);
  });
});
