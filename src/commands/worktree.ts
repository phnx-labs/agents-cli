/**
 * agents worktree -- provision, release, and prune per-terminal git worktrees.
 *
 * Used by surfaces that want to spawn each agent terminal in an isolated
 * working tree (Swarmify extension opt-in toggle). Mirrors the in-process
 * worktree helpers in lib/teams/worktree.ts but exposes them as a CLI so
 * other processes (IDE extensions, shell aliases, hooks) can call them.
 *
 *   agents worktree provision <terminal-id>   -> prints absolute worktree path
 *   agents worktree release   <terminal-id>   -> removes if clean + merged
 *   agents worktree prune                     -> removes every clean+merged one
 *
 * Worktrees live at <repo>/.agents/worktrees/<terminal-id>, on a branch
 * named agent/<terminal-id>. The branch starts at HEAD of the parent repo.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const WORKTREE_SUBDIR = path.join('.agents', 'worktrees');
const BRANCH_PREFIX = 'agent/';

function die(msg: string, code = 1): never {
  console.error(chalk.red(msg));
  process.exit(code);
}

function isValidTerminalId(id: string): boolean {
  // Allow letters, digits, dot, dash, underscore. Reject anything else so a
  // hostile or buggy caller can't inject path traversal or shell metachars.
  return /^[A-Za-z0-9._-]+$/.test(id) && id.length > 0 && id.length <= 128;
}

async function gitRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
    return stdout.trim();
  } catch {
    die(`Not inside a git repo: ${cwd}`);
  }
}

function worktreePathFor(root: string, terminalId: string): string {
  return path.join(root, WORKTREE_SUBDIR, terminalId);
}

function branchNameFor(terminalId: string): string {
  return `${BRANCH_PREFIX}${terminalId}`;
}

interface SafetyReport {
  exists: boolean;
  dirty: boolean;
  aheadOfUpstream: boolean;
  hasUpstream: boolean;
  branchMerged: boolean;
}

async function inspect(root: string, terminalId: string): Promise<SafetyReport> {
  const wt = worktreePathFor(root, terminalId);
  const branch = branchNameFor(terminalId);
  const exists = fsSync.existsSync(wt);
  if (!exists) {
    return { exists: false, dirty: false, aheadOfUpstream: false, hasUpstream: false, branchMerged: false };
  }

  let dirty = false;
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: wt });
    dirty = stdout.trim().length > 0;
  } catch {
    dirty = true; // err on the side of caution
  }

  let hasUpstream = false;
  let aheadOfUpstream = false;
  try {
    await execFileAsync('git', ['rev-parse', '--abbrev-ref', '@{u}'], { cwd: wt });
    hasUpstream = true;
    const { stdout } = await execFileAsync('git', ['rev-list', '--count', '@{u}..HEAD'], { cwd: wt });
    aheadOfUpstream = parseInt(stdout.trim(), 10) > 0;
  } catch {
    hasUpstream = false; // never pushed -- treat as "has commits we'd lose"
  }

  let branchMerged = false;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['branch', '--merged', 'origin/main', '--list', branch],
      { cwd: root }
    );
    branchMerged = stdout.trim().length > 0;
  } catch {
    branchMerged = false;
  }

  return { exists, dirty, aheadOfUpstream, hasUpstream, branchMerged };
}

async function provision(root: string, terminalId: string): Promise<string> {
  const wt = worktreePathFor(root, terminalId);
  const branch = branchNameFor(terminalId);

  if (fsSync.existsSync(wt)) return wt;

  await fs.mkdir(path.dirname(wt), { recursive: true });

  // If the branch already exists (e.g. left over from a previous run), reuse
  // it instead of failing. Surfaces typically reuse a terminal-id when
  // restoring a session.
  let branchExists = false;
  try {
    await execFileAsync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: root });
    branchExists = true;
  } catch {
    branchExists = false;
  }

  const args = branchExists
    ? ['worktree', 'add', wt, branch]
    : ['worktree', 'add', '-b', branch, wt, 'HEAD'];

  await execFileAsync('git', args, { cwd: root });
  return wt;
}

async function release(root: string, terminalId: string, force: boolean): Promise<{ removed: boolean; reason?: string }> {
  const wt = worktreePathFor(root, terminalId);
  const branch = branchNameFor(terminalId);

  if (!fsSync.existsSync(wt)) {
    // Already gone; treat as success but tell the caller.
    return { removed: false, reason: 'worktree does not exist' };
  }

  if (!force) {
    const report = await inspect(root, terminalId);
    if (report.dirty) return { removed: false, reason: 'worktree has uncommitted changes' };
    if (!report.hasUpstream) {
      // Local-only commits exist if HEAD differs from origin/main.
      try {
        const { stdout } = await execFileAsync('git', ['rev-list', '--count', 'origin/main..HEAD'], { cwd: wt });
        if (parseInt(stdout.trim(), 10) > 0) {
          return { removed: false, reason: 'branch has local commits not on origin/main' };
        }
      } catch {
        return { removed: false, reason: 'cannot verify branch state vs origin/main' };
      }
    }
    if (report.aheadOfUpstream) return { removed: false, reason: 'branch has unpushed commits' };
  }

  try {
    await execFileAsync('git', ['worktree', 'remove', force ? '--force' : '', wt].filter(Boolean), { cwd: root });
  } catch (err: any) {
    if (err.message?.includes('is not a working tree')) {
      await execFileAsync('git', ['worktree', 'prune'], { cwd: root });
    } else {
      throw err;
    }
  }

  // Delete the branch if it's safe to do so. -d (lowercase) refuses to drop
  // an unmerged branch by itself, which is exactly the safety net we want.
  try {
    await execFileAsync('git', ['branch', '-d', branch], { cwd: root });
  } catch {
    // Branch may not exist or may not be merged. We already validated above;
    // leaving the branch behind is preferable to silently dropping commits.
  }

  return { removed: true };
}

async function listAgentWorktrees(root: string): Promise<string[]> {
  const dir = path.join(root, WORKTREE_SUBDIR);
  if (!fsSync.existsSync(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter(e => e.isDirectory()).map(e => e.name);
}

export function registerWorktreeCommands(program: Command): void {
  const wt = program
    .command('worktree')
    .description('Provision, release, and prune per-terminal git worktrees for agent isolation.')
    .addHelpText('after', `\nWorktrees live at <repo>/.agents/worktrees/<terminal-id> on branch agent/<terminal-id>.\n\nExamples:\n  agents worktree provision CC-1747509823-3\n  agents worktree release CC-1747509823-3\n  agents worktree prune --dry-run\n`);

  wt.command('provision <terminal-id>')
    .description('Create (or reuse) an isolated worktree for an agent terminal. Prints the absolute path.')
    .option('--root <path>', 'Repo root (defaults to current working directory)')
    .action(async (terminalId: string, opts: { root?: string }) => {
      if (!isValidTerminalId(terminalId)) {
        die(`Invalid terminal-id: ${terminalId} (allowed: [A-Za-z0-9._-], <=128 chars)`);
      }
      const root = await gitRoot(opts.root ?? process.cwd());
      const wtPath = await provision(root, terminalId);
      console.log(wtPath);
    });

  wt.command('release <terminal-id>')
    .description('Remove the worktree if clean and the branch is merged or has no unpushed commits.')
    .option('--root <path>', 'Repo root (defaults to current working directory)')
    .option('--force', 'Skip safety checks (DANGEROUS: discards unpushed work)')
    .action(async (terminalId: string, opts: { root?: string; force?: boolean }) => {
      if (!isValidTerminalId(terminalId)) {
        die(`Invalid terminal-id: ${terminalId} (allowed: [A-Za-z0-9._-], <=128 chars)`);
      }
      const root = await gitRoot(opts.root ?? process.cwd());
      const result = await release(root, terminalId, Boolean(opts.force));
      if (result.removed) {
        console.log(chalk.green(`removed ${worktreePathFor(root, terminalId)}`));
      } else {
        console.log(chalk.yellow(`kept ${worktreePathFor(root, terminalId)} (${result.reason})`));
      }
    });

  wt.command('prune')
    .description('Try to release every agent worktree under .agents/worktrees/. Skips dirty or unpushed ones.')
    .option('--root <path>', 'Repo root (defaults to current working directory)')
    .option('--dry-run', 'Report what would be removed without touching anything')
    .action(async (opts: { root?: string; dryRun?: boolean }) => {
      const root = await gitRoot(opts.root ?? process.cwd());
      const ids = await listAgentWorktrees(root);
      if (ids.length === 0) {
        console.log(chalk.gray('no agent worktrees to prune'));
        return;
      }
      for (const id of ids) {
        if (!isValidTerminalId(id)) {
          console.log(chalk.yellow(`skip ${id} (name not in expected format)`));
          continue;
        }
        if (opts.dryRun) {
          const report = await inspect(root, id);
          const blocker = report.dirty
            ? 'dirty'
            : report.aheadOfUpstream
              ? 'unpushed'
              : !report.hasUpstream
                ? 'never pushed'
                : null;
          if (blocker) {
            console.log(chalk.yellow(`keep   ${id} (${blocker})`));
          } else {
            console.log(chalk.green(`remove ${id}`));
          }
          continue;
        }
        const result = await release(root, id, false);
        if (result.removed) {
          console.log(chalk.green(`removed ${id}`));
        } else {
          console.log(chalk.yellow(`kept    ${id} (${result.reason})`));
        }
      }
    });
}
