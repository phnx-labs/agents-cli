import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Command } from 'commander';

import {
  accountNameFromEmail,
  assertValidSetupToken,
  buildMintCommand,
  driveSetupTokenMint,
  extractClaudeSetupToken,
  extractMintUrl,
  getMintFlow,
  hasMintedSetupToken,
  listMintableHarnesses,
  mintAndSeed,
  MINT_FLOWS,
  resolveMintIdentity,
  resolveSyncTargets,
  seedNamedAccount,
  seedReservedAuthToken,
  stripAnsi,
  unmintableMessage,
  type MintDriveHooks,
} from './auth-mint.js';
import { upsertDevice } from './devices/registry.js';
import { resetSelfHostCache } from './devices/self-host.js';
import {
  AUTH_BUNDLE,
  claudeAccountTokenKey,
  isValidClaudeSetupToken,
  resolveClaudeSetupToken,
} from './claude-account-token.js';
import { findAccount } from './account-registry.js';
import { bundleBackend, bundleExists, readAndResolveBundleEnv } from './secrets/bundles.js';
import { _resetFileStoreForTest } from './secrets/filestore.js';
import { setKeychainBackendForTest, type KeychainBackend } from './secrets/index.js';
import type { PtyDriver } from './fleet/remote-login.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => fs.readFileSync(path.join(here, 'testdata', name), 'utf-8');

const TOKEN = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz012345';
const EMAIL = 'ada@example.com';

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

function fakeDriver(frames: { screen: string; exited?: boolean }[]): PtyDriver & { writes: string[]; execs: string[]; stopped: string[] } {
  let i = 0;
  const writes: string[] = [];
  const execs: string[] = [];
  const stopped: string[] = [];
  return {
    writes,
    execs,
    stopped,
    async start() { return 'sess-mint'; },
    async exec(_id, command) { execs.push(command); },
    async write(_id, input) { writes.push(input); },
    async screen() {
      const frame = frames[Math.min(i, frames.length - 1)]!;
      i++;
      return { screen: frame.screen, exited: Boolean(frame.exited) };
    },
    async stop(id) { stopped.push(id); },
  };
}

describe('mint flow table', () => {
  it('lists only harnesses with a real interactive mint command', () => {
    expect(listMintableHarnesses()).toEqual(['claude']);
    expect(MINT_FLOWS.claude.mintArgs).toEqual(['setup-token']);
    expect(getMintFlow('claude').provider).toBe('anthropic');
  });

  it('fails loud for a harness with no setup-token mint', () => {
    expect(() => getMintFlow('grok')).toThrow(/Cannot mint a setup-token for 'grok'/);
    expect(() => getMintFlow('codex')).toThrow(/agents fleet login --agent codex/);
    expect(() => getMintFlow('not-an-agent')).toThrow(/Unknown harness/);
    expect(unmintableMessage('droid')).toMatch(/agents accounts add/);
  });
});

describe('extractClaudeSetupToken — the #1767 guard', () => {
  it('pulls the token out of a real completed setup-token screen', () => {
    expect(extractClaudeSetupToken(fixture('claude-setup-token-done.txt'))).toBe(TOKEN);
  });

  it('returns null on the authorize-URL screen (no token yet)', () => {
    expect(extractClaudeSetupToken(fixture('claude-setup-token.txt'))).toBeNull();
  });

  it('extracts a clean token from the #1767 ANSI-banner blob instead of treating the blob as the token', () => {
    const blob = '\x1b[?2004h\x1b[?1004hWelcome to Claude Code\n  sk-ant-oat01-abcdefghijklmnopqrstuvwxyz012345\n';
    expect(isValidClaudeSetupToken(blob)).toBe(false);
    expect(extractClaudeSetupToken(blob)).toBe(TOKEN);
    expect(assertValidSetupToken(extractClaudeSetupToken(blob)!)).toBe(TOKEN);
  });

  it('refuses a banner with no token', () => {
    expect(extractClaudeSetupToken('\x1b[32mWelcome to Claude Code\x1b[0m')).toBeNull();
    expect(() => assertValidSetupToken('\x1b[32mWelcome to Claude Code\x1b[0m')).toThrow(/Not a Claude setup-token/);
  });

  it('refuses two distinct tokens rather than guessing', () => {
    expect(() => extractClaudeSetupToken(`a ${TOKEN} b sk-ant-oat01-other-token-zzzz`)).toThrow(/2 distinct setup-tokens/);
  });

  it('strips CSI sequences so a wrapped URL still parses', () => {
    const raw = '\x1b[1mhttps://claude.ai/oauth/authorize?state=abc\x1b[0m';
    expect(stripAnsi(raw)).toContain('https://claude.ai/oauth/authorize?state=abc');
    expect(extractMintUrl(fixture('claude-setup-token.txt'), MINT_FLOWS.claude)).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize/);
  });
});

describe('resolveMintIdentity', () => {
  it('treats --account email as both the name source and the bundle key', () => {
    expect(resolveMintIdentity({ account: EMAIL })).toEqual({
      accountName: 'ada-at-example.com',
      email: EMAIL,
    });
    expect(accountNameFromEmail(EMAIL)).toBe('ada-at-example.com');
  });

  it('keeps a name and requires --email when --account is not an email', () => {
    expect(resolveMintIdentity({ account: 'work', email: EMAIL })).toEqual({
      accountName: 'work',
      email: EMAIL,
    });
    expect(() => resolveMintIdentity({ account: 'work' })).toThrow(/without an email/);
  });

  it('reads the signed-in email from a version home when flags omit it', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mint-identity-home-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: EMAIL } }),
    );
    try {
      expect(resolveMintIdentity({ home })).toEqual({
        accountName: 'ada-at-example.com',
        email: EMAIL,
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('driveSetupTokenMint', () => {
  const fast = { initialDelayMs: 0, pollMs: 1, timeoutMs: 400 };
  const flow = MINT_FLOWS.claude;

  it('opens the authorize URL then captures the token from a later screen', async () => {
    const opened: string[] = [];
    const driver = fakeDriver([
      { screen: fixture('claude-setup-token.txt') },
      { screen: fixture('claude-setup-token-done.txt') },
    ]);
    const r = await driveSetupTokenMint('HOME=/tmp/x /bin/claude setup-token', flow, {
      driver,
      openUrl: async (url) => { opened.push(url); },
      drive: fast,
    });
    expect(driver.execs[0]).toContain('setup-token');
    expect(opened[0]).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize/);
    expect(r.token).toBe(TOKEN);
    expect(driver.stopped).toEqual(['sess-mint']);
  });

  it('driveSetupTokenMint with json writes no Authorize URL on stdout', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => {
      logs.push(a.map(String).join(' '));
    });
    const driver = fakeDriver([
      { screen: fixture('claude-setup-token.txt') },
      { screen: fixture('claude-setup-token-done.txt') },
    ]);
    try {
      await driveSetupTokenMint('claude setup-token', flow, {
        driver,
        json: true,
        openUrl: async () => {},
        drive: fast,
        code: 'AUTHCODE#state',
      });
      expect(logs).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('pastes --code into the PTY after the URL appears', async () => {
    const driver = fakeDriver([
      { screen: fixture('claude-setup-token.txt') },
      { screen: fixture('claude-setup-token-done.txt') },
    ]);
    await driveSetupTokenMint('claude setup-token', flow, {
      driver,
      openUrl: async () => {},
      drive: fast,
      code: 'AUTHCODE#state',
    });
    expect(driver.writes).toEqual(['AUTHCODE#state\r']);
  });

  it('stops the PTY and fails loud when the process exits with no token', async () => {
    const driver = fakeDriver([{ screen: 'denied', exited: true }]);
    await expect(driveSetupTokenMint('claude setup-token', flow, {
      driver,
      openUrl: async () => {},
      drive: fast,
    })).rejects.toThrow(/exited before printing/);
    expect(driver.stopped).toContain('sess-mint');
  });
});

describe('seed + mintAndSeed — real file-backed auth bundle and named account', () => {
  const PASS = 'auth-mint-test-pass';
  let fileDir: string;
  let prevNoAgent: string | undefined;
  let prevPass: string | undefined;
  let prevMeta: string | undefined;
  let home: string;

  beforeEach(() => {
    fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-mint-store-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-mint-home-'));
    prevNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
    prevPass = process.env.AGENTS_SECRETS_PASSPHRASE;
    prevMeta = process.env.AGENTS_SECRETS_META_INDEX_FILE;
    process.env.AGENTS_SECRETS_NO_AGENT = '1';
    process.env.AGENTS_SECRETS_PASSPHRASE = PASS;
    process.env.AGENTS_SECRETS_META_INDEX_FILE = path.join(fileDir, 'bundle-index.json');
    _resetFileStoreForTest({ fileDir, passphrase: PASS });
    setKeychainBackendForTest(new MemoryKeychain());
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: EMAIL } }),
    );
  });

  afterEach(() => {
    setKeychainBackendForTest(null);
    _resetFileStoreForTest({});
    if (prevNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
    else process.env.AGENTS_SECRETS_NO_AGENT = prevNoAgent;
    if (prevPass === undefined) delete process.env.AGENTS_SECRETS_PASSPHRASE;
    else process.env.AGENTS_SECRETS_PASSPHRASE = prevPass;
    if (prevMeta === undefined) delete process.env.AGENTS_SECRETS_META_INDEX_FILE;
    else process.env.AGENTS_SECRETS_META_INDEX_FILE = prevMeta;
    fs.rmSync(fileDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('seeds the reserved file-backed auth bundle so resolveClaudeSetupToken reads it', () => {
    expect(hasMintedSetupToken().ready).toBe(false);
    const { key } = seedReservedAuthToken(EMAIL, TOKEN);
    expect(key).toBe(claudeAccountTokenKey(EMAIL));
    expect(bundleExists(AUTH_BUNDLE)).toBe(true);
    expect(bundleBackend(AUTH_BUNDLE)).toBe('file');
    expect(resolveClaudeSetupToken(home)).toBe(TOKEN);
    const { env } = readAndResolveBundleEnv(AUTH_BUNDLE, { caller: 'usage', agentOnly: true });
    expect(env[key]).toBe(TOKEN);
    expect(hasMintedSetupToken().ready).toBe(true);
  });

  it('refuses to seed the #1767 TTY blob into the reserved bundle', () => {
    const blob = '\x1b[?2004hWelcome to Claude Code\n  sk-ant-oat01-abcdefghijklmnopqrstuvwxyz012345\n';
    expect(() => seedReservedAuthToken(EMAIL, blob)).toThrow(/Not a Claude setup-token/);
    expect(bundleExists(AUTH_BUNDLE)).toBe(false);
    expect(resolveClaudeSetupToken(home)).toBeNull();
  });

  it('mintAndSeed --token path writes the named account AND the reserved auth key', async () => {
    const result = await mintAndSeed({
      harness: 'claude',
      account: EMAIL,
      token: TOKEN,
    });
    expect(result.account).toBe('ada-at-example.com');
    expect(result.email).toBe(EMAIL);
    expect(result.rotated).toBe(false);
    expect(result.fleet).toEqual([]);
    expect(findAccount(result.account)?.auth).toBe('setup-token');
    expect(resolveClaudeSetupToken(home)).toBe(TOKEN);
    expect(result.authBundleKey).toBe(claudeAccountTokenKey(EMAIL));
  });

  it('rotates an existing anthropic setup-token account instead of colliding', async () => {
    seedNamedAccount('work', TOKEN, MINT_FLOWS.claude);
    const rotated = 'sk-ant-oat01-rotatedtokenvaluezzzzzzzzzz';
    const result = await mintAndSeed({
      harness: 'claude',
      account: 'work',
      email: EMAIL,
      token: rotated,
    });
    expect(result.rotated).toBe(true);
    expect(result.account).toBe('work');
    expect(resolveClaudeSetupToken(home)).toBe(rotated);
  });

  it('buildMintCommand quotes HOME and the binary', () => {
    expect(buildMintCommand(MINT_FLOWS.claude, '/opt/claude', '/tmp/home with space')).toBe(
      "HOME='/tmp/home with space' /opt/claude setup-token",
    );
  });

  it('mintAndSeed --code --json writes no progress lines; stdout is only valid JSON', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => {
      logs.push(a.map(String).join(' '));
    });
    const driver = fakeDriver([
      { screen: fixture('claude-setup-token.txt') },
      { screen: fixture('claude-setup-token-done.txt') },
    ]);
    try {
      const result = await mintAndSeed({
        harness: 'claude',
        account: EMAIL,
        code: 'AUTHCODE#state',
        json: true,
        open: false,
        hooks: { driver, drive: { initialDelayMs: 0, pollMs: 1, timeoutMs: 400 } },
      });
      expect(result.account).toBe('ada-at-example.com');
      expect(result.email).toBe(EMAIL);
      expect(logs).toEqual([]);
      expect(result).not.toHaveProperty('token');
    } finally {
      spy.mockRestore();
    }
  });

  it('mintAndSeed --code without --json prints the authorize URL on stdout', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => {
      logs.push(a.map(String).join(' '));
    });
    const driver = fakeDriver([
      { screen: fixture('claude-setup-token.txt') },
      { screen: fixture('claude-setup-token-done.txt') },
    ]);
    try {
      await mintAndSeed({
        harness: 'claude',
        account: EMAIL,
        code: 'AUTHCODE#state',
        open: false,
        hooks: { driver, drive: { initialDelayMs: 0, pollMs: 1, timeoutMs: 400 } },
      });
      const stdout = logs.join('\n');
      expect(stdout).toMatch(/Authorize: https:\/\/claude\.ai\/oauth\/authorize/);
      expect(stdout).toMatch(/Authorize URL: https:\/\/claude\.ai\/oauth\/authorize/);
    } finally {
      spy.mockRestore();
    }
  });

  it('accounts mint --code --json stdout is only parseable JSON', async () => {
    const { registerMintCommand } = await import('../commands/auth-mint.js');
    const driver = fakeDriver([
      { screen: fixture('claude-setup-token.txt') },
      { screen: fixture('claude-setup-token-done.txt') },
    ]);
    const hooks: MintDriveHooks = {
      driver,
      drive: { initialDelayMs: 0, pollMs: 1, timeoutMs: 400 },
    };
    const program = new Command();
    program.exitOverride();
    registerMintCommand(program.command('accounts'), hooks);
    const out: string[] = [];
    const err: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.map(String).join(' ')));
    const error = vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.map(String).join(' ')));
    const proc = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit__:${code}`);
    }) as never);
    try {
      await program.parseAsync([
        'node', 'agents', 'accounts', 'mint', 'claude',
        '--code', 'AUTHCODE#state',
        '--json',
        '--no-open',
        '--account', EMAIL,
      ]);
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith('__exit__')) throw e;
    } finally {
      log.mockRestore();
      error.mockRestore();
      proc.mockRestore();
    }
    const stdout = out.join('\n');
    expect(stdout).not.toMatch(/Authorize/);
    const parsed = JSON.parse(stdout) as {
      harness: string;
      account: string;
      email: string;
      authBundleKey: string;
      rotated: boolean;
      fleet: unknown[];
      token?: string;
      error?: string;
    };
    expect(parsed).toEqual({
      harness: 'claude',
      account: 'ada-at-example.com',
      email: EMAIL,
      authBundleKey: claudeAccountTokenKey(EMAIL),
      rotated: false,
      fleet: [],
    });
    expect(parsed).not.toHaveProperty('token');
    expect(parsed.error).toBeUndefined();
  });

  describe('--fleet / --device through mintAndSeed', () => {
    const SELF = 'mint-self';
    const PEER = 'peer-a';
    let devicesDir: string;
    let prevDevicesDir: string | undefined;
    let prevMachineId: string | undefined;

    beforeEach(async () => {
      devicesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-mint-seed-devices-'));
      prevDevicesDir = process.env.AGENTS_DEVICES_DIR;
      prevMachineId = process.env.AGENTS_SYNC_MACHINE_ID;
      process.env.AGENTS_DEVICES_DIR = devicesDir;
      process.env.AGENTS_SYNC_MACHINE_ID = SELF;
      resetSelfHostCache();
      await upsertDevice(SELF, {
        platform: 'linux',
        user: 'test',
        address: { via: 'manual', dnsName: `${SELF}.example.ts.net` },
      });
      await upsertDevice(PEER, {
        platform: 'linux',
        user: 'test',
        address: { via: 'manual', dnsName: `${PEER}.example.ts.net` },
      });
      resetSelfHostCache();
    });

    afterEach(() => {
      if (prevDevicesDir === undefined) delete process.env.AGENTS_DEVICES_DIR;
      else process.env.AGENTS_DEVICES_DIR = prevDevicesDir;
      if (prevMachineId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
      else process.env.AGENTS_SYNC_MACHINE_ID = prevMachineId;
      resetSelfHostCache();
      fs.rmSync(devicesDir, { recursive: true, force: true });
    });

    it('fails loud on an unknown --device', async () => {
      await expect(mintAndSeed({
        harness: 'claude',
        account: EMAIL,
        token: TOKEN,
        devices: ['no-such-box'],
      })).rejects.toThrow(/Unknown device 'no-such-box'/);
    });

    it('skips --device self and returns an empty fleet list', async () => {
      const result = await mintAndSeed({
        harness: 'claude',
        account: EMAIL,
        token: TOKEN,
        devices: [SELF],
      });
      expect(result.fleet).toEqual([]);
    });

    it('throws a partial-fleet-failure after seeding locally when a peer sync fails', async () => {
      await expect(mintAndSeed({
        harness: 'claude',
        account: EMAIL,
        token: TOKEN,
        devices: [PEER],
      })).rejects.toThrow(/Minted locally but fleet sync failed for: peer-a/);
      expect(findAccount('ada-at-example.com')?.auth).toBe('setup-token');
      expect(resolveClaudeSetupToken(home)).toBe(TOKEN);
    });
  });
});

describe('agents auth mint / accounts mint command wiring', () => {
  async function run(group: 'auth' | 'accounts', ...argv: string[]): Promise<{ out: string; err: string; exit: number | undefined }> {
    const { registerAuthCommand } = await import('../commands/auth.js');
    const { registerAccountsCommand } = await import('../commands/accounts.js');
    const program = new Command();
    program.exitOverride();
    registerAuthCommand(program);
    registerAccountsCommand(program);
    const out: string[] = [];
    const err: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.map(String).join(' ')));
    const error = vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.map(String).join(' ')));
    let exit: number | undefined;
    const proc = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exit = code;
      throw new Error('__exit__');
    }) as never);
    try {
      await program.parseAsync(['node', 'agents', group, ...argv]);
    } catch (e) {
      if (!(e instanceof Error) || e.message !== '__exit__') throw e;
    } finally {
      log.mockRestore();
      error.mockRestore();
      proc.mockRestore();
    }
    return { out: out.join('\n'), err: err.join('\n'), exit };
  }

  it('registers mint on both auth and accounts with a workflow-first help block', async () => {
    const { registerAuthCommand } = await import('../commands/auth.js');
    const { registerAccountsCommand } = await import('../commands/accounts.js');
    const { applyGlobalHelpConventions } = await import('./help.js');
    const program = new Command('agents');
    applyGlobalHelpConventions(program);
    registerAuthCommand(program);
    registerAccountsCommand(program);
    const authHelp = program.commands.find((c) => c.name() === 'auth')!
      .commands.find((c) => c.name() === 'mint')!
      .helpInformation();
    const accountsHelp = program.commands.find((c) => c.name() === 'accounts')!
      .commands.find((c) => c.name() === 'mint')!
      .helpInformation();
    expect(authHelp).toContain('agents accounts mint claude');
    expect(authHelp).toContain('--token-stdin');
    expect(authHelp).toContain('--code AUTHCODE --json');
    expect(accountsHelp).toContain('sk-ant-oat01-');
    expect(program.commands.find((c) => c.name() === 'auth')!.commands.map((c) => c.name())).toContain('mint');
    expect(program.commands.find((c) => c.name() === 'accounts')!.commands.map((c) => c.name())).toContain('mint');
  });

  it('fails loud for an unmintable harness before touching a PTY', async () => {
    const r = await run('auth', 'mint', 'grok');
    const text = `${r.out}${r.err}`;
    expect(text).toMatch(/Cannot mint a setup-token for 'grok'/);
    expect(r.exit).toBe(1);
  });

  it('mint --json for an unmintable harness emits only parseable JSON on stdout', async () => {
    const r = await run('accounts', 'mint', 'grok', '--json');
    expect(r.exit).toBe(1);
    expect(r.out).not.toMatch(/Authorize/);
    const parsed = JSON.parse(r.out);
    expect(parsed.error).toMatch(/Cannot mint a setup-token for 'grok'/);
  });
});

describe('resolveSyncTargets — --fleet / --device', () => {
  const SELF = 'mint-self';
  const PEER_A = 'peer-a';
  const PEER_B = 'peer-b';
  let devicesDir: string;
  let prevDevicesDir: string | undefined;
  let prevMachineId: string | undefined;

  beforeEach(async () => {
    devicesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-mint-devices-'));
    prevDevicesDir = process.env.AGENTS_DEVICES_DIR;
    prevMachineId = process.env.AGENTS_SYNC_MACHINE_ID;
    process.env.AGENTS_DEVICES_DIR = devicesDir;
    process.env.AGENTS_SYNC_MACHINE_ID = SELF;
    resetSelfHostCache();
    fs.mkdirSync(devicesDir, { recursive: true });
    await upsertDevice(SELF, {
      platform: 'linux',
      user: 'test',
      address: { via: 'manual', dnsName: `${SELF}.example.ts.net` },
    });
    await upsertDevice(PEER_A, {
      platform: 'linux',
      user: 'test',
      address: { via: 'manual', dnsName: `${PEER_A}.example.ts.net` },
    });
    await upsertDevice(PEER_B, {
      platform: 'linux',
      user: 'test',
      address: { via: 'manual', dnsName: `${PEER_B}.example.ts.net` },
    });
    resetSelfHostCache();
  });

  afterEach(() => {
    if (prevDevicesDir === undefined) delete process.env.AGENTS_DEVICES_DIR;
    else process.env.AGENTS_DEVICES_DIR = prevDevicesDir;
    if (prevMachineId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = prevMachineId;
    resetSelfHostCache();
    fs.rmSync(devicesDir, { recursive: true, force: true });
  });

  it('returns no targets when neither --fleet nor --device is set', async () => {
    expect(await resolveSyncTargets(false, [])).toEqual([]);
  });

  it('fails loud for an unknown --device name', async () => {
    await expect(resolveSyncTargets(false, ['no-such-box'])).rejects.toThrow(
      /Unknown device 'no-such-box'/,
    );
  });

  it('skips a --device that is this host', async () => {
    expect(await resolveSyncTargets(false, [SELF])).toEqual([]);
    expect(await resolveSyncTargets(false, ['localhost'])).toEqual([]);
  });

  it('unions --fleet with named --device and drops self + duplicates', async () => {
    expect(await resolveSyncTargets(true, [])).toEqual([PEER_A, PEER_B]);
    expect(await resolveSyncTargets(true, [PEER_A, SELF])).toEqual([PEER_A, PEER_B]);
    expect(await resolveSyncTargets(false, [PEER_A, PEER_A, SELF])).toEqual([PEER_A]);
  });
});
