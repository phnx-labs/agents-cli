/**
 * Host link — whether anything is still on the other end of a live session.
 *
 * Every liveness signal the scan already has answers "is the AGENT process
 * alive". None of them answer "is anyone still driving it", and those come apart
 * in exactly the two ways a user notices:
 *
 *   - **The host program died and took the agent with it.** VS Code / the editor
 *     window crashes or the SSH connection drops, so the agent process dies with
 *     its parent, but the window never got to run its teardown — its slice of
 *     `live-terminals.json` is left behind, stale, still naming a dead pid. Today
 *     that entry is filtered out at read time, so the session simply VANISHES
 *     from `--active` instead of reporting that it fell over. That is `host-gone`.
 *
 *   - **The host program died and the agent survived it.** The agent was hosted
 *     in tmux (or otherwise reparented), so it keeps running with zero clients
 *     attached: still burning tokens, or sitting on a question nobody will ever
 *     answer, with no window anywhere showing it. That is `no-client`.
 *
 * Both are DERIVED, never asserted — from the agent pid, the owning window's
 * keepalive, and tmux's own attached-client count. A deliberately backgrounded
 * session (`agents sessions detach`) is excluded by construction: it is supposed
 * to have no client, so calling it orphaned would be a false alarm on the one
 * case the user asked for.
 */

/** How a session is connected to the client that should be driving it. */
export type HostLink =
  /** A client is attached, or nothing indicates otherwise. The normal case. */
  | 'connected'
  /** Alive, but nothing is viewing it — the host window is gone and the agent outlived it. */
  | 'no-client'
  /** The host window is gone AND the agent process died with it — an unclean exit. */
  | 'host-gone';

/**
 * How long an IDE window's registry slice may go without a refresh before we
 * treat that window as gone. AGI EXT force-republishes its slice
 * every 4 minutes (`KEEPALIVE_FORCE_MS` in `apps/ext/src/vscode/foreman.registry.ts`)
 * and on every terminal open/close, so a slice this old means the window is no
 * longer running — it is not merely quiet. Deliberately the same 10 minutes the
 * extension itself uses to garbage-collect a peer window's slice, so the CLI and
 * the extension agree on when a window is dead.
 */
export const HOST_HEARTBEAT_STALE_MS = 10 * 60_000;

export interface HostLinkInput {
  /** The agent process is still alive (already pid-reuse-checked by the caller). */
  pidAlive: boolean;
  /**
   * When the owning IDE window last refreshed its slice of the live-terminals
   * registry. Absent for a session no IDE window owns (a bare terminal, a team
   * spawn, a cloud task) — those have no window whose death we could observe.
   */
  windowHeartbeatMs?: number;
  /**
   * Clients attached to this session's tmux session (`#{session_attached}`).
   * Absent when the session is not tmux-hosted, which is NOT the same as zero:
   * zero is a positive "nobody is looking", absent is "we cannot tell".
   */
  tmuxClients?: number;
  /** The session was deliberately backgrounded — `presence` is `background`/`parked`. */
  deliberatelyDetached?: boolean;
  nowMs?: number;
}

/**
 * Classify a live row's host link. Pure — every signal is passed in, so the
 * whole decision table is unit-testable without a process table, a tmux server,
 * or a running editor.
 */
export function classifyHostLink(input: HostLinkInput): HostLink {
  const now = input.nowMs ?? Date.now();
  // A session detached on purpose has no client BY DESIGN. It is the one case
  // that looks identical to an orphan from the outside, so it is excluded first —
  // otherwise every `agents sessions detach` would raise a false alarm.
  if (input.deliberatelyDetached) return 'connected';

  const windowGone =
    input.windowHeartbeatMs !== undefined && now - input.windowHeartbeatMs >= HOST_HEARTBEAT_STALE_MS;

  // The host window stopped keeping its registry slice alive AND the agent it
  // owned is dead: the pair went down together without teardown.
  if (windowGone && !input.pidAlive) return 'host-gone';

  if (!input.pidAlive) return 'connected'; // a plain dead pid is `closed`, not an orphan

  // Alive with tmux reporting zero attached clients: nobody is watching it. This
  // is the authoritative signal — tmux knows exactly how many clients it has.
  if (input.tmuxClients === 0) return 'no-client';

  // Alive, not tmux-hosted (or tmux says someone is attached), but the window
  // that owned it is gone. The agent outlived its editor.
  if (windowGone) return 'no-client';

  return 'connected';
}
