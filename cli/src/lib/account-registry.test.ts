import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secretsKeychainItem, setKeychainBackendForTest, setKeychainToken, type KeychainBackend } from './secrets/index.js';
import { writeBundleWithItems } from './secrets/bundles.js';
import { _resetFileStoreForTest } from './secrets/filestore.js';
import { readMeta, updateMeta, getUserAgentsDir, getDeviceMetaPath } from './state.js';
import { addAccount, addNativeAccount, findUnifiedAccount, inspectAccount, labelNativeAccount, listNativeAccounts, readAccountRegistry, removeAccount, renameAccount, resolveAccountSelection, resolveCredentialAccount, resolveSpawnAccount, setAccountSecret, type AccountRegistryDocument } from './account-registry.js';

describe('findUnifiedAccount does not touch the provider store for a native lookup', () => {
  // A registry whose every access throws — stands in for a device whose provider
  // bundle read / legacy migration / keychain decrypt would fail (the real crash).
  const poisoned = new Proxy({} as AccountRegistryDocument, {
    get() { throw new Error('provider registry accessed'); },
  });
  const meta = {
    accounts: { native: { 'id-1': { id: 'id-1', name: 'work', agent: 'claude' as const, identityKey: 'claude:user=1', scope: 'version' as const } } },
  };

  it('returns a native account without reading the provider registry', () => {
    expect(findUnifiedAccount('work', meta, poisoned)).toMatchObject({ kind: 'native', name: 'work', agent: 'claude' });
    expect(findUnifiedAccount('id-1', meta, poisoned)).toMatchObject({ kind: 'native', id: 'id-1' });
  });

  it('reaches the provider registry only when the name is not a native account', () => {
    expect(() => findUnifiedAccount('not-native', meta, poisoned)).toThrow('provider registry accessed');
  });
});

describe('native account labels', () => {
  beforeEach(() => updateMeta(meta => ({ ...meta, accounts: { ...meta.accounts, native: {} } })));
  afterEach(() => updateMeta(meta => ({ ...meta, accounts: { ...meta.accounts, native: {} } })));

  it('writes and resolves a manual label and the implicit email label', () => {
    const original = labelNativeAccount('codex', 'codex:user=1', 'user@example.com', 'work', 'version');
    expect(findUnifiedAccount('work', readMeta())).toMatchObject({ id: original.id, identityKey: 'codex:user=1' });
    const relabeled = labelNativeAccount('codex', 'codex:user=1', 'user@example.com', undefined, 'version');
    expect(relabeled.id).toBe(original.id);
    expect(findUnifiedAccount('user@example.com', readMeta())).toMatchObject({ id: original.id, name: 'user@example.com' });
  });

  it('requires a manual label when the harness exposes no email', () => {
    expect(() => labelNativeAccount('kimi', 'kimi:opaque=1', undefined, undefined, 'version')).toThrow('pass a manual label');
  });

  it('removeAccount deletes every central row for the resolved (agent, identityKey)', () => {
    // Two independently labeled boxes merge via git into two UUID rows for one identity.
    const identityKey = 'codex:account=dup:user=x:org=y';
    const row = (id: string) => ({
      id,
      name: 'personal',
      agent: 'codex' as const,
      identityKey,
      identityLabel: 'x@example.com',
      scope: 'version' as const,
    });
    updateMeta(meta => ({
      ...meta,
      accounts: {
        ...meta.accounts,
        native: {
          'uuid-from-box-a': row('uuid-from-box-a'),
          'uuid-from-box-b': row('uuid-from-box-b'),
        },
      },
    }));
    expect(findUnifiedAccount('personal', readMeta())).toMatchObject({ name: 'personal', identityKey });

    removeAccount('personal');

    expect(findUnifiedAccount('personal', readMeta())).toBeNull();
    expect(findUnifiedAccount('uuid-from-box-a', readMeta())).toBeNull();
    expect(findUnifiedAccount('uuid-from-box-b', readMeta())).toBeNull();
    expect(listNativeAccounts(readMeta()).filter(account => account.identityKey === identityKey)).toEqual([]);
  });

  it('renameAccount and labelNativeAccount rewrite every sibling row for the identity', () => {
    const identityKey = 'codex:account=dup:user=x:org=y';
    const row = (id: string, name: string) => ({
      id,
      name,
      agent: 'codex' as const,
      identityKey,
      identityLabel: 'x@example.com',
      scope: 'version' as const,
    });
    updateMeta(meta => ({
      ...meta,
      accounts: {
        ...meta.accounts,
        native: {
          'uuid-from-box-a': row('uuid-from-box-a', 'personal'),
          'uuid-from-box-b': row('uuid-from-box-b', 'personal'),
        },
      },
    }));

    renameAccount('personal', 'home');
    expect(findUnifiedAccount('personal', readMeta())).toBeNull();
    const renamed = listNativeAccounts(readMeta()).filter(account => account.identityKey === identityKey);
    expect(renamed).toHaveLength(2);
    expect(renamed.every(account => account.name === 'home')).toBe(true);

    labelNativeAccount('codex', identityKey, 'x@example.com', 'desk', 'version');
    const relabeled = listNativeAccounts(readMeta()).filter(account => account.identityKey === identityKey);
    expect(relabeled).toHaveLength(2);
    expect(relabeled.every(account => account.name === 'desk')).toBe(true);
    expect(findUnifiedAccount('home', readMeta())).toBeNull();
  });
});

class MemoryKeychain implements KeychainBackend {
  values = new Map<string, string>();
  noAcl = new Map<string, boolean>();
  has(item: string) { return this.values.has(item); }
  get(item: string) { const value = this.values.get(item); if (value === undefined) throw new Error('missing'); return value; }
  set(item: string, value: string, opts?: { noAcl?: boolean }) { this.values.set(item, value); this.noAcl.set(item, Boolean(opts?.noAcl)); }
  delete(item: string) { this.noAcl.delete(item); return this.values.delete(item); }
  list(prefix: string) { return [...this.values.keys()].filter(item => item.startsWith(prefix)); }
}

/** The bundle-metadata blobs stored in the keychain (identity vars, no secret). */
function metadataBlobs(keychain: MemoryKeychain): string[] {
  return [...keychain.values.values()].filter(value => value.includes('ACCOUNT_ID'));
}

describe('credential account registry (bundle-canonical)', () => {
  let root: string;
  let keychain: MemoryKeychain;
  let previousMetaIndex: string | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-accounts-'));
    previousMetaIndex = process.env.AGENTS_SECRETS_META_INDEX_FILE;
    process.env.AGENTS_SECRETS_META_INDEX_FILE = path.join(root, 'bundle-index.json');
    _resetFileStoreForTest({ fileDir: path.join(root, 'secrets'), passphrase: 'account-registry-test' });
    keychain = new MemoryKeychain();
    setKeychainBackendForTest(keychain);
  });
  afterEach(() => {
    setKeychainBackendForTest(null);
    _resetFileStoreForTest();
    if (previousMetaIndex === undefined) delete process.env.AGENTS_SECRETS_META_INDEX_FILE;
    else process.env.AGENTS_SECRETS_META_INDEX_FILE = previousMetaIndex;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stores the account as a never-policy bundle with the secret out of the metadata', () => {
    addAccount('work', 'openrouter', 'api-key', 'sk-or-secret', root);
    // No accounts.yaml is written — the bundle is the canonical store.
    expect(fs.existsSync(path.join(root, 'accounts.yaml'))).toBe(false);
    const blobs = metadataBlobs(keychain);
    expect(blobs.length).toBe(1);
    const meta = JSON.parse(blobs[0]);
    expect(meta.tier).toBe('none'); // policy 'never' → no biometry ACL → syncs without Touch ID
    expect(meta.vars.PROVIDER).toBe('openrouter');
    expect(meta.vars.AUTH_TYPE).toBe('api-key');
    expect(meta.vars.API_KEY).toBe('keychain:API_KEY');
    expect(typeof meta.vars.ACCOUNT_ID).toBe('string');
    expect(blobs[0]).not.toContain('sk-or-secret'); // secret bytes never in metadata
  });

  it('refuses to overwrite an ordinary secrets bundle with the same name', () => {
    const otherItem = secretsKeychainItem('prod', 'OTHER');
    writeBundleWithItems({ name: 'prod', vars: { OTHER: 'keychain:OTHER' } }, new Map([[otherItem, 'keep-me']]));
    expect(() => addAccount('prod', 'openrouter', 'api-key', 'sk-new', root)).toThrow("Secrets bundle 'prod' already exists");
    expect(keychain.values.has(otherItem)).toBe(true);
  });

  it('resolves one account across compatible hosts', () => {
    addAccount('work', 'openrouter', 'api-key', 'sk-or-secret', root);
    expect(resolveCredentialAccount('work', 'claude', undefined, root).env).toEqual({
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: 'sk-or-secret',
    });
    expect(resolveCredentialAccount('work', 'codex', undefined, root).env).toEqual({
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENAI_API_KEY: 'sk-or-secret',
    });
  });

  it('injects a per-account BASE_URL override over the provider default', () => {
    addAccount('gw', 'openrouter', 'api-key', 'sk-or-secret', root, { baseUrl: 'https://gateway.internal/api' });
    expect(inspectAccount('gw', root).baseUrl).toBe('https://gateway.internal/api');
    expect(resolveCredentialAccount('gw', 'claude', undefined, root).env).toEqual({
      ANTHROPIC_BASE_URL: 'https://gateway.internal/api',
      ANTHROPIC_AUTH_TOKEN: 'sk-or-secret',
    });
  });

  it('injects an OpenAI BASE_URL override into Codex', () => {
    addAccount('openai-proxy', 'openai', 'api-key', 'sk-secret', root, { baseUrl: 'https://gateway.internal/v1' });
    expect(resolveCredentialAccount('openai-proxy', 'codex', undefined, root).env).toEqual({
      OPENAI_BASE_URL: 'https://gateway.internal/v1',
      OPENAI_API_KEY: 'sk-secret',
    });
  });

  it('fails loud when a host cannot apply the stored BASE_URL override', () => {
    addAccount('google-proxy', 'google', 'api-key', 'secret', root, { baseUrl: 'https://gateway.internal/v1' });
    expect(() => resolveCredentialAccount('google-proxy', 'gemini', undefined, root)).toThrow(
      "provider 'google' cannot apply it to the gemini harness",
    );
  });

  it('prefers explicit selection, then a per-harness default', () => {
    const meta = { accounts: { defaults: { claude: 'default-work' } } };
    expect(resolveAccountSelection('one-run', 'claude', meta)).toBe('one-run');
    expect(resolveAccountSelection(undefined, 'claude', meta)).toBe('default-work');
    expect(resolveAccountSelection(undefined, 'codex', meta)).toBeUndefined();
    expect(resolveAccountSelection(undefined, 'claude', meta, { useDefault: false })).toBeUndefined();
    expect(resolveAccountSelection('profile-override', 'claude', meta, { useDefault: false })).toBe('profile-override');
  });

  it('resolves exact installation and device-scoped bindings before a harness default', () => {
    const meta = {
      accounts: {
        defaults: { claude: 'default-work' },
        bindings: { 'claude@2.1.220': 'native-work', cursor: 'cursor-device' },
      },
    };
    expect(resolveAccountSelection(undefined, 'claude', meta, { target: 'claude@2.1.220' })).toBe('native-work');
    expect(resolveAccountSelection(undefined, 'claude', meta, { target: 'claude@2.1.225' })).toBe('default-work');
    expect(resolveAccountSelection(undefined, 'cursor', meta, { target: 'cursor@latest' })).toBe('cursor-device');
    expect(resolveAccountSelection('one-run', 'claude', meta, { target: 'claude@2.1.220' })).toBe('one-run');
  });

  it('resolveSpawnAccount classifies provider (with env) vs native (no keychain read), following bindings', () => {
    addAccount('prov', 'cursor', 'api-key', 'device-key', root);
    // Provider selection resolves the injected env at spawn time.
    const provider = resolveSpawnAccount('prov', 'cursor', '1.0.0', { accounts: {} }, { base: root });
    expect(provider).toMatchObject({ kind: 'provider', name: 'prov' });
    expect(provider?.kind === 'provider' && provider.env).toEqual({ CURSOR_API_KEY: 'device-key' });

    // An exact agent@version binding selects a native account, classified from
    // meta alone — no provider bundle / keychain read (base is a temp home).
    const meta = {
      accounts: {
        native: { n1: { id: 'n1', name: 'work', agent: 'claude' as const, identityKey: 'claude:user=1', scope: 'version' as const } },
        bindings: { 'claude@2.1.220': 'n1' },
      },
    };
    const native = resolveSpawnAccount(undefined, 'claude', '2.1.220', meta, { base: root });
    expect(native).toMatchObject({ kind: 'native', name: 'work', agent: 'claude', identityKey: 'claude:user=1', scope: 'version' });
    // A different version is not covered by the exact binding → nothing selected.
    expect(resolveSpawnAccount(undefined, 'claude', '2.1.225', meta, { base: root })).toBeNull();
  });

  it('resolveSpawnAccount binds a custom harness by its raw profile name, not agent@version', () => {
    addAccount('or', 'openrouter', 'api-key', 'sk-or', root);
    const doc = readAccountRegistry(root);
    const account = doc.accounts[Object.keys(doc.accounts)[0]];
    // A profile named 'deepseek' running on the claude host, bound by profile name.
    const meta = { accounts: { bindings: { deepseek: account.id } } };
    // With the profile target, the deepseek binding is found...
    const viaProfile = resolveSpawnAccount(undefined, 'claude', '2.1.220', meta, { base: root, target: 'deepseek' });
    expect(viaProfile).toMatchObject({ kind: 'provider', name: 'or' });
    // ...while the same run keyed on agent@version (no profile) sees no binding.
    expect(resolveSpawnAccount(undefined, 'claude', '2.1.220', meta, { base: root })).toBeNull();
  });

  it('resolveSpawnAccount refuses a native account on a provider-backed harness (explicit --account override)', () => {
    // `agents run deepseek --account work`: deepseek hosts on claude with an
    // OpenRouter provider, so a native claude login must be rejected before spawn
    // — otherwise the provider env would still be injected under a native claim.
    const meta = {
      accounts: { native: { n1: { id: 'n1', name: 'work', agent: 'claude' as const, identityKey: 'claude:user=1', scope: 'version' as const } } },
    };
    expect(() => resolveSpawnAccount('work', 'claude', '2.1.220', meta, { base: root, provider: 'openrouter' }))
      .toThrow('cannot run under a provider-backed harness (openrouter)');
    // Without a provider (a bare native run) the same account resolves fine.
    expect(resolveSpawnAccount('work', 'claude', '2.1.220', meta, { base: root })).toMatchObject({ kind: 'native', name: 'work' });
  });

  it('resolveSpawnAccount refuses a native account bound to a different harness', () => {
    const meta = {
      accounts: {
        native: { n1: { id: 'n1', name: 'work', agent: 'claude' as const, identityKey: 'k', scope: 'version' as const } },
        bindings: { codex: 'n1' },
      },
    };
    expect(() => resolveSpawnAccount(undefined, 'codex', '1.0.0', meta, { base: root }))
      .toThrow('is a claude login and cannot authenticate the codex harness');
  });

  it('rotates a credential without changing the stable id or name', () => {
    const before = addAccount('work', 'cursor', 'api-key', 'old-key', root);
    setAccountSecret('work', 'new-key', root);
    const after = inspectAccount('work', root);
    expect(after.id).toBe(before.id);
    expect(after.name).toBe('work');
    expect(resolveCredentialAccount('work', 'cursor', undefined, root).env).toEqual({ CURSOR_API_KEY: 'new-key' });
  });

  it('renames the account, preserving its stable id, and rewires profile references', () => {
    const before = addAccount('work', 'openrouter', 'api-key', 'secret', root);
    fs.mkdirSync(path.join(root, 'profiles'));
    fs.writeFileSync(path.join(root, 'profiles', 'deepseek.yml'), 'name: deepseek\nhost:\n  agent: claude\nenv: {}\nprovider: openrouter\naccount: work\n');
    renameAccount('work', 'company', root);
    expect(fs.readFileSync(path.join(root, 'profiles', 'deepseek.yml'), 'utf8')).toContain('account: company');
    const renamed = inspectAccount('company', root);
    expect(renamed.id).toBe(before.id); // ACCOUNT_ID survives the rename
    expect(resolveCredentialAccount('company', 'claude', undefined, root).env.ANTHROPIC_AUTH_TOKEN).toBe('secret');
    expect(() => removeAccount('company', root)).toThrow('used by harness: deepseek');
  });

  it('removes the account and its device-local credential', () => {
    addAccount('work', 'cursor', 'api-key', 'old-key', root);
    removeAccount('work', root);
    expect(Object.values(readAccountRegistry(root).accounts).some(account => account.name === 'work')).toBe(false);
    expect(() => inspectAccount('work', root)).toThrow("Unknown account 'work'");
  });

  it('validates setup-token shape before storing it', () => {
    expect(() => addAccount('claude-work', 'anthropic', 'setup-token', 'not-a-setup-token', root)).toThrow('sk-ant-oat01-');
    expect(keychain.values.size).toBe(0);
  });

  it('rejects setup tokens on non-Claude harnesses before injection', () => {
    addAccount('claude-work', 'anthropic', 'setup-token', 'sk-ant-oat01-valid', root);
    expect(() => resolveCredentialAccount('claude-work', 'codex', undefined, root)).toThrow('cannot use a setup-token with the codex harness');
  });
});

describe('legacy accounts.yaml migration', () => {
  let root: string;
  let keychain: MemoryKeychain;
  let previousMetaIndex: string | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-accounts-mig-'));
    previousMetaIndex = process.env.AGENTS_SECRETS_META_INDEX_FILE;
    process.env.AGENTS_SECRETS_META_INDEX_FILE = path.join(root, 'bundle-index.json');
    _resetFileStoreForTest({ fileDir: path.join(root, 'secrets'), passphrase: 'account-migration-test' });
    keychain = new MemoryKeychain();
    setKeychainBackendForTest(keychain);
  });
  afterEach(() => {
    setKeychainBackendForTest(null);
    _resetFileStoreForTest();
    if (previousMetaIndex === undefined) delete process.env.AGENTS_SECRETS_META_INDEX_FILE;
    else process.env.AGENTS_SECRETS_META_INDEX_FILE = previousMetaIndex;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('transactionally migrates v2 accounts into bundles, preserving the UUID, and archives only after success', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const legacyItem = `agents-cli.accounts.${id}.credential`;
    setKeychainToken(legacyItem, 'sk-or-legacy');
    fs.writeFileSync(path.join(root, 'accounts.yaml'), [
      'version: 2',
      'accounts:',
      `  ${id}:`,
      `    id: ${id}`,
      '    name: work',
      '    provider: openrouter',
      '    auth: api-key',
      `    secretRef: ${legacyItem}`,
      '',
    ].join('\n'));

    const doc = readAccountRegistry(root);
    // UUID preserved as the account's stable id.
    expect(doc.accounts[id]).toMatchObject({ id, name: 'work', provider: 'openrouter', auth: 'api-key' });
    // Archived only after success; the live file is gone, the credential moved.
    expect(fs.existsSync(path.join(root, 'accounts.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'accounts.migrated.yaml'))).toBe(true);
    expect(keychain.has(legacyItem)).toBe(false); // old per-account item retired
    expect(resolveCredentialAccount('work', 'claude', undefined, root).env.ANTHROPIC_AUTH_TOKEN).toBe('sk-or-legacy');

    // Idempotent: a second read does nothing (no live file to migrate).
    expect(readAccountRegistry(root).accounts[id]).toMatchObject({ id, name: 'work' });
  });

  it('archives version-bound labels instead of converting them into fake credential accounts', () => {
    fs.writeFileSync(path.join(root, 'accounts.yaml'), 'labels:\n  work:\n    agent: claude\n    fingerprint: abc\n');
    expect(Object.values(readAccountRegistry(root).accounts).some(account => account.name === 'work')).toBe(false);
    expect(fs.existsSync(path.join(root, 'accounts.legacy-labels.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'accounts.yaml'))).toBe(false);
  });

  it('does not archive or delete a legacy account when its name collides with an unrelated bundle', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const legacyItem = `agents-cli.accounts.${id}.credential`;
    setKeychainToken(legacyItem, 'sk-or-legacy');
    const otherItem = secretsKeychainItem('work', 'OTHER');
    writeBundleWithItems({ name: 'work', vars: { OTHER: 'keychain:OTHER' } }, new Map([[otherItem, 'keep-me']]));
    fs.writeFileSync(path.join(root, 'accounts.yaml'), [
      'version: 2',
      'accounts:',
      `  ${id}:`,
      `    id: ${id}`,
      '    name: work',
      '    provider: openrouter',
      '    auth: api-key',
      `    secretRef: ${legacyItem}`,
      '',
    ].join('\n'));

    expect(() => readAccountRegistry(root)).toThrow("a different secrets bundle already uses that name");
    expect(fs.existsSync(path.join(root, 'accounts.yaml'))).toBe(true);
    expect(keychain.has(legacyItem)).toBe(true);
  });
});

describe('native account device-scoping (PHNX-3315)', () => {
  const prevMid = process.env.AGENTS_SYNC_MACHINE_ID;
  const clear = () => updateMeta(m => ({ ...m, accounts: { ...m.accounts, native: {}, bindings: {} }, deviceAccounts: undefined }));
  beforeEach(() => { process.env.AGENTS_SYNC_MACHINE_ID = 'accbox'; clear(); });
  afterEach(() => {
    clear();
    if (prevMid === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = prevMid;
  });

  const central = () => {
    const p = path.join(getUserAgentsDir(), 'agents.yaml');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  };
  const deviceDoc = () => (fs.existsSync(getDeviceMetaPath()) ? fs.readFileSync(getDeviceMetaPath(), 'utf8') : '');

  it("routes a scope:'device' login to this box's device doc, keeping identity PII off central", () => {
    addNativeAccount('opencode-login', 'opencode', 'opencode:user=1', 'me@example.com', 'device');

    // Visible through the effective list (central version natives + this box's device natives).
    expect(listNativeAccounts(readMeta()).map(a => a.name)).toContain('opencode-login');
    // Its identity PII lives in the device doc, never the fleet-shared central file.
    expect(deviceDoc()).toContain('opencode:user=1');
    expect(deviceDoc()).toContain('me@example.com');
    expect(central()).not.toContain('opencode:user=1');
    expect(central()).not.toContain('me@example.com');
  });

  it("keeps a scope:'version' login in the fleet-shared central store", () => {
    addNativeAccount('codex-login', 'codex', 'codex:user=2', 'you@example.com', 'version');
    expect(central()).toContain('codex:user=2');
    expect(deviceDoc()).not.toContain('codex:user=2');
    expect(listNativeAccounts(readMeta()).map(a => a.name)).toContain('codex-login');
  });

  it('resolves a device login by name across both stores (findUnifiedAccount)', () => {
    const acct = addNativeAccount('droid-login', 'droid', 'droid:user=3', undefined, 'device');
    const found = findUnifiedAccount('droid-login', readMeta());
    expect(found).toMatchObject({ kind: 'native', id: acct.id, agent: 'droid', scope: 'device' });
  });
});
