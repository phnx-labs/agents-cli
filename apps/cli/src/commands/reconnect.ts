/**
 * `agents reconnect [session-id]` — get me back into an agent terminal whose ssh
 * link dropped.
 *
 * The auto-reconnect in lib/hosts/reconnect.ts already re-attaches a live remote
 * pane over its own bounded backoff on a transient blink. This is the MANUAL
 * recovery for after it gave up — a sustained outage, or a VS Code terminal tab
 * that closed with the dead ssh client. One verb that always tries hardest to put
 * you back into that agent: attach the live pane if it still exists, else resume
 * the session; live pane > resumed copy > a clear message about what was lost.
 *
 * It delegates to `focus`, which already does exactly attach-else-resume for a
 * resolved id ({@link focusAction} → `focusResolvedSession`), so there is no second
 * recovery path to keep in sync. What `reconnect` adds is the recovery framing and,
 * with no id, targeting the MOST RECENT session in this shell's directory — the one
 * that most likely just dropped — instead of opening the full fleet picker.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { focusAction } from './focus.js';
import { discoverSessions } from '../lib/session/discover.js';
import type { SessionMeta } from '../lib/session/types.js';
import { setHelpSections } from '../lib/help.js';

/**
 * The recency signal a no-id reconnect targets: last activity if the scan
 * computed one, else the creation time. A row with neither parseable sorts last.
 * Pure so target selection is unit-tested without the scanner.
 */
export function sessionRecency(s: Pick<SessionMeta, 'lastActivity' | 'timestamp'>): number {
  const t = Date.parse(s.lastActivity ?? s.timestamp ?? '');
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/**
 * Pick the session to reconnect when the user gave no id: the most recently
 * active one in scope — the terminal that most likely just dropped. Pure; returns
 * undefined for an empty scope so the caller can print guidance.
 */
export function pickMostRecentSession(sessions: SessionMeta[]): SessionMeta | undefined {
  let best: SessionMeta | undefined;
  for (const s of sessions) {
    if (!best || sessionRecency(s) > sessionRecency(best)) best = s;
  }
  return best;
}

/**
 * Resolve the no-id target: prefer the most recent session started from THIS
 * directory (the shell the user is reconnecting from), falling back to the most
 * recent session anywhere when the current directory has none. Best-effort — a
 * discovery failure yields undefined, never throws. Injectable `discover` keeps
 * the two-step scope preference testable without touching the real scanner.
 */
export async function resolveRecentTarget(
  cwd: string,
  discover: (opts: { cwd?: string; all?: boolean; since?: string; limit?: number }) => Promise<SessionMeta[]> = discoverSessions,
): Promise<SessionMeta | undefined> {
  try {
    const here = await discover({ cwd, since: '7d', limit: 200 });
    const local = pickMostRecentSession(here);
    if (local) return local;
    const any = await discover({ all: true, since: '7d', limit: 200 });
    return pickMostRecentSession(any);
  } catch {
    return undefined;
  }
}

export async function reconnectAction(id: string | undefined): Promise<void> {
  if (id) {
    // focus already attaches a live pane or recovers a dropped one for a resolved
    // id — on the origin device for a remote session. Reconnect is that path with
    // a recovery-first name; no reason to duplicate the resolution/attach logic.
    await focusAction(id, {});
    return;
  }

  const recent = await resolveRecentTarget(process.cwd());
  if (!recent) {
    console.log(chalk.gray('No recent session to reconnect from here.'));
    console.log(chalk.gray('  reconnect a specific one:  agents reconnect <session-id>'));
    console.log(chalk.gray('  or pick from the fleet:    agents sessions'));
    return;
  }
  const where = recent.machine ? ` on ${recent.machine}` : '';
  console.log(chalk.gray(`Reconnecting ${recent.shortId}${where} (most recent here)…`));
  await focusAction(recent.id, {});
}

export function registerReconnectCommand(program: Command): void {
  const cmd = program
    .command('reconnect')
    .argument('[session-id]', 'Session id/prefix to reconnect (default: the most recent session started here)')
    .description('Re-enter a dropped agent terminal: attach the live pane if it survived, else resume the session')
    .action(async (id: string | undefined) => {
      await reconnectAction(id);
    });

  setHelpSections(cmd, {
    examples: `
      # Reconnect the session that just dropped in this shell (most recent here)
      agents reconnect

      # Reconnect one specific agent terminal by id/prefix
      agents reconnect 74b13b0b

      # Same, spelled under the sessions group
      agents sessions reconnect 74b13b0b
    `,
    notes: `
      - Best-effort recovery: a living remote tmux pane is JOINED (a second client, no fork); a dropped one is RESUMED on its origin device (a copy if it was mid-run, a /continue if idle).
      - With no id, targets the most recent session started from this directory (the terminal that most likely just dropped), not the full fleet picker. Falls back to the most recent session anywhere when this directory has none.
      - This is the manual companion to the automatic reconnect that runs during a live 'agents run --device <box>' when the network blinks; use it after that gave up or the terminal tab closed.
      - Related: 'agents sessions focus' (attach/recover with a picker) and 'agents sessions resume' (multi-select history -> tabs).
    `,
  });
}
