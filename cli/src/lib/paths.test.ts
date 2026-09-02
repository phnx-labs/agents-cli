import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { FS_CASE_INSENSITIVE, pathIdentityKey, pathIsWithin } from './paths.js';

describe('pathIdentityKey', () => {
  it('folds case and NFC-normalizes on a case-insensitive filesystem', () => {
    expect(pathIdentityKey('/Users/X/.Claude', true)).toBe('/users/x/.claude');
    // NFC "é" (U+00E9) and NFD "e" + combining acute (U+0301) are distinct
    // code-point sequences that name the same file — they fold to one key.
    const nfc = '/Users/café';
    const nfd = '/Users/café';
    expect(nfc).not.toBe(nfd);
    expect(pathIdentityKey(nfc, true)).toBe(pathIdentityKey(nfd, true));
  });

  it('returns the path verbatim on a case-sensitive filesystem', () => {
    expect(pathIdentityKey('/home/x/.Claude', false)).toBe('/home/x/.Claude');
    // Distinct spellings stay distinct — Linux path identity is exact bytes.
    expect(pathIdentityKey('/home/x/.claude', false)).not.toBe(pathIdentityKey('/home/x/.Claude', false));
  });
});

describe('pathIsWithin', () => {
  it('matches an identical and a nested path', () => {
    expect(pathIsWithin('/a/b', '/a/b', false)).toBe(true);
    expect(pathIsWithin('/a/b', path.join('/a/b', 'c'), false)).toBe(true);
    expect(pathIsWithin('/a/b', '/a/bc', false)).toBe(false); // not a path-boundary child
    expect(pathIsWithin('/a/b', '/a', false)).toBe(false);
  });

  it('treats a case variant as the same location only when case-insensitive', () => {
    expect(pathIsWithin('/a/Real', '/a/real', true)).toBe(true);
    expect(pathIsWithin('/a/Real', path.join('/a/real', 'x'), true)).toBe(true);
    expect(pathIsWithin('/a/Real', '/a/real', false)).toBe(false);
  });

  it('exports a platform-derived default matching the running OS', () => {
    expect(FS_CASE_INSENSITIVE).toBe(process.platform === 'darwin' || process.platform === 'win32');
  });
});
