/**
 * Which terminal to launch a NEW surface into, for callers that aren't in one.
 *
 * `detectCurrentBackend` answers this from `$TMUX` / `$TERM_PROGRAM`, which is
 * correct for a command the user typed in a terminal — and useless to a GUI
 * caller. The menu-bar helper is launched by launchd with no terminal in its
 * ancestry, so it used to hardcode AppleScript against Terminal.app and opened
 * every "New Session" there no matter what the user actually works in.
 *
 * The signal it was missing is already on disk: `agents sessions --active`
 * attributes every live session to its host app (`ActiveSession.host`, resolved
 * by walking the process table in session/active.ts). So the terminal the user
 * demonstrably runs agents in is the terminal a new session should open in —
 * that's what this module resolves, and it is the reason the menu bar now opens
 * Ghostty for a Ghostty user and iTerm for an iTerm user.
 *
 * Resolution order (each step is skipped when it names nothing DRIVABLE here):
 *   1. the terminal this process is running in   -> 'current-terminal'
 *   2. the host app of the most recent live session -> 'active-session'
 *   3. the first available backend (Terminal.app is the every-Mac floor) -> 'available'
 */
import type { Backend, EngineContext } from './types.js';
import { BACKENDS, availableBackends, detectCurrentBackend } from './backends/index.js';

/**
 * `ActiveSession.host` -> the backend that can open a new surface in it.
 *
 * Deliberately partial. A host is listed ONLY when the engine can really drive
 * it, because a wrong mapping opens the wrong app and looks like success:
 *   - `code` / `cursor` / `windsurf` are absent even though the engine has an
 *     editor backend — the registered `vscodium-agent` is bound to the VSCodium
 *     variant (backends/vscodium-agent.ts: `EDITOR_VARIANTS[0]`), so mapping
 *     Cursor to it would open VSCodium instead of Cursor.
 *   - `warp` / `kitty` / `wezterm` / `alacritty` / `hyper` / `screen` are absent
 *     because no backend drives them yet.
 * An unmapped host isn't an error — resolution simply moves to the next session,
 * and ultimately to the available-backend floor.
 */
export const SESSION_HOST_BACKENDS: Readonly<Record<string, Backend>> = Object.freeze({
  iterm: 'iterm',
  ghostty: 'ghostty',
  terminal: 'terminal',
  tmux: 'tmux',
  codium: 'vscodium-agent',
});

/** The subset of an ActiveSession this resolver reads. */
export interface SessionHostSample {
  host?: string;
  /**
   * For a tmux-hosted session: the app its attached tmux client is in
   * (`ActiveSession.viewingIn.app`). This is load-bearing, not a nicety —
   * `agents run` wraps interactive runs in tmux, so a session the user started
   * in Ghostty is attributed `host: 'tmux'` and the terminal it is actually
   * displayed in is only knowable through the attached client. Takes precedence
   * over `host`, which for these sessions names the multiplexer, not a terminal.
   */
  viewingApp?: string;
  lastActivityMs?: number;
  startedAtMs?: number;
}

/** Where the chosen backend came from — reported so a caller can say why. */
export type BackendSource = 'forced' | 'current-terminal' | 'active-session' | 'available';

export interface LaunchBackendChoice {
  backend: Backend;
  source: BackendSource;
  /** The `ActiveSession.host` that selected it, when source is 'active-session'. */
  host?: string;
}

/** Most recent first. Falls back to start time, then to the given order. */
function byRecency(a: SessionHostSample, b: SessionHostSample): number {
  const at = a.lastActivityMs ?? a.startedAtMs ?? 0;
  const bt = b.lastActivityMs ?? b.startedAtMs ?? 0;
  return bt - at;
}

/**
 * Injection seam so the PRECEDENCE is testable without the machine's installed
 * apps. `isAvailable` for iterm/ghostty/terminal probes `/Applications`, so a
 * test that just passes `platform: 'darwin'` silently depends on the host having
 * those apps — it passes on a dev Mac and fails on a Linux CI runner. Same shape
 * as `ViewingInDeps` in session/viewing-in.ts.
 */
export interface BackendResolveDeps {
  /** Defaults to the real backend availability probe. */
  isAvailable?: (backend: Backend, ctx: EngineContext) => boolean;
}

const realIsAvailable = (backend: Backend, ctx: EngineContext): boolean =>
  BACKENDS[backend].isAvailable(ctx);

/**
 * The backend for the terminal the user's most recent live session runs in, or
 * null when no live session names a host this engine can drive. Pure — the
 * caller supplies the sessions, so the precedence is unit-testable without a
 * process table.
 */
export function backendFromSessions(
  sessions: SessionHostSample[],
  ctx: EngineContext,
  deps: BackendResolveDeps = {},
): { backend: Backend; host: string } | null {
  const isAvailable = deps.isAvailable ?? realIsAvailable;
  for (const s of [...sessions].sort(byRecency)) {
    // The app an attached tmux client is in beats the multiplexer name.
    const host = s.viewingApp ?? s.host;
    if (!host) continue;
    // hasOwn, not a bare index: the host is data, and `SESSION_HOST_BACKENDS['constructor']`
    // would otherwise hand back a prototype member that BACKENDS cannot key on.
    if (!Object.hasOwn(SESSION_HOST_BACKENDS, host)) continue;
    const backend = SESSION_HOST_BACKENDS[host];
    if (!backend) continue;
    if (!isAvailable(backend, ctx)) continue;
    return { backend, host };
  }
  return null;
}

/**
 * Resolve the terminal to open a new surface in. Pure. Returns null when this
 * machine has no drivable terminal at all (Linux with no tmux, an SSH session),
 * which callers must handle — never a guess that silently goes nowhere.
 */
export function resolveLaunchBackend(
  ctx: EngineContext,
  sessions: SessionHostSample[] = [],
  deps: BackendResolveDeps = {},
): LaunchBackendChoice | null {
  const isAvailable = deps.isAvailable ?? realIsAvailable;
  const current = detectCurrentBackend(ctx);
  if (current && isAvailable(current, ctx)) {
    return { backend: current, source: 'current-terminal' };
  }
  const fromSession = backendFromSessions(sessions, ctx, deps);
  if (fromSession) {
    return { backend: fromSession.backend, source: 'active-session', host: fromSession.host };
  }
  const first = (Object.keys(BACKENDS) as Backend[]).find((b) => isAvailable(b, ctx));
  return first ? { backend: first, source: 'available' } : null;
}

/** One line explaining a choice, for the `agents run --terminal` preamble. */
export function describeBackendChoice(choice: LaunchBackendChoice): string {
  const label = BACKENDS[choice.backend].label;
  switch (choice.source) {
    case 'forced':
      return `${label} (you asked for it)`;
    case 'current-terminal':
      return `${label} (the terminal you're in)`;
    case 'active-session':
      return `${label} (where your ${choice.host} sessions run)`;
    case 'available':
      return `${label} (no running session named a terminal)`;
  }
}
