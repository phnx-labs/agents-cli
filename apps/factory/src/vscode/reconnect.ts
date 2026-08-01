// Reconnect resilience for the Factory terminal grid.
//
// The user runs a Remote-SSH terminal grid hosting 30-60 agents. Each agent
// runs in a DETACHED tmux session on the shared socket, so it survives an SSH
// drop. What did NOT survive before was the CLIENT: on a network drop the
// editor terminals tore down, the old cleanup killed the sessions (fixed in
// tmux.ts: cleanupTmuxTerminal only kills on a true agent exit), and nothing
// re-attached. This module closes that loop — after a reconnect (window
// regains focus, or the extension reactivates), it finds every mapped tmux
// session that is still LIVE but has NO client attached and spawns a terminal
// that re-attaches to it (never a new session). Transient attach/SSH failures
// are retried with bounded backoff.
//
// The durable mapping is the persisted-session store (sessions.persist.ts,
// extended with tmuxSession/tmuxSocket/tmuxPane), so the map survives an
// extension reload — the reattach targets are read back from disk on activate.

import * as vscode from 'vscode';
import type { PersistedSession } from '../core/sessions.persist';
import { queryTmuxSessionState, type TmuxSessionState } from './tmux';

// One reattach target: a persisted terminal↔tmux mapping that names a live,
// client-less session we should reconnect to.
export interface ReattachTarget {
  session: PersistedSession;
  tmuxSession: string;
  tmuxSocket: string;
}

// A persisted session is reattach-eligible iff it carries a tmux session +
// socket (the native terminal path has neither). Exported so restoreAgentTerminals
// can defer these to the reconnect pass instead of recreating/resuming them —
// a reload of a tmux-backed agent must re-attach the live session, never restart it.
export function hasTmuxMapping(
  s: PersistedSession,
): s is PersistedSession & { tmuxSession: string; tmuxSocket: string } {
  return typeof s.tmuxSession === 'string' && s.tmuxSession.length > 0
    && typeof s.tmuxSocket === 'string' && s.tmuxSocket.length > 0;
}

// A permanent (non-transient) reattach failure. `withRetry` rethrows it
// immediately instead of burning the backoff budget — retrying a permanent
// failure (e.g. an unknown agent prefix) just wastes seconds on every
// window-focus event and never succeeds.
export class NonRetryableError extends Error {
  readonly nonRetryable = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

function isNonRetryable(err: unknown): boolean {
  return err instanceof NonRetryableError
    || (typeof err === 'object' && err !== null && (err as { nonRetryable?: unknown }).nonRetryable === true);
}

// Decide, from a session's tmux state, whether it needs reconnecting. Pure so
// it's unit-testable without tmux: reattach iff the session exists, a pane is
// alive (the agent is still running), and no client is attached (nobody is
// viewing it — a live client means it's already connected in another tab).
export function needsReattach(state: TmuxSessionState): boolean {
  return state.exists && state.paneAlive && !state.hasClient;
}

// Scan persisted mappings and return the ones that are live + client-less.
// `query` is injected so tests can drive it with a fake tmux state; production
// passes queryTmuxSessionState. Dead / gone / already-attached sessions are
// skipped — a dead pane means the agent exited (the agent-exit path, handled by
// pruning the mapping), and an attached session is already connected.
export async function scanReattachTargets(
  persisted: PersistedSession[],
  query: (socket: string, session: string) => Promise<TmuxSessionState>,
): Promise<ReattachTarget[]> {
  const out: ReattachTarget[] = [];
  for (const s of persisted) {
    if (!hasTmuxMapping(s)) continue;
    const state = await query(s.tmuxSocket, s.tmuxSession);
    if (needsReattach(state)) {
      out.push({ session: s, tmuxSession: s.tmuxSession, tmuxSocket: s.tmuxSocket });
    }
  }
  return out;
}

export interface RetryOptions {
  attempts: number;      // total tries (>= 1)
  baseDelayMs: number;   // first backoff step
  maxDelayMs: number;    // cap
}

export const DEFAULT_RETRY: RetryOptions = { attempts: 4, baseDelayMs: 500, maxDelayMs: 8_000 };

// Exponential backoff with a cap: baseDelayMs * 2^attempt, clamped to
// maxDelayMs. Pure — unit-tested directly.
export function backoffDelayMs(attempt: number, opts: RetryOptions): number {
  const raw = opts.baseDelayMs * 2 ** attempt;
  return Math.min(raw, opts.maxDelayMs);
}

// Run `fn` with bounded exponential backoff. Resolves with the first success;
// rejects with the last error after exhausting attempts. `sleep` is injected so
// tests run instantly.
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = DEFAULT_RETRY,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // A permanent failure will never succeed on retry — surface it now instead
      // of sleeping through the whole backoff budget on every reconnect pass.
      if (isNonRetryable(err)) throw err;
      if (attempt < opts.attempts - 1) {
        await sleep(backoffDelayMs(attempt, opts));
      }
    }
  }
  throw lastErr;
}

// Everything the reconnect orchestrator needs from the extension host. Injected
// so this module stays free of the big extension.ts import graph (and testable).
export interface ReconnectDeps {
  // Persisted terminal↔tmux mappings for the active workspace (survives reload).
  loadPersisted: () => PersistedSession[];
  // tmux liveness probe on the shared socket (queryTmuxSessionState in prod).
  queryState?: (socket: string, session: string) => Promise<TmuxSessionState>;
  // terminalIds already tracked as open in THIS window — never double-attach one.
  trackedTerminalIds: () => Set<string>;
  // Spawn a reattach terminal for one target and register it (restored:true).
  // Throws on failure so withRetry can retry a transient SSH/attach error.
  reattachOne: (target: ReattachTarget) => Promise<void>;
  // Re-post panelVisibility:true / kick an immediate local-session fetch so the
  // Floor grid unfreezes the moment we reconnect.
  resumePanelPolling: () => void;
  retry?: RetryOptions;
}

// Drive one reconnect pass: find live client-less mappings not already open in
// this window, reattach each (with retry), then resume UI polling. Idempotent —
// safe to call on every window-focus event; the trackedTerminalIds guard makes
// a repeat pass a no-op once the tabs are back.
export async function runReconnectPass(deps: ReconnectDeps): Promise<number> {
  const query = deps.queryState ?? queryTmuxSessionState;
  const persisted = deps.loadPersisted();
  const targets = await scanReattachTargets(persisted, query);
  const tracked = deps.trackedTerminalIds();
  const toAttach = targets.filter((t) => !tracked.has(t.session.terminalId));

  let attached = 0;
  for (const target of toAttach) {
    try {
      await withRetry(() => deps.reattachOne(target), deps.retry ?? DEFAULT_RETRY);
      attached++;
    } catch (err) {
      console.warn(`[RECONNECT] gave up reattaching ${target.tmuxSession}: ${err}`);
    }
  }

  // Always resume polling on a reconnect, even if there was nothing to attach —
  // the grid may be frozen behind a stale panelVisibility from before the drop.
  deps.resumePanelPolling();
  return attached;
}

// Wire the reconnect triggers. Runs a pass on activation (extension reload =
// reconnect after a crash/window-reload) and whenever the window regains focus
// (the common Remote-SSH reconnect signal — the session was live the whole
// time, so no panel view-state transition fires on its own).
export function registerReconnect(
  context: vscode.ExtensionContext,
  deps: ReconnectDeps,
): void {
  // De-dupe overlapping passes: a focus event mid-pass shouldn't start a second.
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      await runReconnectPass(deps);
    } catch (err) {
      console.warn('[RECONNECT] pass failed:', err);
    } finally {
      running = false;
    }
  };

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) void pass();
    }),
  );

  // Activation pass: fires once the terminal scan/restore has settled so
  // trackedTerminalIds is populated and we don't double-attach a tab VS Code
  // already restored.
  void pass();
}
