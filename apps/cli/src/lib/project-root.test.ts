import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import {
  toHomeRelative,
  expandLocalHome,
  parseProjectRef,
  buildProjectPath,
  inferProjectRoot,
} from './project-root.js';

const HOME = process.env.HOME ?? os.homedir();

describe('toHomeRelative', () => {
  it('rewrites a path under $HOME to ~/…', () => {
    expect(toHomeRelative(path.join(HOME, 'src/github.com/me'))).toBe('~/src/github.com/me');
  });
  it('maps the home dir itself to ~', () => {
    expect(toHomeRelative(HOME)).toBe('~');
  });
  it('leaves a path outside $HOME absolute', () => {
    expect(toHomeRelative('/opt/projects')).toBe('/opt/projects');
  });
});

describe('expandLocalHome', () => {
  it('expands ~ and $HOME against the local home', () => {
    expect(expandLocalHome('~/src/x')).toBe(path.join(HOME, 'src/x'));
    expect(expandLocalHome('$HOME/src/x')).toBe(path.join(HOME, 'src/x'));
    expect(expandLocalHome('~')).toBe(HOME);
  });
  it('passes non-home paths through unchanged', () => {
    expect(expandLocalHome('/opt/x')).toBe('/opt/x');
    expect(expandLocalHome('rel/path')).toBe('rel/path');
  });
});

describe('parseProjectRef', () => {
  it('parses a bare slug', () => {
    expect(parseProjectRef('agents-cli')).toEqual({ slug: 'agents-cli' });
  });
  it('parses slug@worktree', () => {
    expect(parseProjectRef('agents-cli@fix-bug')).toEqual({ slug: 'agents-cli', worktree: 'fix-bug' });
  });
  it('treats a trailing @ as no worktree', () => {
    expect(parseProjectRef('agents-cli@')).toEqual({ slug: 'agents-cli', worktree: undefined });
  });
});

describe('buildProjectPath', () => {
  it('joins root + slug, home-relative for remote', () => {
    expect(buildProjectPath('~/src/github.com/me', 'agents-cli', true)).toBe(
      '~/src/github.com/me/agents-cli',
    );
  });
  it('appends the worktree path under .agents/worktrees for remote', () => {
    expect(buildProjectPath('~/src/github.com/me', 'agents-cli@fix', true)).toBe(
      '~/src/github.com/me/agents-cli/.agents/worktrees/fix',
    );
  });
  it('expands to an absolute local path when not for remote', () => {
    expect(buildProjectPath('~/src/x', 'repo', false)).toBe(path.join(HOME, 'src/x/repo'));
  });
  it('rejects an empty slug', () => {
    expect(() => buildProjectPath('~/src', '@wt', true)).toThrow(/Invalid --project/);
  });
});

describe('inferProjectRoot', () => {
  let tmp: string;
  let repo: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proot-'));
    repo = path.join(tmp, 'my-repo');
    fs.mkdirSync(path.join(repo, 'sub', 'deep'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
  });
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns the directory ABOVE the git root, resolved from a nested cwd', async () => {
    const root = await inferProjectRoot(path.join(repo, 'sub', 'deep'));
    // tmp is outside $HOME, so it stays absolute — realpath to dodge /var → /private/var on macOS.
    expect(root).toBe(fs.realpathSync(tmp));
  });

  it('returns undefined when cwd is not inside a git repo', async () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'norepo-'));
    try {
      expect(await inferProjectRoot(nonRepo)).toBeUndefined();
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
