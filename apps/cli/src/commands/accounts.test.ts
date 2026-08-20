import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { classifyAttachTarget, nativeIdentityFromSource, parseBundleKey, registerAccountsCommand, setDefaultAccount } from './accounts.js';
import { addAccount, addNativeAccount } from '../lib/account-registry.js';
import { getUserAgentsDir, readMeta } from '../lib/state.js';
import { applyGlobalHelpConventions } from '../lib/help.js';
import { setKeychainBackendForTest, type KeychainBackend } from '../lib/secrets/index.js';
import { _resetFileStoreForTest } from '../lib/secrets/filestore.js';

class MemoryKeychain implements KeychainBackend {
  values = new Map<string, string>();
  has(item: string) { return this.values.has(item); }
  get(item: string) {
    const value = this.values.get(item);
    if (value === undefined) throw new Error('missing');
    return value;
  }
  set(item: string, value: string) { this.values.set(item, value); }
  delete(item: string) { return this.values.delete(item); }
  list(prefix: string) { return [...this.values.keys()].filter(item => item.startsWith(prefix)); }
}

describe('accounts credential import', () => {
  it('parses the bundle and key without tying the account to an agent version', () => {
    expect(parseBundleKey('openrouter.ai:OPENROUTER_API_KEY')).toEqual({
      bundle: 'openrouter.ai',
      key: 'OPENROUTER_API_KEY',
    });
  });

  it('rejects incomplete secret references', () => {
    expect(() => parseBundleKey('openrouter.ai')).toThrow('Expected bundle:key');
    expect(() => parseBundleKey(':KEY')).toThrow('Expected bundle:key');
  });
});

describe('classifyAttachTarget', () => {
  it('rejects a completely unknown target', () => {
    expect(() => classifyAttachTarget('totally-unknown-xyz-123')).toThrow('Unknown attach target');
  });

  it('rejects an unknown harness in agent@version form', () => {
    expect(() => classifyAttachTarget('notarealagent@1.0.0')).toThrow("Unknown harness 'notarealagent'");
  });

  it('rejects a valid agent with missing version', () => {
    expect(() => classifyAttachTarget('claude@')).toThrow('missing a version');
  });

  it('rejects a valid agent with an uninstalled version', () => {
    expect(() => classifyAttachTarget('claude@99999.0.0')).toThrow('is not installed');
  });
});

describe('accounts switch + native naming honesty-gate', () => {
  let previousMetaIndex: string | undefined;
  let secretsRoot: string;

  beforeEach(() => {
    secretsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-accounts-cmd-'));
    previousMetaIndex = process.env.AGENTS_SECRETS_META_INDEX_FILE;
    process.env.AGENTS_SECRETS_META_INDEX_FILE = path.join(secretsRoot, 'bundle-index.json');
    _resetFileStoreForTest({ fileDir: path.join(secretsRoot, 'secrets'), passphrase: 'accounts-cmd-test' });
    setKeychainBackendForTest(new MemoryKeychain());
  });

  afterEach(() => {
    setKeychainBackendForTest(null);
    _resetFileStoreForTest();
    if (previousMetaIndex === undefined) delete process.env.AGENTS_SECRETS_META_INDEX_FILE;
    else process.env.AGENTS_SECRETS_META_INDEX_FILE = previousMetaIndex;
    vi.restoreAllMocks();
    fs.rmSync(secretsRoot, { recursive: true, force: true });
  });

  async function runAccounts(args: string[]): Promise<string> {
    const program = new Command();
    program.exitOverride();
    registerAccountsCommand(program);
    const chunks: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      chunks.push(a.map(String).join(' '));
    });
    try {
      await program.parseAsync(['node', 'agents', 'accounts', ...args]);
    } finally {
      log.mockRestore();
    }
    return chunks.join('\n');
  }

  it('switch <harness> <account> writes the same default as set-default', async () => {
    const account = addAccount('switch-work', 'openrouter', 'api-key', 'sk-or-secret', getUserAgentsDir());
    const out = await runAccounts(['switch', 'claude', 'switch-work']);
    expect(out).toContain("claude now uses account 'switch-work'");
    expect(readMeta().accounts?.defaults?.claude).toBe(account.id);
    expect(setDefaultAccount('claude', 'switch-work').account.id).toBe(account.id);
  });

  it('switch <harness> --json lists switchable accounts without changing the default', async () => {
    addAccount('switch-json', 'openrouter', 'api-key', 'sk-or-secret', getUserAgentsDir());
    const before = readMeta().accounts?.defaults?.claude;
    const out = await runAccounts(['switch', 'claude', '--json']);
    const parsed = JSON.parse(out);
    expect(parsed.harness).toBe('claude');
    expect(parsed.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'switch-json', kind: 'provider', detail: 'openrouter' }),
    ]));
    expect(readMeta().accounts?.defaults?.claude).toBe(before);
  });

  it('refuses native name for an unsupported harness with a named reason', async () => {
    await expect(nativeIdentityFromSource('kimi@1.0.0')).rejects.toThrow(
      /kimi accounts can't be isolated by agents-cli yet \(device-scoped login\).*Supported today: claude, codex, grok/,
    );
    await expect(runAccounts(['name', 'kimi@1.0.0', 'work'])).rejects.toThrow(
      "kimi accounts can't be isolated by agents-cli yet (device-scoped login)",
    );
  });

  it('refuses native attach for an unsupported harness and still allows provider add', async () => {
    addNativeAccount('kimi-home', 'kimi', 'kimi:opaque=1', undefined, 'device');
    await expect(runAccounts(['attach', 'kimi-home', 'kimi'])).rejects.toThrow(
      "kimi accounts can't be isolated by agents-cli yet (device-scoped login)",
    );
    const provider = addAccount('cursor-work', 'cursor', 'api-key', 'cursor-secret', getUserAgentsDir());
    expect(provider.name).toBe('cursor-work');
    expect(provider.provider).toBe('cursor');
  });

  it('switch help leads with the picker workflow, not a flag dump', () => {
    const program = new Command('agents');
    applyGlobalHelpConventions(program);
    registerAccountsCommand(program);
    const help = program
      .commands.find(command => command.name() === 'accounts')!
      .commands.find(command => command.name() === 'switch')!
      .helpInformation();
    expect(help.indexOf('Examples:')).toBeGreaterThan(help.indexOf('Pick the default account'));
    expect(help).toContain('agents accounts switch claude');
    expect(help).toContain('agents accounts switch claude work');
  });
});
