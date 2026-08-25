/**
 * Concurrency + corruption guarantees for the teams registry.
 *
 * registry.json is the user's source of truth for named teams; a crashed
 * write or a stomp from a parallel writer would erase it. These tests pin
 * down the two invariants we just added:
 *
 *   1. Concurrent createTeam() calls all land — proper-lockfile + atomic
 *      rename serializes the read-modify-write window.
 *   2. A malformed registry on disk surfaces as a thrown error, not a
 *      silent {} that the next write would happily clobber.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Set HOME before persistence.ts loads so its module-level root picks up the
// override. Plain top-level statements run before the dynamic `await import`
// below, so vi.hoisted is not needed (and is also not supported by Bun's
// native test runner).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-teams-registry-test-'));
process.env.HOME = TEST_HOME;

const { createTeam, loadTeams } = await import('../registry.js');

function registryPath(): string {
  return path.join(TEST_HOME, '.agents', '.history', 'teams', 'registry.json');
}

beforeAll(async () => {
  await fsp.mkdir(path.join(TEST_HOME, '.agents', '.history', 'teams'), { recursive: true });
});

beforeEach(async () => {
  // Each test starts from a clean slate so locks/state don't leak.
  await fsp.rm(registryPath(), { force: true });
  // proper-lockfile leaves a `<file>.lock` directory; clean that too.
  await fsp.rm(`${registryPath()}.lock`, { recursive: true, force: true });
});

afterAll(async () => {
  await fsp.rm(TEST_HOME, { recursive: true, force: true });
});

describe('teams registry concurrency', () => {
  it('serializes 5 concurrent createTeam calls so all land', async () => {
    const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
    const results = await Promise.allSettled(
      names.map((n) => createTeam(n, { description: `desc-${n}` }))
    );

    // Every call must succeed — the lock guarantees no read-modify-write
    // races that would otherwise drop entries.
    for (const r of results) {
      expect(r.status).toBe('fulfilled');
    }

    const reg = await loadTeams();
    expect(Object.keys(reg).sort()).toEqual([...names].sort());
    for (const n of names) {
      expect(reg[n].description).toBe(`desc-${n}`);
      expect(typeof reg[n].created_at).toBe('string');
    }
  });
});

describe('teams registry corruption surfacing', () => {
  it('throws when the registry is unparseable instead of silently returning {}', async () => {
    await fsp.mkdir(path.dirname(registryPath()), { recursive: true });
    fs.writeFileSync(registryPath(), '{ this is not json');

    await expect(loadTeams()).rejects.toThrow(/Team registry corrupted/);
  });

  it('returns {} only when the file truly does not exist', async () => {
    expect(fs.existsSync(registryPath())).toBe(false);
    const reg = await loadTeams();
    expect(reg).toEqual({});
  });
});
