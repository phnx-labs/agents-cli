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
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as readiness from './terminalReadiness';
import { runAgents } from '../core/agentsBin';
import { paneBorderText } from '../core/utils';

const pexecFile = promisify(execFile);

interface TmuxTerminal {
  terminal: vscode.Terminal;
  session: string;
  socket: string;  // Shared agents-cli socket (so direct tmux calls hit the same server)
  agentType: string;
  paneCount: number;
  pane?: string;   // Cached `%N` pane id, resolved lazily by getTmuxInfo.
  borderName: string;   // Static agent code shown in the pane border (e.g. "CC"); the
                        // session label is appended once it resolves (relabelTmuxPane).
  borderLabel?: string; // Last label rendered into the border — skip redundant re-sets.
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

export function __factoryPaneDiedHookForTests(session: string): string {
  return `if -F '#{==:#{window_panes},1}' 'detach-client -s =${session}' 'kill-pane'`;
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
    `set-option -t ${shq(session)} pane-border-format ${shq(` #{pane_index}: ${paneBorderText(name)} `)}`,
  ].join(' \\; ');
  parts.push(`{ ${styling} || true; }`);

  // Install the guarded `pane-died` behavior Factory expects from tmux tabs:
  // exiting a pane while another pane remains closes only that pane; the last
  // pane dying detaches the tmux client so VS Code can close instead of parking
  // on "Pane is dead".
  const lifecycle = [
    `tmux -S ${shq(socket)} set-hook -t ${shq(session)} pane-died ${shq(__factoryPaneDiedHookForTests(session))}`,
  ].join(' && ');
  parts.push(`{ ${lifecycle} || true; }`);

  const closeWhenNoLivePanes = [
    `agents tmux attach ${shq(session)}`,
    'FACTORY_ATTACH_STATUS=$?',
    `if ! agents tmux has ${shq(session)} >/dev/null 2>&1; then exit "$FACTORY_ATTACH_STATUS"; fi`,
    `FACTORY_LIVE_PANES=$(tmux -S ${shq(socket)} list-panes -t ${shq(session)} -F '#{pane_dead}' 2>/dev/null | grep -c '^0$' || true)`,
    `if [ "$FACTORY_LIVE_PANES" = "0" ]; then agents tmux kill ${shq(session)} >/dev/null 2>&1 || true; exit "$FACTORY_ATTACH_STATUS"; fi`,
  ].join('; ');
  parts.push(closeWhenNoLivePanes);

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
    borderName: name,
  });

  return terminal;
}

/**
 * Re-render an already-created tmux terminal's pane border to carry the
 * session's resolved auto-label. The border is seeded at creation with the bare
 * agent code (e.g. "CC"); the label pipeline (auto-label poller / focus fetch /
 * manual rename) resolves the topic seconds later, and this swaps it in live —
 * mirroring the VS Code tab ("CC - Incomplete refactor upgrades audit").
 *
 * Runs off the shared socket from the extension host (which may not have tmux
 * on PATH — see hostTmux). No-op for non-tmux terminals, and idempotent: a
 * repeat call with the same label is skipped. Fire-and-forget by contract — a
 * styling failure must never disrupt the live agent session.
 */
export async function relabelTmuxPane(
  terminal: vscode.Terminal,
  label: string | undefined,
): Promise<void> {
  const state = tmuxTerminals.get(terminal);
  if (!state) return;
  const next = label?.trim() || undefined;
  if (state.borderLabel === next) return;  // already showing this label
  const format = ` #{pane_index}: ${paneBorderText(state.borderName, next)} `;
  const result = await hostTmux(state.socket, [
    'set-option', '-t', state.session, 'pane-border-format', format,
  ]);
  // Record the applied label only on success. hostTmux returns stdout (an empty
  // string for set-option) on success and undefined on failure — so a transient
  // tmux error leaves borderLabel unchanged and a later retry with the same
  // label still runs, rather than being wedged stale by the idempotence guard.
  if (result !== undefined) state.borderLabel = next;
}

// Candidate tmux binary locations. The extension host often lacks tmux on its
// own PATH (the terminal's login shell is what runs the CLI), so we probe the
// common Homebrew/system spots the same way for every host-side tmux call.
const TMUX_BIN_CANDIDATES = ['tmux', '/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'] as const;

/**
 * Run a tmux command on the shared socket from the extension host, trying each
 * candidate binary until one exists. Returns stdout on success, or undefined if
 * no tmux binary was found or the command errored — callers treat tmux styling
 * as best-effort, never load-bearing.
 */
async function hostTmux(socket: string, args: string[]): Promise<string | undefined> {
  for (const bin of TMUX_BIN_CANDIDATES) {
    try {
      const { stdout } = await pexecFile(bin, ['-S', socket, ...args], { timeout: 3_000 });
      return stdout;
    } catch (err) {
      // ENOENT → this binary path doesn't exist; try the next candidate.
      // Any other error → tmux ran but the command failed; don't keep probing.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      return undefined;
    }
  }
  return undefined;
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

/**
 * Read the session's `%N` pane id off the shared socket. Best-effort: the
 * extension host may not have `tmux` on its PATH (it's the terminal's shell
 * that runs the styling), so we try the common Homebrew/system locations and
 * give up quietly. A single-pane agent session has exactly one pane; we take
 * the first line.
 */
async function readPaneId(socket: string, session: string): Promise<string | undefined> {
  const stdout = await hostTmux(socket, ['list-panes', '-t', session, '-F', '#{pane_id}']);
  if (stdout === undefined) return undefined;
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean)[0];
}

/**
 * The tmux coordinates for a terminal we spawned, or undefined for a
 * non-tmux terminal. `session` + `socket` are known at creation; `pane` is
 * resolved (and cached) lazily off the shared socket. Consumed by
 * foreman.registry.snapshotOwnTerminals to publish tmuxSession/tmuxPane.
 */
export async function getTmuxInfo(
  terminal: vscode.Terminal,
): Promise<{ session: string; socket: string; pane?: string } | undefined> {
  const state = tmuxTerminals.get(terminal);
  if (!state) return undefined;
  if (!state.pane) state.pane = await readPaneId(state.socket, state.session);
  return { session: state.session, socket: state.socket, pane: state.pane };
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
