/**
 * Daemon service-manifest generation.
 *
 * The load-bearing behavior under test: a long-lived Claude OAuth token stored
 * in the `claude` secrets bundle is baked into the launchd plist / systemd unit
 * environment, so headless routine runs stop depending on the short-lived
 * interactive Keychain OAuth session. The Keychain itself is swapped for an
 * in-memory backend via setKeychainBackendForTest — the contract here is the
 * generator, not the Keychain wiring (that rides the e2e smoke run).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  generateLaunchdPlist,
  generateSystemdUnit,
  readDaemonClaudeOAuthToken,
  buildDetachedDaemonEnv,
  getDaemonLaunch,
  startDetached,
} from './daemon.js';
import { ipcEndpoint } from './platform/index.js';
import {
  secretsKeychainItem,
  setKeychainToken,
  setKeychainBackendForTest,
  type KeychainBackend,
} from './secrets/index.js';
import { writeBundle, deleteBundle } from './secrets/bundles.js';

function makeMemoryBackend(): { backend: KeychainBackend; store: Map<string, string> } {
  const store = new Map<string, string>();
  const backend: KeychainBackend = {
    has: (item) => store.has(item),
    get: (item) => {
      const v = store.get(item);
      if (v === undefined) throw new Error(`Keychain item '${item}' not found.`);
      return v;
    },
    set: (item, value) => { store.set(item, value); },
    delete: (item) => store.delete(item),
    list: (prefix) => Array.from(store.keys()).filter((k) => k.startsWith(prefix)),
  };
  return { backend, store };
}

/** Seed the `claude` bundle with a keychain-backed CLAUDE_CODE_OAUTH_TOKEN. */
function seedKeychainBacked(value: string): void {
  writeBundle({ name: 'claude', vars: { CLAUDE_CODE_OAUTH_TOKEN: 'keychain:CLAUDE_CODE_OAUTH_TOKEN' } });
  setKeychainToken(secretsKeychainItem('claude', 'CLAUDE_CODE_OAUTH_TOKEN'), value);
}

/** Seed the `claude` bundle with a literal CLAUDE_CODE_OAUTH_TOKEN. */
function seedLiteral(value: string): void {
  writeBundle({ name: 'claude', vars: { CLAUDE_CODE_OAUTH_TOKEN: value } });
}

let restore: KeychainBackend | null = null;
let prevNoAgent: string | undefined;

beforeEach(() => {
  const m = makeMemoryBackend();
  restore = setKeychainBackendForTest(m.backend);
  // Hermeticity: readAndResolveBundleEnv consults the running secrets-agent
  // (bundles.ts agentGetSync fast-path) BEFORE the injected keychain backend.
  // On a dev machine where the agent is live and the real `claude` bundle is
  // unlocked, that returns the machine's real CLAUDE_CODE_OAUTH_TOKEN and this
  // test reads a live credential instead of the seeded value (CI has no agent,
  // so it only bites locally). Disable the agent so the read falls through to
  // the in-memory backend above — hermetic regardless of host state.
  prevNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
  process.env.AGENTS_SECRETS_NO_AGENT = '1';
});

afterEach(() => {
  try { deleteBundle('claude'); } catch { /* not created */ }
  setKeychainBackendForTest(restore);
  if (prevNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
  else process.env.AGENTS_SECRETS_NO_AGENT = prevNoAgent;
});

describe('readDaemonClaudeOAuthToken', () => {
  it('returns null when the bundle does not exist', () => {
    expect(readDaemonClaudeOAuthToken()).toBeNull();
  });

  it('returns a keychain-backed token', () => {
    seedKeychainBacked('sk-ant-oat01-abc123');
    expect(readDaemonClaudeOAuthToken()).toBe('sk-ant-oat01-abc123');
  });

  it('returns a token stored as a literal (the no-op footgun fix)', () => {
    seedLiteral('sk-ant-oat01-literal');
    expect(readDaemonClaudeOAuthToken()).toBe('sk-ant-oat01-literal');
  });

  it('trims surrounding whitespace from the stored token', () => {
    seedKeychainBacked('  sk-ant-oat01-abc123\n');
    expect(readDaemonClaudeOAuthToken()).toBe('sk-ant-oat01-abc123');
  });

  it('treats an empty/whitespace-only token as absent', () => {
    seedKeychainBacked('   ');
    expect(readDaemonClaudeOAuthToken()).toBeNull();
  });
});

describe('generateLaunchdPlist', () => {
  it('omits CLAUDE_CODE_OAUTH_TOKEN when none is configured', () => {
    const plist = generateLaunchdPlist();
    expect(plist).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    // The PATH entry is always present so EnvironmentVariables is never empty.
    expect(plist).toContain('<key>PATH</key>');
  });

  it('injects the token into EnvironmentVariables when configured', () => {
    seedKeychainBacked('sk-ant-oat01-abc123');
    const plist = generateLaunchdPlist();
    expect(plist).toContain('<key>CLAUDE_CODE_OAUTH_TOKEN</key>');
    expect(plist).toContain('<string>sk-ant-oat01-abc123</string>');
    // Must sit inside the EnvironmentVariables dict, after PATH.
    const envIdx = plist.indexOf('<key>EnvironmentVariables</key>');
    const tokenIdx = plist.indexOf('<key>CLAUDE_CODE_OAUTH_TOKEN</key>');
    expect(envIdx).toBeGreaterThan(-1);
    expect(tokenIdx).toBeGreaterThan(envIdx);
  });

  it('XML-escapes special characters in the token value', () => {
    seedKeychainBacked('tok&en<x>');
    const plist = generateLaunchdPlist();
    expect(plist).toContain('<string>tok&amp;en&lt;x&gt;</string>');
    expect(plist).not.toContain('<string>tok&en<x></string>');
  });
});

describe('generateSystemdUnit', () => {
  it('omits the token Environment line when none is configured', () => {
    expect(generateSystemdUnit()).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('adds an Environment line for the token when configured', () => {
    seedKeychainBacked('sk-ant-oat01-abc123');
    expect(generateSystemdUnit()).toContain(
      'Environment=CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc123',
    );
  });
});

describe('buildDetachedDaemonEnv', () => {
  it('injects the token when configured and absent from the base env', () => {
    seedKeychainBacked('sk-ant-oat01-detached');
    const env = buildDetachedDaemonEnv({ PATH: '/usr/bin' });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-detached');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('leaves an already-set token untouched (launchd-provided wins)', () => {
    seedKeychainBacked('sk-ant-oat01-fromKeychain');
    const env = buildDetachedDaemonEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fromEnv' });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-fromEnv');
  });

  it('adds no token key when none is configured', () => {
    const env = buildDetachedDaemonEnv({ PATH: '/usr/bin' });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe('getDaemonLaunch', () => {
  // #556: the detached daemon must be launched as `node <entry> daemon _run`,
  // not by executing the entry path directly. Executing a `.js`/shim path relies
  // on a shebang (POSIX) or a console-owning shell wrapper (Windows); on Windows
  // that wrapper's exit closes its console and tears the daemon down ~36ms after
  // it binds the browser IPC socket.
  it('launches a .js entry through the Node runtime', () => {
    const { command, args } = getDaemonLaunch('/opt/agents/dist/index.js');
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['/opt/agents/dist/index.js', 'daemon', '_run']);
  });

  it('launches .mjs and .cjs entries through the Node runtime too', () => {
    expect(getDaemonLaunch('/x/index.mjs').command).toBe(process.execPath);
    expect(getDaemonLaunch('/x/index.mjs').args[0]).toBe('/x/index.mjs');
    expect(getDaemonLaunch('/x/index.cjs').command).toBe(process.execPath);
  });

  it('runs a non-JS launcher (resolved shim) directly', () => {
    const { command, args } = getDaemonLaunch('/usr/local/bin/agents');
    expect(command).toBe('/usr/local/bin/agents');
    expect(args).toEqual(['daemon', '_run']);
  });
});

/** Open a real connection to the daemon endpoint; resolve true only if a
 * process is accepting on it (mirrors the client's own liveness probe). */
function probeEndpoint(endpoint: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(endpoint);
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; sock.destroy(); resolve(ok); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('connect', () => { clearTimeout(timer); finish(true); });
    sock.on('error', () => { clearTimeout(timer); finish(false); });
  });
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');

// #556 / #561 (missing e2e coverage): drive the REAL startDetached path and
// prove the daemon it spawns is always-on — the socket comes up AND is still up
// after >1s, i.e. it did not self-terminate the way the bug report describes
// ("Browser IPC server started" then "Daemon shutting down" ~36ms later).
describe('startDetached (integration: daemon stays alive)', () => {
  it('spawns a detached daemon whose socket comes up and stays up past 1s', async () => {
    // Exercises the built CLI entry the way `browser start` does. CI runs the
    // build before tests; self-heal for a bare `vitest` run without a prior build.
    if (!fs.existsSync(DIST_ENTRY)) {
      execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
    }

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-daemon556-'));
    // Satisfy the setup gate (`ensureInitialized`): ~/.agents/.system must be a repo.
    const systemDir = path.join(tmpHome, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q', systemDir]);

    const logPath = path.join(tmpHome, 'daemon-stdio.log');
    const socketPath = path.join(tmpHome, '.agents', '.cache', 'helpers', 'browser', 'browser.sock');
    const endpoint = ipcEndpoint(socketPath);
    const daemonLog = path.join(tmpHome, '.agents', '.cache', 'helpers', 'daemon', 'logs.jsonl');

    const childEnv = { ...process.env, HOME: tmpHome };
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

    const { pid } = startDetached({ agentsBin: DIST_ENTRY, logPath, env: childEnv });
    expect(pid).toBeTruthy();
    const alive = () => { try { process.kill(pid!, 0); return true; } catch { return false; } };

    try {
      // Wait for the browser IPC socket to accept connections (issue: ~400ms).
      let up = false;
      for (let i = 0; i < 80 && !up; i++) {
        up = await probeEndpoint(endpoint);
        if (!up) await new Promise((r) => setTimeout(r, 100));
      }
      expect(up).toBe(true);

      // The crux of #556: it must NOT tear itself down. Wait well past the 36ms
      // window and re-probe.
      await new Promise((r) => setTimeout(r, 1500));
      expect(await probeEndpoint(endpoint)).toBe(true);
      expect(alive()).toBe(true);

      // The daemon's own structured log confirms it came up and never shut down.
      const logText = fs.existsSync(daemonLog) ? fs.readFileSync(daemonLog, 'utf-8') : '';
      expect(logText).toContain('Browser IPC server started');
      expect(logText).not.toContain('Daemon shutting down');
    } finally {
      try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 30_000);
});
