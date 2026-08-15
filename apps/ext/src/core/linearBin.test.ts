import { describe, expect, test } from 'bun:test';
import * as path from 'path';
import { linearBinDirs, LINEAR_NOT_FOUND_MESSAGE, resolveLinearBin } from './linearBin';

const fixtureRoot = path.join(import.meta.dir, 'testdata', 'linear-bin');
const executableFixture = path.join(fixtureRoot, 'executable');
const nonExecutableFixture = path.join(fixtureRoot, 'non-executable');

describe('linearBinDirs', () => {
  test('prefers the official user-local installation and dedupes PATH', () => {
    const dirs = linearBinDirs('/Users/test', '/opt/homebrew/bin:/usr/bin');
    expect(dirs[0]).toBe('/Users/test/.local/bin');
    expect(dirs.filter((dir) => dir === '/opt/homebrew/bin')).toHaveLength(1);
  });
});

describe('resolveLinearBin', () => {
  test('resolves a real executable to an absolute path', () => {
    expect(resolveLinearBin([executableFixture])).toBe(path.join(executableFixture, 'linear'));
  });

  test('resolves the official install when the GUI PATH is empty', () => {
    const home = path.join(fixtureRoot, 'gui-home');
    expect(resolveLinearBin(linearBinDirs(home, ''))).toBe(
      path.join(home, '.local', 'bin', 'linear'),
    );
  });

  test.skipIf(process.platform === 'win32')('rejects a non-executable file', () => {
    expect(resolveLinearBin([nonExecutableFixture])).toBeNull();
  });

  test('returns null when no candidate exists', () => {
    expect(resolveLinearBin(['/definitely/not/a/bin'])).toBeNull();
  });

  test('provides an actionable installation message', () => {
    expect(LINEAR_NOT_FOUND_MESSAGE).toContain('~/.local/bin/linear');
  });
});
