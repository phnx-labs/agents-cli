import { describe, expect, it } from 'vitest';

import { parseNativeIdentityKey, registeredNativeAccountForEmail } from './native-accounts.js';
import type { Meta, NativeAccountRecord } from './types.js';

function row(over: Partial<NativeAccountRecord>): NativeAccountRecord {
  return {
    id: 'id',
    name: 'name',
    agent: 'claude',
    identityKey: 'claude:account=a:org=o',
    scope: 'version',
    ...over,
  };
}

function meta(central: NativeAccountRecord[], device: NativeAccountRecord[] = []): Pick<Meta, 'accounts' | 'deviceAccounts'> {
  return {
    accounts: { native: Object.fromEntries(central.map((r) => [r.id, r])) },
    deviceAccounts: { native: Object.fromEntries(device.map((r) => [r.id, r])) },
  };
}

describe('registeredNativeAccountForEmail', () => {
  it('returns the single matching row for the harness, case- and space-insensitive', () => {
    const m = meta([
      row({ id: '1', agent: 'claude', identityLabel: 'Work@Getrush.ai ' }),
      row({ id: '2', agent: 'codex', identityLabel: 'work@getrush.ai' }),
    ]);
    const found = registeredNativeAccountForEmail(m, 'claude', 'work@getrush.ai');
    expect(found?.id).toBe('1');
  });

  it('unions device-scoped rows with central rows', () => {
    const m = meta([], [row({ id: 'd1', identityLabel: 'dev@getrush.ai' })]);
    expect(registeredNativeAccountForEmail(m, 'claude', 'dev@getrush.ai')?.id).toBe('d1');
  });

  it('returns null when several rows share the email (never guesses an org)', () => {
    const m = meta([
      row({ id: '1', identityLabel: 'both@getrush.ai', identityKey: 'claude:account=a1:org=team' }),
      row({ id: '2', identityLabel: 'both@getrush.ai', identityKey: 'claude:account=a2:org=max' }),
    ]);
    expect(registeredNativeAccountForEmail(m, 'claude', 'both@getrush.ai')).toBeNull();
  });

  it('returns null on no match, empty email, or wrong harness', () => {
    const m = meta([row({ id: '1', agent: 'claude', identityLabel: 'work@getrush.ai' })]);
    expect(registeredNativeAccountForEmail(m, 'claude', 'nobody@nowhere.dev')).toBeNull();
    expect(registeredNativeAccountForEmail(m, 'claude', '   ')).toBeNull();
    expect(registeredNativeAccountForEmail(m, 'codex', 'work@getrush.ai')).toBeNull();
  });
});

describe('parseNativeIdentityKey', () => {
  it('decodes account+org parts', () => {
    expect(parseNativeIdentityKey('claude', 'claude:account=abc:org=xyz')).toEqual({ account: 'abc', org: 'xyz' });
  });

  it('decodes a single-part key', () => {
    expect(parseNativeIdentityKey('codex', 'codex:user=u1')).toEqual({ user: 'u1' });
  });

  it('rejects a key for another harness or a malformed segment', () => {
    expect(parseNativeIdentityKey('claude', 'codex:account=a')).toBeNull();
    expect(parseNativeIdentityKey('claude', 'claude:accountabc')).toBeNull();
    expect(parseNativeIdentityKey('claude', 'claude:=abc')).toBeNull();
    expect(parseNativeIdentityKey('claude', 'claude:account=')).toBeNull();
    expect(parseNativeIdentityKey('claude', 'claude:')).toBeNull();
  });
});
