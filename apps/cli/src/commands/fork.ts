/**
 * `agents fork <session>` — branch an existing conversation into a new,
 * independent session you can continue separately. The original is untouched.
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

/** Register the top-level `agents fork` command. */
export function registerForkCommand(program: Command): void {
  const cmd = program
    .command('fork <session>')
    .description('Branch a session into a new, independent copy you can continue separately. The original is untouched.')
    .option('--name <label>', 'Label for the fork (default: "fork of <original>")');

  setHelpSections(cmd, {
    examples: `
      # Fork a session by (partial) id, then continue the fork
      agents fork 4f3a9c21
      agents resume <new-id>

      # Give the fork a name
      agents fork 4f3a9c21 --name "try redis instead"
    `,
    notes: `
      - 'resume' continues the SAME conversation; 'fork' copies it under a new id so the two diverge.
      - The fork is a full copy of the conversation so far; continuing it never touches the original.
      - Resolve the session the same way as resume: an exact or prefix id fragment.
      - Currently supports: ${FORKABLE_AGENTS.join(', ')}. Other agents are a planned follow-up.
    `,
  });

  cmd.action(async (sessionArg: string, options: ForkOptions) => {
    // Resolve the source. Try the index first; only pay for a rescan if the id
    // isn't found yet (mirrors the resume path's freshen-then-lookup).
    let matches = findSessionsById(sessionArg, {});
    if (matches.length === 0) {
      await discoverSessions({});
      matches = findSessionsById(sessionArg, {});
    }

    if (matches.length === 0) {
      console.log(chalk.red(`No session matching "${sessionArg}".`));
      console.log(chalk.gray('List candidates with: agents sessions'));
      return;
    }
    if (matches.length > 1) {
      console.log(chalk.yellow(`"${sessionArg}" is ambiguous — ${matches.length} sessions match. Use a longer id:`));
      for (const m of matches.slice(0, 8)) {
        console.log(chalk.gray(`  ${m.shortId}  ${m.agent}  ${m.label || m.topic || ''}`));
      }
      return;
    }

    const source = matches[0];

    if (!isForkableAgent(source.agent)) {
      console.log(chalk.yellow(`fork does not support ${source.agent} sessions yet.`));
      console.log(chalk.gray(`  Supported: ${FORKABLE_AGENTS.join(', ')}.`));
      return;
    }

    let result;
    try {
      result = forkSession(source, { name: options.name });
    } catch (err) {
      console.log(chalk.red(`Could not fork ${source.shortId}: ${(err as Error).message}`));
      return;
    }

    console.log(chalk.green(`Forked ${source.shortId} -> ${result.shortId}`));
    console.log(chalk.gray(`  Label:    ${result.label}`));
    console.log(chalk.gray(`  Continue: agents resume ${result.shortId}`));
    console.log(chalk.gray(`  Original ${source.shortId} is untouched.`));
  });
}
