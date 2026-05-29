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
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('pulls successfully when working tree is clean', async () => {
    // Push a new commit to remote so there's something to pull
    writeFileSync(join(REMOTE_DIR, 'new-file.md'), '# New');
    const remoteGit = simpleGit(REMOTE_DIR);
    await remoteGit.add('.');
    await remoteGit.commit('add new file');

    const result = await pullRepo(LOCAL_DIR);
    expect(result.success).toBe(true);
    expect(result.commit).toBeTruthy();
    expect(result.error).toBeUndefined();
  });

  it('refuses to pull when working tree has uncommitted changes', async () => {
    // Create a dirty working tree
    writeFileSync(join(LOCAL_DIR, 'dirty.txt'), 'uncommitted change');

    const result = await pullRepo(LOCAL_DIR);
    expect(result.success).toBe(false);
    expect(result.error).toContain('uncommitted changes');
  });

  it('refuses to pull when tracked files are modified', async () => {
    // Modify a tracked file
    writeFileSync(join(LOCAL_DIR, 'README.md'), '# Modified');

    const result = await pullRepo(LOCAL_DIR);
    expect(result.success).toBe(false);
    expect(result.error).toContain('uncommitted changes');
  });
});
