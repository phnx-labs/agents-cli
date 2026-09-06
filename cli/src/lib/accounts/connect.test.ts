import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connectLabelForName,
  connectRefusal,
  connectSupported,
  findConnectAccount,
  mintConnectLabel,
  planConnect,
  resolveExistingHomeLabel,
  runConnect,
  verifyConnectedIdentity,
  type ConnectPlan,
  type ConnectRunners,
} from './connect.js';
import { addNativeAccount, listNativeAccounts, nativeAccountHome, type NativeAccount } from '../account-registry.js';
import { readMeta, updateMeta } from '../state.js';

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

describe('runConnect executor (injected runners, real meta)', () => {
  // Fake runners record what happened and return scripted identities.
  function fakeRunners(over: Partial<ConnectRunners> & {
    installed?: string[];
    identityByLabel?: Record<string, { identityKey: string | null; email: string | null; signedIn: boolean }>;
    loginCode?: number;
    onLaunch?: (label: string) => void;
  } = {}): ConnectRunners & { installs: string[]; logins: string[] } {
    const installs: string[] = [];
    const logins: string[] = [];
    const installed = new Set(over.installed ?? []);
    return {
      installs, logins,
      installedLabels: () => [...installed],
      install: async (_a, label) => { installs.push(label); installed.add(label); return { success: true }; },
      launchLogin: async (_a, label) => { logins.push(label); over.onLaunch?.(label); return { code: over.loginCode ?? 0 }; },
      observeIdentity: async (_a, label) => {
        const id = over.identityByLabel?.[label] ?? { identityKey: 'claude:user=1', email: 'a@example.com', signedIn: true };
        return { ...id, releaseVersion: '2.1.220' };
      },
      signedInHomes: async () => [],
      ...over,
    };
  }

  beforeEach(() => updateMeta(meta => ({ ...meta, accounts: { ...meta.accounts, native: {} }, deviceAccounts: { ...meta.deviceAccounts, native: {}, homes: {} } })));
  afterEach(() => updateMeta(meta => ({ ...meta, accounts: { ...meta.accounts, native: {} }, deviceAccounts: { ...meta.deviceAccounts, native: {}, homes: {} } })));

  it('a new named connect installs the deterministic slot, logs in, and registers account + device home', async () => {
    const runners = fakeRunners();
    const result = await runConnect('claude', 'work', { meta: readMeta() }, runners);
    const slot = connectLabelForName('claude', 'work');
    expect(result).toMatchObject({ mode: 'new', label: slot, name: 'work', identityKey: 'claude:user=1', releaseVersion: '2.1.220' });
    expect(runners.installs).toEqual([slot]);
    const account = listNativeAccounts(readMeta()).find(a => a.name === 'work');
    expect(account).toMatchObject({ agent: 'claude', identityKey: 'claude:user=1' });
    expect(nativeAccountHome(account!.id, readMeta())).toBe(slot);
  });

  it('a cancelled login (nonzero exit) records nothing and fails before observe', async () => {
    const runners = fakeRunners({ loginCode: 1 });
    await expect(runConnect('claude', 'work', { meta: readMeta() }, runners)).rejects.toThrow(/did not complete/);
    expect(listNativeAccounts(readMeta()).find(a => a.name === 'work')).toBeUndefined();
  });

  it('a login with no live credential fails closed even if metadata has an identity', async () => {
    const slot = connectLabelForName('claude', 'work');
    const runners = fakeRunners({ identityByLabel: { [slot]: { identityKey: 'claude:user=1', email: null, signedIn: false } } });
    await expect(runConnect('claude', 'work', { meta: readMeta() }, runners)).rejects.toThrow(/no live credential/);
  });

  it('a retried named connect reuses the same slot rather than minting a new home', async () => {
    const slot = connectLabelForName('claude', 'work');
    // First attempt already installed the slot (simulating a prior failed login).
    const runners = fakeRunners({ installed: [slot] });
    await runConnect('claude', 'work', { meta: readMeta() }, runners);
    expect(runners.installs).toEqual([]); // reused the existing home, no re-mint
  });

  it('reconnect refuses BEFORE launching a login when the home holds a different identity', async () => {
    const existing = addNativeAccount('work', 'claude', 'claude:user=1', 'work@example.com', 'version');
    const { setNativeAccountHome } = await import('../account-registry.js');
    setNativeAccountHome(existing.id, 'acct-home');
    const runners = fakeRunners({
      installed: ['acct-home'],
      identityByLabel: { 'acct-home': { identityKey: 'claude:user=OTHER', email: 'x@example.com', signedIn: true } },
    });
    await expect(runConnect('claude', 'work', { meta: readMeta() }, runners)).rejects.toThrow(/different identity/);
    expect(runners.logins).toEqual([]); // never launched the login
  });

  it('a new named connect validates the NAME before install/login', async () => {
    const runners = fakeRunners();
    await expect(runConnect('claude', 'bad name!', { meta: readMeta() }, runners)).rejects.toThrow(/must start with|letters/i);
    expect(runners.installs).toEqual([]);
    expect(runners.logins).toEqual([]);
  });
});
