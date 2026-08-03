/**
 * Backend registry + current-terminal detection.
 */
import type { Backend, EngineContext, TerminalBackend } from '../types.js';
import { itermBackend } from './iterm.js';
import { ghosttyBackend } from './ghostty.js';
import { tmuxBackend } from './tmux.js';
import { vscodiumAgentBackend } from './vscodium-agent.js';
import { terminalAppBackend } from './terminal-app.js';

/**
 * All known interactive backends, keyed by id.
 *
 * Insertion order is the preference order `availableBackends` returns, and
 * `terminal` (Terminal.app) sits LAST deliberately: it is the every-Mac floor, so
 * a caller that falls back to the first available backend still prefers a real
 * terminal the user chose to install.
 */
export const BACKENDS: Record<Backend, TerminalBackend> = {
  iterm: itermBackend,
  ghostty: ghosttyBackend,
  tmux: tmuxBackend,
  'vscodium-agent': vscodiumAgentBackend,
  terminal: terminalAppBackend,
};

/**
 * The backend for the terminal the CLI is currently running in, or null if we
 * can't open a surface into it. tmux wins (via `$TMUX`) because a tmux pane can
 * live inside iTerm/Ghostty; otherwise fall back to `TERM_PROGRAM`.
 */
export function detectCurrentBackend(ctx: EngineContext): Backend | null {
  if (ctx.env.TMUX) return 'tmux';
  const term = (ctx.env.TERM_PROGRAM || '').toLowerCase();
  if (term.includes('iterm')) return 'iterm';
  if (term.includes('ghostty')) return 'ghostty';
  // Terminal.app sets TERM_PROGRAM=Apple_Terminal.
  if (term.includes('apple_terminal')) return 'terminal';
  return null;
}

/** Backends that can actually be driven in this context. */
export function availableBackends(ctx: EngineContext): TerminalBackend[] {
  return Object.values(BACKENDS).filter((b) => b.isAvailable(ctx));
}

export { itermBackend, ghosttyBackend, tmuxBackend, vscodiumAgentBackend, terminalAppBackend };
