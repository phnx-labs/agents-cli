/**
 * `agents sessions fork <session>` — branch an existing conversation into a new,
 * independent session you can continue separately. The original is untouched.
 * Also exposed as the hidden top-level alias `agents fork` (back-compat).
 *
 * Thin command layer; the copy/register logic lives in `lib/session/fork.ts`.
 */
import type { Command } from 'commander';
import chalk from 'chalk';

import { setHelpSections } from '../lib/help.js';
import { findSessionsById } from '../lib/session/db.js';
import { discoverSessions } from '../lib/session/discover.js';
import { forkSession, isForkableAgent, FORKABLE_AGENTS } from '../lib/session/fork.js';

interface ForkOptions {
  name?: string;
}

const FORK_HELP = {
  examples: `
    # Fork a session by (partial) id, then continue the fork
    agents sessions fork 4f3a9c21
    agents sessions resume <new-id>

    # Give the fork a name
    agents sessions fork 4f3a9c21 --name "try redis instead"
  `,
  notes: `
    - 'resume' continues the SAME conversation; 'fork' copies it under a new id so the two diverge.
    - The fork is a full copy of the conversation so far; continuing it never touches the original.
    - Resolve the session the same way as resume: an exact or prefix id fragment.
    - Native copy currently supports: ${FORKABLE_AGENTS.join(', ')}. For other harnesses, branch by
      starting a fresh agent and seeding it with '/continue <id>' — the source stays put.
  `,
};

/**
 * Resolve the source session, copy it under a fresh id, and print how to
 * continue the fork. Shared by `agents sessions fork` and the `agents fork` alias.
 */
export async function runFork(sessionArg: string, options: ForkOptions): Promise<void> {
  // Resolve the source. Try the index first; only pay for a rescan if the id
  // isn't found yet (mirrors the resume path's freshen-then-lookup).
  let matches = findSessionsById(sessionArg, {});
  if (matches.length === 0) {
    await discoverSessions({});
    matches = findSessionsById(sessionArg, {});
  }

  if (matches.length === 0) {
    // Errors go to stderr and set a non-zero exit code so a script chaining on
    // `agents sessions fork <id> && agents sessions resume <new>` doesn't proceed
    // on a failed fork.
    console.error(chalk.red(`No session matching "${sessionArg}".`));
    console.error(chalk.gray('List candidates with: agents sessions'));
    process.exitCode = 1;
    return;
  }
  if (matches.length > 1) {
    console.error(chalk.yellow(`"${sessionArg}" is ambiguous — ${matches.length} sessions match. Use a longer id:`));
    for (const m of matches.slice(0, 8)) {
      console.error(chalk.gray(`  ${m.shortId}  ${m.agent}  ${m.label || m.topic || ''}`));
    }
    process.exitCode = 1;
    return;
  }

  const source = matches[0];

  if (!isForkableAgent(source.agent)) {
    // A native copy needs the agent's transcript to be resumable by id; harnesses
    // without that can still be branched by hand. Fail loud with the manual path
    // rather than a silent no-op or a fake copy.
    console.error(chalk.yellow(`A native fork copy isn't supported for ${source.agent} sessions yet (supported: ${FORKABLE_AGENTS.join(', ')}).`));
    console.error(chalk.gray(`  Branch it by hand — start a fresh ${source.agent} and seed it with the source's context:`));
    console.error(chalk.gray(`    agents run ${source.agent} --terminal   # then, in the new session:`));
    console.error(chalk.gray(`    /continue ${source.shortId}`));
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = forkSession(source, { name: options.name });
  } catch (err) {
    console.error(chalk.red(`Could not fork ${source.shortId}: ${(err as Error).message}`));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.green(`Forked ${source.shortId} -> ${result.shortId}`));
  console.log(chalk.gray(`  Label:    ${result.label}`));
  console.log(chalk.gray(`  Continue: agents sessions resume ${result.shortId}`));
  console.log(chalk.gray(`  Original ${source.shortId} is untouched.`));
}

/**
 * Register `agents sessions fork <session>` — the canonical surface (fork is a
 * session operation, so it lives under the `sessions` group).
 */
export function registerSessionsForkCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('fork <session>')
    .description('Branch a session into a new, independent copy you can continue separately. The original is untouched.')
    .option('--name <label>', 'Label for the fork (default: "fork of <original>")');

  setHelpSections(cmd, FORK_HELP);
  cmd.action(runFork);
}

/**
 * Register the hidden top-level `agents fork` alias. Kept working for back-compat
 * and muscle memory; the canonical, discoverable surface is `agents sessions fork`.
 */
export function registerForkCommand(program: Command): void {
  const cmd = program
    .command('fork <session>', { hidden: true })
    .description('Alias for `agents sessions fork` — branch a session into a new, independent copy.')
    .option('--name <label>', 'Label for the fork (default: "fork of <original>")');

  cmd.action(runFork);
}
