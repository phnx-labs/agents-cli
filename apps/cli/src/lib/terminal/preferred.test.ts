import { describe, it, expect } from 'vitest';
import {
  SESSION_HOST_BACKENDS,
  backendFromSessions,
  resolveLaunchBackend,
  describeBackendChoice,
  type SessionHostSample,
} from './preferred.js';
import { terminalAppBackend, terminalAppTabScript } from './backends/terminal-app.js';
import type { EngineContext } from './types.js';

// A GUI caller with no terminal in its ancestry — exactly the menu-bar helper's
// launchd environment, which is the case this module exists for.
const guiCtx: EngineContext = { platform: 'darwin', env: {} };

describe('backendFromSessions', () => {
  it('picks the terminal the most recent live session runs in', () => {
    const sessions: SessionHostSample[] = [
      { host: 'terminal', lastActivityMs: 1_000 },
      { host: 'ghostty', lastActivityMs: 9_000 },
      { host: 'iterm', lastActivityMs: 5_000 },
    ];
    expect(backendFromSessions(sessions, guiCtx)).toEqual({ backend: 'ghostty', host: 'ghostty' });
  });

  it('falls to the next session when the newest host has no drivable backend', () => {
    // warp is detected by the session engine but no backend drives it, so the
    // iTerm session behind it decides — not a silent wrong-app launch.
    const sessions: SessionHostSample[] = [
      { host: 'warp', lastActivityMs: 9_000 },
      { host: 'iterm', lastActivityMs: 5_000 },
    ];
    expect(backendFromSessions(sessions, guiCtx)).toEqual({ backend: 'iterm', host: 'iterm' });
  });

  it('ranks by startedAtMs when a session has no activity stamp', () => {
    const sessions: SessionHostSample[] = [
      { host: 'iterm', startedAtMs: 100 },
      { host: 'ghostty', startedAtMs: 900 },
    ];
    expect(backendFromSessions(sessions, guiCtx)?.backend).toBe('ghostty');
  });

  it('skips a backend that cannot be driven in this context', () => {
    // tmux is only drivable from inside tmux ($TMUX). A tmux-hosted session must
    // therefore not select it from a GUI caller.
    expect(backendFromSessions([{ host: 'tmux', lastActivityMs: 1 }], guiCtx)).toBeNull();
    const inTmux: EngineContext = { platform: 'darwin', env: { TMUX: '/tmp/tmux-501/default,1,0' } };
    expect(backendFromSessions([{ host: 'tmux', lastActivityMs: 1 }], inTmux)).toEqual({
      backend: 'tmux',
      host: 'tmux',
    });
  });

  it('prefers the app a tmux session is VIEWED in over the multiplexer', () => {
    // `agents run` tmux-wraps interactive runs, so a session started in Ghostty
    // is attributed host 'tmux'. Without viewingApp this resolves to nothing
    // drivable and the menu bar guesses; with it, Ghostty wins.
    expect(backendFromSessions([{ host: 'tmux', viewingApp: 'ghostty', lastActivityMs: 9 }], guiCtx))
      .toEqual({ backend: 'ghostty', host: 'ghostty' });
  });

  it('keeps the tmux host when the session is detached (no viewer)', () => {
    // No client attached => no viewingApp => nothing drivable from a GUI caller.
    expect(backendFromSessions([{ host: 'tmux', lastActivityMs: 9 }], guiCtx)).toBeNull();
  });

  it('returns null for sessions with no host at all', () => {
    expect(backendFromSessions([{ lastActivityMs: 5 }, {}], guiCtx)).toBeNull();
  });

  it('maps only hosts the engine can really drive', () => {
    // Guard against a well-meaning "cursor -> vscodium-agent" edit: the single
    // registered editor backend is bound to the VSCodium variant, so mapping
    // Cursor would open the wrong app.
    expect(SESSION_HOST_BACKENDS.cursor).toBeUndefined();
    expect(SESSION_HOST_BACKENDS.code).toBeUndefined();
    expect(SESSION_HOST_BACKENDS.warp).toBeUndefined();
    expect(SESSION_HOST_BACKENDS.codium).toBe('vscodium-agent');
  });
});

describe('resolveLaunchBackend', () => {
  it('prefers the terminal the caller is already in over session history', () => {
    const inGhostty: EngineContext = { platform: 'darwin', env: { TERM_PROGRAM: 'ghostty' } };
    expect(resolveLaunchBackend(inGhostty, [{ host: 'iterm', lastActivityMs: 9 }])).toEqual({
      backend: 'ghostty',
      source: 'current-terminal',
    });
  });

  it('uses live sessions when the caller has no terminal (the menu-bar case)', () => {
    expect(resolveLaunchBackend(guiCtx, [{ host: 'iterm', lastActivityMs: 9 }])).toEqual({
      backend: 'iterm',
      source: 'active-session',
      host: 'iterm',
    });
  });

  it('falls back to an available backend when nothing names a terminal', () => {
    const choice = resolveLaunchBackend(guiCtx, []);
    expect(choice?.source).toBe('available');
  });

  it('returns null where no terminal can be driven at all', () => {
    // Linux, not inside tmux: no backend in the registry is available.
    expect(resolveLaunchBackend({ platform: 'linux', env: {} }, [{ host: 'iterm' }])).toBeNull();
  });
});

describe('terminal-app backend', () => {
  it('is unavailable over SSH — osascript cannot reach the GUI login there', () => {
    expect(terminalAppBackend.isAvailable({ platform: 'darwin', env: {} })).toBe(true);
    expect(
      terminalAppBackend.isAvailable({ platform: 'darwin', env: { SSH_CONNECTION: '10.0.0.1 22' } }),
    ).toBe(false);
    expect(terminalAppBackend.isAvailable({ platform: 'linux', env: {} })).toBe(false);
  });

  it('cds into the working directory and execs the command in an interactive login shell', () => {
    const script = terminalAppTabScript('/tmp/my repo', ['agents', 'run', 'claude']);
    expect(script).toContain('tell application "Terminal"');
    // The -i is load-bearing: version shims are only on PATH for interactive shells.
    expect(script).toContain('zsh -ilc');
    // The cwd is POSIX single-quoted ('\'' around the inner quote) and then the
    // backslash is doubled for the AppleScript string literal, so AppleScript
    // hands zsh exactly `cd '/tmp/my repo'` — a space in the path stays one arg.
    expect(script).toContain(String.raw`cd '\\''/tmp/my repo'\\'' && exec agents run claude`);
  });
});

describe('describeBackendChoice', () => {
  it('names why each backend was chosen', () => {
    expect(describeBackendChoice({ backend: 'ghostty', source: 'active-session', host: 'ghostty' }))
      .toBe('Ghostty (where your ghostty sessions run)');
    expect(describeBackendChoice({ backend: 'iterm', source: 'current-terminal' }))
      .toBe("iTerm (the terminal you're in)");
    expect(describeBackendChoice({ backend: 'terminal', source: 'available' }))
      .toBe('Terminal (no running session named a terminal)');
  });
});
