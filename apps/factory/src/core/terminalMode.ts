// Terminal-launch mode for agent terminals — pure resolution, no VS Code import.
//
// Replaces the old default-off `agents.enableTmux` boolean. The extension used
// to opt IN to tmux; now tmux is the default on macOS/Linux via 'auto'. This
// module is the single decision point for "tmux or native" so extension.ts
// never re-derives it inline.

/**
 * User-facing setting `agents.terminalMode`:
 *   - 'auto'   — tmux when available (macOS/Linux with tmux on PATH), else native.
 *   - 'tmux'   — force tmux; warn + fall back to native when tmux is unavailable.
 *   - 'native' — never tmux (the pre-tmux VS Code editor-terminal path).
 */
export type TerminalMode = 'auto' | 'tmux' | 'native';

export interface TerminalModeDecision {
  /** Spawn the agent inside tmux (createTmuxTerminal) vs the native terminal. */
  useTmux: boolean;
  /** The user forced 'tmux' but tmux isn't available — the UI should warn. */
  warnUnavailable: boolean;
}

/**
 * Coerce an untrusted config value to a valid TerminalMode. Anything that is
 * not exactly 'tmux' or 'native' — including undefined, a stale boolean, or a
 * typo — resolves to the new default 'auto'. This is also the back-compat path:
 * a user who never set the (now-removed) enableTmux boolean lands on 'auto',
 * which means "tmux by default when available".
 */
export function normalizeTerminalMode(raw: unknown): TerminalMode {
  return raw === 'tmux' || raw === 'native' ? raw : 'auto';
}

/**
 * Decide whether to use tmux given the mode and whether tmux is available.
 *   - native → never tmux, never warn.
 *   - tmux   → tmux iff available; warn when it isn't (the user asked for it).
 *   - auto   → tmux iff available; never warn (silent, graceful fallback).
 */
export function resolveTerminalMode(
  mode: TerminalMode,
  tmuxAvailable: boolean,
): TerminalModeDecision {
  if (mode === 'native') return { useTmux: false, warnUnavailable: false };
  if (mode === 'tmux') return { useTmux: tmuxAvailable, warnUnavailable: !tmuxAvailable };
  return { useTmux: tmuxAvailable, warnUnavailable: false };
}
