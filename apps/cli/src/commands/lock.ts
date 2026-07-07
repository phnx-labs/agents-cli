/**
 * `agents lock` — write a deterministic `agents.lock` for the resolved resource
 * set at the project root; `agents lock --frozen` verifies the live resources
 * match that lock EXACTLY and fails closed (non-zero exit + a clear diff) on any
 * drift. The reproducible-CI slice of governance #337.
 *
 * This is OFF the default path: normal `agents add` / `agents sync` never touch
 * the lock. Generation and verification only run when this command is invoked.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
  enumerateLockSources,
  buildLock,
  writeLock,
  readLock,
  verifyLock,
  lockDiffIsClean,
  resolveProjectRoot,
  LOCK_FILENAME,
} from '../lib/lock.js';

interface LockOpts {
  cwd?: string;
  frozen?: boolean;
}

/** Register the `agents lock` command. */
export function registerLockCommand(program: Command): void {
  program
    .command('lock')
    .summary('Write or verify agents.lock — a SHA-256 manifest of resolved resources')
    .description(
      'Capture a deterministic SHA-256 per resolved resource file (commands, skills, hooks, rules, mcp, permissions, subagents — project > user > system > extras) into an agents.lock at the project root.\n\n' +
        'Run bare to (re)generate the lock. Pass --frozen to VERIFY the live resolved resources match an existing agents.lock exactly — it exits non-zero with an added/removed/changed diff on any mismatch, and errors if no lock exists yet. That is the reproducible-CI gate; normal installs and syncs are unaffected.',
    )
    .option('--cwd <path>', 'Working directory to resolve resources and the project root from')
    .option('--frozen', 'Verify resolved resources match agents.lock exactly; fail (non-zero) on any drift', false)
    .action((opts: LockOpts) => {
      runLock(opts);
    });
}

function runLock(opts: LockOpts): void {
  const cwd = opts.cwd || process.cwd();
  const projectRoot = resolveProjectRoot(cwd);
  const sources = enumerateLockSources(cwd);

  if (opts.frozen) {
    verifyFrozen(projectRoot, sources);
    return;
  }

  const lock = buildLock(sources);
  const written = writeLock(projectRoot, lock);
  const count = Object.keys(lock.resources).length;
  console.log(
    chalk.green(`Wrote ${LOCK_FILENAME}`) +
      chalk.gray(` — ${count} resource file(s) → ${written}`),
  );
}

function verifyFrozen(projectRoot: string, sources: ReturnType<typeof enumerateLockSources>): void {
  let existing;
  try {
    existing = readLock(projectRoot);
  } catch (e) {
    console.error(chalk.red(`agents lock --frozen: ${(e as Error).message}`));
    process.exitCode = 1;
    return;
  }
  if (!existing) {
    console.error(chalk.red(`No ${LOCK_FILENAME} at ${projectRoot}.`));
    console.error(chalk.gray('Generate one first: agents lock'));
    process.exitCode = 1;
    return;
  }

  const diff = verifyLock(existing, sources);
  if (lockDiffIsClean(diff)) {
    const count = Object.keys(existing.resources).length;
    console.log(chalk.green(`✓ ${count} resource file(s) match ${LOCK_FILENAME}`));
    return;
  }

  console.error(chalk.red(`✗ resources drifted from ${LOCK_FILENAME}:`));
  for (const key of diff.changed) console.error(chalk.yellow(`  changed  ${key}`));
  for (const key of diff.added) console.error(chalk.yellow(`  added    ${key}`));
  for (const key of diff.removed) console.error(chalk.yellow(`  removed  ${key}`));
  console.error(chalk.gray('Re-lock once the change is intended: agents lock'));
  process.exitCode = 1;
}
