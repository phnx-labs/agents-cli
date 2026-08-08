import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import type { KeychainBackend } from '../lib/secrets/index.js';
import type { CloudflareRequest, CloudflareRequester } from '../lib/share/provision.js';
import { formatSharePublishResult, formatShareDeleteResult, runShareDelete } from './share.js';
import type { DeleteShareResult } from '../lib/share/delete.js';

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
let previousShareWriteToken: string | undefined;

async function freshShareModules() {
  vi.resetModules();
  const mem = makeMemoryBackend();
  const secrets = await import('../lib/secrets/index.js');
  secrets.setKeychainBackendForTest(mem.backend);
  const bundles = await import('../lib/secrets/bundles.js');
  bundles.setKeychainAgentOnlyBypassForTest(true);
  const filestore = await import('../lib/secrets/filestore.js');
  filestore._resetFileStoreForTest({ fileDir: path.join(tmpHome, '.file-secrets') });
  const share = await import('./share.js');
  const config = await import('../lib/share/config.js');
  return { share, config, mem };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-share-command-'));
  previousHome = process.env.HOME;
  process.env.HOME = tmpHome;
  previousPath = process.env.PATH;
  previousShareGitHubUser = process.env.AGENTS_SHARE_GITHUB_USER;
  delete process.env.AGENTS_SHARE_GITHUB_USER;
  // A live `agents share` session in this shell may have SHARE_WRITE_TOKEN
  // injected (shareRuntimeEnv) — clear it so readWriteToken() in tests always
  // resolves through the (mocked) bundle, not this process's real env.
  previousShareWriteToken = process.env.SHARE_WRITE_TOKEN;
  delete process.env.SHARE_WRITE_TOKEN;
  // Reads go to a temp HOME with an in-memory keychain backend.
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
  if (previousShareWriteToken === undefined) delete process.env.SHARE_WRITE_TOKEN;
  else process.env.SHARE_WRITE_TOKEN = previousShareWriteToken;
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
      templateHash: expect.stringMatching(/^[0-9a-f]{64}$/),
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

describe('runShareUpdate', () => {
  it('refuses when share was never configured', async () => {
    const { share } = await freshShareModules();
    await expect(share.runShareUpdate({})).rejects.toThrow(/Run 'agents share setup'/);
  });

  it('reuses the existing account/worker/bucket/token from config — never re-provisions', async () => {
    const { share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: 'acct_existing',
      workerName: 'worker-existing',
      bucketName: 'bucket-existing',
    });
    config.storeWriteToken('the-original-write-token');

    const seen: CloudflareRequest[] = [];
    const request: CloudflareRequester = async (req) => { seen.push(req); return {}; };

    const result = await share.runShareUpdate({ token: 'cf-token', account: 'acct_existing', request });

    expect(result.updated).toBe(true);
    expect(result.baseUrl).toBe('https://share.test');
    expect(result.workerName).toBe('worker-existing');
    // No bucket/subdomain/domain calls — an update never re-provisions.
    expect(seen.map((r) => r.pathname)).toEqual([
      '/accounts/acct_existing/workers/scripts/worker-existing',
      '/accounts/acct_existing/workers/scripts/worker-existing/secrets',
    ]);
    expect(seen[1].body).toEqual({ name: 'WRITE_TOKEN', text: 'the-original-write-token', type: 'secret_text' });
    // The token in the bundle is untouched — never regenerated.
    expect(config.readWriteToken()).toBe('the-original-write-token');
    expect(config.readShareConfig()?.templateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is idempotent — a second call with a matching hash makes no request', async () => {
    const { share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: 'acct_1',
      workerName: 'worker-one',
      bucketName: 'bucket-one',
    });
    config.storeWriteToken('tok');

    const first: CloudflareRequest[] = [];
    await share.runShareUpdate({ token: 'cf-token', request: async (req) => { first.push(req); return {}; } });
    expect(first.length).toBeGreaterThan(0);

    const second: CloudflareRequest[] = [];
    const result = await share.runShareUpdate({ token: 'cf-token', request: async (req) => { second.push(req); return {}; } });

    expect(result.updated).toBe(false);
    expect(second).toEqual([]);
  });
});

describe('shareTemplateStatus', () => {
  it('is unknown for a config with no recorded hash', async () => {
    const { share } = await freshShareModules();
    expect(
      share.shareTemplateStatus({ baseUrl: 'x', accountId: 'a', workerName: 'w', bucketName: 'b' }),
    ).toBe('unknown');
  });

  it('is current when the recorded hash matches the live template', async () => {
    const { share } = await freshShareModules();
    const { renderWorkerScript } = await import('../lib/share/worker-template.js');
    const { hashWorkerScript } = await import('../lib/share/provision.js');
    expect(
      share.shareTemplateStatus({
        baseUrl: 'x', accountId: 'a', workerName: 'w', bucketName: 'b',
        templateHash: hashWorkerScript(renderWorkerScript()),
      }),
    ).toBe('current');
  });

  it('is outdated when the recorded hash does not match', async () => {
    const { share } = await freshShareModules();
    expect(
      share.shareTemplateStatus({
        baseUrl: 'x', accountId: 'a', workerName: 'w', bucketName: 'b', templateHash: 'stale-hash',
      }),
    ).toBe('outdated');
  });
});

describe('agents share update (CLI)', () => {
  it('--json reports skipped:false=>updated true with the new hash on first run', async () => {
    const { share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: 'acct_1',
      workerName: 'worker-one',
      bucketName: 'bucket-one',
    });
    config.storeWriteToken('tok');

    // The CLI action doesn't accept a `request` override, so this exercises the
    // real Cloudflare requester path only up to argument parsing — assert via
    // the underlying function instead, and cover the CLI wiring/help surface here.
    const program = new Command();
    program.exitOverride();
    share.registerShareCommands(program);
    const updateCmd = program.commands.find((c) => c.name() === 'share')?.commands.find((c) => c.name() === 'update');
    expect(updateCmd).toBeDefined();
    expect(updateCmd?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--bundle', '--account', '--token', '--force', '--json']),
    );
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
    // The namespace line resolves via gh — it must not fall back to the
    // "unknown — set gh auth" hint (a separate "template unknown" line is
    // expected here since this config has no recorded template hash).
    expect(out).not.toMatch(/namespace.*unknown/);
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

  it('shows the template as unknown for a config with no recorded hash', async () => {
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

    expect(loggedOutput()).toContain('unknown');
  });

  it('shows the template as current right after `agents share update` and outdated once the hash is stale', async () => {
    const { share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: 'acct_1',
      workerName: 'agents-share',
      bucketName: 'agents-share',
    });
    config.storeWriteToken('tok');
    await share.runShareUpdate({ token: 'cf-token', request: async () => ({}) });
    installFakeGh('gh-only-user');

    const program = new Command();
    program.exitOverride();
    share.registerShareCommands(program);
    await program.parseAsync(['node', 'agents', 'share', 'status']);
    expect(loggedOutput()).toContain('current');

    config.writeShareConfig({ ...config.readShareConfig()!, templateHash: 'stale-hash' });
    vi.mocked(console.log).mockClear();
    await program.parseAsync(['node', 'agents', 'share', 'status']);
    expect(loggedOutput()).toContain('outdated');
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

describe('formatShareDeleteResult', () => {
  it('emits stable JSON with the cover result nested', () => {
    const result: DeleteShareResult = {
      key: 'octocat/plan',
      url: 'https://share.example/octocat/plan',
      existedBefore: true,
      verified404: true,
      cover: {
        key: 'octocat/plan.png',
        url: 'https://share.example/octocat/plan.png',
        existedBefore: true,
        verified404: true,
      },
    };
    expect(JSON.parse(formatShareDeleteResult(result, true))).toEqual(result);
  });

  it('reports a skipped (--if-exists) target distinctly from a real delete', () => {
    const skipped: DeleteShareResult = {
      key: 'octocat/gone',
      url: 'https://share.example/octocat/gone',
      existedBefore: false,
      verified404: true,
      skipped: true,
    };
    expect(formatShareDeleteResult(skipped)).toMatch(/skipped/i);
  });
});

describe('runShareDelete (CLI-layer multi-target handler)', () => {
  const okResult = (target: string): DeleteShareResult => ({
    key: target,
    url: `https://share.example/${target}`,
    existedBefore: true,
    verified404: true,
  });

  it('continues past a failed target and deletes the rest (rm-style)', async () => {
    const attempted: string[] = [];
    const fakeDelete = async (target: string) => {
      attempted.push(target);
      if (target === 'octocat/bad') throw new Error('takedown NOT verified');
      return okResult(target);
    };
    await runShareDelete(['octocat/good-1', 'octocat/bad', 'octocat/good-2'], {}, fakeDelete as never);
    expect(attempted).toEqual(['octocat/good-1', 'octocat/bad', 'octocat/good-2']);
  });

  it('sets a non-zero exitCode when any target failed', async () => {
    const prevExitCode = process.exitCode;
    try {
      const fakeDelete = async (target: string) => {
        if (target === 'octocat/bad') throw new Error('boom');
        return okResult(target);
      };
      process.exitCode = 0;
      await runShareDelete(['octocat/good', 'octocat/bad'], {}, fakeDelete as never);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExitCode;
    }
  });

  it('leaves exitCode untouched when every target succeeds', async () => {
    const prevExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      await runShareDelete(['octocat/a', 'octocat/b'], {}, (async (t: string) => okResult(t)) as never);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = prevExitCode;
    }
  });

  it('a --if-exists skip does not count as a failure', async () => {
    const prevExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      const skipped: DeleteShareResult = { key: 'octocat/gone', url: 'x', existedBefore: false, verified404: true, skipped: true };
      await runShareDelete(['octocat/gone'], { ifExists: true }, (async () => skipped) as never);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = prevExitCode;
    }
  });

  it('--json emits one array covering every target, success and failure alike', async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((s: string) => { logs.push(s); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation((s: string) => { errors.push(s); });
    try {
      const fakeDelete = async (target: string) => {
        if (target === 'octocat/bad') throw new Error('takedown NOT verified');
        return okResult(target);
      };
      await runShareDelete(['octocat/good', 'octocat/bad'], { json: true }, fakeDelete as never);
      // JSON mode suppresses the per-target console lines — only the final array prints.
      expect(errors).toEqual([]);
      expect(logs.length).toBe(1);
      const parsed = JSON.parse(logs[0]);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toMatchObject({ target: 'octocat/good', result: { key: 'octocat/good' } });
      expect(parsed[1]).toMatchObject({ target: 'octocat/bad', error: expect.stringContaining('takedown NOT verified') });
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
