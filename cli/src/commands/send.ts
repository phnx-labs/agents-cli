/**
 * `agents send` — deliver a message over any registered channel provider.
 *
 * Envelope (flag-first, industry-shaped):
 *   agents send --to <dest> --text "…" [--channel <name>] [--attach …] [--url …]
 *
 * Destination:
 *   --to owner          expands to notify.owner.{channel,to} in agents.yaml
 *   --to <id>           channel-specific recipient (requires --channel)
 *
 * Compat: positional text still works (`agents send "hi" --channel … --to …`).
 *
 * `agents notify` is the same delivery path with owner defaults
 * (`send --to owner`). Not a second stack. Not agent control — use
 * `agents message` / `agents sessions inject` for running agents.
 *
 * Feed / activity are a different plane (record + read); feed.broadcast may
 * call this command as a forward sink.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { die } from '../lib/format.js';
import { setHelpSections } from '../lib/help.js';
import { readMeta } from '../lib/state.js';
import { sendMessage, type ResolveSendInput } from '../lib/channels/send.js';

interface SendCliOpts {
  text?: string;
  channel?: string;
  to?: string;
  thread?: string;
  /** Preferred flag for local files. */
  attach?: string[];
  /** Legacy alias of --attach. */
  attachment?: string[];
  url?: string[];
  from?: string;
  json?: boolean;
  dryRun?: boolean;
}

function mergeAttachments(opts: SendCliOpts): string[] | undefined {
  const list = [...(opts.attach ?? []), ...(opts.attachment ?? [])];
  return list.length ? list : undefined;
}

function toInput(
  positionalText: string | undefined,
  opts: SendCliOpts,
  ownerMode: boolean,
): ResolveSendInput {
  return {
    text: opts.text,
    positionalText,
    to: opts.to,
    channel: opts.channel,
    thread: opts.thread,
    attachments: mergeAttachments(opts),
    urls: opts.url,
    from: opts.from,
    dryRun: opts.dryRun,
    ownerMode,
  };
}

async function runSend(
  positionalText: string | undefined,
  opts: SendCliOpts,
  ownerMode: boolean,
): Promise<void> {
  const meta = readMeta();
  const out = await sendMessage(toInput(positionalText, opts, ownerMode), meta);
  if ('error' in out) {
    die(out.error);
  }
  const { result, envelope } = out;

  if (opts.json) {
    console.log(
      JSON.stringify({
        ...result,
        text: envelope.text,
        dryRun: Boolean(envelope.dryRun),
      }),
    );
    if (!result.ok) process.exit(1);
    return;
  }
  if (!result.ok) {
    die(`send failed [${result.channel} → ${result.id}]: ${result.error ?? 'unknown error'}`);
  }
  const suffix = result.msgId ? chalk.dim(` (${result.msgId})`) : '';
  const dry = envelope.dryRun ? chalk.dim(' [dry-run]') : '';
  console.log(chalk.green(`Sent via ${result.channel} → ${result.id}`) + suffix + dry);
}

const SHARED_NOTES = `
  Planes (do not mix them up):
    send / notify     - DELIVER a message to a recipient (this command)
    feed post         - RECORD progress / milestones (optional broadcast may call send)
    activity          - READ the activity stream (not a send path)
    message / inject  - CONTROL a running agent (mailbox answer or terminal keystroke)

  --to owner is an address alias for notify.owner in agents.yaml, not a
  special control path. Agent resume / PTY inject stay on message and
  sessions inject.
`;

export function registerSendCommand(program: Command): void {
  const sendCmd = program
    .command('send [text]')
    .description(
      'Deliver a message through a channel provider (imessage, slack, desktop, mailbox, …). Prefer --text/--to flags.',
    )
    .option('--text <text>', 'message body (preferred over positional text)')
    .option('--to <target>', 'recipient id, or "owner" for notify.owner in agents.yaml')
    .option('--channel <name>', 'channel / provider (required unless --to owner)')
    .option('--thread <id>', 'channel thread id / timestamp')
    .option('--attach <path...>', 'local file attachment path (repeatable)')
    .option('--attachment <path...>', 'alias of --attach')
    .option('--url <url...>', 'link or remote media URL to include in the body (repeatable)')
    .option('--from <who>', 'sender label (mailbox)')
    .option('--json', 'output JSON')
    .option('--dry-run', 'resolve + build but do not send');

  setHelpSections(sendCmd, {
    examples: `
      # Flag-first envelope (preferred)
      agents send --channel imessage --to "+18055550100" --text "PR #1803 is green"
      agents send --to owner --text "need a decision on the release"
      agents send --channel desktop --to local --text "deploy finished" --url https://example.com/pr/1
      agents send --channel mailbox --to <session-id> --text "peer note" --from orchestrator

      # Attach a local file
      agents send --to owner --text "screenshot" --attach ./out/cover.png

      # Owner alias without the notify verb
      agents send --to owner --text "wiring test"

      # Legacy positional text still works
      agents send "hi" --channel desktop --to local

      # Dry-run (resolve provider, no delivery)
      agents send --to owner --text "probe" --dry-run --json
    `,
    notes: SHARED_NOTES,
  });

  sendCmd.action(async (text: string | undefined, opts: SendCliOpts) => {
    await runSend(text, opts, false);
  });

  const notifyCmd = program
    .command('notify [text]')
    .description(
      'Deliver to the owner (alias of send --to owner). Channel + target default from notify.owner in agents.yaml.',
    )
    .option('--text <text>', 'message body (preferred over positional text)')
    .option('--channel <name>', 'override owner channel')
    .option('--to <target>', 'override owner target (or pass a non-owner dest with --channel)')
    .option('--thread <id>', 'channel thread id / timestamp')
    .option('--attach <path...>', 'local file attachment path (repeatable)')
    .option('--attachment <path...>', 'alias of --attach')
    .option('--url <url...>', 'link or remote media URL to include in the body (repeatable)')
    .option('--from <who>', 'sender label (mailbox)')
    .option('--json', 'output JSON')
    .option('--dry-run', 'resolve + build but do not send');

  setHelpSections(notifyCmd, {
    examples: `
      # Same as: agents send --to owner --text "…"
      agents notify --text "Build finished — PR #1346 is green"
      agents notify "legacy positional still works"

      # Override channel for this one ping
      agents notify --text "fallback" --channel desktop --to local

      agents notify --text "probe" --dry-run --json
    `,
    notes: `
      notify ≡ send --to owner. One delivery stack (lib/channels). Set
      notify.owner.{channel,to} in agents.yaml once per machine/fleet.

      ${SHARED_NOTES}
    `,
  });

  notifyCmd.action(async (text: string | undefined, opts: SendCliOpts) => {
    await runSend(text, opts, true);
  });
}
