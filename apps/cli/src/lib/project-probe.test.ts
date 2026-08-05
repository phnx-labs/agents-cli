import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { stripAnsi } from './session/width.js';
import {
  formatFleetWorkspaces,
  workspaceWarnings,
  formatWorkspaceLine,
  parseRemoteProbe,
  probeProjectWorkspaces,
  probeRepoWorkspace,
  workspaceTargetsForDef,
  type HostWorkspaceStatus,
} from './project-probe.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-probe-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(p: string): void {
  fs.mkdirSync(p, { recursive: true });
  git(p, ['init', '-b', 'main']);
  git(p, ['config', 'user.email', 'probe@example.com']);
  git(p, ['config', 'user.name', 'Probe Test']);
  git(p, ['config', 'commit.gpgsign', 'false']);
}

function commit(p: string, msg: string): void {
  fs.appendFileSync(path.join(p, 'file.txt'), `${msg}\n`);
  git(p, ['add', '.']);
  git(p, ['commit', '-m', msg]);
}

/** A repo with an upstream set to a local bare remote, pushed and even. */
function repoWithUpstream(name: string): { repo: string; remote: string } {
  const remote = path.join(dir, `${name}.git`);
  // `-b main` on the bare init too: its HEAD symref decides what a clone checks
  // out, and CI's init.defaultBranch is master — a bare HEAD→master leaves the
  // sibling clone branchless and its push fails with "src refspec main does not
  // match any".
  git(dir, ['init', '--bare', '-b', 'main', remote]);
  const repo = path.join(dir, name);
  initRepo(repo);
  commit(repo, 'initial');
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-u', 'origin', 'main']);
  return { repo, remote };
}

describe('probeRepoWorkspace', () => {
  it('reports a missing path as not present without any git state', () => {
    const s = probeRepoWorkspace(path.join(dir, 'nope'));
    expect(s).toEqual({ path: path.join(dir, 'nope'), present: false });
  });

  it('reads branch, upstream, zero drift, and cleanliness on an even repo', () => {
    const { repo } = repoWithUpstream('even');
    const s = probeRepoWorkspace(repo);
    expect(s.present).toBe(true);
    expect(s.branch).toBe('main');
    expect(s.upstream).toBe('origin/main');
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);
    expect(s.dirty).toBe(0);
    expect(s.error).toBeUndefined();
    expect(s.lastCommit).toBe(git(repo, ['log', '-1', '--format=%cI']).trim());
  });

  it('counts ahead commits not yet pushed', () => {
    const { repo } = repoWithUpstream('ahead');
    commit(repo, 'one');
    commit(repo, 'two');
    const s = probeRepoWorkspace(repo);
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(0);
  });

  it('counts behind commits against the last-fetched upstream (no fetch in the probe)', () => {
    const { repo, remote } = repoWithUpstream('behind');
    // Advance the remote from a sibling clone, then fetch so the remote-tracking
    // ref moves — the probe itself must never fetch.
    const other = path.join(dir, 'behind-other');
    git(dir, ['clone', remote, other]);
    git(other, ['config', 'user.email', 'probe@example.com']);
    git(other, ['config', 'user.name', 'Probe Test']);
    git(other, ['config', 'commit.gpgsign', 'false']);
    commit(other, 'remote-work');
    git(other, ['push', 'origin', 'main']);
    git(repo, ['fetch', 'origin']);
    const s = probeRepoWorkspace(repo);
    expect(s.behind).toBe(1);
    expect(s.ahead).toBe(0);
  });

  it('counts uncommitted and untracked files as dirty', () => {
    const { repo } = repoWithUpstream('dirty');
    fs.appendFileSync(path.join(repo, 'file.txt'), 'modified\n');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');
    const s = probeRepoWorkspace(repo);
    expect(s.dirty).toBe(2);
  });

  it('leaves ahead/behind undefined on a repo with no upstream', () => {
    const repo = path.join(dir, 'no-upstream');
    initRepo(repo);
    commit(repo, 'initial');
    const s = probeRepoWorkspace(repo);
    expect(s.present).toBe(true);
    expect(s.branch).toBe('main');
    expect(s.upstream).toBeUndefined();
    expect(s.ahead).toBeUndefined();
    expect(s.behind).toBeUndefined();
    expect(s.error).toBeUndefined();
  });

  it('treats a linked worktree (a .git FILE) as present', () => {
    const { repo } = repoWithUpstream('wt-src');
    const wt = path.join(dir, 'wt-linked');
    git(repo, ['worktree', 'add', '-b', 'wt-branch', wt]);
    expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true);
    const s = probeRepoWorkspace(wt);
    expect(s.present).toBe(true);
    expect(s.branch).toBe('wt-branch');
  });

  it('surfaces a broken .git as present-with-error, never silently clean', () => {
    const broken = path.join(dir, 'broken');
    fs.mkdirSync(path.join(broken, '.git'), { recursive: true });
    const s = probeRepoWorkspace(broken);
    expect(s.present).toBe(true);
    expect(s.error).toBeTruthy();
    expect(s.branch).toBeUndefined();
  });
});

describe('probeProjectWorkspaces', () => {
  it('probes each given path in order', () => {
    const repo = path.join(dir, 'home-rel');
    initRepo(repo);
    commit(repo, 'initial');
    // A tmp dir is never under HOME, so the home-relative echo is the path
    // itself; home-relative expansion is covered by toHomeRelative's own tests.
    const [s, missing] = probeProjectWorkspaces([repo, path.join(dir, 'absent')]);
    expect(s.present).toBe(true);
    expect(s.path).toBe(repo);
    expect(missing.present).toBe(false);
  });
});

describe('workspaceTargetsForDef', () => {
  it('collects root plus repos[].path, deduped', () => {
    expect(workspaceTargetsForDef({
      name: 'rush',
      root: '~/src/rush',
      repos: [
        { slug: 'phnx-labs/rush-infra', path: '~/src/rush-infra' },
        { slug: 'phnx-labs/rush-docs', path: '~/src/rush' }, // dup of root
        { slug: 'phnx-labs/slug-only' }, // no path — not probed
      ],
    })).toEqual(['~/src/rush', '~/src/rush-infra']);
  });

  it('returns an empty list when the def carries no on-disk paths', () => {
    expect(workspaceTargetsForDef({ name: 'x', repo: 'a/b' })).toEqual([]);
  });

  it('normalizes hand-edited def paths to the same home-relative form the probe echoes', () => {
    // Defs are hand-editable YAML — an absolute path under home (or a trailing
    // slash) must still match the probe row's `~/…` echo, or the row silently
    // drops out of the fleet line.
    const abs = path.join(os.homedir(), 'src', 'rush');
    expect(workspaceTargetsForDef({ name: 'rush', root: abs })).toEqual(['~/src/rush']);
    expect(workspaceTargetsForDef({ name: 'rush', root: '~/src/rush/' })).toEqual(['~/src/rush']);
  });
});

describe('parseRemoteProbe', () => {
  it('host-tags valid rows and drops malformed ones', () => {
    const rows = parseRemoteProbe(JSON.stringify([
      { path: '~/src/rush', present: true, branch: 'main', dirty: 0 },
      { path: 42, present: true }, // malformed path
      'nope',
    ]), 'mac-mini');
    expect(rows).toEqual([{ path: '~/src/rush', present: true, branch: 'main', dirty: 0, host: 'mac-mini' }]);
  });

  it('returns [] on non-JSON or non-array output (version skew)', () => {
    expect(parseRemoteProbe('not json', 'a')).toEqual([]);
    expect(parseRemoteProbe('{"x":1}', 'a')).toEqual([]);
  });
});

describe('formatWorkspaceLine', () => {
  const base = { path: '~/src/rush', present: true };

  it('renders each state', () => {
    expect(stripAnsi(formatWorkspaceLine({ path: '~/src/rush', present: false }))).toBe('✗ missing');
    expect(stripAnsi(formatWorkspaceLine({ ...base, branch: 'main', dirty: 0, ahead: 0, behind: 0 })))
      .toBe('✓ clean · main');
    expect(stripAnsi(formatWorkspaceLine({ ...base, branch: 'feature/x', dirty: 12, ahead: 3, behind: 1 })))
      .toBe('⚠ 12 dirty · ↑3 ↓1 · feature/x');
    expect(stripAnsi(formatWorkspaceLine({ ...base, branch: 'main', dirty: 0, ahead: 3 })))
      .toBe('⚠ ↑3 · main');
    expect(stripAnsi(formatWorkspaceLine({ ...base, branch: 'main', dirty: 0, behind: 5 })))
      .toBe('⚠ ↓5 · main');
    expect(stripAnsi(formatWorkspaceLine({ ...base, error: 'git exploded' }))).toBe('⚠ error: git exploded');
  });
});

describe('formatFleetWorkspaces', () => {
  it('joins one line host-sorted for a single probed path', () => {
    const statuses: HostWorkspaceStatus[] = [
      { path: '~/src/rush', present: false, host: 'zion' },
      { path: '~/src/rush', present: true, branch: 'main', dirty: 0, host: 'gpu-box' },
      { path: '~/src/rush', present: true, branch: 'feature/x', dirty: 2, behind: 5, host: 'mac-mini' },
    ];
    const lines = formatFleetWorkspaces(statuses).map(stripAnsi);
    expect(lines).toEqual([
      'gpu-box: ✓ clean · main  ·  mac-mini: ⚠ 2 dirty · ↓5 · feature/x  ·  zion: ✗ missing',
    ]);
  });

  it('renders one labelled line per path when a project probes several', () => {
    const statuses: HostWorkspaceStatus[] = [
      { path: '~/src/rush', present: true, branch: 'main', dirty: 0, host: 'zion' },
      { path: '~/src/rush-infra', present: false, host: 'zion' },
    ];
    const lines = formatFleetWorkspaces(statuses).map(stripAnsi);
    expect(lines).toEqual([
      '~/src/rush · zion: ✓ clean · main',
      '~/src/rush-infra · zion: ✗ missing',
    ]);
  });
});

describe('workspaceWarnings', () => {
  it('marks missing checkouts critical and dirty trees continue', () => {
    const w = workspaceWarnings([
      { host: 'zion', path: '~/src/x', present: true, dirty: 2, behind: 0, branch: 'main' },
      { host: 'yosemite-s0', path: '~/src/x', present: true, behind: 40, upstream: 'origin/main', branch: 'main' },
      { host: 'mac-mini', path: '~/src/x', present: false },
    ]);
    expect(w.find((x) => x.text.includes('missing'))?.severity).toBe('critical');
    expect(w.find((x) => x.text.includes('40'))?.severity).toBe('critical');
    expect(w.find((x) => x.text.includes('uncommitted'))?.severity).toBe('continue');
  });

  it('treats small behind as continue', () => {
    const w = workspaceWarnings([
      { host: 'zion', path: '~/src/x', present: true, behind: 2, upstream: 'origin/main' },
    ]);
    expect(w[0].severity).toBe('continue');
  });
});
