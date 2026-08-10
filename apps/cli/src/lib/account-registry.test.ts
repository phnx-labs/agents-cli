import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secretsKeychainItem, setKeychainBackendForTest, setKeychainToken, type KeychainBackend } from './secrets/index.js';
import { writeBundleWithItems } from './secrets/bundles.js';
import { _resetFileStoreForTest } from './secrets/filestore.js';
import { addAccount, inspectAccount, readAccountRegistry, removeAccount, renameAccount, resolveAccountSelection, resolveCredentialAccount, setAccountSecret } from './account-registry.js';

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
