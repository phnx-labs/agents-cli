import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import { commonBinDirs, resolveExecutable } from './binResolve';

describe('commonBinDirs', () => {
  test('puts Homebrew ahead of the inherited PATH', () => {
    const dirs = commonBinDirs('/some/inherited/bin');
    expect(dirs[0]).toBe('/opt/homebrew/bin');
    expect(dirs).toContain('/some/inherited/bin');
    // Homebrew must precede the inherited entry so a Dock-launched host still
    // finds ffmpeg even when PATH is the minimal /usr/bin:/bin.
    expect(dirs.indexOf('/opt/homebrew/bin')).toBeLessThan(dirs.indexOf('/some/inherited/bin'));
  });

  test('dedupes entries already present in PATH', () => {
    const dirs = commonBinDirs('/opt/homebrew/bin:/usr/bin');
    const homebrewCount = dirs.filter((d) => d === '/opt/homebrew/bin').length;
    expect(homebrewCount).toBe(1);
  });
});

describe('resolveExecutable', () => {
  test('resolves a real binary to an absolute file path', () => {
    // node runs this suite, so it is guaranteed on disk somewhere resolvable.
    const dir = path.dirname(process.execPath);
    const resolved = resolveExecutable(path.basename(process.execPath), [dir]);
    expect(resolved).toBe(process.execPath);
  });

  test('returns null when the binary is nowhere', () => {
    expect(resolveExecutable('definitely-not-a-real-binary-xyz')).toBeNull();
  });
});
