/**
 * Git worktree utilities for isolated agent execution.
 *
 * Creates/removes temporary worktrees so each teammate can work on
 * its own branch without interfering with others or the main checkout.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { safeJoin } from '../paths.js';

const execFileAsync = promisify(execFile);

const WORKTREE_NAME_RE = /^[A-Za-z0-9_-]+$/;

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

export async function getGitRoot(dir: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
  return stdout.trim();
}

/**
 * Check if a worktree directory has uncommitted changes.
 */
export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: worktreePath });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Default cap on diff text so one giant worktree can't blow up the serve dashboard. */
export const DEFAULT_DIFF_MAX_BYTES = 200_000;

/**
 * Return the uncommitted working-tree diff for a worktree (staged + unstaged,
 * relative to HEAD), capped so a huge diff can't overwhelm the read-only serve
 * dashboard. Read-only: shells out to `git diff HEAD` and never mutates state.
 * Returns '' when the path isn't a git worktree or has no pending changes.
 */
export async function gitDiff(
  worktreePath: string,
  maxBytes: number = DEFAULT_DIFF_MAX_BYTES,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', 'HEAD'], {
      cwd: worktreePath,
      maxBuffer: Math.max(maxBytes * 4, 1_000_000),
    });
    if (stdout.length > maxBytes) {
      return stdout.slice(0, maxBytes) + `\n… [diff truncated at ${maxBytes} bytes]`;
    }
    return stdout;
  } catch {
    return '';
  }
}

/**
 * Create a new git worktree for a teammate.
 *
 * @param repoDir - Directory inside the git repository
 * @param worktreeName - Name for the worktree (used in path and branch)
 * @returns The absolute path to the created worktree
 */
export async function createWorktree(repoDir: string, worktreeName: string): Promise<string> {
  if (!WORKTREE_NAME_RE.test(worktreeName)) {
    throw new Error(`Invalid worktree name: ${worktreeName}`);
  }
  const gitRoot = await getGitRoot(repoDir);
  const worktreePath = safeJoin(path.join(gitRoot, '.agents', 'worktrees'), worktreeName);
  const branchName = `agents/${worktreeName}`;

  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await execFileAsync('git', ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], {
    cwd: gitRoot,
  });

  return worktreePath;
}

/**
 * Remove a git worktree and optionally its branch.
 *
 * @param repoDir - Directory inside the main git repository (not the worktree)
 * @param worktreeName - Name of the worktree to remove
 * @param deleteBranch - Whether to delete the associated branch
 */
export async function removeWorktree(
  repoDir: string,
  worktreeName: string,
  deleteBranch = true
): Promise<void> {
  if (!WORKTREE_NAME_RE.test(worktreeName)) {
    throw new Error(`Invalid worktree name: ${worktreeName}`);
  }
  const gitRoot = await getGitRoot(repoDir);
  const worktreePath = safeJoin(path.join(gitRoot, '.agents', 'worktrees'), worktreeName);
  const branchName = `agents/${worktreeName}`;

  try {
    await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: gitRoot });
  } catch (err: any) {
    if (err.message?.includes('is not a working tree')) {
      await execFileAsync('git', ['worktree', 'prune'], { cwd: gitRoot });
    } else {
      throw err;
    }
  }

  if (deleteBranch) {
    try {
      await execFileAsync('git', ['branch', '-D', branchName], { cwd: gitRoot });
    } catch {
      // Branch might not exist; ignore
    }
  }
}

/**
 * Get the worktree path for a given name.
 */
export function getWorktreePath(gitRoot: string, worktreeName: string): string {
  if (!WORKTREE_NAME_RE.test(worktreeName)) {
    throw new Error(`Invalid worktree name: ${worktreeName}`);
  }
  return safeJoin(path.join(gitRoot, '.agents', 'worktrees'), worktreeName);
}

/**
 * Get the branch name for a worktree.
 */
export function getWorktreeBranch(worktreeName: string): string {
  return `agents/${worktreeName}`;
}
