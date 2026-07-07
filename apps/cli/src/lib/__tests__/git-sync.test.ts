import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getGitSyncStatus, getTrackedFiles, isGitRepo } from '../git.js';

let repoDir: string;

function git(args: string): string {
  return execSync(`git -C ${JSON.stringify(repoDir)} ${args}`, { encoding: 'utf-8' }).trim();
}

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-test-'));
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('git sync helpers', () => {
  it('detects git repositories', () => {
    expect(isGitRepo(repoDir)).toBe(false);

    execSync(`git init ${JSON.stringify(repoDir)}`, { encoding: 'utf-8' });

    expect(isGitRepo(repoDir)).toBe(true);
  });

  it('lists tracked files from the actual repository index', async () => {
    execSync(`git init ${JSON.stringify(repoDir)}`, { encoding: 'utf-8' });
    git('config user.name "Test User"');
    git('config user.email "test@example.com"');

    fs.mkdirSync(path.join(repoDir, 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'skills', 'demo', 'SKILL.md'), '# demo\n');
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'root\n');
    git('add skills/demo/SKILL.md README.md');
    git('commit -m "initial"');

    expect(await getTrackedFiles(repoDir)).toEqual(['README.md', 'skills/demo/SKILL.md']);
    expect(await getTrackedFiles(repoDir, 'skills')).toEqual(['skills/demo/SKILL.md']);
  });

  it('categorizes synced, modified, staged, new, and deleted files', async () => {
    execSync(`git init ${JSON.stringify(repoDir)}`, { encoding: 'utf-8' });
    git('config user.name "Test User"');
    git('config user.email "test@example.com"');

    fs.mkdirSync(path.join(repoDir, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'skills', 'clean.md'), 'clean\n');
    fs.writeFileSync(path.join(repoDir, 'skills', 'modified.md'), 'before\n');
    fs.writeFileSync(path.join(repoDir, 'skills', 'staged.md'), 'before\n');
    fs.writeFileSync(path.join(repoDir, 'skills', 'deleted.md'), 'delete me\n');
    git('add skills');
    git('commit -m "initial"');

    fs.writeFileSync(path.join(repoDir, 'skills', 'modified.md'), 'after\n');
    fs.writeFileSync(path.join(repoDir, 'skills', 'staged.md'), 'after\n');
    git('add skills/staged.md');
    fs.rmSync(path.join(repoDir, 'skills', 'deleted.md'));
    fs.writeFileSync(path.join(repoDir, 'skills', 'new.md'), 'new\n');

    const status = await getGitSyncStatus(repoDir, 'skills');

    expect(status).toEqual({
      synced: ['skills/clean.md'],
      modified: ['skills/modified.md', 'skills/staged.md'],
      new: ['skills/new.md'],
      staged: ['skills/staged.md'],
      deleted: ['skills/deleted.md'],
    });
  });

  it('returns null or empty results for non-repositories', async () => {
    expect(await getGitSyncStatus(repoDir, 'skills')).toBeNull();
    expect(await getTrackedFiles(repoDir, 'skills')).toEqual([]);
  });
});
