/**
 * Tests for git source parsing and transport validation.
 *
 * Focus: assertSafeGitTransport must reject the transports that lead to
 * clone-time RCE (ext::/fd:: remote helpers, option injection) or plaintext
 * MITM (http://, git://, file://), while still allowing https/ssh/SCP and
 * local paths. These checks are pure string logic, identical on every OS.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';
import { assertSafeGitTransport, parseSource, syncRepoGit } from './git.js';

describe('assertSafeGitTransport', () => {
  const allowed = [
    'https://github.com/owner/repo.git',
    'https://gitlab.com/owner/repo',
    'ssh://git@github.com/owner/repo.git',
    'git@github.com:owner/repo.git', // SCP-style SSH
    'example.com:owner/repo.git', // SCP-style without user
    '/abs/local/path',
    './relative/path',
    'C:\\Users\\me\\repo', // Windows absolute path (no scheme)
  ];

  for (const src of allowed) {
    it(`allows ${src}`, () => {
      expect(() => assertSafeGitTransport(src)).not.toThrow();
    });
  }

  const rejected: Array<[string, RegExp]> = [
    ['ext::sh -c "id"', /remote-helper/],
    ['ext::sh -c touch\\ /tmp/pwned', /remote-helper/],
    ['fd::17/18', /remote-helper/],
    ['-oProxyCommand=evil', /interpreted as a git option/],
    ['--upload-pack=evil', /interpreted as a git option/],
    ['http://example.com/repo.git', /not an allowed transport/],
    ['git://example.com/repo.git', /not an allowed transport/],
    ['file:///etc/passwd', /not an allowed transport/],
  ];

  for (const [src, pattern] of rejected) {
    it(`rejects ${src}`, () => {
      expect(() => assertSafeGitTransport(src)).toThrow(pattern);
    });
  }

  it('ignores surrounding whitespace when classifying', () => {
    expect(() => assertSafeGitTransport('  ext::sh -c id  ')).toThrow(/remote-helper/);
  });
});

describe('parseSource transport safety', () => {
  it('rejects a generic http:// URL', () => {
    expect(() => parseSource('http://example.com/owner/repo')).toThrow(/not an allowed transport/);
  });

  it('accepts a generic https:// URL as type url', () => {
    const parsed = parseSource('https://example.com/owner/repo');
    expect(parsed.type).toBe('url');
    expect(parsed.url).toBe('https://example.com/owner/repo.git');
  });

  it('upgrades an http://github.com URL to https (does not reject)', () => {
    const parsed = parseSource('http://github.com/owner/repo');
    expect(parsed.type).toBe('github');
    expect(parsed.url).toBe('https://github.com/owner/repo.git');
  });

  it('keeps gh: shorthand on https', () => {
    const parsed = parseSource('gh:owner/repo');
    expect(parsed.type).toBe('github');
    expect(parsed.url).toBe('https://github.com/owner/repo.git');
  });
});

/**
 * Real-repo tests for syncRepoGit — the git-level `agents sync <repo>` engine.
 * Uses a bare "remote" plus two clones on the filesystem (no mocking): one
 * stands in for the remote author, one for the local machine being synced.
 */
describe('syncRepoGit', () => {
  let root: string;
  let remote: string; // bare origin
  let local: string; // the repo we sync
  let author: string; // a second clone that pushes upstream commits

  async function commitFile(dir: string, name: string, body: string, msg: string): Promise<void> {
    const g = simpleGit(dir);
    fs.writeFileSync(path.join(dir, name), body);
    await g.add('-A');
    await g.commit(msg);
  }

  async function configIdentity(dir: string): Promise<void> {
    const g = simpleGit(dir);
    await g.addConfig('user.email', 'test@example.com');
    await g.addConfig('user.name', 'Test');
    await g.addConfig('commit.gpgsign', 'false');
    // Keep line endings byte-identical across OSes: without this, Windows
    // checks out committed '\n' content as '\r\n' (core.autocrlf defaults to
    // true there), breaking exact readFileSync content assertions below.
    await g.addConfig('core.autocrlf', 'false');
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrepo-'));
    remote = path.join(root, 'remote.git');
    local = path.join(root, 'local');
    author = path.join(root, 'author');

    // Bare remote on main.
    await simpleGit().raw(['init', '--bare', '-b', 'main', remote]);

    // Author clone seeds the first commit and pushes it.
    await simpleGit().clone(remote, author);
    await configIdentity(author);
    await commitFile(author, 'README.md', 'v1\n', 'init');
    await simpleGit(author).push('origin', 'main');

    // Local clone is the machine we call syncRepoGit on.
    await simpleGit().clone(remote, local);
    await configIdentity(local);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses to sync when the working tree is dirty', async () => {
    fs.writeFileSync(path.join(local, 'dirty.txt'), 'uncommitted\n');
    const res = await syncRepoGit(local, { push: false });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/uncommitted changes/);
  });

  it('rebases local onto new upstream commits (pull-only)', async () => {
    // Author advances the remote.
    await commitFile(author, 'README.md', 'v2\n', 'upstream change');
    await simpleGit(author).push('origin', 'main');

    const res = await syncRepoGit(local, { push: false });
    expect(res.success).toBe(true);
    expect(res.pushed).toBe(false);
    // Local now carries the upstream file content.
    expect(fs.readFileSync(path.join(local, 'README.md'), 'utf8')).toBe('v2\n');
  });

  it('rebases a local commit on top of upstream and pushes it up', async () => {
    // Upstream moves.
    await commitFile(author, 'up.txt', 'from-author\n', 'author commit');
    await simpleGit(author).push('origin', 'main');
    // Local makes its own commit (diverged, but on a different file → rebases clean).
    await commitFile(local, 'down.txt', 'from-local\n', 'local commit');

    const res = await syncRepoGit(local, { push: true });
    expect(res.success).toBe(true);
    expect(res.pushed).toBe(true);

    // The local commit reached the remote: a fresh clone sees down.txt.
    const verify = path.join(root, 'verify');
    await simpleGit().clone(remote, verify);
    expect(fs.existsSync(path.join(verify, 'down.txt'))).toBe(true);
    expect(fs.existsSync(path.join(verify, 'up.txt'))).toBe(true);
  });
});
