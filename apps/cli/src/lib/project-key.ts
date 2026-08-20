/**
 * The one worktree-aware cwd -> project fold.
 *
 * Several surfaces bucket work "by project": the `agents sessions` overview,
 * the `agents feed` timeline, and anything else that has a cwd and needs a
 * stable repo-level key. They must agree, or the same session shows up under
 * `agents-cli` in one view and `my-branch-slug` in another — so the rule lives
 * here and every caller delegates.
 *
 * The rule: a worktree cwd (`…/<repo>/.agents/worktrees/<slug>[/sub]`) folds to
 * the REPO directory name, so a worktree groups with the repo it branched from;
 * any other path resolves to its own basename. {@link projectKeyFromCwd} is pure
 * — no filesystem, no git, so it works identically for a remote peer's events as
 * for local ones; {@link resolveProjectKey} adds the filesystem repo-root walk
 * for paths this machine can see.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const WORKTREE_SEGMENT = '/.agents/worktrees/';

/**
 * Resolve a stable project key from a working directory, or `undefined` when
 * the path carries nothing usable (empty, `/`, whitespace).
 */
export function projectKeyFromCwd(cwd?: string | null): string | undefined {
  if (!cwd) return undefined;
  const norm = cwd.replace(/\\/g, '/').replace(/\/+$/, '').trim();
  if (!norm) return undefined;
  const wtIdx = norm.indexOf(WORKTREE_SEGMENT);
  if (wtIdx > 0) {
    const repoPath = norm.slice(0, wtIdx);
    const base = repoPath.slice(repoPath.lastIndexOf('/') + 1);
    if (base) return base;
  }
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  return base || undefined;
}

/**
 * The git working-tree root containing `dir`, by walking up for a `.git` entry
 * — a directory in a normal checkout, a file in a linked worktree, so one
 * `existsSync` covers both. Filesystem-only: no `git` process per lookup, which
 * matters because a timeline can hold dozens of distinct cwds.
 *
 * Returns `undefined` when `dir` is not inside a repo, when it does not exist
 * (a path from another machine), or when the only repo found IS the home
 * directory — a dotfiles repo at `$HOME` would otherwise swallow every
 * non-project directory under it into one bogus "project".
 */
export function repoRootForCwd(dir: string, home: string = os.homedir()): string | undefined {
  const stop = path.resolve(home);
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current === stop ? undefined : current;
    // Never climb past $HOME: an ancestor of home (/tmp, /, ...) is not part of
    // any project this cwd belongs to, and treating one as the repo root would
    // let unrelated host state (e.g. a stray /tmp/.git) swallow every loose
    // directory under home. Mirrors the shim's own home boundary — see the codex
    // adapter's shimExecTail (lib/harness/adapters/codex.ts).
    if (current === stop) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * The main-repo `.agents` directory for a cwd, or `undefined` when the cwd is
 * not inside a repo.
 *
 * For a worktree cwd (`…/<repo>/.agents/worktrees/<slug>[/sub]`) this resolves
 * to the PRIMARY repo's `.agents` — the directory that actually holds the
 * worktrees — so a run started anywhere in the repo can write into any worktree.
 * For any other in-repo cwd it is `<repo-root>/.agents`.
 *
 * The single caller is Codex's `edit`-mode writable-root list: Codex's
 * `workspace-write` sandbox hardcodes `.agents/` (and `.codex/`) as read-only,
 * but naming the `.agents` directory itself as an explicit writable root
 * overrides that — so an in-repo build/test never hits EROFS on a path under
 * `.agents/worktrees/`. Filesystem-only (no `git` process): reuses the same
 * worktree-segment fold as {@link projectKeyFromCwd}.
 */
export function repoAgentsDirForCwd(cwd?: string | null, home?: string): string | undefined {
  if (!cwd) return undefined;
  const norm = cwd.replace(/\\/g, '/').replace(/\/+$/, '').trim();
  if (!norm) return undefined;
  const wtIdx = norm.indexOf(WORKTREE_SEGMENT);
  const repoRoot = wtIdx > 0 ? norm.slice(0, wtIdx) : repoRootForCwd(norm, home);
  return repoRoot ? path.join(repoRoot, '.agents') : undefined;
}

/**
 * Resolve the project key for a cwd **on this machine**: the repository it
 * belongs to when there is one (so a monorepo subdir like `<repo>/apps/cli`
 * groups under `<repo>`, not `cli`), else the directory itself.
 *
 * Each machine resolves its own paths — a peer answering a fan-out stamps the
 * project for its events before they cross the wire — so this is never asked
 * about a path it cannot see. {@link projectKeyFromCwd} is the pure fold for
 * everything else.
 */
export function resolveProjectKey(cwd?: string | null, home?: string): string | undefined {
  if (!cwd) return undefined;
  const root = repoRootForCwd(cwd, home);
  return projectKeyFromCwd(root ?? cwd);
}
