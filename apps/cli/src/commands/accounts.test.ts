import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { Command } from 'commander';
import { classifyAttachTarget, dormantAccountsForHarness, listSwitchableAccounts, nativeIdentityFromSource, parseBundleKey, registerAccountsCommand, setDefaultAccount } from './accounts.js';
import { addAccount, addNativeAccount } from '../lib/account-registry.js';
import { getUserAgentsDir, readMeta, updateMeta } from '../lib/state.js';
import { applyGlobalHelpConventions } from '../lib/help.js';
import { secretsKeychainItem, setKeychainBackendForTest, type KeychainBackend } from '../lib/secrets/index.js';
import { _resetFileStoreForTest } from '../lib/secrets/filestore.js';
import { keychainRef, writeBundleWithItems } from '../lib/secrets/bundles.js';
import { entitlementCachePath } from '../lib/entitlement.js';

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

  it('setDefaultAccount succeeds for a native account and records it as the harness default (follow-up to PR #2810)', () => {
    const native = addNativeAccount('claude-native-default', 'claude', 'native-identity-key-1', 'user@example.com', 'version');
    const result = setDefaultAccount('claude', 'claude-native-default');
    expect(result.agent).toBe('claude');
    expect(result.account.id).toBe(native.id);
    expect(readMeta().accounts?.defaults?.claude).toBe(native.id);
  });
});

describe('accounts plan-tier cap (RUSH-2424)', () => {
  let secretsRoot: string;
  let previousMetaIndex: string | undefined;
  let rushUserYaml: string;

  /** Real read path entitlement.ts itself uses — no monkey-patching, just the on-disk fixture. */
  function writeTierFixture(tierName: string, isPaid: boolean): void {
    fs.mkdirSync(path.dirname(rushUserYaml), { recursive: true });
    fs.writeFileSync(rushUserYaml, yaml.stringify({ session: { access_token: 'test-token' } }));
    const cachePath = entitlementCachePath();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ version: 1, tierName, isPaid, fetchedAt: Date.now() }));
  }

  beforeEach(() => {
    secretsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-accounts-cap-'));
    previousMetaIndex = process.env.AGENTS_SECRETS_META_INDEX_FILE;
    process.env.AGENTS_SECRETS_META_INDEX_FILE = path.join(secretsRoot, 'bundle-index.json');
    _resetFileStoreForTest({ fileDir: path.join(secretsRoot, 'secrets'), passphrase: 'accounts-cap-test' });
    setKeychainBackendForTest(new MemoryKeychain());
    rushUserYaml = path.join(os.homedir(), '.rush', 'user.yaml');
    // Native accounts/defaults live in central agents.yaml (sandbox HOME, shared
    // across tests in this fork) — start each test from a clean slate.
    updateMeta(meta => ({ ...meta, accounts: { native: {}, defaults: {}, bindings: {} } }));
    // `accounts add --from-secrets x:y` needs a real bundle to import from —
    // a setup-token shaped value so `anthropic`'s validator accepts it.
    writeBundleWithItems(
      { name: 'x', policy: 'never', vars: { y: keychainRef('y') } },
      new Map([[secretsKeychainItem('x', 'y'), 'sk-ant-oat01-test-secret']]),
    );
  });

  afterEach(() => {
    setKeychainBackendForTest(null);
    _resetFileStoreForTest();
    if (previousMetaIndex === undefined) delete process.env.AGENTS_SECRETS_META_INDEX_FILE;
    else process.env.AGENTS_SECRETS_META_INDEX_FILE = previousMetaIndex;
    vi.restoreAllMocks();
    fs.rmSync(secretsRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(rushUserYaml), { recursive: true, force: true }); // ~/.rush inside the sandbox HOME
    fs.rmSync(entitlementCachePath(), { force: true });
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

  it('free plan: refuses a 4th claude-capable account with the exact cap message and a non-zero exit', async () => {
    addNativeAccount('claude1', 'claude', 'id-1', undefined, 'version');
    addNativeAccount('claude2', 'claude', 'id-2', undefined, 'version');
    addNativeAccount('claude3', 'claude', 'id-3', undefined, 'version');
    await expect(runAccounts(['add', 'anthro4', '--provider', 'anthropic', '--auth', 'api-key', '--from-secrets', 'x:y']))
      .rejects.toThrow('free plan is capped at 3 claude accounts (3/3). agents upgrade — up to 10 per harness.');
  });

  it('free plan: a successful 3rd add prints a one-line non-blocking notice at exactly 3/3', async () => {
    addNativeAccount('claude1', 'claude', 'id-1', undefined, 'version');
    addNativeAccount('claude2', 'claude', 'id-2', undefined, 'version');
    // The 3rd claude-capable account — the add itself must succeed, only the notice fires.
    const out = await runAccounts(['add', 'anthro3', '--provider', 'anthropic', '--auth', 'api-key', '--from-secrets', 'x:y']);
    expect(out).toContain("Added anthropic api-key account 'anthro3'.");
    expect(out).toContain('3/3 claude accounts on the free plan. agents upgrade — up to 10 per harness.');
  });

  it('admin tier caps at 10, not 3 — a 4th claude-capable account is accepted with no free-plan notice', async () => {
    writeTierFixture('admin', true);
    addNativeAccount('claude1', 'claude', 'id-1', undefined, 'version');
    addNativeAccount('claude2', 'claude', 'id-2', undefined, 'version');
    addNativeAccount('claude3', 'claude', 'id-3', undefined, 'version');
    const out = await runAccounts(['add', 'anthro4', '--provider', 'anthropic', '--auth', 'api-key', '--from-secrets', 'x:y']);
    expect(out).toContain("Added anthropic api-key account 'anthro4'.");
    expect(out).not.toContain('free plan');
  });

  it('downgrade never deletes credentials: over-cap accounts fall out of listSwitchableAccounts and are reported dormant', async () => {
    // Simulate a downgrade from a paid plan that had 5 registered claude accounts.
    addNativeAccount('claude-a', 'claude', 'id-a', undefined, 'version');
    addNativeAccount('claude-b', 'claude', 'id-b', undefined, 'version');
    addNativeAccount('claude-c', 'claude', 'id-c', undefined, 'version');
    addNativeAccount('claude-d', 'claude', 'id-d', undefined, 'version');
    addNativeAccount('claude-e', 'claude', 'id-e', undefined, 'version');

    const active = await listSwitchableAccounts('claude');
    const dormant = await dormantAccountsForHarness('claude');
    expect(active).toHaveLength(3);
    expect(dormant).toHaveLength(2);
    // Deterministic, name-sorted slice — the first 3 alphabetically stay active.
    expect(active.map(a => a.name)).toEqual(['claude-a', 'claude-b', 'claude-c']);
    expect(dormant.map(a => a.name)).toEqual(['claude-d', 'claude-e']);

    // Never deleted: still resolvable via findUnifiedAccount, just excluded from switch.
    const switchJson = await runAccounts(['switch', 'claude', '--json']);
    const parsed = JSON.parse(switchJson);
    expect(parsed.accounts.map((a: { name: string }) => a.name)).not.toContain('claude-d');
    expect(readMeta().accounts?.native).toBeTruthy();
    const nativeIds = Object.values(readMeta().accounts?.native ?? {}).map(a => a.name);
    expect(nativeIds).toContain('claude-d'); // credential metadata never deleted by the cap
  });
});
