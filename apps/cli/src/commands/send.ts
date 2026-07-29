/**
 * `agents send <text> --channel <name> --to <target>` — deliver a message over
 * any registered channel (mailbox, telegram, imessage, slack, discord, apps).
 *
 * `agents notify <text>` — owner-facing alias. Fills channel + target from the
 * `notify.owner` block in agents.yaml when not passed, so routines/agents ping
 * the owner without hardcoding a chat id / host / account.
 *
 * Both go through one `doSend()` seam: resolve the provider for the channel
 * (notify.transports picks the transport per host) and call provider.send().
 * The agent mailbox is just one channel; `agents message` stays the richer
 * agent-control command (feed-claim / identity / PTY / resume) on the same spool.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { die } from '../lib/format.js';
import { readMeta } from '../lib/state.js';
import { registerBuiltinProviders } from '../lib/channels/providers/index.js';
import { resolveTransport } from '../lib/channels/resolve.js';
import type { SendResult } from '../lib/channels/registry.js';

interface SendCliOpts {
  channel?: string;
  to?: string;
  thread?: string;
  attachment?: string[];
  from?: string;
  json?: boolean;
  dryRun?: boolean;
}

async function doSend(text: string, channel: string, to: string, opts: SendCliOpts): Promise<void> {
  registerBuiltinProviders();
  const provider = resolveTransport(channel, readMeta());
  const result: SendResult = await provider.send(text, {
    target: to,
    thread: opts.thread,
    attachments: opts.attachment,
    from: opts.from,
    dryRun: opts.dryRun,
  });

  if (opts.json) {
    console.log(JSON.stringify(result));
    if (!result.ok) process.exit(1);
    return;
  }
  if (!result.ok) {
    die(`send failed [${result.channel} → ${result.id}]: ${result.error ?? 'unknown error'}`);
  }
  const suffix = result.msgId ? chalk.dim(` (${result.msgId})`) : '';
  const dry = opts.dryRun ? chalk.dim(' [dry-run]') : '';
  console.log(chalk.green(`Sent via ${result.channel} → ${result.id}`) + suffix + dry);
}

export function registerSendCommand(program: Command): void {
  program
    .command('send <text>')
    .description('Send a message through a channel provider (mailbox, telegram, imessage, slack, discord).')
    .requiredOption('--channel <name>', 'channel / provider name')
    .requiredOption('--to <target>', 'channel-specific recipient id')
    .option('--thread <id>', 'channel thread id / timestamp')
    .option('--attachment <path...>', 'file attachment path (repeatable)')
    .option('--from <who>', 'sender label (mailbox)')
    .option('--json', 'output JSON')
    .option('--dry-run', 'resolve + build but do not send')
    .action(async (text: string, opts: SendCliOpts) => {
      await doSend(text, opts.channel!, opts.to!, opts);
    });

  program
    .command('notify <text>')
    .description('Notify the owner (channel + target default to notify.owner in agents.yaml).')
    .option('--channel <name>', 'override owner channel')
    .option('--to <target>', 'override owner target')
    .option('--thread <id>', 'channel thread id / timestamp')
    .option('--attachment <path...>', 'file attachment path (repeatable)')
    .option('--json', 'output JSON')
    .option('--dry-run', 'resolve + build but do not send')
    .action(async (text: string, opts: SendCliOpts) => {
      const owner = readMeta().notify?.owner;
      const channel = opts.channel ?? owner?.channel;
      const to = opts.to ?? owner?.to;
      if (!channel || !to) {
        die(
          'notify: no --channel/--to given and no notify.owner.{channel,to} in agents.yaml. ' +
            'Set notify.owner or pass --channel/--to.',
        );
      }
      await doSend(text, channel, to, opts);
    });
}
