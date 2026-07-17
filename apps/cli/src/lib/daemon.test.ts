/**
 * Daemon service-manifest generation.
 *
 * The load-bearing security contract under test (RUSH-1759): the Claude OAuth
 * token stored in the `claude` secrets bundle is NEVER written into the launchd
 * plist / systemd unit, even when one is configured — a persisted service
 * manifest is a plaintext credential on disk. The daemon obtains the token at
 * startup from the secure store instead (readDaemonClaudeOAuthToken). The
 * Keychain itself is swapped for an in-memory backend via
 * setKeychainBackendForTest so the generators can be exercised with a token
 * configured and proven to omit it.
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
  getAgentsInvocation,
  getAgentsBinPath,
  startDetached,
  writeOwnerOnlyServiceManifest,
  ensureDaemonStarted,
  isDaemonRunning,
  readDaemonPid,
  writeDaemonPid,
  removeDaemonPid,
} from './daemon.js';
import { ipcEndpoint } from './platform/index.js';

const systemdQuote = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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
    expect(readDaemonClaudeOAuthToken({ allowPrompt: true })).toBe('sk-ant-oat01-abc123');
  });

  it('returns a token stored as a literal (the no-op footgun fix)', () => {
    seedLiteral('sk-ant-oat01-literal');
    expect(readDaemonClaudeOAuthToken({ allowPrompt: true })).toBe('sk-ant-oat01-literal');
  });

  it('trims surrounding whitespace from the stored token', () => {
    seedKeychainBacked('  sk-ant-oat01-abc123\n');
    expect(readDaemonClaudeOAuthToken({ allowPrompt: true })).toBe('sk-ant-oat01-abc123');
  });

  it('treats an empty/whitespace-only token as absent', () => {
    seedKeychainBacked('   ');
    expect(readDaemonClaudeOAuthToken({ allowPrompt: true })).toBeNull();
  });

  it('does not fall through to Keychain when prompting is unavailable', () => {
    seedKeychainBacked('sk-ant-oat01-must-not-be-read');
    expect(readDaemonClaudeOAuthToken({ allowPrompt: false })).toBeNull();
  });
});

describe('writeOwnerOnlyServiceManifest', () => {
  it('creates the file with mode 0600 immediately (no world-readable TOCTOU window)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-daemon-manifest-'));
    const manifestPath = path.join(tmpDir, 'com.agents.daemon.plist');
    writeOwnerOnlyServiceManifest(manifestPath, generateLaunchdPlist());
    expect(fs.existsSync(manifestPath)).toBe(true);
    // NTFS has no POSIX mode bits — the 0o600 lockdown is a no-op on Windows.
    if (process.platform !== 'win32') {
      expect(fs.statSync(manifestPath).mode & 0o777).toBe(0o600);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('re-locks a pre-existing world-readable manifest to 0600 on overwrite', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-daemon-manifest-'));
    const manifestPath = path.join(tmpDir, 'com.agents.daemon.plist');
    // Simulate a stale manifest left world-readable by an older install.
    fs.writeFileSync(manifestPath, 'stale', { mode: 0o644 });
    if (process.platform !== 'win32') {
      fs.chmodSync(manifestPath, 0o644);
      expect(fs.statSync(manifestPath).mode & 0o777).toBe(0o644);
    }
    writeOwnerOnlyServiceManifest(manifestPath, generateLaunchdPlist());
    expect(fs.readFileSync(manifestPath, 'utf-8')).not.toBe('stale');
    // writeFileSync's mode is a no-op when overwriting an existing file, so the
    // unlink-before-create is what forces this back to 0600.
    if (process.platform !== 'win32') {
      expect(fs.statSync(manifestPath).mode & 0o777).toBe(0o600);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('generateLaunchdPlist', () => {
  it('never embeds CLAUDE_CODE_OAUTH_TOKEN, only PATH', () => {
    const plist = generateLaunchdPlist();
    expect(plist).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    // The PATH entry is always present so EnvironmentVariables is never empty.
    expect(plist).toContain('<key>PATH</key>');
    // PATH pins the running Node's bin dir first and drops the stale hardcoded
    // nvm version that bricked the daemon fleet-wide when it was pruned.
    expect(plist).toContain(`<string>${path.dirname(process.execPath)}:`);
    expect(plist).not.toContain('v24.0.0');
  });

  it('omits the token even when one is configured in the claude bundle (RUSH-1759)', () => {
    seedKeychainBacked('sk-ant-oat01-abc123');
    // Sanity: the token IS resolvable — proving the omission below is the
    // generator's doing, not an empty bundle.
    expect(readDaemonClaudeOAuthToken({ allowPrompt: true })).toBe('sk-ant-oat01-abc123');
    const plist = generateLaunchdPlist();
    expect(plist).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(plist).not.toContain('sk-ant-oat01-abc123');
  });
});

describe('generateSystemdUnit', () => {
  it('never embeds a token Environment line, only PATH', () => {
    expect(generateSystemdUnit()).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('omits the token even when one is configured in the claude bundle (RUSH-1759)', () => {
    seedKeychainBacked('sk-ant-oat01-abc123');
    expect(readDaemonClaudeOAuthToken({ allowPrompt: true })).toBe('sk-ant-oat01-abc123');
    const unit = generateSystemdUnit();
    expect(unit).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(unit).not.toContain('sk-ant-oat01-abc123');
  });

  it('pins the running Node bin dir first on PATH and drops the stale hardcoded nvm version', () => {
    const unit = generateSystemdUnit();
    expect(unit).toContain(`Environment=PATH=${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`);
    expect(unit).not.toContain('v24.0.0');
  });

  it('pins a JavaScript install to the Node runtime that installed the service', () => {
    const savedArgv1 = process.argv[1];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents daemon runtime '));
    const indexJs = path.join(tmpDir, 'index.js');
    fs.writeFileSync(indexJs, '');
    process.argv[1] = indexJs;
    try {
      expect(generateSystemdUnit()).toContain(
        `ExecStart=${[process.execPath, indexJs, 'daemon', '_run'].map(systemdQuote).join(' ')}`,
      );
    } finally {
      process.argv[1] = savedArgv1;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('service manifest CLI entry injection', () => {
  it('uses the explicitly installed CLI entry instead of the lifecycle script entry', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-daemon-postinstall-'));
    const installedEntry = path.join(tmpDir, 'dist', 'index.js');
    const postinstallEntry = path.join(tmpDir, 'scripts', 'postinstall.js');
    fs.mkdirSync(path.dirname(installedEntry), { recursive: true });
    fs.mkdirSync(path.dirname(postinstallEntry), { recursive: true });
    fs.writeFileSync(installedEntry, '');
    fs.writeFileSync(postinstallEntry, '');

    const savedArgv1 = process.argv[1];
    process.argv[1] = postinstallEntry;
    try {
      const plist = generateLaunchdPlist(installedEntry);
      const unit = generateSystemdUnit(installedEntry);
      expect(plist).toContain(`<string>${installedEntry}</string>`);
      expect(unit).toContain(systemdQuote(installedEntry));
      expect(plist).not.toContain(postinstallEntry);
      expect(unit).not.toContain(systemdQuote(postinstallEntry));
    } finally {
      process.argv[1] = savedArgv1;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('buildDetachedDaemonEnv', () => {
  it('injects the token when configured and absent from the base env', () => {
    seedKeychainBacked('sk-ant-oat01-detached');
    const env = buildDetachedDaemonEnv(
      { PATH: '/usr/bin' },
      readDaemonClaudeOAuthToken({ allowPrompt: true }),
    );
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

  // The fleet-wide crash-loop: `bin/agents` is a symlink to `dist/index.js`, so
  // an extension check on the *link name* (`agents`) misses it, the daemon runs
  // the shim's shebang, and `env node` lands on a pruned/ancient node.
  it('launches an extension-less symlink to a .js entry through the Node runtime', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-symlink-'));
    const indexJs = path.join(tmpDir, 'index.js');
    fs.writeFileSync(indexJs, '#!/usr/bin/env node\n');
    const link = path.join(tmpDir, 'agents');
    fs.symlinkSync(indexJs, link);
    try {
      const { command, args } = getDaemonLaunch(link);
      expect(command).toBe(process.execPath);
      expect(args).toEqual([link, 'daemon', '_run']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // A real extension-less `#!/usr/bin/env node` shim (dev install) must also be
  // pinned to process.execPath, not run bare off PATH.
  it('launches an extension-less node-shebang shim through the Node runtime', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-shim-'));
    const shim = path.join(tmpDir, 'agents');
    fs.writeFileSync(shim, '#!/usr/bin/env -S node --no-warnings\nrequire("./index.js");\n');
    try {
      const { command, args } = getDaemonLaunch(shim);
      expect(command).toBe(process.execPath);
      expect(args).toEqual([shim, 'daemon', '_run']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // A real compiled binary (no #!node shebang) runs directly — it owns its runtime.
  it('runs a real compiled launcher (no node shebang) directly', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-native-'));
    const bin = path.join(tmpDir, 'agents');
    fs.writeFileSync(bin, '\x7fELF\x02\x01\x01\x00binary-not-a-script');
    try {
      const { command, args } = getDaemonLaunch(bin);
      expect(command).toBe(bin);
      expect(args).toEqual(['daemon', '_run']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('getAgentsInvocation', () => {
  // Regression for the #315 compiled-binary self-spawn bug: teams/message/profiles
  // used to relaunch as `[process.execPath, process.argv[1], …]`. Under the bun
  // standalone binary process.argv[1] is the virtual entry `/$bunfs/root/agents`,
  // so the child became `agents /$bunfs/root/agents …` → "unknown command".
  it('launches a .js entry through the Node runtime', () => {
    const { command, args } = getAgentsInvocation(['run', 'claude'], '/opt/agents/dist/index.js');
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['/opt/agents/dist/index.js', 'run', 'claude']);
  });

  it('runs a native/compiled binary directly — never re-passes a bunfs entry', () => {
    const { command, args } = getAgentsInvocation(['run', 'claude'], '/Users/me/.local/bin/agents');
    expect(command).toBe('/Users/me/.local/bin/agents');
    expect(args).toEqual(['run', 'claude']);
    // The compiled binary is the entry; its own bunfs path must not appear as an arg.
    expect(args.some((a) => a.includes('$bunfs'))).toBe(false);
  });

  it('resolves a bun virtual entry to the real binary (process.execPath), not the un-exec-able $bunfs path', () => {
    const { command, args } = getAgentsInvocation(['run', 'claude'], '/$bunfs/root/agents');
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['run', 'claude']);
    expect(command.includes('$bunfs')).toBe(false);
  });
});

describe('getAgentsBinPath (sibling shim resolution)', () => {
  let savedArgv1: string | undefined;

  beforeEach(() => { savedArgv1 = process.argv[1]; });
  afterEach(() => {
    if (savedArgv1 !== undefined) process.argv[1] = savedArgv1;
  });

  it('resolves compiled browser and computer shims to index.js', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-shim-'));
    fs.writeFileSync(path.join(tmpDir, 'index.js'), '');
    fs.writeFileSync(path.join(tmpDir, 'browser.js'), '');
    fs.writeFileSync(path.join(tmpDir, 'computer.js'), '');
    process.argv[1] = path.join(tmpDir, 'browser.js');
    expect(getAgentsBinPath()).toBe(path.join(tmpDir, 'index.js'));
    process.argv[1] = path.join(tmpDir, 'computer.js');
    expect(getAgentsBinPath()).toBe(path.join(tmpDir, 'index.js'));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves installed browser and computer shims to the agents launcher', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-shim-'));
    fs.writeFileSync(path.join(tmpDir, 'agents'), '');
    fs.writeFileSync(path.join(tmpDir, 'browser'), '');
    fs.writeFileSync(path.join(tmpDir, 'computer'), '');
    process.argv[1] = path.join(tmpDir, 'browser');
    expect(getAgentsBinPath()).toBe(path.join(tmpDir, 'agents'));
    process.argv[1] = path.join(tmpDir, 'computer');
    expect(getAgentsBinPath()).toBe(path.join(tmpDir, 'agents'));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps the main compiled and installed entries unchanged', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-shim-'));
    const indexJs = path.join(tmpDir, 'index.js');
    const agentsBin = path.join(tmpDir, 'agents');
    fs.writeFileSync(indexJs, '');
    fs.writeFileSync(agentsBin, '');
    process.argv[1] = indexJs;
    expect(getAgentsBinPath()).toBe(indexJs);
    process.argv[1] = agentsBin;
    expect(getAgentsBinPath()).toBe(agentsBin);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves a Bun standalone virtual entry to its physical executable', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-bun-standalone-'));
    const physicalBin = path.join(tmpDir, process.platform === 'win32' ? 'agents.exe' : 'agents');
    fs.writeFileSync(physicalBin, '');
    expect(getAgentsBinPath('/$bunfs/root/agents', physicalBin)).toBe(physicalBin);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses a Bun standalone virtual entry without a physical executable', () => {
    const missingBin = path.join(os.tmpdir(), `agents-missing-${process.pid}`);
    expect(() => getAgentsBinPath('/$bunfs/root/agents', missingBin)).toThrow(
      `Cannot resolve agents CLI: Bun standalone executable not found at ${missingBin}`,
    );
  });

  it('refuses a sibling shim when its main entry is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-shim-'));
    const browserJs = path.join(tmpDir, 'browser.js');
    fs.writeFileSync(browserJs, '');
    process.argv[1] = browserJs;
    expect(() => getAgentsBinPath()).toThrow(`main CLI entry not found at ${path.join(tmpDir, 'index.js')}`);
    const browser = path.join(tmpDir, 'browser');
    fs.writeFileSync(browser, '');
    process.argv[1] = browser;
    expect(() => getAgentsBinPath()).toThrow(`main CLI entry not found at ${path.join(tmpDir, 'agents')}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates launchd arguments for the main entry from both shim layouts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-plist-'));
    const indexJs = path.join(tmpDir, 'index.js');
    const browserJs = path.join(tmpDir, 'browser.js');
    const agentsBin = path.join(tmpDir, 'agents');
    const browserBin = path.join(tmpDir, 'browser');
    for (const file of [indexJs, browserJs, agentsBin, browserBin]) fs.writeFileSync(file, '');
    process.argv[1] = browserJs;
    let plist = generateLaunchdPlist();
    expect(plist).toContain(`<string>${process.execPath}</string>`);
    expect(plist).toContain(`<string>${indexJs}</string>`);
    expect(plist).not.toContain(`<string>${browserJs}</string>`);
    process.argv[1] = browserBin;
    plist = generateLaunchdPlist();
    expect(plist).toContain(`<string>${agentsBin}</string>`);
    expect(plist).not.toContain(`<string>${browserBin}</string>`);
    expect(plist).toContain('<string>daemon</string>');
    expect(plist).toContain('<string>_run</string>');
    fs.rmSync(tmpDir, { recursive: true, force: true });
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

    // The daemon's browser IPC binds an AF_UNIX socket at
    // <HOME>/.agents/.cache/helpers/browser/browser.sock. macOS caps AF_UNIX
    // paths at 104 bytes (sun_path); os.tmpdir() there is the long
    // /var/folders/…/T/… (~48 chars), so nesting the socket under it overflows
    // to ~116 chars and bind() fails with EADDRINUSE. Root the fake HOME at a
    // short base on POSIX so the socket path stays well under the limit. Windows
    // uses named pipes (no path-length limit), so os.tmpdir() is fine there.
    const tmpRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    const tmpHome = fs.mkdtempSync(path.join(tmpRoot, 'agd-'));
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

// #414: enforce a single daemon instance and never report a null PID.
//  - A second concurrent `daemon _run` must exit without clobbering the live
//    daemon's pid file (else two schedulers double-fire every routine).
//  - A start that produced no OS pid must fail loudly, never surface null.
describe('daemon single-instance (#414)', () => {
  it('startDetached fails loudly instead of returning a null PID when the binary is unspawnable', () => {
    // A non-JS entry is spawned directly (getDaemonLaunch), so a missing binary
    // makes spawn() yield an undefined pid — the exact `child.pid || null`
    // footgun. Pre-fix this returned { pid: null }; now it throws.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-null-'));
    const logPath = path.join(tmpDir, 'stdio.log');
    expect(() =>
      startDetached({ agentsBin: '/nonexistent/agents-cli-does-not-exist', logPath }),
    ).toThrow(/no PID/i);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses a second concurrent daemon: it exits without clobbering the live pid file', async () => {
    // CI builds before tests; self-heal for a bare `vitest` run.
    if (!fs.existsSync(DIST_ENTRY)) {
      execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
    }

    // Short POSIX base keeps the daemon's AF_UNIX browser socket under the
    // 104-byte sun_path cap (see the integration test above for the rationale).
    const tmpRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    const tmpHome = fs.mkdtempSync(path.join(tmpRoot, 'agd-si-'));
    // Satisfy the setup gate (`ensureInitialized`): ~/.agents/.system must be a repo.
    const systemDir = path.join(tmpHome, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q', systemDir]);

    const pidFile = path.join(tmpHome, '.agents', '.cache', 'helpers', 'daemon', 'daemon.pid');
    const childEnv = { ...process.env, HOME: tmpHome };
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const readPid = () => (fs.existsSync(pidFile) ? parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10) : null);
    const waitFor = async (cond: () => boolean, timeoutMs: number) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (cond()) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return cond();
    };

    let pidA: number | null = null;
    let pidB: number | null = null;
    try {
      // Daemon A comes up and records itself as the pid-file owner.
      pidA = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(tmpHome, 'a.log'), env: childEnv }).pid!;
      expect(pidA).toBeTruthy();
      expect(await waitFor(() => readPid() === pidA, 20_000)).toBe(true);

      // Daemon B — a second concurrent `daemon _run` — must detect A and exit.
      pidB = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(tmpHome, 'b.log'), env: childEnv }).pid!;
      expect(pidB).toBeTruthy();
      expect(pidB).not.toBe(pidA);

      // B exits on its own (claimDaemonInstance() returned false → process.exit(0)).
      expect(await waitFor(() => !alive(pidB!), 20_000)).toBe(true);

      // A never lost ownership of the pid file and is still running.
      expect(readPid()).toBe(pidA);
      expect(alive(pidA)).toBe(true);
    } finally {
      for (const p of [pidA, pidB]) { try { if (p) process.kill(p, 'SIGKILL'); } catch { /* already gone */ } }
      // SIGKILL is async: the kernel delivers it but the daemon can still be
      // mid-write into tmpHome/.agents when we start removing it. Reap both PIDs
      // first, then retry rmSync — otherwise a write landing during the tree walk
      // makes rmdir throw ENOTEMPTY (flaky teardown, unrelated to the assertions).
      for (const p of [pidA, pidB]) { if (p) await waitFor(() => !alive(p), 5_000); }
      for (let attempt = 0; ; attempt++) {
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; }
        catch (err) {
          if (attempt >= 10) throw err;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
  }, 60_000);
});

/**
 * #415: the daemon must be always-on for any background need, not only after
 * `routines add`. `ensureDaemonStarted` is the shared side-effect entrypoint the
 * secrets-unlock path (src/commands/secrets.ts) now calls after bringing up the
 * standalone secrets broker. It must reuse the single `startDaemon` entrypoint,
 * so the #414 single-instance guard makes a second unlock a no-op rather than a
 * relaunch. We seed the pid file with our own (guaranteed-alive) pid so
 * startDaemon takes its already-running branch and never spawns a real daemon.
 */
describe('ensureDaemonStarted (#415: always-on beyond routines)', () => {
  let priorPid: number | null = null;

  beforeEach(() => { priorPid = readDaemonPid(); });
  afterEach(() => {
    // Leave any real daemon on this machine exactly as we found it.
    if (priorPid === null) removeDaemonPid();
    else writeDaemonPid(priorPid);
  });

  it('is an idempotent no-op when a daemon is already running', () => {
    writeDaemonPid(process.pid);
    expect(isDaemonRunning()).toBe(true);

    // First unlock brings the daemon "up" — but it's already running, so this
    // reports the existing owner without spawning a second process.
    const first = ensureDaemonStarted();
    expect(first).not.toBeNull();
    expect(first!.method).toBe('already-running');
    expect(first!.pid).toBe(process.pid);

    // A second unlock (or any later background trigger) is a steady-state
    // no-op, never a relaunch — the always-on guarantee, not a restart loop.
    const second = ensureDaemonStarted();
    expect(second!.method).toBe('already-running');
    expect(second!.pid).toBe(process.pid);

    // The pid file still points at the single owning process throughout.
    expect(readDaemonPid()).toBe(process.pid);
  });
});
