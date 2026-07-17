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
import {
  adoptRepo,
  assertSafeGitTransport,
  assertValidBranchName,
  canonicalGitRemote,
  commitAndPush,
  displayHomePath,
  parseSource,
  pullRepo,
  pushOrigin,
  sameGitRemote,
  syncRepoGit,
} from './git.js';

describe('assertValidBranchName', () => {
  it('allows ordinary branch names', () => {
    expect(() => assertValidBranchName('main')).not.toThrow();
    expect(() => assertValidBranchName('feature/foo')).not.toThrow();
    expect(() => assertValidBranchName('rush-1765-git-push')).not.toThrow();
  });

  it('rejects empty names', () => {
    expect(() => assertValidBranchName('')).toThrow(/empty/);
    expect(() => assertValidBranchName('   ')).toThrow(/empty/);
  });

  // RUSH-1765 finding 2: a branch beginning with "-" is parsed as a git push option.
  it('rejects names that would be parsed as git push options', () => {
    expect(() => assertValidBranchName('--mirror')).toThrow(/git option/);
    expect(() => assertValidBranchName('--receive-pack=evil')).toThrow(/git option/);
    expect(() => assertValidBranchName('-u')).toThrow(/git option/);
    expect(() => assertValidBranchName('--force')).toThrow(/git option/);
  });
});

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
    // Commit `* -text` so every clone checks out byte-identical LF content
    // regardless of the machine's core.autocrlf. On Windows CI (autocrlf=true)
    // the *checkout* during `git clone` runs before configIdentity() can set
    // autocrlf=false on the fresh clone, so the local working tree would come
    // out as CRLF and `status.isClean()` would see a phantom modification —
    // making syncRepoGit refuse with "uncommitted changes". A committed
    // .gitattributes wins over autocrlf at checkout time and prevents that.
    fs.writeFileSync(path.join(author, '.gitattributes'), '* -text\n');
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

describe('displayHomePath', () => {
  it('renders a home-anchored path in ~-relative form with forward slashes', () => {
    const abs = os.homedir() + path.sep + '.agents' + path.sep + '.system';
    expect(displayHomePath(abs)).toBe('~/.agents/.system');
  });

  it('leaves a path outside the home directory unchanged (bar slash normalization)', () => {
    expect(displayHomePath('/opt/other/repo')).toBe('/opt/other/repo');
    expect(displayHomePath('C:\\some\\win\\path')).toBe('C:/some/win/path');
  });
});

describe('pullRepo dirty-tree hint', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('points the remediation hint at the repo that actually failed, not a hardcoded path', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-pull-'));
    tmpDirs.push(repo);
    await simpleGit(repo).init();
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'uncommitted');

    const res = await pullRepo(repo);

    expect(res.success).toBe(false);
    expect(res.error).toContain('Working tree has uncommitted changes');
    // The hint must reference this repo's own directory ...
    expect(res.error).toContain(path.basename(repo));
    expect(res.error).toContain(`cd ${displayHomePath(repo)} && git status`);
    // ... not the old hardcoded ~/.agents (which is not even a git repo).
    expect(res.error).not.toContain('cd ~/.agents ');
  });
});

/**
 * Real-repo tests for commitAndPush + pullRepo rebase — RUSH-1454.
 * Bare remote + clones; no mocks.
 */
describe('commitAndPush (clean-but-ahead + dirty)', () => {
  let root: string;
  let remote: string;
  let local: string;

  async function configIdentity(dir: string): Promise<void> {
    const g = simpleGit(dir);
    await g.addConfig('user.email', 'test@example.com');
    await g.addConfig('user.name', 'Test');
    await g.addConfig('commit.gpgsign', 'false');
    await g.addConfig('core.autocrlf', 'false');
  }

  async function commitFile(dir: string, name: string, body: string, msg: string): Promise<void> {
    const g = simpleGit(dir);
    fs.writeFileSync(path.join(dir, name), body);
    await g.add('-A');
    await g.commit(msg);
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'commitpush-'));
    remote = path.join(root, 'remote.git');
    local = path.join(root, 'local');

    await simpleGit().raw(['init', '--bare', '-b', 'main', remote]);
    await simpleGit().clone(remote, local);
    await configIdentity(local);
    fs.writeFileSync(path.join(local, '.gitattributes'), '* -text\n');
    await commitFile(local, 'README.md', 'v1\n', 'init');
    await simpleGit(local).push('origin', 'main');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports already up to date when clean and not ahead', async () => {
    const res = await commitAndPush(local, 'noop');
    expect(res.success).toBe(true);
    expect(res.pushed).toBe(false);
    expect(res.committed).toBe(false);
    expect(res.detail).toBe('already up to date');
    expect(res.branch).toBe('main');
  });

  it('pushes when the tree is clean but local is ahead of origin', async () => {
    // Commit locally without push (simulates post-rebase ahead state).
    await commitFile(local, 'local-only.txt', 'ahead\n', 'local ahead');
    // Confirm we're clean but ahead before calling commitAndPush.
    const pre = await simpleGit(local).status();
    expect(pre.isClean()).toBe(true);
    expect(pre.ahead).toBe(1);

    const res = await commitAndPush(local, 'should not create a new commit');
    expect(res.success).toBe(true);
    expect(res.committed).toBe(false);
    expect(res.pushed).toBe(true);
    expect(res.detail).toMatch(/pushed /);
    expect(res.detail).not.toBe('already up to date');

    // Remote carries the local-only commit.
    const verify = path.join(root, 'verify-ahead');
    await simpleGit().clone(remote, verify);
    expect(fs.existsSync(path.join(verify, 'local-only.txt'))).toBe(true);
  });

  it('commits dirty changes and pushes them', async () => {
    fs.writeFileSync(path.join(local, 'dirty.txt'), 'new\n');
    const res = await commitAndPush(local, 'add dirty');
    expect(res.success).toBe(true);
    expect(res.committed).toBe(true);
    expect(res.pushed).toBe(true);
    expect(res.detail).toMatch(/committed and pushed/);

    const verify = path.join(root, 'verify-dirty');
    await simpleGit().clone(remote, verify);
    expect(fs.readFileSync(path.join(verify, 'dirty.txt'), 'utf8')).toBe('new\n');
  });

  // RUSH-1765 finding 2: hostile branch names must never reach git as push options.
  // Real simple-git instance; pushOrigin validates before any push argv is built.
  it('refuses to push a hostile branch name that would be a git option', async () => {
    const git = simpleGit(local);
    await expect(pushOrigin(git, '--mirror')).rejects.toThrow(/git option/);
    await expect(pushOrigin(git, '--receive-pack=evil')).rejects.toThrow(/git option/);
    // Normal branch still pushes via the hardened path (real remote).
    await commitFile(local, 'safe-push.txt', 'ok\n', 'safe push');
    await pushOrigin(git, 'main');
    const verify = path.join(root, 'verify-safe-push');
    await simpleGit().clone(remote, verify);
    expect(fs.readFileSync(path.join(verify, 'safe-push.txt'), 'utf8')).toBe('ok\n');
  });
});

describe('pullRepo divergent rebase', () => {
  let root: string;
  let remote: string;
  let local: string;
  let author: string;

  async function configIdentity(dir: string): Promise<void> {
    const g = simpleGit(dir);
    await g.addConfig('user.email', 'test@example.com');
    await g.addConfig('user.name', 'Test');
    await g.addConfig('commit.gpgsign', 'false');
    await g.addConfig('core.autocrlf', 'false');
  }

  async function commitFile(dir: string, name: string, body: string, msg: string): Promise<void> {
    const g = simpleGit(dir);
    fs.writeFileSync(path.join(dir, name), body);
    await g.add('-A');
    await g.commit(msg);
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pullrepo-'));
    remote = path.join(root, 'remote.git');
    local = path.join(root, 'local');
    author = path.join(root, 'author');

    await simpleGit().raw(['init', '--bare', '-b', 'main', remote]);
    await simpleGit().clone(remote, author);
    await configIdentity(author);
    fs.writeFileSync(path.join(author, '.gitattributes'), '* -text\n');
    await commitFile(author, 'README.md', 'v1\n', 'init');
    await simpleGit(author).push('origin', 'main');

    await simpleGit().clone(remote, local);
    await configIdentity(local);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rebases local commits onto divergent upstream instead of failing', async () => {
    // Upstream and local each add a different file → diverged histories.
    await commitFile(author, 'up.txt', 'from-author\n', 'author commit');
    await simpleGit(author).push('origin', 'main');
    await commitFile(local, 'down.txt', 'from-local\n', 'local commit');

    const res = await pullRepo(local);
    expect(res.success).toBe(true);
    expect(res.branch).toBe('main');
    expect(res.commit).toMatch(/^[0-9a-f]{7,8}$/);
    // Both sides' files present after rebase.
    expect(fs.existsSync(path.join(local, 'up.txt'))).toBe(true);
    expect(fs.existsSync(path.join(local, 'down.txt'))).toBe(true);
  });
});

describe('adoptRepo guards', () => {
  let base: string;
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-guard-'));
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('refuses a local source (adopt is remote-only, like cloneIntoExisting)', async () => {
    const target = path.join(base, 'target');
    fs.mkdirSync(target);
    const res = await adoptRepo(base, target); // base exists on disk → parsed as local
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/local source/i);
    // A rejected adopt must not have created a .git.
    expect(fs.existsSync(path.join(target, '.git'))).toBe(false);
  });

  it('refuses to adopt a dir that is already a git repo', async () => {
    const target = path.join(base, 'already');
    fs.mkdirSync(target);
    await simpleGit(target).init();
    const res = await adoptRepo('https://github.com/owner/repo.git', target);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/already a git repo/i);
  });

  it('returns a graceful error (never throws) for an unsafe transport URL', async () => {
    // parseSource/assertSafeGitTransport throw for http:// — the command has no
    // try/catch, so this must be caught inside adoptRepo and returned, not thrown.
    const target = path.join(base, 'bad');
    fs.mkdirSync(target);
    const res = await adoptRepo('http://insecure.example/repo.git', target);
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
    // A rejected adopt leaves no .git and no leftover temp.
    expect(fs.existsSync(path.join(target, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.git-adopt-temp'))).toBe(false);
  });
});

describe('sameGitRemote (adopt-existing repo matching)', () => {
  it('treats the same repo cloned over SSH vs HTTPS as equal', () => {
    // parseSource normalizes every github form to https://…/repo.git, but a
    // hand-cloned checkout's origin may be the SSH form — they must still match
    // so `repos add` adopts it instead of erroring.
    expect(sameGitRemote('git@github.com:phnx-labs/.agents-extras.git', 'https://github.com/phnx-labs/.agents-extras.git')).toBe(true);
    expect(sameGitRemote('ssh://git@github.com/acme/team-skills', 'https://github.com/acme/team-skills.git')).toBe(true);
    expect(sameGitRemote('https://user@github.com/acme/team-skills.git', 'https://github.com/acme/team-skills')).toBe(true);
  });

  it('is case-insensitive on host/owner and tolerates trailing slash + .git', () => {
    expect(sameGitRemote('https://GitHub.com/Acme/Team-Skills.git/', 'https://github.com/acme/team-skills')).toBe(true);
  });

  it('distinguishes different repos and refuses null/empty', () => {
    expect(sameGitRemote('git@github.com:acme/a.git', 'git@github.com:acme/b.git')).toBe(false);
    expect(sameGitRemote('https://github.com/acme/a', 'https://gitlab.com/acme/a')).toBe(false);
    expect(sameGitRemote(null, 'https://github.com/acme/a')).toBe(false);
    expect(sameGitRemote('https://github.com/acme/a', undefined)).toBe(false);
  });

  it('canonicalizes to host/owner/repo', () => {
    expect(canonicalGitRemote('git@github.com:phnx-labs/.agents-extras.git')).toBe('github.com/phnx-labs/.agents-extras');
    expect(canonicalGitRemote('https://github.com/phnx-labs/.agents-extras')).toBe('github.com/phnx-labs/.agents-extras');
  });
});
