import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { Command } from 'commander';
import { classifyAttachTarget, groupLabelIdentities, listSwitchableAccounts, nativeIdentityFromSource, parseBundleKey, registerAccountsCommand, resolveLabelIdentity, runAccountsLabel, setDefaultAccount, writeClaudeInteractiveOauthToken } from './accounts.js';
import { claudeAccountTokenKey } from '../lib/claude-account-token.js';
import { getVersionHomePath } from '../lib/installations/versions.js';
import { addAccount, addNativeAccount, listNativeAccounts } from '../lib/account-registry.js';
import type { RotateCandidate } from '../lib/accounting/rotate.js';
import { getUserAgentsDir, readMeta, updateMeta } from '../lib/state.js';
import { applyGlobalHelpConventions } from '../lib/help.js';
import { secretsKeychainItem, setKeychainBackendForTest, type KeychainBackend } from '../lib/secrets/index.js';
import { _resetFileStoreForTest } from '../lib/secrets/filestore.js';
import { bundleItemStore, keychainRef, writeBundle, writeBundleWithItems, type SecretsBundle } from '../lib/secrets/bundles.js';

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

  const clearTestNativeAccounts = (): void => updateMeta(meta => {
    const native = Object.fromEntries(Object.entries(meta.accounts?.native ?? {}).filter(([, account]) =>
      !['claude-native-default', 'antigravity-home'].includes(account.name),
    ));
    return { ...meta, accounts: { ...meta.accounts, native } };
  });

  beforeEach(() => {
    clearTestNativeAccounts();
    secretsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-accounts-cmd-'));
    previousMetaIndex = process.env.AGENTS_SECRETS_META_INDEX_FILE;
    process.env.AGENTS_SECRETS_META_INDEX_FILE = path.join(secretsRoot, 'bundle-index.json');
    _resetFileStoreForTest({ fileDir: path.join(secretsRoot, 'secrets'), passphrase: 'accounts-cmd-test' });
    setKeychainBackendForTest(new MemoryKeychain());
  });

  afterEach(() => {
    clearTestNativeAccounts();
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
    await expect(nativeIdentityFromSource('antigravity@1.0.0')).rejects.toThrow(
      /antigravity accounts can't be isolated by agents-cli yet \(device-scoped login\).*Supported today: claude, codex, cursor, grok, kimi/,
    );
    await expect(runAccounts(['name', 'antigravity@1.0.0', 'work'])).rejects.toThrow(
      "antigravity accounts can't be isolated by agents-cli yet (device-scoped login)",
    );
  });

  it('refuses native attach for an unsupported harness and still allows provider add', async () => {
    addNativeAccount('antigravity-home', 'antigravity', 'antigravity:opaque=1', undefined, 'device');
    await expect(runAccounts(['attach', 'antigravity-home', 'antigravity'])).rejects.toThrow(
      "antigravity accounts can't be isolated by agents-cli yet (device-scoped login)",
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

  it('label <harness>@<version> refuses a contradictory --account selector', async () => {
    await expect(runAccounts(['label', 'claude@2.1.220', 'work', '--account', 'someone@example.com'])).rejects.toThrow(
      "'claude@2.1.220' already selects one login; drop --account",
    );
  });

  it('label <harness>@<version> fails loud for an uninstalled version', async () => {
    await expect(runAccounts(['label', 'claude@99999.0.0', 'work'])).rejects.toThrow('claude@99999.0.0 is not installed');
  });

  it('label <harness>@<version> refuses an unsupported harness with the same named reason as name', async () => {
    await expect(runAccounts(['label', 'antigravity@1.0.0', 'work'])).rejects.toThrow(
      "antigravity accounts can't be isolated by agents-cli yet (device-scoped login)",
    );
  });

  it('label help leads with the selector workflow, not a flag dump', () => {
    const program = new Command('agents');
    applyGlobalHelpConventions(program);
    registerAccountsCommand(program);
    const help = program
      .commands.find(command => command.name() === 'accounts')!
      .commands.find(command => command.name() === 'label')!
      .helpInformation();
    expect(help).toContain('agents accounts label codex@0.146.0 personal');
    expect(help).toContain('agents run codex#work');
  });
});

describe('groupLabelIdentities', () => {
  it('folds one account signed into several versions into a single identity row', () => {
    const rows = groupLabelIdentities([
      { version: '0.145.0', email: 'you@example.com', accountKey: 'codex:acct=1' },
      { version: '0.146.0', email: 'you@example.com', accountKey: 'codex:acct=1' },
    ], '0.146.0');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      identityKey: 'codex:acct=1',
      email: 'you@example.com',
      versions: ['0.145.0', '0.146.0'],
      isDefault: true,
    });
  });

  it('keeps distinct identities separate and sorts the default-version login first', () => {
    const rows = groupLabelIdentities([
      { version: '0.145.0', email: 'a@example.com', accountKey: 'codex:acct=a' },
      { version: '0.146.0', email: 'b@example.com', accountKey: 'codex:acct=b' },
    ], '0.146.0');
    expect(rows.map(row => row.email)).toEqual(['b@example.com', 'a@example.com']);
    expect(rows[0].isDefault).toBe(true);
    expect(rows[1].isDefault).toBe(false);
  });

  it('falls back to the lowercased email when the harness exposes no account key', () => {
    const rows = groupLabelIdentities([
      { version: '1.0.0', email: 'You@Example.com', accountKey: null },
    ], null);
    expect(rows).toHaveLength(1);
    expect(rows[0].identityKey).toBe('you@example.com');
  });

  it('drops candidates with no stable identity — a label has nothing to bind to', () => {
    const rows = groupLabelIdentities([
      { version: '1.0.0', email: null, accountKey: null },
      { version: '1.1.0', email: 'kept@example.com', accountKey: null },
    ], null);
    expect(rows.map(row => row.email)).toEqual(['kept@example.com']);
  });
});

describe('writeClaudeInteractiveOauthToken', () => {
  // The .oauth_token fallback is the Linux keychain-less path; the write is a no-op
  // off Linux, so exercise the write/clear behavior only there.
  const linuxOnly = process.platform === 'linux' ? it : it.skip;
  const PASS = 'oauth-write-test-pass';
  const VERSION = '2.1.0';
  const EMAIL = 'social@swarmify.co';
  const TOKEN = 'sk-ant-oat01-interactive-write-test';
  let home: string;
  let fileDir: string;
  let prev: Record<string, string | undefined>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-write-home-'));
    fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-write-store-'));
    prev = {
      HOME: process.env.HOME,
      noAgent: process.env.AGENTS_SECRETS_NO_AGENT,
      pass: process.env.AGENTS_SECRETS_PASSPHRASE,
      tok: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    };
    process.env.HOME = home;
    process.env.AGENTS_SECRETS_NO_AGENT = '1';
    process.env.AGENTS_SECRETS_PASSPHRASE = PASS;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    _resetFileStoreForTest({ fileDir, passphrase: PASS });
    // A version home whose .claude.json names the account, so resolveClaudeSetupToken
    // can key the per-account token in the auth bundle.
    const configDir = path.join(getVersionHomePath('claude', VERSION), '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: EMAIL } }));
  });

  afterEach(() => {
    _resetFileStoreForTest({});
    for (const [k, v] of [['HOME', prev.HOME], ['AGENTS_SECRETS_NO_AGENT', prev.noAgent], ['AGENTS_SECRETS_PASSPHRASE', prev.pass], ['CLAUDE_CODE_OAUTH_TOKEN', prev.tok]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(fileDir, { recursive: true, force: true });
  });

  function oauthTokenPath(): string {
    return path.join(getVersionHomePath('claude', VERSION), '.claude', '.oauth_token');
  }
  function writeAuthToken(email: string, token: string): void {
    const bundle: SecretsBundle = { name: 'auth', backend: 'file', vars: {} };
    bundleItemStore('file').set(secretsKeychainItem('auth', claudeAccountTokenKey(email)), token);
    bundle.vars[claudeAccountTokenKey(email)] = keychainRef(claudeAccountTokenKey(email));
    writeBundle(bundle);
  }

  linuxOnly('writes the resolved setup-token mode 0600 for a claude@version attach', () => {
    writeAuthToken(EMAIL, TOKEN);
    writeClaudeInteractiveOauthToken({ kind: 'installation', agent: 'claude', version: VERSION }, 'claude');
    expect(fs.readFileSync(oauthTokenPath(), 'utf8')).toBe(TOKEN);
    expect(fs.statSync(oauthTokenPath()).mode & 0o777).toBe(0o600);
  });

  linuxOnly('clears a stale .oauth_token when no token resolves (re-point / detach)', () => {
    fs.writeFileSync(oauthTokenPath(), 'stale-token-from-a-previous-account');
    // No auth-bundle key for this account -> resolveClaudeSetupToken returns null.
    writeClaudeInteractiveOauthToken({ kind: 'installation', agent: 'claude', version: VERSION }, 'claude');
    expect(fs.existsSync(oauthTokenPath())).toBe(false);
  });

  it('no-ops for a non-installation target (device-scoped attach)', () => {
    writeClaudeInteractiveOauthToken({ kind: 'device-agent', agent: 'claude' }, 'claude');
    expect(fs.existsSync(oauthTokenPath())).toBe(false);
  });
});

describe('accounts label bare-harness selection (injected collector, the resolveRunVersion pattern)', () => {
  const TEST_LABELS = ['label-seam-solo', 'label-seam-picked'];
  const candidate = (version: string, email: string | null, accountKey: string | null): RotateCandidate =>
    ({ agent: 'codex', version, email, accountKey, signedIn: true }) as unknown as RotateCandidate;
  const collectSolo = async () => [
    candidate('9.9.1', 'solo@example.com', 'codex:acct=solo'),
    candidate('9.9.2', 'solo@example.com', 'codex:acct=solo'),
  ];
  const collectMulti = async () => [
    candidate('9.9.1', 'a@example.com', 'codex:acct=a'),
    candidate('9.9.2', 'b@example.com', 'codex:acct=b'),
  ];

  const removeTestLabels = (): void => updateMeta(meta => {
    const native = Object.fromEntries(Object.entries(meta.accounts?.native ?? {}).filter(([, account]) =>
      !TEST_LABELS.includes(account.name),
    ));
    return { ...meta, accounts: { ...meta.accounts, native } };
  });

  beforeEach(removeTestLabels);
  afterEach(() => {
    removeTestLabels();
    vi.restoreAllMocks();
  });

  it('one account signed into two versions auto-selects and writes the label — no picker, no selector', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runAccountsLabel('codex', 'label-seam-solo', {}, collectSolo);
    expect(log.mock.calls.flat().join('\n')).toContain("Labeled codex account solo@example.com as 'label-seam-solo'");
    const saved = listNativeAccounts(readMeta()).find(account => account.name === 'label-seam-solo');
    expect(saved).toMatchObject({ agent: 'codex', identityKey: 'codex:acct=solo', identityLabel: 'solo@example.com' });
  });

  it('--account picks the matching identity among several and writes it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runAccountsLabel('codex', 'label-seam-picked', { account: 'b@example.com' }, collectMulti);
    const saved = listNativeAccounts(readMeta()).find(account => account.name === 'label-seam-picked');
    expect(saved).toMatchObject({ agent: 'codex', identityKey: 'codex:acct=b', identityLabel: 'b@example.com' });
  });

  it('several distinct identities and no selector resolve as ambiguous — the picker/fail-loud branch', async () => {
    const selection = await resolveLabelIdentity('codex', undefined, collectMulti);
    expect(selection.kind).toBe('ambiguous');
    if (selection.kind === 'ambiguous') {
      expect(selection.identities.map(identity => identity.email)).toEqual(['a@example.com', 'b@example.com']);
    }
  });

  it('an unknown --account fails loud instead of writing anything', async () => {
    await expect(resolveLabelIdentity('codex', 'nobody@example.com', collectMulti)).rejects.toThrow(
      "Unknown codex account 'nobody@example.com'",
    );
  });

  it('zero signed-in identities fail loud with the login hint', async () => {
    await expect(resolveLabelIdentity('codex', undefined, async () => [])).rejects.toThrow(
      'No signed-in codex account with a stable identity',
    );
  });
});
