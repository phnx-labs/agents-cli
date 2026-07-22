import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import type { KeychainBackend } from '../lib/secrets/index.js';
import type { CloudflareRequest, CloudflareRequester } from '../lib/share/provision.js';
import { formatSharePublishResult } from './share.js';

interface StoredItem { value: string }

function makeMemoryBackend(): { backend: KeychainBackend; store: Map<string, StoredItem> } {
  const store = new Map<string, StoredItem>();
  const backend: KeychainBackend = {
    has: (item) => store.has(item),
    get: (item) => {
      const v = store.get(item);
      if (!v) throw new Error(`Keychain item '${item}' not found.`);
      return v.value;
    },
    set: (item, value) => { store.set(item, { value }); },
    delete: (item) => store.delete(item),
    list: (prefix) => Array.from(store.keys()).filter((k) => k.startsWith(prefix)),
  };
  return { backend, store };
}

let tmpHome = '';
let previousHome: string | undefined;
let previousPath: string | undefined;
let previousShareGitHubUser: string | undefined;

async function freshShareModules() {
  vi.resetModules();
  const mem = makeMemoryBackend();
  const secrets = await import('../lib/secrets/index.js');
  secrets.setKeychainBackendForTest(mem.backend);
  const filestore = await import('../lib/secrets/filestore.js');
  filestore._resetFileStoreForTest({ fileDir: path.join(tmpHome, '.file-secrets') });
  const share = await import('./share.js');
  const config = await import('../lib/share/config.js');
  return { share, config, mem };
}

let previousNoPrompt: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-share-command-'));
  previousHome = process.env.HOME;
  process.env.HOME = tmpHome;
  previousPath = process.env.PATH;
  previousShareGitHubUser = process.env.AGENTS_SHARE_GITHUB_USER;
  delete process.env.AGENTS_SHARE_GITHUB_USER;
  // Reads go to a temp HOME with no real keychain/agent; on darwin-headless (the
  // release-gated macOS CI matrix) isHeadlessSecretsContext() would force the
  // agentOnly no-prompt throw. Pin NO_PROMPT=0 so the direct read runs on every OS.
  previousNoPrompt = process.env.AGENTS_SECRETS_NO_PROMPT;
  process.env.AGENTS_SECRETS_NO_PROMPT = '0';
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (previousShareGitHubUser === undefined) delete process.env.AGENTS_SHARE_GITHUB_USER;
  else process.env.AGENTS_SHARE_GITHUB_USER = previousShareGitHubUser;
  if (previousNoPrompt === undefined) delete process.env.AGENTS_SECRETS_NO_PROMPT;
  else process.env.AGENTS_SECRETS_NO_PROMPT = previousNoPrompt;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function installFakeGh(username: string): void {
  const bin = path.join(tmpHome, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'gh.cmd'), `@echo off\r\necho ${username}\r\n`);
  } else {
    const gh = path.join(bin, 'gh');
    fs.writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(username)}\n`);
    fs.chmodSync(gh, 0o755);
  }
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
}

function loggedOutput(): string {
  return vi.mocked(console.log).mock.calls.map((call) => call.map(String).join(' ')).join('\n');
}

describe('runShareProvision custom domain selection', () => {
  it('maps share.agents-cli.sh by default when the token can see agents-cli.sh', async () => {
    const { share, config } = await freshShareModules();
    const seen: CloudflareRequest[] = [];
    const request: CloudflareRequester = async (req) => {
      seen.push(req);
      if (req.pathname === '/accounts/acct_1/workers/subdomain') return { subdomain: 'acct-sub' };
      if (req.pathname === '/zones?name=agents-cli.sh') return [{ id: 'zone_agents', name: 'agents-cli.sh' }];
      if (req.pathname.startsWith('/zones?name=')) return [];
      return {};
    };

    await share.runShareProvision({
      bundle: 'unused',
      worker: 'agents-share',
      bucket: 'agents-share',
      account: 'acct_1',
      token: 'cf-token',
      request,
    });

    expect(config.readShareConfig()).toMatchObject({
      baseUrl: 'https://share.agents-cli.sh',
      accountId: 'acct_1',
      workerName: 'agents-share',
      bucketName: 'agents-share',
      domain: 'share.agents-cli.sh',
    });
    expect(config.readWriteToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(seen.map((req) => req.pathname)).toEqual([
      '/accounts/acct_1/r2/buckets',
      '/accounts/acct_1/r2/buckets/agents-share/lifecycle',
      '/accounts/acct_1/r2/buckets/agents-share/lifecycle',
      '/accounts/acct_1/workers/scripts/agents-share',
      '/accounts/acct_1/workers/scripts/agents-share/secrets',
      '/accounts/acct_1/workers/scripts/agents-share/subdomain',
      '/accounts/acct_1/workers/subdomain',
      '/zones?name=share.agents-cli.sh',
      '/zones?name=agents-cli.sh',
      '/accounts/acct_1/workers/domains',
    ]);
    expect(seen.at(-1)?.body).toEqual({
      zone_id: 'zone_agents',
      hostname: 'share.agents-cli.sh',
      service: 'agents-share',
      environment: 'production',
    });
  });

  it('stays on workers.dev when the default agents-cli.sh zone is not visible', async () => {
    const { share, config } = await freshShareModules();
    const seen: CloudflareRequest[] = [];
    const request: CloudflareRequester = async (req) => {
      seen.push(req);
      if (req.pathname === '/accounts/acct_1/workers/subdomain') return { subdomain: 'acct-sub' };
      if (req.pathname.startsWith('/zones?name=')) return [];
      return {};
    };

    await share.runShareProvision({
      bundle: 'unused',
      worker: 'agents-share',
      bucket: 'agents-share',
      account: 'acct_1',
      token: 'cf-token',
      request,
    });

    expect(config.readShareConfig()).toEqual({
      baseUrl: 'https://agents-share.acct-sub.workers.dev',
      accountId: 'acct_1',
      workerName: 'agents-share',
      bucketName: 'agents-share',
      domain: undefined,
    });
    expect(seen.some((req) => req.pathname === '/accounts/acct_1/workers/domains')).toBe(false);
  });

  it('uses --domain as the custom-domain candidate instead of the default hostname', async () => {
    const { share, config } = await freshShareModules();
    const seen: CloudflareRequest[] = [];
    const request: CloudflareRequester = async (req) => {
      seen.push(req);
      if (req.pathname === '/accounts/acct_1/workers/subdomain') return { subdomain: 'acct-sub' };
      if (req.pathname === '/zones?name=example.com') return [{ id: 'zone_example', name: 'example.com' }];
      if (req.pathname.startsWith('/zones?name=')) return [];
      return {};
    };

    await share.runShareProvision({
      bundle: 'unused',
      worker: 'agents-share',
      bucket: 'agents-share',
      account: 'acct_1',
      token: 'cf-token',
      domain: 'https://share.example.com/path/',
      request,
    });

    expect(config.readShareConfig()).toMatchObject({
      baseUrl: 'https://share.example.com',
      domain: 'share.example.com',
    });
    expect(seen.map((req) => req.pathname)).toContain('/zones?name=share.example.com');
    expect(seen.map((req) => req.pathname)).toContain('/zones?name=example.com');
    expect(seen.map((req) => req.pathname)).not.toContain('/zones?name=agents-cli.sh');
    expect(seen.at(-1)?.body).toMatchObject({
      zone_id: 'zone_example',
      hostname: 'share.example.com',
    });
  });

  it('persists --analytics-token in the share config', async () => {
    const { share, config } = await freshShareModules();
    const request: CloudflareRequester = async (req) => {
      if (req.pathname === '/accounts/acct_1/workers/subdomain') return { subdomain: 'acct-sub' };
      if (req.pathname.startsWith('/zones?name=')) return [];
      return {};
    };

    await share.runShareProvision({
      bundle: 'unused',
      worker: 'agents-share',
      bucket: 'agents-share',
      account: 'acct_1',
      token: 'cf-token',
      analyticsToken: 'cf-web-analytics-token',
      request,
    });

    expect(config.readShareConfig()).toMatchObject({
      analyticsToken: 'cf-web-analytics-token',
    });
  });
});

describe('share status and analytics namespace display', () => {
  it('resolves the status namespace through gh auth when github.user is unset', async () => {
    const { share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: 'acct_1',
      workerName: 'agents-share',
      bucketName: 'agents-share',
    });
    installFakeGh('gh-only-user');

    const program = new Command();
    program.exitOverride();
    share.registerShareCommands(program);
    await program.parseAsync(['node', 'agents', 'share', 'status']);

    const out = loggedOutput();
    expect(out).toContain('https://share.test/gh-only-user');
    expect(out).not.toContain('unknown');
  });

  it('uses the gh-resolved namespace in the analytics path hint', async () => {
    const { share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: 'acct_1',
      workerName: 'agents-share',
      bucketName: 'agents-share',
      domain: 'share.test',
      analyticsToken: 'cf-web-analytics-token',
    });
    installFakeGh('gh-only-user');

    const program = new Command();
    program.exitOverride();
    share.registerShareCommands(program);
    await program.parseAsync(['node', 'agents', 'share', 'analytics']);

    expect(loggedOutput()).toContain('filter by /gh-only-user/');
  });
});



describe('formatSharePublishResult', () => {
  it('emits stable JSON for plan-render hooks and scripts', () => {
    const text = formatSharePublishResult(
      {
        url: 'https://share.example/plan',
        coverUrl: 'https://share.example/plan.png',
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
      true,
    );

    expect(JSON.parse(text)).toEqual({
      url: 'https://share.example/plan',
      coverUrl: 'https://share.example/plan.png',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
  });

  it('keeps the first human output line as the share URL', () => {
    const text = formatSharePublishResult({ url: 'https://share.example/plan' });

    expect(text.split('\n')[0]).toBe('https://share.example/plan');
  });
});
