/**
 * `agents sessions inject <sessionId> <text>` — deliver text into the terminal a
 * running session lives in. The CLI face of the Terminal Engine's Gap 2 primitive
 * (`injectIntoTerminal`, src/lib/terminal/inject.ts), so a native watchdog
 * (RUSH-1415) can shell out to nudge a stalled agent with "continue".
 *
 * Resolution: find the active session by id, then resolve its exact split through
 * the SAME canonical resolver the watchdog uses — `resolveInjectTargetForSession`
 * (lib/terminal/resolve.ts), precedence tmux > iterm > vscodium > pty. Sharing one
 * resolver keeps the manual unblock path and the watchdog in agreement on which
 * sessions are addressable (a prior duplicate resolver read only `provenance.reply`
 * and could not address a VSCodium/Cursor terminal the watchdog handled fine).
 * `--pane`/`--pty` target a backend directly when the handle is already known.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { getActiveSessions } from '../lib/session/active.js';
import { resolveInjectTargetForSession } from '../lib/terminal/resolve.js';
import { injectIntoTerminal, type InjectTarget } from '../lib/terminal/index.js';
import { setHelpSections } from '../lib/help.js';

interface InjectOptions {
  pane?: string;
  socket?: string;
  pty?: string;
  host?: string;
  enter?: boolean;
  combined?: boolean;
  json?: boolean;
}

/** Resolve a session id (short or full) to an addressable terminal target, via the
 * same resolver the watchdog uses so both agree on what is reachable. */
async function resolveTarget(sessionId: string): Promise<{ target: InjectTarget | null; reason?: string }> {
  const sessions = await getActiveSessions();
  const match = sessions.find(
    (s) => s.sessionId === sessionId || (s.sessionId != null && s.sessionId.startsWith(sessionId)),
  );
  if (!match) return { target: null, reason: `No active session matches "${sessionId}".` };
  const resolution = resolveInjectTargetForSession(match);
  if (!resolution.addressable) {
    // Surface the resolver's precise reason (host/rail), not a generic "not tmux".
    return { target: null, reason: `Session "${sessionId}": ${resolution.reason}` };
  }
  return { target: resolution.target };
}

async function runInject(sessionId: string, text: string, options: InjectOptions): Promise<void> {
  // Direct-target shortcuts skip the session lookup — the watchdog often already
  // holds the pane id or pty session it wants to type into.
  let target: InjectTarget | null = null;
  if (options.pty) {
    target = { backend: 'pty', id: options.pty };
  } else if (options.pane) {
    target = { backend: 'tmux', pane: options.pane, socket: options.socket };
  } else {
    const resolved = await resolveTarget(sessionId);
    if (!resolved.target) {
      if (options.json) console.log(JSON.stringify({ ok: false, error: resolved.reason }));
      else console.error(chalk.red(resolved.reason));
      process.exit(1);
    }
    target = resolved.target;
  }

  const res = await injectIntoTerminal(target, text, {
    enter: options.enter !== false,
    combined: options.combined,
    socket: options.socket,
    host: options.host,
  });

  if (options.json) {
    console.log(JSON.stringify(res));
  } else if (res.ok) {
    console.log(chalk.green(`Injected into ${res.backend} (${res.writes} write${res.writes === 1 ? '' : 's'}).`));
  } else {
    console.error(chalk.red(res.error ?? 'injection failed'));
  }
  if (!res.ok) process.exit(1);
}

/** Attach the `inject` subcommand to an existing `sessions` command. */
export function registerSessionsInjectCommand(sessionsCmd: Command): void {
  const injectCmd = sessionsCmd
    .command('inject <sessionId> <text>')
    .description('Deliver text (+ Enter) into the terminal a running session lives in — nudge a stalled agent.')
    .option('--pane <id>', 'Target a tmux pane id directly (e.g. %3), skipping session lookup')
    .option('--pty <id>', 'Target an agents-pty session id directly, skipping session lookup')
    .option('--socket <path>', 'tmux socket path (defaults to the session/shared socket)')
    .option('--host <target>', 'Deliver on a remote host over SSH (tmux/AppleScript backends)')
    .option('--no-enter', 'Send only the text, without a trailing Enter')
    .option('--combined', 'Fuse text + Enter into ONE write (default: two writes, Ink-TUI safe)')
    .option('--json', 'Output the InjectResult as JSON');

  setHelpSections(injectCmd, {
    examples: `
      # Nudge a stalled agent by session id (resolves its tmux pane)
      agents sessions inject a1b2c3d4 "continue"

      # Target a tmux pane directly (what a watchdog already holds)
      agents sessions inject _ "continue" --pane %3 --socket /tmp/agents/tmux.sock

      # Type into an agents-pty session without submitting
      agents sessions inject _ "ls" --pty $SID --no-enter
    `,
    notes: `
      - Ink-TUI Enter semantics: by default the text and Enter are two separate
        writes, which is what Claude's Ink TUI needs. --combined fuses them.
      - A session is addressable by id when it resolves to a precise split —
        tmux, iTerm, a VSCodium/Cursor/VS Code integrated terminal, or a pty
        (resolveInjectTargetForSession). Use --pane/--pty for direct targeting.
      - Built on the Terminal Engine (src/lib/terminal): --host runs the tmux /
        AppleScript spec over the same SSH transport the launch engine uses.
    `,
  });

  // The parent `sessions` command also defines --json, so it binds there;
  // optsWithGlobals() merges parent + subcommand options so --json is honored.
  injectCmd.action(async (sessionId: string, text: string, _options: InjectOptions, command: Command) => {
    await runInject(sessionId, text, command.optsWithGlobals() as InjectOptions);
  });
}
