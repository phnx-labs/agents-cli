/**
 * Terminal injection — Gap 2 of the Terminal Engine.
 *
 * Where the rest of the engine OPENS a surface (a tab / split running a
 * command), injection types into an ALREADY-running surface. It's the primitive
 * a native watchdog (RUSH-1415) needs to nudge a stalled agent with "continue"
 * delivered into the exact terminal that agent lives in — the gap flagged in
 * src/lib/session/provenance.ts:20:
 *
 *   > Actually delivering the keystrokes is Gap 2 (pty/tmux send-keys).
 *
 * It mirrors the engine's shape exactly: pure per-backend spec builders (like
 * `tmuxTabArgv` / `itermTabScript`) produce a `LaunchSpec` (argv), and the same
 * `runSpec` transport runs it — so injection inherits the engine's local/remote
 * (`--host` over SSH) execution for free. A `LaunchSpec` never opens anything;
 * building one is side-effect-free and unit-testable without a display.
 *
 * Backends:
 *   - tmux  → `tmux send-keys -t <pane>` — the send-keys primitive addressed by
 *             pane id + socket (the exact rail provenance.ts:147-149 identifies).
 *   - iterm/ghostty (macOS) → AppleScript that ADDRESSES the target window/tab
 *             and injects via System Events keystrokes. Uses the engine's
 *             `appleScriptStr` escaper; guarded by the backend's own
 *             `isAvailable` (platform + app installed).
 *   - pty   → the `agents pty write` sidecar path (ptyRequest). Local-only —
 *             the sidecar is not an engine transport surface.
 *
 * Ink-TUI Enter semantics: Claude's Ink TUI swallows an Enter fused to the text,
 * so the default path delivers the text and the Enter as TWO SEPARATE writes
 * (swarmify's `sendText(text,false)` then `sendText('\r',false)`). `combined`
 * opts into one fused write for plain shells / REPLs.
 */

import { ptyRequest } from '../pty-client.js';
import { appleScriptStr } from './quote.js';
import { runSpec, type HostResolver } from './transport.js';
import { itermBackend, ghosttyBackend } from './backends/index.js';
import { currentContext, type LaunchSpec, type EngineContext } from './types.js';

/**
 * An already-running surface to type into. A superset of the engine's launch
 * `Backend` — it adds `pty` (the sidecar), which the engine can't launch but can
 * be injected into.
 */
export type InjectTarget =
  | { backend: 'tmux'; pane: string; socket?: string }
  | { backend: 'iterm'; session?: string }
  | { backend: 'ghostty'; window?: string }
  | { backend: 'pty'; id: string };

export type InjectBackend = InjectTarget['backend'];

export interface InjectOptions {
  /** Append Enter after the text. Default true. */
  enter?: boolean;
  /**
   * Fuse the text and its Enter into a SINGLE write. Default false — the safe
   * default sends the text, then the Enter, as two separate writes (Ink-TUI
   * safe). Set true for plain shells / REPLs that want one atomic line.
   */
  combined?: boolean;
  /** tmux socket override (defaults to `target.socket`, then tmux's default socket). */
  socket?: string;
  /** Remote host for the tmux / AppleScript backends (runs the spec over SSH). Local by default. */
  host?: string;
  /** Resolve a host alias to an ssh target (see the engine's transport). */
  resolveHost?: HostResolver;
  /** Ambient context for the availability check (defaults to the live process context). */
  ctx?: EngineContext;
  /** Don't execute — return the spec(s) that WOULD run. Lets the macOS paths be asserted on Linux. */
  dryRun?: boolean;
}

export interface InjectResult {
  ok: boolean;
  backend: InjectBackend;
  /** Discrete writes delivered: 2 for the Ink-safe text+Enter split, 1 when combined or enter=false. */
  writes: number;
  /** For the tmux / AppleScript backends (or any dryRun), the spec(s) that ran / would run. */
  specs?: LaunchSpec[];
  error?: string;
}

/** Carriage return — what Enter delivers into a raw PTY/tmux byte stream. */
const CR = '\r';

// --- tmux -------------------------------------------------------------------

/**
 * argv for `tmux send-keys` targeting a pane by id. Starts with `tmux` (like the
 * engine's `tmuxTabArgv`) so the same transport runs it locally or over SSH. The
 * socket, when set, is positioned before the subcommand (`-S` must lead). `-l`
 * sends the keys literally; without it tmux interprets a key name like `Enter`.
 *
 * NOTE: distinct from `sendKeys()` in src/lib/tmux/session.ts — that one
 * addresses by session *name* on the default socket (the `agents tmux` surface)
 * and shells out directly; this one addresses by *pane id* + arbitrary socket and
 * returns an SSH-capable `LaunchSpec` for the engine transport. Don't collapse them.
 */
export function tmuxSendKeysArgv(
  pane: string,
  keys: string,
  opts: { literal?: boolean; socket?: string } = {},
): string[] {
  const argv = ['tmux'];
  if (opts.socket) argv.push('-S', opts.socket);
  argv.push('send-keys', '-t', pane);
  if (opts.literal) argv.push('-l');
  argv.push(keys);
  return argv;
}

/** The one-or-two send-keys specs for a tmux injection (Ink-safe split by default). */
export function tmuxInjectSpecs(
  target: Extract<InjectTarget, { backend: 'tmux' }>,
  text: string,
  o: { enter: boolean; combined: boolean; socket?: string },
): LaunchSpec[] {
  const socket = o.socket ?? target.socket;
  if (o.enter && o.combined) {
    return [{ argv: tmuxSendKeysArgv(target.pane, text + CR, { literal: true, socket }) }];
  }
  const specs: LaunchSpec[] = [{ argv: tmuxSendKeysArgv(target.pane, text, { literal: true, socket }) }];
  // A separate Enter keypress — its own write, so the Ink TUI sees Enter alone.
  if (o.enter) specs.push({ argv: tmuxSendKeysArgv(target.pane, 'Enter', { socket }) });
  return specs;
}

// --- macOS (iterm / ghostty) ------------------------------------------------

/**
 * AppleScript that brings the target iTerm2 session (tab) to the front, then
 * injects `text` and — when `enter` — a SEPARATE Return keypress (`key code 36`)
 * so the Ink TUI sees Enter as its own event. Omitting `session` types into the
 * current session.
 */
export function itermInjectScript(text: string, opts: { session?: string; enter: boolean }): string {
  const lines: string[] = ['tell application "iTerm2"', '  activate'];
  if (opts.session) {
    lines.push(
      '  repeat with w in windows',
      '    repeat with t in tabs of w',
      '      repeat with s in sessions of t',
      `        if (id of s) is ${appleScriptStr(opts.session)} then`,
      '          select w',
      '          tell w to select t',
      '        end if',
      '      end repeat',
      '    end repeat',
      '  end repeat',
    );
  }
  lines.push('end tell');
  lines.push(`tell application "System Events" to keystroke ${appleScriptStr(text)}`);
  if (opts.enter) lines.push('tell application "System Events" to key code 36');
  return lines.join('\n');
}

/**
 * AppleScript for Ghostty (no scripting dictionary): raise the target window via
 * System Events, then keystroke the text and a separate Return. `window` matches
 * a window whose title contains the string; omitted → the frontmost Ghostty window.
 */
export function ghosttyInjectScript(text: string, opts: { window?: string; enter: boolean }): string {
  const lines: string[] = ['tell application "System Events"', '  tell process "ghostty"', '    set frontmost to true'];
  if (opts.window) {
    lines.push(`    perform action "AXRaise" of (first window whose title contains ${appleScriptStr(opts.window)})`);
  }
  lines.push('  end tell');
  lines.push(`  keystroke ${appleScriptStr(text)}`);
  if (opts.enter) lines.push('  key code 36');
  lines.push('end tell');
  return lines.join('\n');
}

/** The osascript spec for a macOS injection. One invocation delivers keystroke + Return. */
export function appleScriptInjectSpec(
  target: Extract<InjectTarget, { backend: 'iterm' | 'ghostty' }>,
  text: string,
  enter: boolean,
): LaunchSpec {
  const script =
    target.backend === 'iterm'
      ? itermInjectScript(text, { session: target.session, enter })
      : ghosttyInjectScript(text, { window: target.window, enter });
  return { argv: ['osascript', '-e', script] };
}

// --- pty --------------------------------------------------------------------

async function injectPty(
  target: Extract<InjectTarget, { backend: 'pty' }>,
  text: string,
  o: { enter: boolean; combined: boolean; host?: string; dryRun?: boolean },
): Promise<InjectResult> {
  if (o.host && o.host !== 'local') {
    return { ok: false, backend: 'pty', writes: 0, error: 'pty injection is local-only (the sidecar is not a remote surface)' };
  }
  // Same Ink-safe split as tmux: text write, then a separate CR write.
  const writes: string[] = o.enter && o.combined ? [text + CR] : o.enter ? [text, CR] : [text];

  if (o.dryRun) return { ok: true, backend: 'pty', writes: writes.length };

  try {
    for (const input of writes) {
      const res = await ptyRequest('write', target.id, { input });
      if (!res.ok) return { ok: false, backend: 'pty', writes: 0, error: res.error ?? 'pty write failed' };
    }
    return { ok: true, backend: 'pty', writes: writes.length };
  } catch (err) {
    return { ok: false, backend: 'pty', writes: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// --- public entry -----------------------------------------------------------

/**
 * Deliver `text` (+ Enter) into an existing terminal surface. Resolves the
 * target's backend and routes to the matching primitive. Never throws — launch
 * failures come back in the result, like the engine's `openSurface`.
 */
export async function injectIntoTerminal(
  target: InjectTarget,
  text: string,
  opts: InjectOptions = {},
): Promise<InjectResult> {
  const enter = opts.enter !== false;
  const combined = opts.combined === true;

  if (target.backend === 'pty') {
    return injectPty(target, text, { enter, combined, host: opts.host, dryRun: opts.dryRun });
  }

  // tmux + AppleScript backends run through the engine transport.
  const specs =
    target.backend === 'tmux'
      ? tmuxInjectSpecs(target, text, { enter, combined, socket: opts.socket })
      : [appleScriptInjectSpec(target, text, enter)];

  // A macOS keystroke injection is one osascript spec that emits keystroke +
  // Return, i.e. two writes; tmux/pty count their discrete send-keys/write calls.
  const writes = target.backend === 'tmux' ? specs.length : enter ? 2 : 1;

  if (opts.dryRun) return { ok: true, backend: target.backend, writes, specs };

  // AppleScript backends: guard on the backend's own availability, but only for a
  // LOCAL run (a remote host is assumed to have the app — its ssh leg reports failure).
  if (target.backend === 'iterm' || target.backend === 'ghostty') {
    if (!opts.host || opts.host === 'local') {
      const backend = target.backend === 'iterm' ? itermBackend : ghosttyBackend;
      const ctx = opts.ctx ?? currentContext();
      if (!backend.isAvailable(ctx)) {
        return { ok: false, backend: target.backend, writes: 0, specs, error: `${backend.label} is not available here (platform ${ctx.platform})` };
      }
    }
  }

  for (const spec of specs) {
    const res = await runSpec(spec, opts.host, opts.resolveHost);
    if (!res.ok) return { ok: false, backend: target.backend, writes: 0, specs, error: res.error };
  }
  return { ok: true, backend: target.backend, writes, specs };
}
