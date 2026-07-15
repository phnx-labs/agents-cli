/**
 * `agents mailboxes` — inspect the agent mailbox spool.
 *
 * The mailbox spool (`~/.agents/.history/mailbox/<id>/{inbox,processing,consumed}`)
 * is the transport under `agents message` / `agents feed` / `agents teams message`:
 * one box per logical agent (session UUID / teams agentId / loop runId). This
 * command is the read-only window onto it — which boxes exist, how much mail
 * each holds, and a recency-ordered log of the messages that flowed BETWEEN
 * agents (including already-consumed ones), so an operator can see the
 * agent-to-agent chatter after the fact.
 *
 *   agents mailboxes            overview: boxes + a recent cross-box message log
 *   agents mailboxes <id>       one box in full (inbox / processing / consumed)
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { die, relTime, truncate } from '../lib/format.js';
import { listBoxes, readBox, mailboxDir, isValidMailboxId, type StoredMessage } from '../lib/mailbox.js';
import { getMailboxRootDir } from '../lib/state.js';
import { getActiveSessions, type ActiveSession } from '../lib/session/active.js';
import { mailboxIdForActiveSession } from '../lib/mailbox-target.js';

/** A box plus its messages and a resolved human label. */
interface BoxView {
  id: string;
  label: string;
  live: boolean;
  messages: StoredMessage[];
}

/** Short, human label for a box id — the live session's topic when running, else the id stem. */
function labelForBox(id: string, byMailbox: Map<string, ActiveSession>): { label: string; live: boolean } {
  const s = byMailbox.get(id);
  if (s) {
    const topic = s.name || s.topic || s.label;
    return { label: topic ? truncate(topic, 40) : id.slice(0, 8), live: true };
  }
  return { label: id.slice(0, 8), live: false };
}

/** Build the per-box views, resolving live-session labels once. */
async function collectBoxes(root: string): Promise<BoxView[]> {
  let sessions: ActiveSession[] = [];
  try {
    sessions = await getActiveSessions();
  } catch {
    // Label enrichment is best-effort; a box with no live session still lists.
  }
  const byMailbox = new Map<string, ActiveSession>();
  for (const s of sessions) {
    const mid = mailboxIdForActiveSession(s);
    if (mid) byMailbox.set(mid, s);
  }
  return listBoxes(root).map((id) => {
    const { label, live } = labelForBox(id, byMailbox);
    return { id, label, live, messages: readBox(mailboxDir(id, root)) };
  });
}

function pending(box: BoxView): number {
  return box.messages.filter((m) => m.state !== 'consumed').length;
}

/** `from` label for a message — agents stamp `claude/<slug>`; operator sends may omit it. */
function senderOf(m: StoredMessage): string {
  return m.from || 'operator';
}

const STATE_TAG: Record<StoredMessage['state'], string> = {
  inbox: chalk.yellow('pending'),
  processing: chalk.cyan('in-flight'),
  consumed: chalk.dim('delivered'),
};

function renderOverview(boxes: BoxView[], limit: number): void {
  const nonEmpty = boxes.filter((b) => b.messages.length > 0);
  if (nonEmpty.length === 0) {
    console.log(chalk.dim('No mailboxes with messages. Boxes are created on the first `agents message`.'));
    return;
  }

  // 1. Box summary — one row per box that has ever held mail.
  console.log(chalk.bold(`${nonEmpty.length} mailbox${nonEmpty.length === 1 ? '' : 'es'}`));
  const rows = [...nonEmpty].sort((a, b) => lastTs(b) - lastTs(a));
  for (const box of rows) {
    const p = pending(box);
    const dot = box.live ? chalk.green('●') : chalk.dim('○');
    const counts = [
      p > 0 ? chalk.yellow(`${p} pending`) : null,
      chalk.dim(`${box.messages.length} total`),
    ].filter(Boolean).join(chalk.dim(' · '));
    const last = box.messages.length ? chalk.dim(relTime(newestMessage(box).ts)) : '';
    console.log(`  ${dot} ${chalk.bold(box.label.padEnd(40))} ${counts}  ${last}`);
    console.log(`    ${chalk.dim(box.id)}`);
  }

  // 2. Recent cross-box message log — the agent-to-agent chatter, newest first.
  const all = boxes
    .flatMap((b) => b.messages.map((m) => ({ m, toLabel: b.label })))
    .sort((a, b) => (a.m.ts < b.m.ts ? 1 : a.m.ts > b.m.ts ? -1 : 0))
    .slice(0, limit);
  if (all.length > 0) {
    console.log();
    console.log(chalk.bold(`Recent messages`) + chalk.dim(` (${all.length})`));
    for (const { m, toLabel } of all) {
      const when = chalk.dim(relTime(m.ts).padStart(10));
      const route = `${chalk.magenta(truncate(senderOf(m), 24))} ${chalk.dim('→')} ${chalk.cyan(toLabel)}`;
      console.log(`  ${when}  ${STATE_TAG[m.state]}  ${route}`);
      console.log(`    ${truncate(m.text.replace(/\s+/g, ' ').trim(), 100)}`);
    }
  }
  console.log();
  console.log(chalk.dim('Tip: `agents mailboxes <id>` for one box in full · `--json` for machine output'));
}

function renderBox(box: BoxView): void {
  const dot = box.live ? chalk.green('● live') : chalk.dim('○ not running');
  console.log(chalk.bold(box.label) + '  ' + dot);
  console.log(chalk.dim(box.id));
  if (box.messages.length === 0) {
    console.log(chalk.dim('  (empty)'));
    return;
  }
  console.log();
  for (const m of box.messages) {
    const when = chalk.dim(relTime(m.ts));
    console.log(`  ${STATE_TAG[m.state]}  ${chalk.magenta(senderOf(m))}  ${when}${m.blockId ? chalk.dim(`  block ${m.blockId.slice(0, 12)}`) : ''}`);
    console.log(`    ${truncate(m.text.replace(/\s+/g, ' ').trim(), 200)}`);
  }
}

function lastTs(box: BoxView): number {
  if (box.messages.length === 0) return 0;
  const t = Date.parse(newestMessage(box).ts);
  return Number.isNaN(t) ? 0 : t;
}

function newestMessage(box: BoxView): StoredMessage {
  return box.messages.reduce((a, b) => (a.ts >= b.ts ? a : b));
}

export function registerMailboxesCommand(program: Command): void {
  program
    .command('mailboxes')
    .alias('mailbox')
    .argument('[id]', 'A mailbox id (session UUID / teams agentId) to inspect in full')
    .description('Inspect the agent mailbox spool — boxes and the messages that flowed between agents')
    .option('--json', 'Output as JSON')
    .option('-n, --limit <n>', 'Max recent messages in the overview log', '20')
    .action(async (id: string | undefined, opts: { json?: boolean; limit?: string }) => {
      const root = getMailboxRootDir();
      const limit = Math.max(1, Number.parseInt(opts.limit ?? '20', 10) || 20);

      if (id) {
        if (!isValidMailboxId(id)) die(`Invalid mailbox id ${JSON.stringify(id)}.`);
        const boxes = await collectBoxes(root);
        const box = boxes.find((b) => b.id === id) ?? boxes.find((b) => b.id.startsWith(id));
        if (!box) die(`No mailbox ${JSON.stringify(id)} under ${root}.`);
        if (opts.json) {
          console.log(JSON.stringify(box, null, 2));
          return;
        }
        renderBox(box);
        return;
      }

      const boxes = await collectBoxes(root);
      if (opts.json) {
        console.log(JSON.stringify(
          boxes.map((b) => ({ id: b.id, label: b.label, live: b.live, pending: pending(b), total: b.messages.length, messages: b.messages })),
          null,
          2,
        ));
        return;
      }
      renderOverview(boxes, limit);
    });
}
