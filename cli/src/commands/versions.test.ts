import { describe, expect, it } from 'vitest';
import { planAccountFirstInstall } from './versions.js';

describe('account-first bare install', () => {
  const base = { spec: 'codex', supported: true, isolated: false, labels: ['0.147.0', 'acct-work'], defaultLabel: 'acct-work' };

  it('reuses the default account home instead of minting the latest release as another account', () => {
    expect(planAccountFirstInstall(base)).toEqual({ existingLabel: 'acct-work' });
  });

  it('recovers an existing home when the default is absent or stale', () => {
    expect(planAccountFirstInstall({ ...base, defaultLabel: 'missing' })).toEqual({ existingLabel: '0.147.0' });
    expect(planAccountFirstInstall({ ...base, defaultLabel: null })).toEqual({ existingLabel: '0.147.0' });
  });

  it('gives a first installation a release-independent home', () => {
    expect(planAccountFirstInstall({ ...base, labels: [], defaultLabel: null })).toEqual({ installationLabel: 'main' });
  });

  it('preserves explicit and isolated installation semantics', () => {
    expect(planAccountFirstInstall({ ...base, spec: 'codex@latest' })).toEqual({});
    expect(planAccountFirstInstall({ ...base, spec: 'codex@0.147.0' })).toEqual({});
    expect(planAccountFirstInstall({ ...base, isolated: true })).toEqual({});
    expect(planAccountFirstInstall({ ...base, supported: false })).toEqual({});
  });
});
