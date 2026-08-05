import { describe, expect, test } from 'bun:test';
import { resolveSpawnSurface } from './spawn';

// The `…/spawn` URI verb reopens a session as an editor tab. Factory no longer
// spawns tmux-backed terminals at the extension level, so every request lands on
// a plain VS Code terminal surface.
describe('resolveSpawnSurface', () => {
  test('a plain spawn opens a new native tab', () => {
    expect(
      resolveSpawnSurface({ wantsSplit: false, hasParent: false })
    ).toBe('native-tab');
  });

  test('a split beside a live parent uses a native split', () => {
    expect(
      resolveSpawnSurface({ wantsSplit: true, hasParent: true })
    ).toBe('native-split');
  });

  test('a split request with no live parent falls back to a tab', () => {
    expect(
      resolveSpawnSurface({ wantsSplit: true, hasParent: false })
    ).toBe('native-tab');
  });
});
