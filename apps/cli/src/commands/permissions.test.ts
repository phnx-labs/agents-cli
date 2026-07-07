import { describe, expect, it } from 'vitest';
import { shouldRefuseBroadPermissions } from './permissions.js';

describe('permissions add broad grant gate', () => {
  it('refuses broad permission packs unless --allow-broad-permissions is set', () => {
    const permissions = [{
      name: 'broad',
      path: '/tmp/broad.yml',
      set: {
        name: 'broad',
        allow: ['Bash(*)'],
        deny: [],
      },
    }];

    expect(shouldRefuseBroadPermissions(permissions, false)).toBe(true);
    expect(shouldRefuseBroadPermissions(permissions, true)).toBe(false);
  });
});
