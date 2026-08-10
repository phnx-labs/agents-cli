import { expect, test, describe, afterAll } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { rankRepos } from './repoIndex';
import { inferProjectCandidates, type ProjectCandidate } from './projectIndex';

describe('rankRepos', () => {
  const tmpDirs: string[] = [];

  async function createTempRepo(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), 'repoidx-'));
    tmpDirs.push(d);
    await writeFile(join(d, 'package.json'), '{}');
    return d;
  }

  afterAll(async () => {
    for (const d of tmpDirs) {
      await rm(d, { recursive: true, force: true });
    }
  });

  // A tiny real detectProjects that reads the temp dir for a marker file.
  async function realDetectProjects(root: string) {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(root);
    if (entries.includes('package.json')) {
      return [{ name: basename(root), relPath: '.' }];
    }
    return [];
  }

  test('groups by slug, sums freq, injects local path and projects', async () => {
    const local = await createTempRepo();
    const candidates: ProjectCandidate[] = [
      { path: local, repo: 'acme/widget', freq: 2, lastUsed: 100 },
      { path: local, repo: 'acme/widget', freq: 3, lastUsed: 200 },
      { path: '/some/other/beta/gamma', repo: 'beta/gamma', freq: 1, lastUsed: 50 },
    ];

    const infos = await rankRepos(candidates, realDetectProjects);

    expect(infos).toHaveLength(2);
    expect(infos[0].slug).toBe('acme/widget');
    expect(infos[0].freq).toBe(5);
    expect(infos[0].perHostPaths['this-mac']).toBe(local);
    expect(infos[0].projects).toEqual([{ name: basename(local), relPath: '.' }]);

    expect(infos[1].slug).toBe('beta/gamma');
    expect(infos[1].freq).toBe(1);
    // detectProjects reads a real (nonexistent) dir -> throws -> falls back to []
    expect(infos[1].projects).toEqual([]);
  });

  test('sorted by freq descending', async () => {
    const candidates: ProjectCandidate[] = [
      { path: '/a/one/repo', repo: 'one/repo', freq: 1, lastUsed: 0 },
      { path: '/a/two/repo', repo: 'two/repo', freq: 9, lastUsed: 0 },
    ];
    const infos = await rankRepos(candidates, async () => []);
    expect(infos[0].slug).toBe('two/repo');
    expect(infos[1].slug).toBe('one/repo');
  });

  test('integrates with real inferProjectCandidates without throwing', async () => {
    const candidates = await inferProjectCandidates();
    const infos = await rankRepos(candidates, async () => []);
    expect(Array.isArray(infos)).toBe(true);
    for (const info of infos) {
      expect(info.slug).toContain('/');
      expect(typeof info.freq).toBe('number');
      expect(info.perHostPaths['this-mac']).toBeDefined();
    }
  });
});
