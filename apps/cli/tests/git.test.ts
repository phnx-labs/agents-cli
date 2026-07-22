import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import simpleGit from 'simple-git';
import { pullRepo } from '../src/lib/git.js';

const TEST_DIR = join(tmpdir(), 'agents-cli-git-test');
const REMOTE_DIR = join(TEST_DIR, 'remote');
const LOCAL_DIR = join(TEST_DIR, 'local');

describe('pullRepo', () => {
  beforeEach(async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });

    // Create a bare remote repo
    mkdirSync(REMOTE_DIR, { recursive: true });
    const remoteGit = simpleGit(REMOTE_DIR);
    await remoteGit.init(false);
    await remoteGit.addConfig('user.name', 'Test User');
    await remoteGit.addConfig('user.email', 'test@example.com');
    writeFileSync(join(REMOTE_DIR, 'README.md'), '# Test');
    await remoteGit.add('.');
    await remoteGit.commit('initial');

    // Clone it to local
    mkdirSync(LOCAL_DIR, { recursive: true });
    await simpleGit().clone(REMOTE_DIR, LOCAL_DIR);
    const localGit = simpleGit(LOCAL_DIR);
    await localGit.addConfig('user.name', 'Test User');
    await localGit.addConfig('user.email', 'test@example.com');
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('fast-forwards when local is behind origin', async () => {
    // Push a new commit to remote so there's something to pull
    writeFileSync(join(REMOTE_DIR, 'new-file.md'), '# New');
    const remoteGit = simpleGit(REMOTE_DIR);
    await remoteGit.add('.');
    await remoteGit.commit('add new file');

    const before = await simpleGit(LOCAL_DIR).revparse(['HEAD']);
    const result = await pullRepo(LOCAL_DIR);
    const after = await simpleGit(LOCAL_DIR).revparse(['HEAD']);

    expect(result.success).toBe(true);
    expect(result.commit).toBeTruthy();
    expect(result.error).toBeUndefined();
    expect(after).not.toBe(before);
    expect(
      await simpleGit(LOCAL_DIR).revparse(['HEAD']),
    ).toBe(await remoteGit.revparse(['HEAD']));
  });

  it('reports success when already up to date', async () => {
    const before = await simpleGit(LOCAL_DIR).revparse(['HEAD']);
    const result = await pullRepo(LOCAL_DIR);
    const after = await simpleGit(LOCAL_DIR).revparse(['HEAD']);

    expect(result.success).toBe(true);
    expect(result.commit).toBeTruthy();
    expect(after).toBe(before);
  });

  it('refuses to pull when working tree has uncommitted changes', async () => {
    // Create a dirty working tree
    writeFileSync(join(LOCAL_DIR, 'dirty.txt'), 'uncommitted change');

    const result = await pullRepo(LOCAL_DIR);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked by local changes');
  });

  it('refuses to pull when tracked files are modified', async () => {
    // Modify a tracked file
    writeFileSync(join(LOCAL_DIR, 'README.md'), '# Modified');

    const result = await pullRepo(LOCAL_DIR);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked by local changes');
  });

  it('refuses to fast-forward when local commits diverge from origin', async () => {
    // Commit on remote, then commit locally on a divergent line.
    writeFileSync(join(REMOTE_DIR, 'remote-only.txt'), 'remote');
    const remoteGit = simpleGit(REMOTE_DIR);
    await remoteGit.add('.');
    await remoteGit.commit('remote commit');

    writeFileSync(join(LOCAL_DIR, 'local-only.txt'), 'local');
    const localGit = simpleGit(LOCAL_DIR);
    await localGit.add('.');
    await localGit.commit('local commit');

    const before = await localGit.revparse(['HEAD']);
    const result = await pullRepo(LOCAL_DIR);
    const after = await localGit.revparse(['HEAD']);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked by local commits');
    expect(after).toBe(before);
    expect(
      await localGit.revparse(['HEAD']),
    ).not.toBe(await remoteGit.revparse(['HEAD']));
  });
});
