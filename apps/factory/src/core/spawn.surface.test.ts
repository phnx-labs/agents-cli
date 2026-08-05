import { describe, expect, test } from 'bun:test';
import { resolveSpawnSurface } from './spawn';

// The `…/spawn` URI verb is how `agents sessions resume --vscodium` reopens a
// session as an editor tab. It used to hardwire a plain VS Code terminal, so a
// session reopened that way died with the window and left no tmux coords for the
// reconnect pass — the one launch path that opted out of crash resilience.
describe('resolveSpawnSurface', () => {
  test('tmux mode puts a plain spawn in its own tmux-backed tab', () => {
    expect(
      resolveSpawnSurface({ useTmux: true, wantsSplit: false, hasParent: false, parentIsTmux: false })
    ).toBe('tmux-tab');
  });

  test('no tmux on PATH (useTmux=false) stays a plain tab', () => {
    expect(
      resolveSpawnSurface({ useTmux: false, wantsSplit: false, hasParent: false, parentIsTmux: false })
    ).toBe('native-tab');
  });

  test('a split beside a live tmux parent splits inside that tmux session', () => {
    expect(
      resolveSpawnSurface({ useTmux: true, wantsSplit: true, hasParent: true, parentIsTmux: true })
    ).toBe('tmux-split');
  });

  // Regression: splitting the VS Code tab here would put the new pane outside any
  // tmux session, silently costing it the durable coords reconnect re-attaches to.
  test('tmux mode with a non-tmux parent takes its own tmux tab, never a native split', () => {
    expect(
      resolveSpawnSurface({ useTmux: true, wantsSplit: true, hasParent: true, parentIsTmux: false })
    ).toBe('tmux-tab');
  });

  test('a split request with no live parent falls back to a tab', () => {
    expect(
      resolveSpawnSurface({ useTmux: true, wantsSplit: true, hasParent: false, parentIsTmux: false })
    ).toBe('tmux-tab');
    expect(
      resolveSpawnSurface({ useTmux: false, wantsSplit: true, hasParent: false, parentIsTmux: false })
    ).toBe('native-tab');
  });

  test('native mode splits the VS Code tab when a parent is alive', () => {
    expect(
      resolveSpawnSurface({ useTmux: false, wantsSplit: true, hasParent: true, parentIsTmux: false })
    ).toBe('native-split');
  });
});
