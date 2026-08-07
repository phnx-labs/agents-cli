import { describe, expect, it } from 'vitest';
import { fingerprintFromSource } from './accounts.js';

describe('accounts name --from', () => {
  it('rejects an installed version absent from launchable account discovery', async () => {
    const result = fingerprintFromSource('claude@2.1.220', {
      installedVersions: () => ['2.1.220'],
      discover: async () => [{
        agent: 'claude',
        fingerprint: 'work-fingerprint',
        display: 'work@example.com',
        versions: ['2.1.219'],
        label: null,
      }],
    });
    await expect(result).rejects.toThrow('claude@2.1.220 has no stable signed-in account');
  });

  it('uses the discovered account shared by the selected launchable version', async () => {
    await expect(fingerprintFromSource('claude@2.1.220', {
      installedVersions: () => ['2.1.220'],
      discover: async () => [{
        agent: 'claude',
        fingerprint: 'work-fingerprint',
        display: 'work@example.com',
        versions: ['2.1.219', '2.1.220'],
        label: null,
      }],
    })).resolves.toEqual({ agent: 'claude', fingerprint: 'work-fingerprint', versions: ['2.1.219', '2.1.220'] });
  });
});
