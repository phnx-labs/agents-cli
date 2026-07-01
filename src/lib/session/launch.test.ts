import { describe, expect, it } from 'vitest';
import {
  shellQuote,
  appleScriptStr,
  detectCurrentTerminal,
  availableDestinations,
  itermTabScript,
  ghosttyTabScript,
  buildLaunchArgv,
} from './launch.js';

const RESUME = ['claude@2.1.187', '--resume', 'cad0e546'];

describe('shellQuote', () => {
  it('wraps plain strings in single quotes', () => {
    expect(shellQuote('/Users/me/src')).toBe(`'/Users/me/src'`);
  });
  it('escapes embedded single quotes', () => {
    // a path with an apostrophe must not break out of the quoting
    expect(shellQuote(`/Users/o'brien/dev`)).toBe(`'/Users/o'\\''brien/dev'`);
  });
});

describe('appleScriptStr', () => {
  it('escapes backslashes before quotes', () => {
    expect(appleScriptStr('a\\b"c')).toBe('"a\\\\b\\"c"');
  });
});

describe('detectCurrentTerminal', () => {
  it('prefers tmux when $TMUX is set, over TERM_PROGRAM', () => {
    expect(detectCurrentTerminal({ TMUX: '/tmp/tmux-501/default,1,0', TERM_PROGRAM: 'iTerm.app' })).toBe('tmux');
  });
  it('maps iTerm.app', () => {
    expect(detectCurrentTerminal({ TERM_PROGRAM: 'iTerm.app' })).toBe('iterm');
  });
  it('maps ghostty', () => {
    expect(detectCurrentTerminal({ TERM_PROGRAM: 'ghostty' })).toBe('ghostty');
  });
  it('falls back to inplace for unknown / bare terminals', () => {
    expect(detectCurrentTerminal({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('inplace');
    expect(detectCurrentTerminal({})).toBe('inplace');
  });
});

describe('availableDestinations', () => {
  it('off macOS offers only "this terminal"', () => {
    const dests = availableDestinations('linux', { TERM_PROGRAM: 'iTerm.app' });
    expect(dests.map(d => d.id)).toEqual(['this']);
    // "this terminal" still resolves to the detected emulator
    expect(dests[0].target).toBe('iterm');
  });
  it('on macOS the first choice is always "this terminal"', () => {
    const dests = availableDestinations('darwin', { TERM_PROGRAM: 'ghostty' });
    expect(dests[0].id).toBe('this');
    expect(dests[0].target).toBe('ghostty');
  });
});

describe('itermTabScript', () => {
  it('creates a tab in the current window, or a window when none is open', () => {
    const s = itermTabScript('/Users/me/dev', RESUME);
    expect(s).toContain('tell application "iTerm2"');
    expect(s).toContain('create tab with default profile command');
    expect(s).toContain('if (count of windows) is 0 then');
    // the resume command is wrapped in a login shell that cd's into the session cwd
    expect(s).toContain('zsh -lc');
    expect(s).toContain('/Users/me/dev');
    expect(s).toContain('exec claude@2.1.187 --resume cad0e546');
  });
});

describe('ghosttyTabScript', () => {
  it('sets cwd + command as native surface properties (no cd wrapper)', () => {
    const s = ghosttyTabScript('/Users/me/dev', RESUME);
    expect(s).toContain('tell application "Ghostty"');
    expect(s).toContain('new surface configuration');
    expect(s).toContain('set initial working directory of cfg to "/Users/me/dev"');
    expect(s).toContain('new tab in front window with configuration cfg');
    // cwd is native, so the command execs without a cd
    expect(s).toContain('exec claude@2.1.187 --resume cad0e546');
    expect(s).not.toContain('cd ');
  });
});

describe('buildLaunchArgv', () => {
  it('routes iterm/ghostty through osascript', () => {
    expect(buildLaunchArgv('iterm', '/x', RESUME)[0]).toBe('osascript');
    expect(buildLaunchArgv('ghostty', '/x', RESUME)[0]).toBe('osascript');
  });
  it('opens a tmux window with the cwd and joined command', () => {
    expect(buildLaunchArgv('tmux', '/x/y', RESUME)).toEqual([
      'tmux', 'new-window', '-c', '/x/y', 'claude@2.1.187 --resume cad0e546',
    ]);
  });
  it('inplace returns the resume argv verbatim', () => {
    expect(buildLaunchArgv('inplace', '/x', RESUME)).toEqual(RESUME);
  });
});
