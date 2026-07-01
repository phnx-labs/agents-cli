import { describe, expect, it } from 'vitest';
import type { EngineContext } from '../types.js';
import { itermTabScript, itermSplitScript, itermBackend } from './iterm.js';
import { ghosttyTabScript, ghosttySplitScript, ghosttyBackend } from './ghostty.js';
import { tmuxTabArgv, tmuxSplitArgv, tmuxBackend } from './tmux.js';
import { detectCurrentBackend, availableBackends, BACKENDS } from './index.js';

const CMD = ['claude@2.1.187', '--resume', 'cad0e546'];
const ctx = (env: Record<string, string>, platform: NodeJS.Platform = 'darwin'): EngineContext =>
  ({ platform, env: env as NodeJS.ProcessEnv });

describe('iterm backend', () => {
  it('tab: creates a tab in current window (or a window when none), interactive login shell + cd', () => {
    const s = itermTabScript('/Users/me/dev', CMD);
    expect(s).toContain('tell application "iTerm2"');
    expect(s).toContain('create tab with default profile command');
    expect(s).toContain('if (count of windows) is 0 then');
    expect(s).toContain('zsh -ilc');
    expect(s).toContain('/Users/me/dev');
    expect(s).toContain('exec claude@2.1.187 --resume cad0e546');
  });
  it('split: right = "split vertically", down = "split horizontally"', () => {
    expect(itermSplitScript('/d', CMD, 'right')).toContain('split vertically with default profile command');
    expect(itermSplitScript('/d', CMD, 'down')).toContain('split horizontally with default profile command');
    // falls back to a window when none is open (can't split nothing)
    expect(itermSplitScript('/d', CMD, 'right')).toContain('create window with default profile command');
  });
  it('buildTab/buildSplit route through osascript', () => {
    expect(itermBackend.buildTab('/d', CMD).argv[0]).toBe('osascript');
    expect(itermBackend.buildSplit('/d', CMD, 'right').argv[0]).toBe('osascript');
  });
});

describe('ghostty backend', () => {
  it('tab: native cwd + command, no cd wrapper', () => {
    const s = ghosttyTabScript('/Users/me/dev', CMD);
    expect(s).toContain('tell application "Ghostty"');
    expect(s).toContain('new surface configuration');
    expect(s).toContain('set initial working directory of cfg to "/Users/me/dev"');
    expect(s).toContain('new tab in front window with configuration cfg');
    expect(s).toContain('zsh -ilc');
    expect(s).toContain('exec claude@2.1.187 --resume cad0e546');
    expect(s).not.toContain('cd ');
  });
  it('split: splits the current surface (focused terminal of selected tab of front window)', () => {
    const right = ghosttySplitScript('/d', CMD, 'right');
    expect(right).toContain('split (focused terminal of selected tab of front window) direction right with configuration cfg');
    expect(ghosttySplitScript('/d', CMD, 'down')).toContain('direction down with configuration cfg');
    // window when none open
    expect(right).toContain('new window with configuration cfg');
  });
});

describe('tmux backend', () => {
  it('tab: new-window with -c cwd and interactive-login-wrapped command', () => {
    expect(tmuxTabArgv('/x/y', CMD)).toEqual([
      'tmux', 'new-window', '-c', '/x/y', "zsh -ilc 'exec claude@2.1.187 --resume cad0e546'",
    ]);
  });
  it('split: -h for right (side-by-side), -v for down (stacked)', () => {
    expect(tmuxSplitArgv('/x', CMD, 'right').slice(0, 3)).toEqual(['tmux', 'split-window', '-h']);
    expect(tmuxSplitArgv('/x', CMD, 'down').slice(0, 3)).toEqual(['tmux', 'split-window', '-v']);
  });
});

describe('availability + detection', () => {
  it('tmux is available iff $TMUX is set (any platform)', () => {
    expect(tmuxBackend.isAvailable(ctx({ TMUX: '/tmp/x,1,0' }, 'linux'))).toBe(true);
    expect(tmuxBackend.isAvailable(ctx({}, 'linux'))).toBe(false);
  });
  it('iTerm/Ghostty are darwin-only (app-presence checked at runtime)', () => {
    expect(itermBackend.isAvailable(ctx({}, 'linux'))).toBe(false);
    expect(ghosttyBackend.isAvailable(ctx({}, 'linux'))).toBe(false);
  });
  it('detectCurrentBackend prefers tmux, then TERM_PROGRAM', () => {
    expect(detectCurrentBackend(ctx({ TMUX: 'x', TERM_PROGRAM: 'iTerm.app' }))).toBe('tmux');
    expect(detectCurrentBackend(ctx({ TERM_PROGRAM: 'iTerm.app' }))).toBe('iterm');
    expect(detectCurrentBackend(ctx({ TERM_PROGRAM: 'ghostty' }))).toBe('ghostty');
    expect(detectCurrentBackend(ctx({ TERM_PROGRAM: 'Apple_Terminal' }))).toBeNull();
  });
  it('availableBackends on linux with tmux = [tmux] only', () => {
    const a = availableBackends(ctx({ TMUX: 'x' }, 'linux'));
    expect(a.map((b) => b.id)).toEqual(['tmux']);
  });
  it('registry has all three backends', () => {
    expect(Object.keys(BACKENDS).sort()).toEqual(['ghostty', 'iterm', 'tmux']);
  });
});
