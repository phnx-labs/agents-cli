import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENTS, ALL_AGENT_IDS, deprecationNotice, getAccountInfo, resolveAgentName, resolveLastActive, warnAgentDeprecated } from './agents.js';
import { IS_WINDOWS } from './platform/index.js';
import type { CapabilityName } from './types.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-agents-'));
  tempDirs.push(dir);
  return dir;
}

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function writeArgLogger(dir: string): { binary: string; logPath: string } {
  const binary = path.join(dir, 'fake-agent');
  const logPath = path.join(dir, 'argv.log');
  fs.writeFileSync(
    binary,
    [
      '#!/bin/sh',
      `LOG_FILE=${shSingleQuote(logPath)}`,
      'printf "HOME:%s\\n" "$HOME" >> "$LOG_FILE"',
      'for arg do',
      '  printf "ARG:%s\\n" "$arg" >> "$LOG_FILE"',
      'done',
      '',
    ].join('\n'),
    'utf-8'
  );
  fs.chmodSync(binary, 0o755);
  return { binary, logPath };
}

function runAgentsModule(expression: string): unknown {
  const moduleUrl = pathToFileURL(path.resolve('dist/lib/agents.js')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { registerMcp, unregisterMcp } from ${JSON.stringify(moduleUrl)};
    const result = await ${expression};
    console.log(JSON.stringify(result));
  `], {
    env: { ...process.env },
    encoding: 'utf-8',
  });

  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// These prove the SOURCE passes MCP commands as an argv array (never a shell
// string), so injection payloads like `; touch pwned` stay inert. The proof
// relies on a `#!/bin/sh` argv-logger fake that records each arg — a POSIX-only
// mechanism (no shebang/argv-logger on Windows, where the agent CLI is a `.cmd`
// reached through cmd.exe). The argv-safety property itself is platform-agnostic
// (execFileAsync with an array), but it can only be asserted via the sh fake, so
// these run on POSIX. registerMcp's Windows spawn path is hardened in agents.ts.
describe.skipIf(IS_WINDOWS)('MCP CLI execution', () => {
  it('registers MCP servers with argv, not a shell command string', async () => {
    const dir = makeTempDir();
    const { binary, logPath } = writeArgLogger(dir);
    const pwnedPath = path.join(dir, 'pwned');

    const result = runAgentsModule(
      `registerMcp('codex', ${JSON.stringify(`demo; touch ${pwnedPath}`)}, ${JSON.stringify(`/bin/echo; touch ${pwnedPath}`)}, 'user', 'stdio', { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)} })`
    ) as { success: boolean };

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(fs.existsSync(pwnedPath)).toBe(false);
    expect(log).toContain(`HOME:${dir}`);
    expect(log).toContain('ARG:mcp\nARG:add');
    expect(log).toContain(`ARG:demo; touch ${pwnedPath}`);
    expect(log).toContain('ARG:/bin/echo;');
    expect(log).toContain('ARG:touch');
    expect(log).toContain(`ARG:${pwnedPath}`);
  });

  it('removes MCP servers with argv, not a shell command string', async () => {
    const dir = makeTempDir();
    const { binary, logPath } = writeArgLogger(dir);
    const pwnedPath = path.join(dir, 'pwned');

    const result = runAgentsModule(
      `unregisterMcp('codex', ${JSON.stringify(`demo"; touch ${pwnedPath}`)}, { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)} })`
    ) as { success: boolean };

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(fs.existsSync(pwnedPath)).toBe(false);
    expect(log).toContain('ARG:mcp\nARG:remove');
    expect(log).toContain(`ARG:demo"; touch ${pwnedPath}`);
  });

  it('preserves quoted MCP command arguments without invoking a shell', async () => {
    const dir = makeTempDir();
    const { binary, logPath } = writeArgLogger(dir);

    const result = runAgentsModule(
      `registerMcp('claude', 'demo', 'node -e "console.log(1)"', 'project', 'stdio', { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)} })`
    ) as { success: boolean };

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(log).toContain('ARG:--transport\nARG:stdio\nARG:--scope\nARG:project');
    expect(log).toContain('ARG:node');
    expect(log).toContain('ARG:-e');
    expect(log).toContain('ARG:console.log(1)');
  });

  it('registers Claude HTTP MCP servers with native transport args and headers', async () => {
    const dir = makeTempDir();
    const { binary, logPath } = writeArgLogger(dir);

    const result = runAgentsModule(
      `registerMcp('claude', 'docs', 'https://developers.openai.com/mcp', 'user', 'http', { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)}, headers: { Authorization: 'Bearer token' } })`
    ) as { success: boolean };

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(log).toContain('ARG:--transport\nARG:http\nARG:--scope\nARG:user');
    expect(log).toContain('ARG:docs\nARG:https://developers.openai.com/mcp');
    expect(log).toContain('ARG:--header\nARG:Authorization: Bearer token');
    expect(log).not.toContain('ARG:--\n');
  });

  it('registers Codex HTTP MCP servers with --url', async () => {
    const dir = makeTempDir();
    const { binary, logPath } = writeArgLogger(dir);

    const result = runAgentsModule(
      `registerMcp('codex', 'docs', 'https://developers.openai.com/mcp', 'user', 'http', { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)} })`
    ) as { success: boolean };

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(log).toContain('ARG:mcp\nARG:add\nARG:docs\nARG:--url\nARG:https://developers.openai.com/mcp');
    expect(log).not.toContain('ARG:--\n');
  });

  it('registers Gemini HTTP MCP servers with native transport args', async () => {
    const dir = makeTempDir();
    const { binary, logPath } = writeArgLogger(dir);

    const result = runAgentsModule(
      `registerMcp('gemini', 'docs', 'https://developers.openai.com/mcp', 'project', 'http', { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)} })`
    ) as { success: boolean };

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(log).toContain('ARG:--transport\nARG:http\nARG:--scope\nARG:project');
    expect(log).toContain('ARG:docs\nARG:https://developers.openai.com/mcp');
    expect(log).not.toContain('ARG:--\n');
  });

  it('skips HTTP MCP registration for agents without native HTTP support', async () => {
    const dir = makeTempDir();
    const { binary } = writeArgLogger(dir);

    const result = runAgentsModule(
      `registerMcp('cursor', 'docs', 'https://developers.openai.com/mcp', 'user', 'http', { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)} })`
    ) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe('skipped: agent does not support HTTP MCP registration');
  });
});

describe('AGENTS capability matrix', () => {
  it('declares every gateable resource capability for every agent', () => {
    const requiredCapabilities: CapabilityName[] = [
      'hooks',
      'mcp',
      'allowlist',
      'skills',
      'commands',
      'plugins',
      'subagents',
      'rules',
      'workflows',
    ];

    for (const [agentId, config] of Object.entries(AGENTS)) {
      for (const capability of requiredCapabilities) {
        expect(config.capabilities, `${agentId} missing ${capability}`).toHaveProperty(capability);
      }
    }
  });
});

describe('resolveLastActive', () => {
  function makeClaudeHome(sessionMtimeSec?: number): string {
    const home = makeTempDir();
    const projects = path.join(home, '.claude', 'projects', 'some-project');
    fs.mkdirSync(projects, { recursive: true });
    if (sessionMtimeSec !== undefined) {
      const session = path.join(projects, 'session.jsonl');
      fs.writeFileSync(session, '{}', 'utf-8');
      fs.utimesSync(session, sessionMtimeSec, sessionMtimeSec);
    }
    return home;
  }

  function cacheFile(): string {
    return path.join(makeTempDir(), 'last-active.json');
  }

  it('returns the newest session mtime and persists it to the cache', () => {
    const home = makeClaudeHome(5_000);
    const cachePath = cacheFile();

    const result = resolveLastActive('claude', home, undefined, cachePath);
    expect(result?.getTime()).toBe(5_000_000);

    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    expect(cache[`claude:${home}`]).toEqual({ mtimeMs: 5_000_000, computedAt: expect.any(Number) });
  });

  it('serves from cache within the fresh window instead of re-walking', () => {
    const home = makeClaudeHome(5_000);
    const cachePath = cacheFile();
    const t0 = new Date('2026-06-11T00:00:00Z');

    expect(resolveLastActive('claude', home, undefined, cachePath, t0)?.getTime()).toBe(5_000_000);

    // A newer session appears, but the cache is still fresh — the cached
    // value must win, proving the walk was skipped.
    const newer = path.join(home, '.claude', 'projects', 'some-project', 'newer.jsonl');
    fs.writeFileSync(newer, '{}', 'utf-8');
    fs.utimesSync(newer, 9_000, 9_000);

    const within = new Date(t0.getTime() + 60_000);
    expect(resolveLastActive('claude', home, undefined, cachePath, within)?.getTime()).toBe(5_000_000);

    // Past the fresh window the walk runs again and picks up the newer file.
    const beyond = new Date(t0.getTime() + 3 * 60_000);
    expect(resolveLastActive('claude', home, undefined, cachePath, beyond)?.getTime()).toBe(9_000_000);
  });

  it('falls back to config mtime when the home has no sessions, including via a fresh null entry', () => {
    const home = makeClaudeHome();
    const cachePath = cacheFile();
    const config = path.join(home, '.claude.json');
    fs.writeFileSync(config, '{}', 'utf-8');
    fs.utimesSync(config, 7_000, 7_000);
    const t0 = new Date('2026-06-11T00:00:00Z');

    expect(resolveLastActive('claude', home, config, cachePath, t0)?.getTime()).toBe(7_000_000);
    // Second call hits the fresh null entry and must still fall through to config mtime.
    const within = new Date(t0.getTime() + 60_000);
    expect(resolveLastActive('claude', home, config, cachePath, within)?.getTime()).toBe(7_000_000);
  });

  it('treats a corrupt cache file as empty and recomputes', () => {
    const home = makeClaudeHome(5_000);
    const cachePath = cacheFile();
    fs.writeFileSync(cachePath, 'not json', 'utf-8');

    expect(resolveLastActive('claude', home, undefined, cachePath)?.getTime()).toBe(5_000_000);
  });
});

describe('resolveLastActive cache pruning', () => {
  it('drops stale entries for other homes on write', () => {
    const home = path.join(makeTempDir(), 'live-home');
    const projects = path.join(home, '.claude', 'projects', 'p');
    fs.mkdirSync(projects, { recursive: true });
    const session = path.join(projects, 's.jsonl');
    fs.writeFileSync(session, '{}', 'utf-8');
    fs.utimesSync(session, 5_000, 5_000);

    const cachePath = path.join(makeTempDir(), 'last-active.json');
    const t0 = new Date('2026-06-11T00:00:00Z');
    fs.writeFileSync(cachePath, JSON.stringify({
      'claude:/gone/stale-home': { mtimeMs: 1_000, computedAt: t0.getTime() - 10 * 60_000 },
      'claude:/gone/fresh-home': { mtimeMs: 2_000, computedAt: t0.getTime() - 30_000 },
    }), 'utf-8');

    resolveLastActive('claude', home, undefined, cachePath, t0);

    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    expect(Object.keys(cache).sort()).toEqual([`claude:${home}`, 'claude:/gone/fresh-home'].sort());
  });
});

describe('resolveAgentName', () => {
  it('resolves every canonical id, including ones missing from the alias map', () => {
    for (const id of ALL_AGENT_IDS) {
      expect(resolveAgentName(id), `canonical id ${id}`).toBe(id);
    }
  });

  it('resolves aliases and shorthands case-insensitively', () => {
    expect(resolveAgentName('claude-code')).toBe('claude');
    expect(resolveAgentName('cc')).toBe('claude');
    expect(resolveAgentName('CLAUDE')).toBe('claude');
    expect(resolveAgentName('kimi-code')).toBe('kimi');
  });

  it('corrects a single typo against canonical ids', () => {
    expect(resolveAgentName('cladue')).toBe('claude'); // transposition
    expect(resolveAgentName('claud')).toBe('claude'); // deletion
    expect(resolveAgentName('clude')).toBe('claude'); // deletion
    expect(resolveAgentName('codx')).toBe('codex');
    expect(resolveAgentName('kim')).toBe('kimi');
    expect(resolveAgentName('gemni')).toBe('gemini');
    expect(resolveAgentName('grook')).toBe('grok');
  });

  it('corrects a single typo against multi-letter aliases', () => {
    expect(resolveAgentName('clw')).toBe('openclaw'); // claw minus a letter
  });

  it('returns null when the correction is ambiguous', () => {
    // 'kiri' is one edit from both kiro and kimi
    expect(resolveAgentName('kiri')).toBeNull();
  });

  it('returns null for short or unrecognizable input', () => {
    expect(resolveAgentName('cl')).toBeNull();
    expect(resolveAgentName('gpt')).toBeNull();
    expect(resolveAgentName('')).toBeNull();
    expect(resolveAgentName('definitely-not-an-agent')).toBeNull();
  });
});

/** Encode a minimal JWT (only the payload segment is ever decoded). */
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

// Write a Droid credential the way the CLI does: a JSON blob (with a WorkOS
// access_token JWT) encrypted AES-256-GCM as `ivB64:tagB64:ctB64`, keyed by the
// base64 contents of auth.v2.key. Uses real crypto — no mocking.
function writeDroidCredential(dir: string, claims: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const credential = JSON.stringify({
    access_token: makeJwt(claims),
    refresh_token: 'rt',
    active_organization_id: 'org_local',
  });
  const ct = Buffer.concat([cipher.update(credential, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = [iv, tag, ct].map((b) => b.toString('base64')).join(':');
  fs.writeFileSync(path.join(dir, 'auth.v2.file'), blob, 'utf-8');
  fs.writeFileSync(path.join(dir, 'auth.v2.key'), key.toString('base64'), 'utf-8');
}

describe('getAccountInfo — token-only agents (no local email)', () => {
  // Sign-in is account-global: getAccountInfo falls back from the passed
  // per-version home to the active config under AGENTS_REAL_HOME. Pin that to a
  // fresh empty dir so "signed out" assertions don't leak into the developer's
  // real ~/.factory / ~/.kimi-code / ~/.gemini login (RUSH-1318 fallback).
  // Antigravity on macOS stores its token in the real keychain, which can't be
  // sandboxed per-test — opt out of the probe so "signed out" is hermetic.
  let prevRealHome: string | undefined;
  let prevNoKeychain: string | undefined;
  beforeEach(() => {
    prevRealHome = process.env.AGENTS_REAL_HOME;
    process.env.AGENTS_REAL_HOME = makeTempDir();
    prevNoKeychain = process.env.AGENTS_NO_KEYCHAIN_PROBE;
    process.env.AGENTS_NO_KEYCHAIN_PROBE = '1';
  });
  afterEach(() => {
    if (prevRealHome === undefined) delete process.env.AGENTS_REAL_HOME;
    else process.env.AGENTS_REAL_HOME = prevRealHome;
    if (prevNoKeychain === undefined) delete process.env.AGENTS_NO_KEYCHAIN_PROBE;
    else process.env.AGENTS_NO_KEYCHAIN_PROBE = prevNoKeychain;
  });

  it('marks Antigravity signed in when a refresh token is present', async () => {
    const home = makeTempDir();
    const dir = path.join(home, '.gemini', 'antigravity-cli');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'antigravity-oauth-token'),
      JSON.stringify({
        token: { access_token: 'ya29.expired', refresh_token: '1//refresh', token_type: 'Bearer' },
        auth_method: 'consumer',
      }),
      'utf-8'
    );

    const info = await getAccountInfo('antigravity', home);
    expect(info.signedIn).toBe(true);
    // Consumer Google OAuth exposes no email/identity claim locally.
    expect(info.email).toBeNull();
  });

  it('treats Antigravity as signed out when the token file is missing', async () => {
    const info = await getAccountInfo('antigravity', makeTempDir());
    expect(info.signedIn).toBe(false);
    expect(info.email).toBeNull();
  });

  it('treats Antigravity as signed out when the token carries no refresh token', async () => {
    const home = makeTempDir();
    const dir = path.join(home, '.gemini', 'antigravity-cli');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'antigravity-oauth-token'),
      JSON.stringify({ token: { access_token: 'ya29.x' } }),
      'utf-8'
    );
    const info = await getAccountInfo('antigravity', home);
    expect(info.signedIn).toBe(false);
  });

  it('marks Kimi signed in and derives a stable account key from the JWT user_id', async () => {
    const home = makeTempDir();
    const dir = path.join(home, '.kimi-code', 'credentials');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'kimi-code.json'),
      JSON.stringify({
        access_token: makeJwt({ user_id: 'd483kfq783mkn8of1gtg', sub: 'd483kfq783mkn8of1gtg', scope: 'kimi-code' }),
        refresh_token: makeJwt({ type: 'refresh' }),
        token_type: 'Bearer',
      }),
      'utf-8'
    );

    const info = await getAccountInfo('kimi', home);
    expect(info.signedIn).toBe(true);
    expect(info.email).toBeNull();
    expect(info.accountId).toBe('d483kfq783mkn8of1gtg');
    expect(info.accountKey).toBe('kimi:user=d483kfq783mkn8of1gtg');
  });

  it('treats Kimi as signed out when the credentials file is missing', async () => {
    const info = await getAccountInfo('kimi', makeTempDir());
    expect(info.signedIn).toBe(false);
  });

  it('decrypts auth.v2.file and surfaces the email + org from the WorkOS JWT', async () => {
    const home = makeTempDir();
    writeDroidCredential(path.join(home, '.factory'), {
      email: 'muqsit@getrush.ai',
      org_id: 'org_abc',
      role: 'owner',
      first_name: 'Muqsit',
    });

    const info = await getAccountInfo('droid', home);
    expect(info.signedIn).toBe(true);
    expect(info.email).toBe('muqsit@getrush.ai');
    expect(info.organizationId).toBe('org_abc');
    expect(info.accountKey).toBe('droid:org=org_abc');
  });

  it('falls back to signed-in with no email when the blob cannot be decrypted', async () => {
    const home = makeTempDir();
    const dir = path.join(home, '.factory');
    fs.mkdirSync(dir, { recursive: true });
    // Garbage blob with no matching key file: decrypt fails, but the auth file's
    // presence still reads as signed in (the conservative floor).
    fs.writeFileSync(path.join(dir, 'auth.v2.file'), 'opaque-encrypted-blob', 'utf-8');

    const info = await getAccountInfo('droid', home);
    expect(info.signedIn).toBe(true);
    expect(info.email).toBeNull();
  });

  it('treats Droid as signed out when the auth file is missing', async () => {
    const info = await getAccountInfo('droid', makeTempDir());
    expect(info.signedIn).toBe(false);
    expect(info.email).toBeNull();
  });
});

describe('agent deprecation warnings', () => {
  it('marks gemini deprecated by Google with a dated notice and antigravity successor', () => {
    const dep = AGENTS.gemini.deprecated;
    expect(dep).toBeDefined();
    expect(dep?.by).toBe('Google');
    expect(dep?.date).toBe('June 18, 2026');
    expect(dep?.replacement).toBe('antigravity');
  });

  it('builds a notice whose header names the agent, vendor, and date and points at the successor', () => {
    const lines = deprecationNotice('gemini');
    expect(lines).not.toBeNull();
    expect(lines![0]).toBe('Warning: Gemini was deprecated by Google (June 18, 2026).');
    // The successor line uses the replacement's display name + install command, not a hardcoded string.
    expect(lines!.some((l) => l.includes('Consider using Antigravity instead:  agents add antigravity'))).toBe(true);
    expect(lines!.some((l) => l.includes('developers.googleblog.com'))).toBe(true);
  });

  it('returns null for agents that are not deprecated', () => {
    for (const id of ALL_AGENT_IDS) {
      if (id === 'gemini') continue;
      expect(deprecationNotice(id)).toBeNull();
    }
    // Sanity: only gemini carries a marker today, so exactly one agent warns.
    const deprecated = ALL_AGENT_IDS.filter((id) => AGENTS[id].deprecated);
    expect(deprecated).toEqual(['gemini']);
  });

  it('warnAgentDeprecated prints the gemini notice and stays silent for others', () => {
    const printed: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { printed.push(args.join(' ')); };
    try {
      warnAgentDeprecated('claude');
      expect(printed).toHaveLength(0);
      warnAgentDeprecated('gemini');
    } finally {
      console.log = original;
    }
    expect(printed.length).toBeGreaterThan(0);
    // chalk wraps in ANSI codes; assert the visible substring survives.
    expect(printed.join('\n')).toContain('was deprecated by Google');
  });
});

describe('getAccountInfo — grok (nested auth.json)', () => {
  // Isolate the HOME fallback so a missing fixture doesn't read the dev's real ~/.grok.
  let prevRealHome: string | undefined;
  beforeEach(() => { prevRealHome = process.env.AGENTS_REAL_HOME; process.env.AGENTS_REAL_HOME = makeTempDir(); });
  afterEach(() => {
    if (prevRealHome === undefined) delete process.env.AGENTS_REAL_HOME;
    else process.env.AGENTS_REAL_HOME = prevRealHome;
  });

  it('reads the nested "<issuer>::<client_id>" record — signed in with email + ids', async () => {
    const home = makeTempDir();
    const dir = path.join(home, '.grok');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
      'https://auth.x.ai::abc-123': {
        email: 'muqsitnawaz@icloud.com',
        user_id: '5b5643da',
        team_id: '4af61418',
        refresh_token: 'rt_xxx',
        create_time: '2026-07-01T03:11:20Z',
        auth_mode: 'oidc',
      },
    }));

    const info = await getAccountInfo('grok', home);
    expect(info.signedIn).toBe(true);
    expect(info.email).toBe('muqsitnawaz@icloud.com');
    expect(info.accountId).toBe('5b5643da');
  });

  it('picks the newest record when multiple providers are present', async () => {
    const home = makeTempDir();
    const dir = path.join(home, '.grok');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
      old: { email: 'old@x.ai', refresh_token: 'a', create_time: '2026-01-01T00:00:00Z' },
      new: { email: 'new@x.ai', refresh_token: 'b', create_time: '2026-07-01T00:00:00Z' },
    }));
    const info = await getAccountInfo('grok', home);
    expect(info.email).toBe('new@x.ai');
  });

  it('treats grok as signed out when auth.json is absent', async () => {
    const info = await getAccountInfo('grok', makeTempDir());
    expect(info.signedIn).toBe(false);
  });
});
