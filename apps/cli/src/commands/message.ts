/**
 * `agents message <target> <text>` — send a message to a running agent.
 *
 * Unifies two delivery paths behind one verb:
 *   - a live LOCAL/teams/loop agent → enqueue into its file-spool mailbox; the
 *     PreToolUse hook injects it at the agent's next tool call.
 *   - a CLOUD task id → the existing provider follow-up path (was
 *     `agents cloud message`).
 *
 * Cross-host is handled one layer up: `--host <h>` routes the whole command over
 * ssh via `REMOTE_PASSTHROUGH` (see src/lib/hosts/passthrough.ts), so the box is
 * written on the host that actually owns the agent.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { getActiveSessions } from '../lib/session/active.js';
import { getTaskById, updateTaskStatus } from '../lib/cloud/store.js';
import { resolveProvider } from '../lib/cloud/registry.js';
import { mailboxDir, enqueue } from '../lib/mailbox.js';
import { resolveMessageTarget } from '../lib/mailbox-target.js';

function die(msg: string, code = 1): never {
  console.error(chalk.red(msg));
  process.exit(code);
}

export function registerMessageCommand(program: Command): void {
  program
    .command('message <target> <text>')
    .description('Send a message to a running agent (delivered at its next tool call) or a cloud task.')
    .option('--from <who>', 'Label recorded as the sender of this message')
    .action(async (target: string, text: string, opts: { from?: string }) => {
      if (!target.trim()) {
        die('Target must be a session/agent id or cloud task id. Run `agents sessions --active` to list running agents.');
      }
      const sessions = await getActiveSessions();
      const res = resolveMessageTarget(target, sessions, (id) => getTaskById(id) != null);

      switch (res.kind) {
        case 'cloud': {
          const task = getTaskById(res.id)!;
          const provider = resolveProvider(task.provider);
          try {
            await provider.message(res.id, text);
            updateTaskStatus(res.id, 'running');
            console.log(chalk.green(`Message sent to cloud task ${res.id}. Agent is continuing.`));
          } catch (err) {
            die((err as Error).message);
          }
          return;
        }
        case 'local': {
          try {
            const msgId = enqueue(mailboxDir(res.id), { to: res.id, text, from: opts.from });
            console.log(
              chalk.green(`Queued message ${msgId} for ${res.id}. `) +
                chalk.dim('The agent will see it at its next tool call.'),
            );
          } catch (err) {
            die((err as Error).message);
          }
          return;
        }
        case 'ambiguous': {
          const lines = res.candidates.map((c) => `  ${c.id}  ${chalk.dim(c.label)}`).join('\n');
          die(`"${target}" matches ${res.candidates.length} running agents:\n${lines}\nRe-run with a full id.`);
          return;
        }
        case 'none':
          die(`No running agent or cloud task matches "${target}". List targets with \`agents sessions --active\`.`);
      }
    });
}
