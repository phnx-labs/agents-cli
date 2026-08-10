import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setKeychainBackendForTest, type KeychainBackend } from './secrets/index.js';
import { addAccount, inspectAccount, readAccountRegistry, removeAccount, renameAccount, resolveCredentialAccount, setAccountSecret } from './account-registry.js';

class MemoryKeychain implements KeychainBackend {
  values = new Map<string, string>();
  has(item: string) { return this.values.has(item); }
  get(item: string) { const value = this.values.get(item); if (!value) throw new Error('missing'); return value; }
  set(item: string, value: string) { this.values.set(item, value); }
  delete(item: string) { return this.values.delete(item); }
  list(prefix: string) { return [...this.values.keys()].filter(item => item.startsWith(prefix)); }
}

describe('credential account registry', () => {
  let root: string;
  let keychain: MemoryKeychain;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-accounts-')); keychain = new MemoryKeychain(); setKeychainBackendForTest(keychain); });
  afterEach(() => { setKeychainBackendForTest(null); fs.rmSync(root, { recursive: true, force: true }); });

  it('keeps secret bytes out of metadata and resolves one account across compatible hosts', () => {
    addAccount('work', 'openrouter', 'api-key', 'sk-or-secret', root);
    expect(fs.readFileSync(path.join(root, 'accounts.yaml'), 'utf8')).not.toContain('sk-or-secret');
    expect(resolveCredentialAccount('work', 'claude', undefined, root).env).toEqual({
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: 'sk-or-secret',
    });
    expect(resolveCredentialAccount('work', 'codex', undefined, root).env).toEqual({
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENAI_API_KEY: 'sk-or-secret',
    });
  });

  it('rotates a credential without changing the stable id or name', () => {
    const before = addAccount('work', 'cursor', 'api-key', 'old-key', root);
    setAccountSecret('work', 'new-key', root);
    const after = inspectAccount('work', root);
    expect(after.id).toBe(before.id);
    expect(after.name).toBe('work');
    expect(resolveCredentialAccount('work', 'cursor', undefined, root).env).toEqual({ CURSOR_API_KEY: 'new-key' });
  });

  it('renames profile references and refuses removal while a harness consumes the account', () => {
    addAccount('work', 'openrouter', 'api-key', 'secret', root);
    fs.mkdirSync(path.join(root, 'profiles'));
    fs.writeFileSync(path.join(root, 'profiles', 'deepseek.yml'), 'name: deepseek\nhost:\n  agent: claude\nenv: {}\nprovider: openrouter\naccount: work\n');
    renameAccount('work', 'company', root);
    expect(fs.readFileSync(path.join(root, 'profiles', 'deepseek.yml'), 'utf8')).toContain('account: company');
    expect(() => removeAccount('company', root)).toThrow('used by harness: deepseek');
    expect(readAccountRegistry(root).accounts).toHaveProperty(Object.keys(readAccountRegistry(root).accounts)[0]);
  });

  it('validates setup-token shape before storing it', () => {
    expect(() => addAccount('claude-work', 'anthropic', 'setup-token', 'not-a-setup-token', root)).toThrow('sk-ant-oat01-');
    expect(keychain.values.size).toBe(0);
  });

  it('rejects setup tokens on non-Claude harnesses before injection', () => {
    addAccount('claude-work', 'anthropic', 'setup-token', 'sk-ant-oat01-valid', root);
    expect(() => resolveCredentialAccount('claude-work', 'codex', undefined, root)).toThrow('cannot use a setup-token with the codex harness');
  });

  it('archives version-bound labels instead of converting them into fake credential accounts', () => {
    fs.writeFileSync(path.join(root, 'accounts.yaml'), 'labels:\n  work:\n    agent: claude\n    fingerprint: abc\n');
    expect(readAccountRegistry(root)).toEqual({ version: 2, accounts: {} });
    expect(fs.existsSync(path.join(root, 'accounts.legacy-labels.yaml'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'accounts.yaml'), 'utf8')).toContain('version: 2');
  });
});
