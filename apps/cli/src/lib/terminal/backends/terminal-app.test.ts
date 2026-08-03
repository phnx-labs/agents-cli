import { describe, it, expect } from 'vitest';
import { terminalAppBackend, terminalAppTabScript } from './terminal-app.js';

describe('terminal-app backend', () => {
  it('is darwin-only and unavailable over SSH — osascript cannot reach the GUI login there', () => {
    // App presence is checked at runtime (same as the iTerm/Ghostty backends), so
    // assert only the platform + SSH rules, which hold on every machine.
    expect(terminalAppBackend.isAvailable({ platform: 'linux', env: {} })).toBe(false);
    expect(
      terminalAppBackend.isAvailable({ platform: 'darwin', env: { SSH_CONNECTION: '10.0.0.1 22' } }),
    ).toBe(false);
    expect(terminalAppBackend.isAvailable({ platform: 'darwin', env: { SSH_TTY: '/dev/ttys004' } })).toBe(false);
  });

  it('cds into the working directory and execs in an interactive login shell', () => {
    const script = terminalAppTabScript('/tmp/my repo', ['agents', 'run', 'claude']);
    expect(script).toContain('tell application "Terminal"');
    // The -i is load-bearing: version shims are only on PATH for interactive shells.
    expect(script).toContain('zsh -ilc');
    // The cwd is POSIX single-quoted ('\'' around the inner quote) and then the
    // backslash is doubled for the AppleScript string literal, so AppleScript
    // hands zsh exactly `cd '/tmp/my repo'` — a space in the path stays one arg.
    expect(script).toContain(String.raw`cd '\\''/tmp/my repo'\\'' && exec agents run claude`);
  });

  it('opens a window when none exists, otherwise a tab of the front window', () => {
    const script = terminalAppTabScript('/tmp', ['agents', 'run', 'claude']);
    expect(script).toContain('if (count of windows) is 0 then');
    expect(script).toContain('in front window');
  });

  it('has no scriptable split — a split request builds the tab command', () => {
    // Documented degradation, pinned so nobody "fixes" it into a broken AppleScript
    // verb. The caller warns at runtime (sessions-resume) rather than silently
    // pretending a pane happened.
    const tab = terminalAppBackend.buildTab('/tmp', ['x']);
    expect(terminalAppBackend.buildSplit('/tmp', ['x'], 'right')).toEqual(tab);
    expect(terminalAppBackend.buildSplit('/tmp', ['x'], 'down')).toEqual(tab);
  });

  it('escapes a quote in the working directory rather than breaking the script', () => {
    const script = terminalAppTabScript(`/tmp/a"b`, ['agents', 'run', 'claude']);
    // The double quote must not terminate the AppleScript string literal.
    expect(script).toContain('\\"');
    expect(script.split('\n').filter((l) => l.includes('do script')).length).toBe(2);
  });
});
