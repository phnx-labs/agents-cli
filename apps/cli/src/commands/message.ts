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
 *
 * For local agents, the message is tied to the agent's current open feed block
 * (if any). The first answer to a block wins: a second concurrent answer is
 * rejected with the surface that already answered. Delivery receipts
 * (queued → consumed → continued) are surfaced in the feed store.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { die } from '../lib/format.js';
import { getActiveSessions } from '../lib/session/active.js';
import { getTaskById, updateTaskStatus } from '../lib/cloud/store.js';
import { resolveProvider } from '../lib/cloud/registry.js';
import { mailboxDir, enqueue } from '../lib/mailbox.js';
import { resolveMessageTarget } from '../lib/mailbox-target.js';
import {
  blockIdForSession,
  listBlocks,
  readBlock,
  recordAnswer,
  recordMessageReceipt,
  type OpenBlock,
} from '../lib/feed.js';
import { getOperator } from '../lib/operator.js';

/** Find the still-open block addressed to `mailboxId`, if any. */
function findOpenBlockForMailbox(mailboxId: string): OpenBlock | undefined {
  // Fast path: the mailbox id is usually the session id, so the block id is
  // directly derivable. This avoids scanning the whole feed store.
  const direct = readBlock(blockIdForSession(mailboxId));
  if (direct && direct.mailboxId === mailboxId) return direct;
  // Fallback: scan (agentId-based mailbox ids, rare).
  return listBlocks().find((b) => b.mailboxId === mailboxId);
}

export function registerMessageCommand(program: Command): void {
  program
    .command('message <target> <text>')
    .description('Send a message to a running agent (delivered at its next tool call) or a cloud task.')
    .option('--from <who>', 'Label recorded as the sender of this message')
    .option('--as <operator>', 'Verified operator id answering a high-consequence block')
    .option('--surface <surface>', 'Surface that is sending this answer (feed, terminal, etc.)', 'cli')
    .action(async (target: string, text: string, opts: { from?: string; as?: string; surface?: string }) => {
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
            const block = findOpenBlockForMailbox(res.id);
            const operatorId = opts.as;
            const verified = operatorId ? getOperator(operatorId) !== undefined : false;
            if (block) {
              const claim = recordAnswer(block.blockId, {
                answeredBy: opts.from,
                answeredFrom: opts.surface || 'cli',
                operatorId,
                verified,
              });
              if (!claim.ok) {
                if ('unauthorized' in claim) {
                  die(`Not authorized: ${claim.reason}`);
                }
                const who = claim.existing.answeredFrom + (claim.existing.answeredBy ? ` (${claim.existing.answeredBy})` : '');
                die(`This question was already answered by ${who}.`);
              }
            }

            const msgId = enqueue(mailboxDir(res.id), { to: res.id, text, from: opts.from, blockId: block?.blockId });

            if (block) {
              recordMessageReceipt(block.blockId, {
                msgId,
                status: 'queued',
                at: new Date().toISOString(),
                from: opts.from,
              });
              console.log(
                chalk.green(`Queued message ${msgId} for ${res.id}. `) +
                  chalk.dim(`Answer tied to ${block.blockId}; the agent will see it at its next tool call.`),
              );
            } else {
              console.log(
                chalk.green(`Queued message ${msgId} for ${res.id}. `) +
                  chalk.dim('The agent will see it at its next tool call.'),
              );
            }
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
