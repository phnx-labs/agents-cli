// Tmux integration - VS Code dependent functions.
//
// Delegates the whole tmux lifecycle (new / split / attach / kill / has) to
// the `agents tmux` CLI command tree shipped in agents-cli 1.20+ (see
// phnx-labs/agents-cli PR #143). The CLI owns slug validation, the shared
// server socket (~/.agents/.cache/helpers/tmux/server.sock), meta JSON, and
// arg-array spawning — this module is now a thin VS Code adapter.
//
// Public surface is preserved verbatim so extension.ts call sites don't
// move: `isTmuxAvailable`, `createTmuxTerminal`, `tmuxSplitH`, `tmuxSplitV`,
// `isTmuxTerminal`, `getTmuxState`, `cleanupTmuxTerminal`,
// `registerTmuxCleanup`.

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as readiness from './terminalReadiness';
import { runAgents } from '../core/agentsBin';

interface TmuxTerminal {
  terminal: vscode.Terminal;
  session: string;
  socket: string;  // Shared agents-cli socket (so direct tmux calls hit the same server)
  agentType: string;
  paneCount: number;
}

const tmuxTerminals = new Map<vscode.Terminal, TmuxTerminal>();

let tmuxAvailable: Promise<boolean> | null = null;

/**
 * Returns true iff `agents tmux check` succeeds. That's a stronger probe
 * than `command -v tmux` because the migration depends on BOTH `agents`
 * (resolved by agentsBin) and `tmux` being present. If `agents` is missing
 * we surface that via the existing `ensureAgentsCliInstalled` flow in
 * extension.ts; here we just say "tmux integration unavailable" and fall
 * back to VS Code splits.
 */
export function isTmuxAvailable(): Promise<boolean> {
  if (!tmuxAvailable) {
    tmuxAvailable = runAgents('tmux check', { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
  }
  return tmuxAvailable;
}

/** Test hook — drop the cached `agents tmux check` result. */
export function __resetTmuxAvailableCacheForTests(): void {
  tmuxAvailable = null;
}

/**
 * Path the agents-cli pins its shared tmux server to. We need it for the
 * pane-styling tweaks (mouse, pane-border) that aren't exposed as an
 * `agents tmux` subcommand — those are stylistic, not lifecycle. Direct
 * `tmux -S <path>` calls hit the same server the CLI uses, so the styling
 * sticks for the session we just created.
 *
 * Keep in sync with agents-cli's `src/lib/tmux/paths.ts` (`getDefaultSocketPath`).
 */
export function getAgentsTmuxSocketPath(): string {
  return path.join(os.homedir(), '.agents', '.cache', 'helpers', 'tmux', 'server.sock');
}

/**
 * Wrap a string in single quotes safe for an interactive shell.
 * Standard POSIX trick: any embedded `'` becomes `'\''` (close, escape, open).
 * Replaces swarmify's previous ad-hoc `command.replace(/'/g, "'\\''")` —
 * same technique, just in one helper so we can't forget to apply it.
 */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** agents-cli session slug rule: [A-Za-z0-9_-]{1,64}. */
function newSessionName(): string {
  return `agents-${Date.now()}`;
}

export function createTmuxTerminal(
  name: string,
  agentType: string,
  agentCommand: string,
  options: {
    iconPath?: vscode.Uri;
    env?: Record<string, string | null>;
    viewColumn?: vscode.ViewColumn;
    cwd?: string;
  }
): vscode.Terminal {
  const session = newSessionName();
  const socket = getAgentsTmuxSocketPath();

  const terminal = vscode.window.createTerminal({
    name,
    iconPath: options.iconPath,
    location: { viewColumn: options.viewColumn ?? vscode.ViewColumn.Active },
    env: {
      ...options.env,
      TMUX_AGENT_SESSION: session,
    },
    cwd: options.cwd,
    isTransient: true,
  });

  // Build the chained shell command we send into the terminal:
  //   1. `agents tmux new` — create the detached session via the CLI. Tagged
  //      `--source extension` so `agents tmux list` shows provenance.
  //   2. Direct `tmux -S` styling tweaks on the shared socket (mouse,
  //      pane labels) — these aren't `agents tmux` subcommands.
  //   3. `agents tmux attach` — replaces the shell with the tmux client.
  const parts: string[] = [];

  const newArgs: string[] = [`agents tmux new ${shq(session)}`, '--source', 'extension'];
  if (options.cwd) newArgs.push('--cwd', shq(options.cwd));
  if (agentCommand) newArgs.push('--cmd', shq(agentCommand));
  parts.push(newArgs.join(' '));

  // Multi-command tmux call: backslash-escaped `;` separates tmux commands
  // inside one shell argument. The shell strips the backslash, tmux sees
  // `;` as its command separator. Mouse + pane-border styling, all on the
  // same -S socket so they target the session we just created.
  //
  // Wrapped in `{ ... || true; }` so a styling failure (e.g. bare `tmux` not
  // on the terminal's shell PATH even though agents-cli found one at an
  // absolute path) doesn't break the chain and prevent `attach` from running.
  // Worst case: styling is missing, but the user is still attached to a live
  // session — much better than a half-init terminal sitting at a shell prompt.
  const styling = [
    `tmux -S ${shq(socket)} set-option -t ${shq(session)} mouse on`,
    `set-option -t ${shq(session)} pane-border-status top`,
    `set-option -t ${shq(session)} pane-border-format ${shq(` #{pane_index}: ${name} `)}`,
  ].join(' \\; ');
  parts.push(`{ ${styling} || true; }`);

  parts.push(`agents tmux attach ${shq(session)}`);

  const tmuxInit = parts.join(' && ');

  // Wait for the shell's rc files to finish (PATH populated, aliases loaded)
  // before sending the init command. Same gate as before — `agents` may live
  // under nvm so we need the user's PATH fully resolved.
  readiness.registerTerminal(terminal);
  readiness.waitFor(terminal, 'promptReady').then(
    () => terminal.sendText(tmuxInit, true),
    () => terminal.sendText(tmuxInit, true),
  );

  tmuxTerminals.set(terminal, {
    terminal,
    session,
    socket,
    agentType,
    paneCount: 1,
  });

  return terminal;
}

/**
 * Horizontal user-facing split (new pane BELOW). tmux's `-v` flag actually
 * does that — the swarmify naming convention treats "horizontal split" as
 * "horizontally-divided panes stacked vertically".
 */
export async function tmuxSplitH(terminal: vscode.Terminal, agentCommand: string): Promise<void> {
  await splitPane(terminal, 'v', agentCommand, 'H');
}

/**
 * Vertical user-facing split (new pane to RIGHT). tmux's `-h` flag does that.
 */
export async function tmuxSplitV(terminal: vscode.Terminal, agentCommand: string): Promise<void> {
  await splitPane(terminal, 'h', agentCommand, 'V');
}

async function splitPane(
  terminal: vscode.Terminal,
  tmuxDirection: 'h' | 'v',
  agentCommand: string,
  logTag: string,
): Promise<void> {
  const state = tmuxTerminals.get(terminal);
  if (!state) return;

  try {
    // `agents tmux has` exits 0 if alive, 1 if dead. runAgents throws on
    // non-zero exit — that's how we detect a dead session and prune state.
    await runAgents(`tmux has ${shq(state.session)}`);

    state.paneCount++;

    const args = [`tmux split ${shq(state.session)} ${tmuxDirection}`];
    if (agentCommand) args.push('--cmd', shq(agentCommand));
    await runAgents(args.join(' '));
  } catch (err) {
    console.error(`[TMUX] Split ${logTag} failed:`, err);
    tmuxTerminals.delete(terminal);
  }
}

export function isTmuxTerminal(terminal: vscode.Terminal): boolean {
  return tmuxTerminals.has(terminal);
}

export function getTmuxState(terminal: vscode.Terminal): TmuxTerminal | undefined {
  return tmuxTerminals.get(terminal);
}

export function cleanupTmuxTerminal(terminal: vscode.Terminal): void {
  const state = tmuxTerminals.get(terminal);
  if (!state) return;

  // `agents tmux kill` is idempotent — race with a dead session is a no-op.
  // Fire-and-forget so VS Code's onDidCloseTerminal callback doesn't block.
  runAgents(`tmux kill ${shq(state.session)}`).catch(() => { /* ignore */ });

  tmuxTerminals.delete(terminal);
}

export function registerTmuxCleanup(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      cleanupTmuxTerminal(terminal);
    }),
  );
}
