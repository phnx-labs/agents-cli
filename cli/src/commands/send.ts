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
 * (`send --to owner`) and is deprecated — new callers should use
 * `agents feed post`. Not a second stack. Not agent control — use
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
import { sendMessage, isOwnerAlias, type ResolveSendInput } from '../lib/channels/send.js';
import { ownerMessageComposer } from '../lib/owner-message.js';
import { fireTraceSyncInBackground } from '../lib/run-trace-sync.js';
import type { SinkMessageFormat } from '../lib/sink-format.js';

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
  let input = toInput(positionalText, opts, ownerMode);

  // An owner-bound ping (`agents notify`, `agents send --to owner`) goes through
  // the SAME composer as an important `feed post` (PHNX-3698): short-shaped body,
  // TEAM-N keys linkified, session crumb as a tappable console URL — instead of a
  // raw dump. A non-owner send (explicit --channel/--to) is delivered verbatim.
  let ownerCompose: ((format: SinkMessageFormat) => string) | undefined;
  if (ownerMode || isOwnerAlias(opts.to)) {
    const flagged = opts.text?.trim() ?? '';
    const positional = (positionalText ?? '').trim();
    const raw = flagged || positional;
    // When both forms are given and disagree, leave it to sendMessage to fail
    // loud with the "pass the message once" error rather than composing a guess.
    const bothDiffer = flagged !== '' && positional !== '' && flagged !== positional;
    if (raw && !bothDiffer) {
      // Resolve the context once, then let each owner destination render its own
      // format: the envelope carries the plain default (for --json and dry-run
      // display), while ownerCompose hands sendToOwner the mrkdwn variant for a
      // Slack owner destination and plain for iMessage (PHNX-3698).
      ownerCompose = ownerMessageComposer(raw);
      input = { ...input, text: ownerCompose('plain'), positionalText: undefined };
      // The console URL in the composed body only resolves once this session's
      // trace shard is uploaded; fire that now so the tapped link isn't a 404.
      // A --dry-run resolves + composes but MUST NOT act (its documented contract),
      // so it never spawns the sync — it just shows what would be sent.
      fireTraceSyncInBackground({ disabled: Boolean(opts.dryRun) });
    }
  }

  const out = await sendMessage(input, meta, ownerCompose);
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
  if (result.error) console.error(chalk.yellow(`Partial delivery failure: ${result.error}`));
}

const SHARED_NOTES = `
  Planes (do not mix them up):
    send              - DELIVER a message to a recipient (this command)
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
      '[DEPRECATED] Deliver to the owner (alias of send --to owner). Use "agents feed post" for new code.',
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
      # Deprecated: prefer "agents feed post --title \"…\" \"…\" --level important"
      agents notify --text "Build finished — PR #1346 is green"
      agents notify "legacy positional still works"

      # Override channel for this one ping
      agents notify --text "fallback" --channel desktop --to local

      agents notify --text "probe" --dry-run --json
    `,
    notes: `
      DEPRECATED. notify ≡ send --to owner and still works, but new callers
      should use "agents feed post" (record + optional broadcast) instead.
      Set owner.channels + owner.policy.normal in humans.yaml once per fleet.
      Every channel listed in the normal policy receives an owner-addressed send.

      Owner sends go through the same composer as "feed post": the body is
      short-shaped, any TEAM-N key becomes a Linear URL, and the session crumb
      becomes a tappable https://prix.dev/console/sessions/<id> link.

      ${SHARED_NOTES}
    `,
  });

  notifyCmd.action(async (text: string | undefined, opts: SendCliOpts) => {
    console.error(
      chalk.yellow(
        'Warning: "agents notify" is deprecated. Use "agents feed post" for progress posts that can also reach the owner.',
      ),
    );
    await runSend(text, opts, true);
  });
}
