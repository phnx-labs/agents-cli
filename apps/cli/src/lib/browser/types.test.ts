/**
 * The ProfileName / ConnectionKey split (RUSH-2709). `BrowserProfile.name` is
 * the user-facing name and is ALWAYS bare; the runtime key that carries the
 * endpoint is a separate, branded type derived at exactly one site. These pin
 * the derivation and the single membership rule every consumer now shares.
 */
import { describe, it, expect } from 'vitest';
import { connectionKey, parseConnectionKey, keyBelongsToProfile, asConnectionKey } from './types.js';

describe('connectionKey / parseConnectionKey — the ONE derivation rule (RUSH-2709)', () => {
  it('derives and splits a runtime key', () => {
    expect(connectionKey('comet-local', 'endpoint-0')).toBe('comet-local@endpoint-0');
    expect(parseConnectionKey('comet-local@endpoint-0')).toEqual({
      profile: 'comet-local',
      endpoint: 'endpoint-0',
    });
    expect(parseConnectionKey('comet-local@endpoint-0.2')).toEqual({
      profile: 'comet-local',
      endpoint: 'endpoint-0',
      fork: 2,
    });
    // Legacy pre-composite dirs still on disk.
    expect(parseConnectionKey('comet-local')).toEqual({ profile: 'comet-local' });
    expect(parseConnectionKey('comet-local.2')).toEqual({ profile: 'comet-local', fork: 2 });
  });

  it('matches a bare name to its endpoint and fork keys, and nothing else', () => {
    expect(keyBelongsToProfile('comet-local', 'comet-local')).toBe(true);
    expect(keyBelongsToProfile('comet-local@endpoint-0', 'comet-local')).toBe(true);
    expect(keyBelongsToProfile('comet-local@endpoint-0.2', 'comet-local')).toBe(true);
    expect(keyBelongsToProfile('comet-other@endpoint-0', 'comet-local')).toBe(false);
    // A prefix is not a match: `comet` must not claim `comet-local`'s browser.
    expect(keyBelongsToProfile('comet-local@endpoint-0', 'comet')).toBe(false);
  });
});

describe('asConnectionKey', () => {
  it('adopts an on-disk runtime dir name verbatim', () => {
    // Runtime dir names ARE keys — round-tripping one must not alter it.
    const key = asConnectionKey('comet-local@endpoint-0');
    expect(key).toBe('comet-local@endpoint-0');
    expect(parseConnectionKey(key).profile).toBe('comet-local');
  });
});
