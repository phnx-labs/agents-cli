import { describe, expect, it } from 'vitest';
import type { PhoenixSession } from '../identity/client.js';
import { selectStorageBackendKind, isManagedSelection } from './selection.js';

const SIGNED_IN: PhoenixSession = {
  access_token: 'pid_token',
  userId: 'user-1',
  email: 'dev@example.com',
};

describe('selectStorageBackendKind — the one managed-vs-BYO policy', () => {
  it('picks managed for a signed-in caller with no BYO override', () => {
    expect(selectStorageBackendKind({ session: SIGNED_IN })).toBe('managed');
    expect(isManagedSelection({ session: SIGNED_IN })).toBe(true);
  });

  it('picks BYO for a signed-out caller', () => {
    expect(selectStorageBackendKind({ session: null })).toBe('byo');
    expect(isManagedSelection({ session: null })).toBe(false);
  });

  it('an explicit BYO override wins even when signed in', () => {
    expect(selectStorageBackendKind({ session: SIGNED_IN, byoOverride: true })).toBe('byo');
    expect(isManagedSelection({ session: SIGNED_IN, byoOverride: true })).toBe(false);
  });

  it('byoOverride does not short-circuit to managed when signed out', () => {
    expect(selectStorageBackendKind({ session: null, byoOverride: false })).toBe('byo');
  });
});
