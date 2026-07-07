import { expect, test, describe } from 'bun:test';
import { inferProjectCandidates, repoSlugFromPath } from './projectIndex';

describe('repoSlugFromPath', () => {
  test('derives owner/repo from a convention path', () => {
    expect(repoSlugFromPath('/Users/x/src/github.com/acme/widget')).toBe('acme/widget');
  });

  test('returns undefined for a single-segment path', () => {
    expect(repoSlugFromPath('/only')).toBeUndefined();
  });
});

describe('inferProjectCandidates', () => {
  test('never throws and returns a well-formed sorted array', async () => {
    const candidates = await inferProjectCandidates();
    expect(Array.isArray(candidates)).toBe(true);
    for (const c of candidates) {
      expect(typeof c.path).toBe('string');
      expect(c.path.length).toBeGreaterThan(0);
      expect(typeof c.freq).toBe('number');
      expect(typeof c.lastUsed).toBe('number');
      if (c.repo !== undefined) expect(c.repo).toContain('/');
    }
    for (let i = 1; i < candidates.length; i++) {
      const prev = candidates[i - 1];
      const cur = candidates[i];
      const ordered =
        prev.freq > cur.freq ||
        (prev.freq === cur.freq && prev.lastUsed >= cur.lastUsed);
      expect(ordered).toBe(true);
    }
  });

  test('paths are unique after merge', async () => {
    const candidates = await inferProjectCandidates();
    const paths = candidates.map((c) => c.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
