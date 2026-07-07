import { describe, it, expect } from 'vitest';
import { getCliVersion, getCliVersionFresh } from './version.js';

describe('version', () => {
  it('getCliVersion returns a non-empty version string', () => {
    const v = getCliVersion();
    expect(typeof v).toBe('string');
    expect(v.length).toBeGreaterThan(0);
  });

  it('getCliVersionFresh re-reads package.json and matches getCliVersion when unchanged', () => {
    // Both read the same on-disk package.json; with no in-place swap mid-test
    // they must agree. (In production they diverge only after `npm i -g` swaps
    // the file under a running process — the signal the broker/daemon heal on.)
    expect(getCliVersionFresh()).toBe(getCliVersion());
  });

  it('getCliVersionFresh is not the memoized cache (callable repeatedly, stable)', () => {
    const a = getCliVersionFresh();
    const b = getCliVersionFresh();
    expect(a).toBe(b);
    expect(a).not.toBe('');
  });
});
