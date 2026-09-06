import { describe, expect, it } from 'vitest';
import {
  connectLabelForName,
  connectRefusal,
  connectSupported,
  findConnectAccount,
  mintConnectLabel,
  planConnect,
  resolveExistingHomeLabel,
  verifyConnectedIdentity,
  type ConnectPlan,
} from './connect.js';
import type { NativeAccount } from '../account-registry.js';

const account = (over: Partial<NativeAccount> = {}): NativeAccount => ({
  id: 'id-1',
  name: 'work',
  kind: 'native',
  agent: 'claude',
  identityKey: 'claude:user=1',
  identityLabel: 'work@example.com',
  scope: 'version',
  ...over,
});

describe('connect support gating', () => {
  it('supports the version-scoped harnesses with a wired native login', () => {
    expect(connectSupported('claude')).toBe(true);
    expect(connectSupported('codex')).toBe(true);
    expect(connectRefusal('claude')).toBeNull();
  });

  it('refuses a device-scoped harness with a capability reason, not a fake flow', () => {
    // droid is device-scoped/unsupported for native naming.
    expect(connectSupported('droid')).toBe(false);
    expect(connectRefusal('droid')).toMatch(/device-scoped|can't be/i);
  });

  it('refuses a version-scoped harness with no wired login clearly', () => {
    // kimi is version-scoped + nameable but has no connect login invocation yet.
    expect(connectSupported('kimi')).toBe(false);
    expect(connectRefusal('kimi')).toMatch(/does not yet drive kimi/);
  });
});

describe('mintConnectLabel', () => {
  it('mints an opaque, VERSION_RE-safe, non-release label each time', () => {
    const a = mintConnectLabel();
    const b = mintConnectLabel();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^acct-[0-9a-f]+$/);
    expect(a).not.toBe('latest');
  });
});

describe('planConnect', () => {
  const mintLabel = () => 'acct-fixed';

  it('gives a NEW named connect a deterministic (retryable) slot from the name', () => {
    const plan = planConnect({ agent: 'claude', name: 'work', existing: null, existingHomeLabel: null, mintLabel });
    expect(plan).toMatchObject({ mode: 'new', label: connectLabelForName('claude', 'work'), name: 'work' });
    expect(plan.existing).toBeUndefined();
    // Same name → same slot across retries.
    expect(planConnect({ agent: 'claude', name: 'work', existing: null, existingHomeLabel: null }).label)
      .toBe(connectLabelForName('claude', 'work'));
  });

  it('mints a random slot for a NEW UNNAMED connect', () => {
    const plan = planConnect({ agent: 'claude', existing: null, existingHomeLabel: null, mintLabel });
    expect(plan).toMatchObject({ mode: 'new', label: 'acct-fixed' });
  });

  it('reuses the recorded home when reconnecting an existing account', () => {
    const existing = account();
    const plan = planConnect({ agent: 'claude', name: 'work', existing, existingHomeLabel: 'acct-home', mintLabel });
    expect(plan).toMatchObject({ mode: 'reconnect', label: 'acct-home', name: 'work', adoptedHome: false });
  });

  it('adopts a deterministic home for a legacy account with no resolvable home', () => {
    const existing = account();
    const plan = planConnect({ agent: 'claude', name: 'work', existing, existingHomeLabel: null, mintLabel });
    expect(plan).toMatchObject({ mode: 'reconnect', label: connectLabelForName('claude', 'work'), adoptedHome: true });
  });
});

describe('verifyConnectedIdentity (fail closed)', () => {
  const reconnect: ConnectPlan = { mode: 'reconnect', agent: 'claude', label: 'acct-home', name: 'work', existing: account() };
  const observed = (identityKey: string | null, signedIn = true) => ({ identityKey, signedIn });

  it('throws when no live credential is present, even with a metadata identity', () => {
    expect(() => verifyConnectedIdentity({ mode: 'new', agent: 'claude', label: 'acct-1' }, observed('claude:user=9', false))).toThrow(/no live credential/);
    expect(() => verifyConnectedIdentity({ mode: 'new', agent: 'claude', label: 'acct-1' }, observed(null))).toThrow(/no live credential/);
  });

  it('accepts any signed-in identity for a NEW connect', () => {
    expect(() => verifyConnectedIdentity({ mode: 'new', agent: 'claude', label: 'acct-1' }, observed('claude:user=9'))).not.toThrow();
  });

  it('refuses to rebind a different identity on reconnect (binding left unchanged)', () => {
    expect(() => verifyConnectedIdentity(reconnect, observed('claude:user=2'))).toThrow(/different identity|binding unchanged/);
  });

  it('accepts a matching identity on reconnect', () => {
    expect(() => verifyConnectedIdentity(reconnect, observed('claude:user=1'))).not.toThrow();
  });
});

describe('resolveExistingHomeLabel', () => {
  it('prefers this box\'s recorded (device-scoped) connect home', () => {
    const existing = account();
    expect(resolveExistingHomeLabel(existing, 'acct-recorded', [{ agent: 'claude', identityKey: 'claude:user=1', label: 'acct-live' }]))
      .toBe('acct-recorded');
  });

  it('falls back to a live home carrying the identity when none is recorded', () => {
    const existing = account();
    expect(resolveExistingHomeLabel(existing, null, [
      { agent: 'codex', identityKey: 'claude:user=1', label: 'wrong' },
      { agent: 'claude', identityKey: 'claude:user=1', label: 'acct-live' },
    ])).toBe('acct-live');
  });

  it('returns null when neither is known', () => {
    expect(resolveExistingHomeLabel(account(), null, [])).toBeNull();
  });
});

describe('findConnectAccount', () => {
  const meta = {
    accounts: {
      native: {
        'id-1': { id: 'id-1', name: 'work', agent: 'claude' as const, identityKey: 'claude:user=1', identityLabel: 'work@x.com', scope: 'version' as const },
        'id-2': { id: 'id-2', name: 'work', agent: 'codex' as const, identityKey: 'codex:user=1', scope: 'version' as const },
      },
    },
  };

  it('scopes the lookup to the requested harness', () => {
    expect(findConnectAccount('claude', 'work', meta)).toMatchObject({ id: 'id-1', agent: 'claude' });
    expect(findConnectAccount('codex', 'work', meta)).toMatchObject({ id: 'id-2', agent: 'codex' });
  });

  it('matches by id and by identity email, and returns null for no name', () => {
    expect(findConnectAccount('claude', 'id-1', meta)).toMatchObject({ id: 'id-1' });
    expect(findConnectAccount('claude', 'WORK@X.COM', meta)).toMatchObject({ id: 'id-1' });
    expect(findConnectAccount('claude', undefined, meta)).toBeNull();
    expect(findConnectAccount('claude', 'missing', meta)).toBeNull();
  });
});
