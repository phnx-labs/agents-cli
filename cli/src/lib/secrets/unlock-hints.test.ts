import { describe, it, expect } from 'vitest';
import { frequentlyPromptedBundles, type SecretGetRecord } from './unlock-hints.js';

describe('frequentlyPromptedBundles', () => {
  const rec = (bundle: string, source?: string): SecretGetRecord => ({ bundle, source });

  it('surfaces a bundle read from the keychain >= minReads times, not held', () => {
    const records = [rec('yosemite'), rec('yosemite'), rec('yosemite')];
    expect(frequentlyPromptedBundles(records, new Set(), { minReads: 3 }))
      .toEqual([{ name: 'yosemite', count: 3 }]);
  });

  it('ignores broker-hit and durable-session reads (they never prompted)', () => {
    // hetzner is read 5x but every read was served silently by the broker/session.
    const records = [
      rec('hetzner.com', 'agent'), rec('hetzner.com', 'agent'), rec('hetzner.com', 'session'),
      rec('hetzner.com', 'agent'), rec('hetzner.com', 'agent'),
    ];
    expect(frequentlyPromptedBundles(records, new Set(), { minReads: 3 })).toEqual([]);
  });

  it('excludes a currently-held bundle even if it has keychain reads in the window', () => {
    // Prompted 4x earlier, but it is held now — unlocking is already done.
    const records = [rec('apple.com'), rec('apple.com'), rec('apple.com'), rec('apple.com')];
    expect(frequentlyPromptedBundles(records, new Set(['apple.com']), { minReads: 3 })).toEqual([]);
  });

  it('drops bundles below the threshold', () => {
    const records = [rec('rare'), rec('rare')]; // 2 < 3
    expect(frequentlyPromptedBundles(records, new Set(), { minReads: 3 })).toEqual([]);
  });

  it('ranks by prompting count desc, then name for ties', () => {
    const records = [
      rec('a'), rec('a'), rec('a'),               // 3
      rec('zeta'), rec('zeta'), rec('zeta'), rec('zeta'), // 4
      rec('m'), rec('m'), rec('m'),               // 3
    ];
    expect(frequentlyPromptedBundles(records, new Set(), { minReads: 3 })).toEqual([
      { name: 'zeta', count: 4 },
      { name: 'a', count: 3 },
      { name: 'm', count: 3 },
    ]);
  });

  it('skips records with no bundle name', () => {
    const records = [rec('x'), { source: 'keychain' }, rec('x'), rec('x')];
    expect(frequentlyPromptedBundles(records, new Set(), { minReads: 3 }))
      .toEqual([{ name: 'x', count: 3 }]);
  });
});
