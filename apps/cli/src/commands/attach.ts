/**
 * `agents sessions attach <id>` — bring a backgrounded (or parked) agent session
 * back to the foreground: stop its headless continuation, then resume it
 * interactively in this terminal. The resume is version-pinned native resume
 * (claude/codex) or a `/continue` replay (others) — the same session, full
 * history, the exact inverse of `agents sessions detach`.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import type { SessionMeta } from '../lib/session/types.js';
import { runOnPeer } from '../lib/session/remote-list.js';
import { sessionRecoveryPeer } from '../lib/session/recovery.js';
import { resolveSessionMetadataValue, resumeSessionInPlace } from './sessions.js';
import { readDetachRecord, clearDetachRecord, isHeadlessAlive } from '../lib/session/detached.js';

export function registerAttachCommand(program: Command): void {
  program
    .command('attach')
    .argument('<id>', 'Short or full id of the backgrounded/parked session to resume interactively')
    .description('Bring a backgrounded agent to the foreground — resume it interactively here')
    .action(async (id: string) => {
      await attachAction(id);
    });
}

export async function attachAction(id: string): Promise<void> {
  const outcome = await resolveSessionMetadataValue(id);
  if (outcome.kind === 'partial') {
    // RUSH-2492: an unreachable peer is a warning, not a hard failure. The
    // resolver already resolves an id found on the reachable fleet (SES-9a), so
    // reaching here means the session was not found on any device we COULD reach
    // — it may live on one of the unreachable peers, which we could not check.
    const offline = outcome.failedPeers;
    console.error(chalk.yellow(`Warning: ${offline.length} device(s) unreachable, not checked: ${offline.join(', ')}`));
    console.error(chalk.red(`No session matching "${id}" on any reachable device (${offline.length} unreachable, not checked).`));
    console.error(chalk.gray('  If it lives on an offline box, wake it (agents devices) or run there: agents ssh <device>'));
    process.exitCode = 1;
    return;
  }
  if (outcome.kind === 'not-found') {
    console.error(chalk.red(`No session matching "${id}".`));
    console.error(chalk.gray('  See your sessions: agents sessions'));
    process.exitCode = 1;
    return;
  }
  if (outcome.kind === 'ambiguous') {
    console.error(chalk.red(`"${id}" matches ${outcome.candidates.length} sessions. Pass the full session id.`));
    process.exitCode = 1;
    return;
  }
  const meta = outcome.session;

  // Route the WHOLE attach operation to the origin, not just its eventual
  // resume. The detach record and headless PID are device-local; clearing them
  // here would leave the real background continuation running beside a second
  // process on the owning machine.
  const peer = sessionRecoveryPeer(meta);
  if (peer) {
    const routed = await runOnPeer(attachRecoveryArgs(meta), peer, { tty: true });
    if (routed === 'no-target') {
      console.error(chalk.red(`Cannot attach ${meta.shortId}: origin device ${peer} is not a registered reachable peer.`));
      process.exitCode = 1;
    }
    return;
  }

  // If it's backgrounded, stop the headless continuation first so two processes
  // don't resume the same transcript at once.
  const rec = readDetachRecord(meta.id);
  if (rec) {
    if (isHeadlessAlive(rec)) {
      try {
        process.kill(rec.headlessPid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    clearDetachRecord(meta.id);
  }

  console.log(chalk.gray(`Attaching ${meta.agent} ${meta.id.slice(0, 8)} — resuming interactively…`));
  await resumeSessionInPlace(meta);
}

export function attachRecoveryArgs(session: Pick<SessionMeta, 'id'>): string[] {
  return ['sessions', 'attach', session.id];
}
