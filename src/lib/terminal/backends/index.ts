/**
 * Backend registry + current-terminal detection.
 */
import type { Backend, EngineContext, TerminalBackend } from '../types.js';
import { itermBackend } from './iterm.js';
import { ghosttyBackend } from './ghostty.js';
import { tmuxBackend } from './tmux.js';
import { vscodiumAgentBackend } from './vscodium-agent.js';

/** All known interactive backends, keyed by id. */
export const BACKENDS: Record<Backend, TerminalBackend> = {
  iterm: itermBackend,
  ghostty: ghosttyBackend,
  tmux: tmuxBackend,
  'vscodium-agent': vscodiumAgentBackend,
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
  return null;
}

/** Backends that can actually be driven in this context. */
export function availableBackends(ctx: EngineContext): TerminalBackend[] {
  return Object.values(BACKENDS).filter((b) => b.isAvailable(ctx));
}

export { itermBackend, ghosttyBackend, tmuxBackend, vscodiumAgentBackend };
