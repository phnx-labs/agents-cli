import { describe, expect, it } from 'vitest';
import { ALL_AGENT_IDS } from './agents.js';
import { NATIVE_ACCOUNT_CAPABILITIES, nativeAccountNameable, nativeIdentityKey } from './account-capabilities.js';

describe('native account capability registry', () => {
  it('classifies every harness exactly once', () => {
    expect(Object.keys(NATIVE_ACCOUNT_CAPABILITIES).sort()).toEqual([...ALL_AGENT_IDS].sort());
  });

  it('never claims name/attach support without an inspectable identity', () => {
    for (const capability of Object.values(NATIVE_ACCOUNT_CAPABILITIES)) {
      if (capability.status === 'supported' || capability.status === 'conditional') {
        expect(capability.inspection).not.toBe('none');
        expect(capability.scope).not.toBe('unsupported');
      }
    }
  });

  it('pins the version-scoped strong set to exactly Claude / Codex / Grok', () => {
    const versionStrong = ALL_AGENT_IDS.filter((id) => {
      const cap = NATIVE_ACCOUNT_CAPABILITIES[id];
      return cap.scope === 'version' && cap.inspection === 'strong';
    });
    expect(versionStrong.sort()).toEqual(['claude', 'codex', 'grok']);
  });

  it('treats Muse as a conditional, email-only version harness', () => {
    expect(NATIVE_ACCOUNT_CAPABILITIES.muse).toEqual({ inspection: 'email', scope: 'version', status: 'conditional' });
  });

  it('blocks Cursor from native naming/attachment', () => {
    expect(NATIVE_ACCOUNT_CAPABILITIES.cursor.status).toBe('unsupported');
    expect(nativeAccountNameable('cursor')).toBe(false);
  });

  it('records Antigravity / Kimi / Droid / OpenCode as device-scoped opaque but UNSUPPORTED', () => {
    // No device-id discriminator in NativeAccount → an opaque/singleton identity
    // cannot be proven unique across synced metadata, so naming is refused.
    for (const id of ['antigravity', 'kimi', 'droid', 'opencode'] as const) {
      expect(NATIVE_ACCOUNT_CAPABILITIES[id]).toEqual({ inspection: 'opaque', scope: 'device', status: 'unsupported' });
      expect(nativeAccountNameable(id)).toBe(false);
    }
  });

  it('never marks an opaque harness supported/conditional (no safe device identity yet)', () => {
    for (const [, cap] of Object.entries(NATIVE_ACCOUNT_CAPABILITIES)) {
      if (cap.inspection === 'opaque') expect(['unsupported', 'discovery-only']).toContain(cap.status);
    }
  });

  it('exposes nameability for the supported + conditional set only', () => {
    expect(nativeAccountNameable('claude')).toBe(true);
    expect(nativeAccountNameable('muse')).toBe(true); // conditional
    expect(nativeAccountNameable('gemini')).toBe(false); // discovery-only
    expect(nativeAccountNameable('copilot')).toBe(false); // unsupported
  });

  it('stores Muse (email-inspection) as accountKey, never the bare email', () => {
    // getAccountInfo('muse') sets accountKey to muse:email=<addr>. If name
    // stored the bare email, run/view would compare liveKey !== identityKey
    // and reject a correctly signed-in install.
    const muse = NATIVE_ACCOUNT_CAPABILITIES.muse;
    expect(nativeIdentityKey(
      { signedIn: true, email: 'user@x.com', accountKey: 'muse:email=user@x.com' },
      muse,
    )).toBe('muse:email=user@x.com');
    expect(nativeIdentityKey({ signedIn: true, email: 'user@x.com', accountKey: null }, muse)).toBe('user@x.com');
    expect(nativeIdentityKey({ signedIn: true, email: null, accountKey: 'muse:email=x' }, muse)).toBeNull();
    expect(nativeIdentityKey({ signedIn: false, email: 'user@x.com', accountKey: 'muse:email=user@x.com' }, muse)).toBeNull();
  });

  it('stores a strong harness as accountKey', () => {
    expect(nativeIdentityKey(
      { signedIn: true, email: 'a@b.com', accountKey: 'claude:user=abc' },
      NATIVE_ACCOUNT_CAPABILITIES.claude,
    )).toBe('claude:user=abc');
  });
});
