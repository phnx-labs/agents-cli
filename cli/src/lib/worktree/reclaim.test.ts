/**
 * Real git repos, no mocks — the reclaim decision is a safety gate, so the
 * cases that matter (rebase-merged, dirty, unpushed) are built as actual
 * worktrees and run through the actual code path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  classifyWorktree,
  collectWorktrees,
  countUnmergedCommits,
  isInside,
  parseWorktreePorcelain,
  reclaimWorktree,
  refreshFacts,
  resolveDefaultRef,
  type WorktreeFacts,
} from './reclaim.js';

const execFileAsync = promisify(execFile);
const G = ['-c', 'user.email=t@t.dev', '-c', 'user.name=t', '-c', 'init.defaultBranch=main'];
const git = async (cwd: string, args: string[]) =>
  (await execFileAsync('git', [...G, ...args], { cwd })).stdout.trim();

function facts(over: Partial<WorktreeFacts> = {}): WorktreeFacts {
  return {
    name: 'wt',
    path: '/tmp/wt',
    branch: 'feat/x',
    isPrimary: false,
    locked: false,
    dirtyFiles: 0,
    unmergedCommits: 0,
    ageDays: 30,
    ...over,
  };
}

describe('classifyWorktree', () => {
  it('reclaims a clean, fully-merged, aged worktree', () => {
    expect(classifyWorktree(facts(), 3)).toEqual({ reclaimable: true, blockers: [] });
  });

  it('refuses the primary checkout', () => {
    const v = classifyWorktree(facts({ isPrimary: true }), 3);
    expect(v.reclaimable).toBe(false);
    expect(v.blockers).toContain('primary-checkout');
  });

  it('refuses uncommitted changes', () => {
    expect(classifyWorktree(facts({ dirtyFiles: 1 }), 3).blockers).toContain('uncommitted-changes');
  });

  it('refuses commits that are not upstream', () => {
    expect(classifyWorktree(facts({ unmergedCommits: 2 }), 3).blockers).toContain('unmerged-commits');
  });

  it('fails CLOSED when the working tree status could not be read', () => {
    // A `git status` that threw (index.lock held by a live agent) must never
    // read as "clean" — that is the tree most likely to be holding work.
    const v = classifyWorktree(facts({ dirtyFiles: -1 }), 3);
    expect(v.reclaimable).toBe(false);
    expect(v.blockers).toContain('indeterminate');
  });

  it('does not double-report indeterminate when both probes fail', () => {
    const v = classifyWorktree(facts({ dirtyFiles: -1, unmergedCommits: -1 }), 3);
    expect(v.blockers.filter((b) => b === 'indeterminate')).toHaveLength(1);
  });

  it('fails CLOSED when merge state is undeterminable', () => {
    const v = classifyWorktree(facts({ unmergedCommits: -1 }), 3);
    expect(v.reclaimable).toBe(false);
    expect(v.blockers).toContain('indeterminate');
  });

  it('honours the grace window', () => {
    expect(classifyWorktree(facts({ ageDays: 0 }), 3).blockers).toContain('within-grace');
    expect(classifyWorktree(facts({ ageDays: 3 }), 3).reclaimable).toBe(true);
  });

  it('refuses a locked worktree', () => {
    expect(classifyWorktree(facts({ locked: true }), 3).blockers).toContain('locked');
  });

  it('reports every blocker at once, not just the first', () => {
    const v = classifyWorktree(facts({ dirtyFiles: 2, unmergedCommits: 1, ageDays: 0 }), 3);
    expect(v.blockers).toEqual(
      expect.arrayContaining(['uncommitted-changes', 'unmerged-commits', 'within-grace']),
    );
  });
});

describe('isInside', () => {
  it('matches the directory itself and real descendants', () => {
    expect(isInside('/r/.agents/worktrees/fix-110', '/r/.agents/worktrees/fix-110')).toBe(true);
    expect(isInside('/r/.agents/worktrees/fix-110/cli/src', '/r/.agents/worktrees/fix-110')).toBe(true);
  });

  it('does NOT treat a sibling sharing a name prefix as inside', () => {
    // The `done` bug: startsWith() made fix-1103 look like it lived in fix-110,
    // so `done` from one worktree reclaimed its neighbour.
    expect(isInside('/r/.agents/worktrees/fix-1103', '/r/.agents/worktrees/fix-110')).toBe(false);
    expect(isInside('/r/.agents/worktrees/fix-110-old', '/r/.agents/worktrees/fix-110')).toBe(false);
  });

  it('does not treat a parent or an unrelated path as inside', () => {
    expect(isInside('/r/.agents/worktrees', '/r/.agents/worktrees/fix-110')).toBe(false);
    expect(isInside('/elsewhere', '/r/.agents/worktrees/fix-110')).toBe(false);
  });
});

describe('parseWorktreePorcelain', () => {
  it('parses branch, detached and locked records', () => {
    const out = [
      'worktree /repo',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /repo/.agents/worktrees/a',
      'HEAD def',
      'branch refs/heads/feat/a',
      'locked',
      '',
      'worktree /repo/.agents/worktrees/b',
      'HEAD 123',
      'detached',
    ].join('\n');
    const e = parseWorktreePorcelain(out);
    expect(e).toHaveLength(3);
    expect(e[0].branch).toBe('main');
    expect(e[1].branch).toBe('feat/a');
    expect(e[1].locked).toBe(true);
    expect(e[2].branch).toBeNull();
    expect(e[2].detached).toBe(true);
  });
});

describe('against real repositories', () => {
  let base: string;
  let origin: string;
  let repo: string;

  beforeAll(async () => {
    // NOT under /tmp: main-branch-guard treats a git primary there as protected
    // (PHNX-2732), and these fixtures write into their own checkouts.
    base = await fs.mkdtemp(path.join(os.homedir(), '.agents-reclaim-test-'));
    origin = path.join(base, 'origin.git');
    repo = path.join(base, 'repo');
    await execFileAsync('git', [...G, 'init', '--bare', '-b', 'main', origin]);
    await execFileAsync('git', [...G, 'clone', origin, repo]);
    await fs.writeFile(path.join(repo, 'a.txt'), 'one\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'init']);
    await git(repo, ['push', '-u', 'origin', 'main']);
  });

  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('resolves the default ref', async () => {
    expect(await resolveDefaultRef(repo)).toMatch(/^origin\/(main|master)$/);
  });

  it('counts a REBASE-MERGED branch as fully merged though its SHAs differ', async () => {
    // The trap this module exists for: rebase rewrites SHAs, so ancestry says
    // "unmerged" for a branch that fully landed. Patch-id must say merged.
    const wt = path.join(base, 'wt-rebased');
    await git(repo, ['worktree', 'add', '-b', 'feat/rebased', wt, 'origin/main']);
    await fs.writeFile(path.join(wt, 'b.txt'), 'feature\n');
    await git(wt, ['add', '.']);
    await git(wt, ['commit', '-m', 'add b']);

    // Advance main FIRST, so replaying the patch lands it on a different parent
    // and therefore a different SHA — which is what a real rebase-merge does.
    // (Without this, `git am` onto the identical parent reproduces the exact
    // same SHA and the fixture stops exercising the trap at all.)
    await fs.writeFile(path.join(repo, 'unrelated.txt'), 'main moved on\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'unrelated main commit']);

    const patch = await git(wt, ['format-patch', '-1', '--stdout']);
    const pf = path.join(base, 'p.patch');
    await fs.writeFile(pf, patch + '\n');
    await git(repo, ['am', pf]);
    await git(repo, ['push', 'origin', 'main']);
    await git(repo, ['fetch', 'origin']);

    const mainSha = await git(repo, ['rev-parse', 'origin/main']);
    const brSha = await git(wt, ['rev-parse', 'HEAD']);
    expect(brSha).not.toBe(mainSha); // SHAs genuinely differ

    // Ancestry — the naive check — is wrong here.
    let ancestor = true;
    try {
      await git(repo, ['merge-base', '--is-ancestor', 'feat/rebased', 'origin/main']);
    } catch {
      ancestor = false;
    }
    expect(ancestor).toBe(false);

    // Patch-id is right.
    expect(await countUnmergedCommits(wt, 'origin/main')).toBe(0);
  });

  it('counts a genuinely unpushed commit as unmerged', async () => {
    const wt = path.join(base, 'wt-unpushed');
    await git(repo, ['worktree', 'add', '-b', 'feat/unpushed', wt, 'origin/main']);
    await fs.writeFile(path.join(wt, 'c.txt'), 'never pushed\n');
    await git(wt, ['add', '.']);
    await git(wt, ['commit', '-m', 'unpushed work']);
    expect(await countUnmergedCommits(wt, 'origin/main')).toBeGreaterThan(0);
  });

  it('returns -1 (indeterminate) with no default ref', async () => {
    expect(await countUnmergedCommits(repo, null)).toBe(-1);
  });

  it('collects facts and flags the primary checkout', async () => {
    const all = await collectWorktrees(repo);
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all.filter((w) => w.isPrimary)).toHaveLength(1);
    expect(all.find((w) => w.isPrimary)!.path).toBe(repo);
  });

  it('REFUSES to reclaim a worktree holding unpushed work', async () => {
    const all = await collectWorktrees(repo);
    const target = all.find((w) => w.name === 'wt-unpushed')!;
    const res = await reclaimWorktree(repo, target, 0);
    expect(res.removed).toBe(false);
    expect(res.reason).toMatch(/not upstream/);
    await fs.access(target.path); // still on disk
  });

  it('REFUSES to reclaim a dirty worktree', async () => {
    const wt = path.join(base, 'wt-dirty');
    await git(repo, ['worktree', 'add', '-b', 'feat/dirty', wt, 'origin/main']);
    await fs.writeFile(path.join(wt, 'scratch.txt'), 'uncommitted\n');
    const all = await collectWorktrees(repo);
    const target = all.find((w) => w.name === 'wt-dirty')!;
    expect(target.dirtyFiles).toBeGreaterThan(0);
    const res = await reclaimWorktree(repo, target, 0);
    expect(res.removed).toBe(false);
    expect(res.reason).toMatch(/uncommitted/);
    await fs.access(wt);
  });

  it('reclaims the rebase-merged worktree AND deletes its branch', async () => {
    const all = await collectWorktrees(repo);
    const target = all.find((w) => w.name === 'wt-rebased')!;
    expect(target.unmergedCommits).toBe(0);

    const res = await reclaimWorktree(repo, target, 0);
    expect(res.removed).toBe(true);
    // The -D fallback must fire: `-d` alone refuses a rebase-merged branch.
    expect(res.branchDeleted).toBe(true);

    await expect(fs.access(target.path)).rejects.toThrow();
    const branches = await git(repo, ['branch', '--list', 'feat/rebased']);
    expect(branches).toBe('');
  });

  it('REFUSES a worktree that gained a commit AFTER the facts were collected', async () => {
    // The mid-sweep race. `sweep` snapshots every worktree, then removes them
    // one at a time — minutes of wall-clock on a box with 136 of them. An agent
    // that COMMITS into a worktree in that gap leaves the tree clean, so
    // `git worktree remove` has no objection, and the stale unmergedCommits===0
    // would then authorise `branch -D` and destroy the commit outright.
    const wt = path.join(base, 'wt-race');
    await git(repo, ['worktree', 'add', '-b', 'feat/race', wt, 'origin/main']);

    // Snapshot while it is genuinely clean and fully merged.
    const stale = (await collectWorktrees(repo)).find((w) => w.name === 'wt-race')!;
    expect(stale.dirtyFiles).toBe(0);
    expect(stale.unmergedCommits).toBe(0);

    // ...then work lands, and is committed, exactly as an agent would.
    await fs.writeFile(path.join(wt, 'race.txt'), 'landed mid-sweep\n');
    await git(wt, ['add', '.']);
    await git(wt, ['commit', '-m', 'work committed during the sweep']);

    const res = await reclaimWorktree(repo, stale, 0);
    expect(res.removed).toBe(false);
    expect(res.reason).toMatch(/not upstream/);
    await fs.access(wt); // checkout survived
    // and critically, the branch and its commit survived
    expect(await git(repo, ['branch', '--list', 'feat/race'])).toContain('feat/race');
    expect(await git(wt, ['log', '-1', '--pretty=%s'])).toBe('work committed during the sweep');
  });

  it('refreshFacts returns null once a worktree is deregistered', async () => {
    const wt = path.join(base, 'wt-gone');
    await git(repo, ['worktree', 'add', '-b', 'feat/gone', wt, 'origin/main']);
    const snap = (await collectWorktrees(repo)).find((w) => w.name === 'wt-gone')!;
    await git(repo, ['worktree', 'remove', wt]);
    expect(await refreshFacts(repo, snap)).toBeNull();
    // and reclaiming from that stale snapshot refuses rather than acting
    const res = await reclaimWorktree(repo, snap, 0);
    expect(res.removed).toBe(false);
    expect(res.reason).toMatch(/no longer a registered worktree/);
  });

  it('refuses a worktree inside the grace window even when merged', async () => {
    const wt = path.join(base, 'wt-fresh');
    await git(repo, ['worktree', 'add', '-b', 'feat/fresh', wt, 'origin/main']);
    const all = await collectWorktrees(repo);
    const target = all.find((w) => w.name === 'wt-fresh')!;
    expect(target.ageDays).toBe(0);
    const res = await reclaimWorktree(repo, target, 3);
    expect(res.removed).toBe(false);
    expect(res.reason).toMatch(/grace/);
  });
});
