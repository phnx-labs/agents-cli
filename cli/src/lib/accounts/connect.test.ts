import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  allocateConnectSlot,
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
import { addNativeAccount, listNativeAccounts, nativeAccountHome, pendingConnectSlot, renameAccount, type NativeAccount } from '../account-registry.js';
import { setConfiguredDeviceRole } from '../device-config.js';
import { getVersionsDir, readMeta, updateMeta } from '../state.js';

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
  it('uses the pre-allocated fresh slot for a NEW connect (never a name-derived label)', () => {
    const plan = planConnect({ agent: 'claude', name: 'work', existing: null, existingHomeLabel: null, freshSlot: 'acct-fresh' });
    expect(plan).toMatchObject({ mode: 'new', label: 'acct-fresh', name: 'work' });
    expect(plan.existing).toBeUndefined();
  });

  it('reuses the recorded home when reconnecting an existing account', () => {
    const existing = account();
    const plan = planConnect({ agent: 'claude', name: 'work', existing, existingHomeLabel: 'acct-home', freshSlot: 'acct-fresh' });
    expect(plan).toMatchObject({ mode: 'reconnect', label: 'acct-home', name: 'work', adoptedHome: false });
  });

  it('adopts the fresh slot for a legacy account with no resolvable home', () => {
    const existing = account();
    const plan = planConnect({ agent: 'claude', name: 'work', existing, existingHomeLabel: null, freshSlot: 'acct-fresh' });
    expect(plan).toMatchObject({ mode: 'reconnect', label: 'acct-fresh', adoptedHome: true });
  });
});

describe('allocateConnectSlot (safe, never reuses an identity-bearing slot)', () => {
  const base = { agent: 'claude' as const, existing: null, installedLabels: new Set<string>() };

  it('mints a random slot disjoint from occupied homes', () => {
    let n = 0;
    const mint = () => ['acct-a', 'acct-b', 'acct-c'][n++];
    const slot = allocateConnectSlot({ ...base, name: 'work', occupied: new Set(['acct-a', 'acct-b']), pending: null, mint });
    expect(slot).toBe('acct-c'); // skipped the two occupied
  });

  it('skips a slot that is installed even if not occupied', () => {
    let n = 0;
    const mint = () => ['acct-a', 'acct-b'][n++];
    const slot = allocateConnectSlot({ ...base, name: 'work', occupied: new Set(), installedLabels: new Set(['acct-a']), pending: null, mint });
    expect(slot).toBe('acct-b');
  });

  it('reuses a pending slot for a named retry when it is not occupied', () => {
    const slot = allocateConnectSlot({ ...base, name: 'work', occupied: new Set(), pending: 'acct-pending', mint: () => 'acct-new' });
    expect(slot).toBe('acct-pending');
  });

  it('ABANDONS a pending slot that has become occupied (never overwrites it)', () => {
    const slot = allocateConnectSlot({ ...base, name: 'work', occupied: new Set(['acct-pending']), pending: 'acct-pending', mint: () => 'acct-new' });
    expect(slot).toBe('acct-new');
  });

  it('does not reuse a pending slot for a reconnect (pending is a new-connect concept)', () => {
    const slot = allocateConnectSlot({ ...base, existing: account(), name: 'work', occupied: new Set(), pending: 'acct-pending', mint: () => 'acct-new' });
    expect(slot).toBe('acct-new');
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
  type Identity = { identityKey: string | null; email: string | null; signedIn: boolean };
  // Fake runners record what happened. `identityByLabel` holds the identity a
  // KNOWN installed home carries (used for occupancy + observe of that label);
  // `defaultObserved` is what a login into a fresh/unknown slot yields.
  function fakeRunners(over: {
    installed?: string[];
    identityByLabel?: Record<string, Identity>;
    defaultObserved?: Identity;
    loginCode?: number;
    installOk?: boolean;
  } = {}): ConnectRunners & { installs: string[]; logins: string[] } {
    const installs: string[] = [];
    const logins: string[] = [];
    const installed = new Set(over.installed ?? []);
    const loggedIn = new Set<string>();
    const idOf = (label: string): Identity | undefined => over.identityByLabel?.[label];
    const postLogin: Identity = over.defaultObserved ?? { identityKey: 'claude:user=1', email: 'a@example.com', signedIn: true };
    return {
      installs, logins,
      installedLabels: () => [...installed],
      install: async (_a, label) => { installs.push(label); installed.add(label); return { success: over.installOk ?? true }; },
      launchLogin: async (_a, label) => { logins.push(label); if ((over.loginCode ?? 0) === 0) loggedIn.add(label); return { code: over.loginCode ?? 0 }; },
      observeIdentity: async (_a, label) => {
        // An explicit identity wins (a pre-existing occupied home). Otherwise a
        // home reads not-signed-in UNTIL a login completes into it — so a slot
        // installed by a failed prior attempt is correctly seen as empty.
        const id = idOf(label) ?? (loggedIn.has(label) ? postLogin : { identityKey: null, email: null, signedIn: false });
        return { ...id, releaseVersion: '2.1.220' };
      },
      // Occupancy is only the KNOWN signed-in homes (an about-to-be-created fresh
      // slot is never here). Owned homes come from the registry, not this.
      signedInHomes: async () => [...installed]
        .map(label => ({ label, id: idOf(label) }))
        .filter((e): e is { label: string; id: Identity } => !!e.id?.signedIn && !!e.id.identityKey)
        .map(e => ({ agent: 'claude' as const, identityKey: e.id.identityKey!, label: e.label })),
    };
  }

  const DEVICE = `connect-role-fixture-${process.pid}`;
  let prevMachineId: string | undefined;

  const reset = () => updateMeta(meta => ({
    ...meta,
    accounts: { ...meta.accounts, native: {}, defaults: {} },
    deviceAccounts: { ...meta.deviceAccounts, native: {}, homes: {}, pendingConnects: {} },
  }));
  beforeEach(() => {
    prevMachineId = process.env.AGENTS_SYNC_MACHINE_ID;
    process.env.AGENTS_SYNC_MACHINE_ID = DEVICE;
    // Headed role so the worker gate does not break the existing happy path
    // when this file runs on a worker or unmarked box.
    setConfiguredDeviceRole(DEVICE, 'personal');
    reset();
  });
  afterEach(() => {
    reset();
    setConfiguredDeviceRole(DEVICE, undefined);
    if (prevMachineId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = prevMachineId;
  });

  it('refuses on a worker before allocating a slot, installing, or launching a login', async () => {
    setConfiguredDeviceRole(DEVICE, 'worker');
    const versionsDir = path.join(getVersionsDir(), 'codex');
    const beforeDirs = fs.existsSync(versionsDir) ? fs.readdirSync(versionsDir).sort() : [];
    const runners = fakeRunners();
    const message = `codex#icloud: this device is a worker (role worker) and never runs an interactive login. `
      + `Add the account on your personal device with \`agents accounts connect codex icloud\`; `
      + `workers are provisioned from the durable credential automatically `
      + `(codex: a provider API key — agents accounts add icloud --provider openai then agents accounts sync icloud ${DEVICE}). `
      + `To mark this box as your interactive seat: agents devices role ${DEVICE} personal.`;
    await expect(runConnect('codex', 'icloud', { meta: readMeta() }, runners)).rejects.toThrow(message);
    expect(runners.installs).toEqual([]);
    expect(runners.logins).toEqual([]);
    expect(pendingConnectSlot('codex', 'icloud', readMeta())).toBeNull();
    expect(listNativeAccounts(readMeta()).find(a => a.agent === 'codex' && a.name === 'icloud')).toBeUndefined();
    const afterDirs = fs.existsSync(versionsDir) ? fs.readdirSync(versionsDir).sort() : [];
    expect(afterDirs).toEqual(beforeDirs);
  });

  it('a new named connect allocates a fresh slot, logs in, and registers account + device home + default', async () => {
    const runners = fakeRunners();
    const result = await runConnect('claude', 'work', { meta: readMeta() }, runners);
    expect(result).toMatchObject({ mode: 'new', name: 'work', identityKey: 'claude:user=1', releaseVersion: '2.1.220', becameDefault: true });
    expect(result.label).toMatch(/^acct-[0-9a-f]+$/);
    expect(runners.installs).toEqual([result.label]);
    const acct = listNativeAccounts(readMeta()).find(a => a.name === 'work');
    expect(acct).toMatchObject({ agent: 'claude', identityKey: 'claude:user=1' });
    expect(nativeAccountHome(acct!.id, readMeta())).toBe(result.label);
    expect(readMeta().accounts?.defaults?.claude).toBe('work');
    // Pending slot cleared once the account landed.
    expect(pendingConnectSlot('claude', 'work', readMeta())).toBeNull();
  });

  it('SECURITY: connect <name> after that name was renamed allocates a FRESH slot and never overwrites the renamed home', async () => {
    // 1. connect work → identity A in home S1.
    const r1 = await runConnect('claude', 'work', { meta: readMeta() },
      fakeRunners({ defaultObserved: { identityKey: 'claude:user=A', email: 'a@x.com', signedIn: true } }));
    const S1 = r1.label;
    // 2. rename work → personal (S1 is now personal's home, still signed in as A).
    renameAccount('work', 'personal');
    // 3. connect work again (a NEW account, identity B).
    const runners = fakeRunners({
      installed: [S1],
      identityByLabel: { [S1]: { identityKey: 'claude:user=A', email: 'a@x.com', signedIn: true } },
      defaultObserved: { identityKey: 'claude:user=B', email: 'b@x.com', signedIn: true },
    });
    const r2 = await runConnect('claude', 'work', { meta: readMeta() }, runners);
    expect(r2.label).not.toBe(S1);                 // fresh slot, not personal's home
    expect(runners.logins).not.toContain(S1);      // never launched a login into personal's home
    expect(runners.installs).not.toContain(S1);
    // personal's home is untouched; work got its own.
    const personal = listNativeAccounts(readMeta()).find(a => a.name === 'personal');
    const work = listNativeAccounts(readMeta()).find(a => a.name === 'work');
    expect(nativeAccountHome(personal!.id, readMeta())).toBe(S1);
    expect(nativeAccountHome(work!.id, readMeta())).toBe(r2.label);
  });

  it('a new connect allocates around an occupied (signed-in) slot', async () => {
    // A stray installed home signed in as someone, not owned by any account.
    const stray = mintConnectLabel();
    const runners = fakeRunners({
      installed: [stray],
      identityByLabel: { [stray]: { identityKey: 'claude:user=Z', email: 'z@x.com', signedIn: true } },
      defaultObserved: { identityKey: 'claude:user=B', email: 'b@x.com', signedIn: true },
    });
    const r = await runConnect('claude', 'work', { meta: readMeta() }, runners);
    expect(r.label).not.toBe(stray);
    expect(runners.logins).not.toContain(stray);
  });

  it('a cancelled login records nothing but keeps the pending slot for a same-home retry', async () => {
    const attempt1 = fakeRunners({ loginCode: 1 });
    await expect(runConnect('claude', 'work', { meta: readMeta() }, attempt1)).rejects.toThrow(/did not complete.*retry the same home/);
    const pending = pendingConnectSlot('claude', 'work', readMeta());
    expect(pending).toBeTruthy();
    expect(attempt1.installs).toEqual([pending]);          // installed the home on attempt 1
    expect(listNativeAccounts(readMeta()).find(a => a.name === 'work')).toBeUndefined();

    // Retry reuses the SAME home (the pending slot is installed, not re-minted).
    const attempt2 = fakeRunners({ installed: [pending!] });
    const r2 = await runConnect('claude', 'work', { meta: readMeta() }, attempt2);
    expect(r2.label).toBe(pending);
    expect(attempt2.installs).toEqual([]);
    expect(pendingConnectSlot('claude', 'work', readMeta())).toBeNull(); // cleared on success
  });

  it('a login with no live credential fails closed even if metadata has an identity', async () => {
    const runners = fakeRunners({ defaultObserved: { identityKey: 'claude:user=1', email: null, signedIn: false } });
    await expect(runConnect('claude', 'work', { meta: readMeta() }, runners)).rejects.toThrow(/no live credential/);
  });

  it('an UNNAMED connect forces no name, sets no default, and returns a name hint', async () => {
    const runners = fakeRunners({ defaultObserved: { identityKey: 'claude:user=A', email: 'a@x.com', signedIn: true } });
    const r = await runConnect('claude', undefined, { meta: readMeta() }, runners);
    expect(r.name).toBeUndefined();
    expect(r.nameHint).toMatch(/accounts label claude/);
    expect(r.becameDefault).toBe(false);
    expect(readMeta().accounts?.defaults?.claude).toBeUndefined();
    expect(listNativeAccounts(readMeta())).toHaveLength(0);
  });

  it('an UNNAMED cancelled login says a NEW home is allocated on retry (not the same home)', async () => {
    const runners = fakeRunners({ loginCode: 1 });
    await expect(runConnect('claude', undefined, { meta: readMeta() }, runners)).rejects.toThrow(/a new home is allocated/);
  });

  it('a second named connect does not override an existing default', async () => {
    await runConnect('claude', 'work', { meta: readMeta() },
      fakeRunners({ defaultObserved: { identityKey: 'claude:user=A', email: 'a@x.com', signedIn: true } }));
    const r2 = await runConnect('claude', 'work2', { meta: readMeta() },
      fakeRunners({ defaultObserved: { identityKey: 'claude:user=B', email: 'b@x.com', signedIn: true } }));
    expect(r2.becameDefault).toBe(false);
    expect(readMeta().accounts?.defaults?.claude).toBe('work');
  });

  it('connecting an account preserves a legacy installation default', async () => {
    updateMeta(current => ({ ...current, agents: { ...current.agents, claude: '2.1.100' } }));
    const result = await runConnect('claude', 'work', { meta: readMeta() },
      fakeRunners({ defaultObserved: { identityKey: 'claude:user=work', email: 'work@example.com', signedIn: true } }));
    expect(result.becameDefault).toBe(false);
    expect(readMeta().agents?.claude).toBe('2.1.100');
    expect(readMeta().accounts?.defaults?.claude).toBeUndefined();
  });

  it('a competing same-name connect cannot enter native login while the first is awaiting auth', async () => {
    const runners = fakeRunners({ defaultObserved: { identityKey: 'claude:user=work', email: 'work@example.com', signedIn: true } });
    let entered!: () => void;
    let finish!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const login = runners.launchLogin;
    runners.launchLogin = async (...args) => { entered(); await pending; return login(...args); };
    const first = runConnect('claude', 'work', { meta: readMeta() }, runners);
    await ready;
    const other = fakeRunners({ defaultObserved: { identityKey: 'claude:user=other', email: 'other@example.com', signedIn: true } });
    try {
      await expect(runConnect('claude', 'work', { meta: readMeta() }, other)).rejects.toThrow(/in progress/);
      expect(other.logins).toEqual([]);
      expect(other.installs).toEqual([]);
    } finally { finish(); }
    await first;
    expect(listNativeAccounts(readMeta()).find(a => a.name === 'work')?.identityKey).toBe('claude:user=work');
  });

  it('reconnect refuses BEFORE launching a login when the home holds a different identity', async () => {
    const existing = addNativeAccount('work', 'claude', 'claude:user=1', 'work@example.com', 'version');
    const { setNativeAccountHome } = await import('../account-registry.js');
    setNativeAccountHome(existing.id, 'acct-home');
    const runners = fakeRunners({
      installed: ['acct-home'],
      identityByLabel: { 'acct-home': { identityKey: 'claude:user=OTHER', email: 'x@example.com', signedIn: true } },
    });
    await expect(runConnect('claude', 'work', { meta: readMeta() }, runners)).rejects.toThrow(/currently signed in|overwrite/);
    expect(runners.logins).toEqual([]); // never launched the login
  });

  it('a new named connect validates the NAME before install/login', async () => {
    const runners = fakeRunners();
    await expect(runConnect('claude', 'bad name!', { meta: readMeta() }, runners)).rejects.toThrow(/must start with|letters/i);
    expect(runners.installs).toEqual([]);
    expect(runners.logins).toEqual([]);
  });
});
