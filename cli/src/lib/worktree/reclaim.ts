/**
 * Reclaiming PR-bound agent worktrees (PHNX-3503).
 *
 * Worktree law puts every tracked change in `<repo>/.agents/worktrees/<slug>/`,
 * but nothing ever removed one: `gh pr merge --delete-branch` drops the branch
 * and leaves the checkout, `git branch -d/-D` is denied to agents on purpose,
 * and `git worktree remove` was allowed but nobody was told to run it. Measured
 * 2026-08-30: 581 worktrees / ~263 GB across the fleet, which wedged the release
 * home base at 1.6 GiB free (PHNX-3478).
 *
 * The safety property that lets this delete a branch when agents may not:
 * **authority comes from the merge, never from the caller's judgement.** Every
 * check below fails CLOSED — an unknown answer is a blocker, not a pass.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execFileAsync = promisify(execFile);

/** Worktree dir names are slugs; anything else is refused rather than shelled. */
const WORKTREE_NAME_RE = /^[A-Za-z0-9._-]+$/;

export type ReclaimBlocker =
  | 'primary-checkout'
  | 'uncommitted-changes'
  | 'unmerged-commits'
  | 'within-grace'
  | 'locked'
  | 'indeterminate';

/**
 * Everything the verdict depends on, gathered once so the decision itself stays
 * pure and unit-testable without a git fixture per case.
 */
export interface WorktreeFacts {
  name: string;
  path: string;
  /** null for a detached HEAD — reclaimable on commit reachability alone. */
  branch: string | null;
  isPrimary: boolean;
  locked: boolean;
  /**
   * `git status --porcelain` line count (untracked included, since porcelain
   * lists them as `??`). Negative means "could not be determined", which is a
   * blocker — never read as clean.
   */
  dirtyFiles: number;
  /**
   * Commits on this worktree with NO patch-equivalent upstream, via
   * `git cherry` — negative means "could not determine", which is a blocker.
   *
   * Patch-id, not ancestry, is load-bearing: this fleet rebase-merges, so a
   * merged branch's SHAs are rewritten and `merge-base --is-ancestor` reports
   * *not merged* for a branch that fully landed (verified against the
   * rebase-merged phnx-2732-hook-tests: ancestor=no, cherry=0 unmerged). It also
   * subsumes the unpushed check — an unpushed commit has no upstream equivalent,
   * so it surfaces as unmerged rather than needing a separate probe.
   */
  unmergedCommits: number;
  /** Whole days since the worktree dir was last modified. */
  ageDays: number;
}

export interface ReclaimVerdict {
  reclaimable: boolean;
  blockers: ReclaimBlocker[];
}

/**
 * Decide whether a worktree may be removed. Pure.
 *
 * Reclaimable only when every one of these holds: not the primary checkout, not
 * locked, no uncommitted changes, no commits missing upstream, and older than
 * the grace window. `unmergedCommits < 0` (undeterminable) yields
 * `indeterminate` so an unreachable remote or a broken repo can never read as
 * "safe to delete".
 */
export function classifyWorktree(facts: WorktreeFacts, graceDays: number): ReclaimVerdict {
  const blockers: ReclaimBlocker[] = [];
  if (facts.isPrimary) blockers.push('primary-checkout');
  if (facts.locked) blockers.push('locked');
  // Negative means "could not be read". A status we failed to read is NOT a
  // clean status: an index.lock held by a live agent lands here, and that is
  // precisely when the tree is most likely to be holding work.
  if (facts.dirtyFiles < 0) blockers.push('indeterminate');
  else if (facts.dirtyFiles > 0) blockers.push('uncommitted-changes');
  if (facts.unmergedCommits < 0) {
    if (!blockers.includes('indeterminate')) blockers.push('indeterminate');
  } else if (facts.unmergedCommits > 0) blockers.push('unmerged-commits');
  if (facts.ageDays < graceDays) blockers.push('within-grace');
  return { reclaimable: blockers.length === 0, blockers };
}

/** Human-readable reason, for the `list`/`sweep` tables and the skip log. */
export function describeBlocker(b: ReclaimBlocker): string {
  switch (b) {
    case 'primary-checkout':
      return 'is the primary checkout';
    case 'uncommitted-changes':
      return 'has uncommitted changes';
    case 'unmerged-commits':
      return 'has commits not upstream';
    case 'within-grace':
      return 'inside the grace window';
    case 'locked':
      return 'is locked';
    case 'indeterminate':
      return 'merge state could not be determined';
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Resolve the default branch ref to compare against: `origin/HEAD` when set,
 * else whichever of `origin/main` / `origin/master` exists. Returns null when
 * none resolve, which makes every worktree `indeterminate` rather than
 * silently comparing against nothing.
 */
export async function resolveDefaultRef(repoRoot: string): Promise<string | null> {
  try {
    const head = await git(repoRoot, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']);
    if (head) return head;
  } catch {
    /* fall through to the probes below */
  }
  for (const ref of ['origin/main', 'origin/master']) {
    try {
      await git(repoRoot, ['rev-parse', '--verify', '--quiet', ref]);
      return ref;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Count commits with no patch-equivalent upstream. Returns -1 when the answer
 * cannot be established, which `classifyWorktree` treats as a blocker.
 */
export async function countUnmergedCommits(
  worktreePath: string,
  defaultRef: string | null,
): Promise<number> {
  if (!defaultRef) return -1;
  try {
    const out = await git(worktreePath, ['cherry', defaultRef, 'HEAD']);
    if (!out) return 0;
    return out.split('\n').filter((l) => l.startsWith('+')).length;
  } catch {
    return -1;
  }
}

/**
 * True when `child` is `parent` or sits beneath it, compared on path
 * boundaries. A raw `startsWith` makes `.../fix-1103` look like it is inside
 * `.../fix-110`, so `done` run from one worktree would reclaim its neighbour.
 */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/** One `git worktree list --porcelain` record. */
interface PorcelainEntry {
  path: string;
  branch: string | null;
  locked: boolean;
  detached: boolean;
}

export function parseWorktreePorcelain(out: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  let cur: PorcelainEntry | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur);
      cur = { path: line.slice('worktree '.length), branch: null, locked: false, detached: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'locked' || line.startsWith('locked ')) {
      cur.locked = true;
    } else if (line === 'detached') {
      cur.detached = true;
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

/**
 * Gather facts for every worktree registered in `repoRoot`. Read-only.
 *
 * The primary checkout is the first porcelain record, which git always lists
 * first; it is included (flagged `isPrimary`) rather than filtered out so a
 * caller that names it explicitly still gets a refusal with a reason instead of
 * an empty result.
 */
export async function collectWorktrees(repoRoot: string): Promise<WorktreeFacts[]> {
  const porcelain = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  const entries = parseWorktreePorcelain(porcelain);
  const defaultRef = await resolveDefaultRef(repoRoot);
  const now = Date.now();

  const facts: WorktreeFacts[] = [];
  for (const [i, e] of entries.entries()) {
    facts.push(await factsForEntry(e, i === 0, defaultRef, now));
  }
  return facts;
}

/**
 * Gather the facts for a single porcelain entry. Shared by `collectWorktrees`
 * and `refreshFacts` so a re-read is guaranteed to apply the same probes and
 * the same fail-closed defaults as the original read.
 */
async function factsForEntry(
  e: PorcelainEntry,
  isPrimary: boolean,
  defaultRef: string | null,
  now: number,
): Promise<WorktreeFacts> {
  let missing = false;
  try {
    await fs.access(e.path);
  } catch {
    missing = true;
  }

  let dirtyFiles = -1;
  let ageDays = 0;
  let unmergedCommits = -1;
  if (!missing) {
    try {
      const status = await git(e.path, ['status', '--porcelain']);
      dirtyFiles = status ? status.split('\n').length : 0;
    } catch {
      dirtyFiles = -1;
    }
    try {
      const st = await fs.stat(e.path);
      ageDays = Math.floor((now - st.mtimeMs) / 86_400_000);
    } catch {
      ageDays = 0;
    }
    unmergedCommits = await countUnmergedCommits(e.path, defaultRef);
  }

  return {
    name: path.basename(e.path),
    path: e.path,
    branch: e.branch,
    isPrimary,
    locked: e.locked,
    // A registered worktree whose directory is gone is pure bookkeeping —
    // `git worktree prune` is the correct fix and is always safe.
    dirtyFiles: missing ? 0 : dirtyFiles,
    unmergedCommits: missing ? 0 : unmergedCommits,
    ageDays: missing ? Number.MAX_SAFE_INTEGER : ageDays,
  };
}

/**
 * Re-read one worktree's facts from git, right now.
 *
 * `sweep` collects facts once and then removes sequentially; on a box with 136
 * worktrees that is minutes of wall-clock, so any verdict taken from the
 * original snapshot is a claim about the past. An agent that commits into a
 * worktree mid-sweep leaves the tree CLEAN, so `git worktree remove` — which
 * only objects to uncommitted changes — would happily remove it, and the stale
 * `unmergedCommits === 0` would then authorise `branch -D` and destroy the new
 * commit. Returns null when the worktree is no longer registered, which the
 * caller must treat as a refusal.
 */
export async function refreshFacts(
  repoRoot: string,
  target: WorktreeFacts,
): Promise<WorktreeFacts | null> {
  const entries = parseWorktreePorcelain(
    await git(repoRoot, ['worktree', 'list', '--porcelain']),
  );
  const idx = entries.findIndex((e) => e.path === target.path);
  if (idx < 0) return null;
  const defaultRef = await resolveDefaultRef(repoRoot);
  return factsForEntry(entries[idx], idx === 0, defaultRef, Date.now());
}

export interface ReclaimResult {
  name: string;
  removed: boolean;
  branchDeleted: boolean;
  reason?: string;
}

/**
 * Remove one worktree and, when it had a branch, delete that branch.
 *
 * Re-verifies the verdict immediately before mutating — a caller may have
 * collected facts minutes ago and an agent may have written into the tree since.
 * Never uses `--force`: a refusal from git itself is a second, independent
 * opinion that the tree is not clean, and overriding it would defeat the point.
 */
export async function reclaimWorktree(
  repoRoot: string,
  facts: WorktreeFacts,
  graceDays: number,
): Promise<ReclaimResult> {
  if (!WORKTREE_NAME_RE.test(facts.name)) {
    return { name: facts.name, removed: false, branchDeleted: false, reason: 'unsafe worktree name' };
  }
  // Decide on facts read NOW, not on the caller's snapshot. Re-reading is the
  // whole point of this step; reusing `facts` would re-derive the same verdict
  // from the same stale inputs and prove nothing.
  let fresh: WorktreeFacts | null;
  try {
    fresh = await refreshFacts(repoRoot, facts);
  } catch (err: any) {
    return {
      name: facts.name,
      removed: false,
      branchDeleted: false,
      reason: `could not re-verify: ${String(err?.stderr || err?.message || err).trim()}`,
    };
  }
  if (!fresh) {
    return {
      name: facts.name,
      removed: false,
      branchDeleted: false,
      reason: 'no longer a registered worktree',
    };
  }

  const verdict = classifyWorktree(fresh, graceDays);
  if (!verdict.reclaimable) {
    return {
      name: fresh.name,
      removed: false,
      branchDeleted: false,
      reason: verdict.blockers.map(describeBlocker).join(', '),
    };
  }

  try {
    await git(repoRoot, ['worktree', 'remove', fresh.path]);
  } catch (err: any) {
    const msg = String(err?.stderr || err?.message || err);
    if (/is not a working tree|does not exist/i.test(msg)) {
      await git(repoRoot, ['worktree', 'prune']);
    } else {
      return { name: fresh.name, removed: false, branchDeleted: false, reason: msg.trim() };
    }
  }

  let branchDeleted = false;
  if (fresh.branch) {
    // Try `-d` first so git's own ancestry check gets to agree when it can.
    // It CANNOT agree under this fleet's rebase-merge: `-d` tests reachability,
    // and a rebase rewrites the SHAs, so it refuses "not fully merged" for a
    // branch that fully landed. Insisting on `-d` would therefore leave every
    // merged branch behind — half the leak. The `-D` fallback is gated on the
    // patch-id verdict (`unmergedCommits === 0`), which is the check that IS
    // correct for rewritten history, so nothing is force-dropped on the
    // caller's say-so alone.
    try {
      await git(repoRoot, ['branch', '-d', fresh.branch]);
      branchDeleted = true;
    } catch {
      if (fresh.unmergedCommits === 0) {
        try {
          await git(repoRoot, ['branch', '-D', fresh.branch]);
          branchDeleted = true;
        } catch {
          branchDeleted = false;
        }
      }
    }
  }
  return { name: fresh.name, removed: true, branchDeleted };
}
