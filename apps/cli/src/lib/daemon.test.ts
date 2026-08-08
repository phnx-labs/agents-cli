/**
 * Daemon service-manifest generation.
 *
 * The load-bearing security contract under test: the service manifest (launchd
 * plist / systemd unit) NEVER embeds a Claude OAuth token — even when one is
 * configured in the `claude` secrets bundle. The daemon holds no Claude
 * credential of its own; routine runs authenticate through the per-account
 * CLAUDE_CONFIG_DIR login on the device. The Keychain is swapped for an
 * in-memory backend via setKeychainBackendForTest so a token can be configured
 * and the generators proven to omit it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';
import * as path from 'path';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  generateLaunchdPlist,
  generateSystemdUnit,
  getDaemonLaunch,
  getAgentsInvocation,
  getAgentsBinPath,
  startDetached,
  startDaemon,
  isDaemonAutostartCircuitOpen,
  DAEMON_AUTOSTART_FAILURE_LIMIT,
  writeOwnerOnlyServiceManifest,
  ensureDaemonStarted,
  isDaemonRunning,
  readDaemonPid,
  writeDaemonPid,
  removeDaemonPid,
  shouldTakeOverBroker,
  schedulerGateTransition,
  anchorDaemonCwd,
  describeEphemeralDaemonRoot,
  warnEphemeralDaemonRoot,
  validateDaemonBinary,
  registerDaemonInstance,
  unregisterDaemonInstance,
  reapStrayDaemons,
  stopResidueArtifacts,
} from './daemon.js';
import { getDaemonDir } from './state.js';
import { readSubsystemHealth, recordSubsystemOk, SUBSYSTEM_DAEMON_START } from './daemon-health.js';
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

  it('omits the token even when one is configured in the claude bundle', () => {
    seedKeychainBacked('sk-ant-oat01-abc123');
    const plist = generateLaunchdPlist();
    expect(plist).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(plist).not.toContain('sk-ant-oat01-abc123');
  });
});

// RUSH-2418: crash-loop prevention had no application-level guarantee at all —
// only the OS supervisor's retry, uncapped. `KeepAlive` with no
// `ThrottleInterval` lets launchd relaunch on its ~10s default, so a daemon that
// dies while booting is restarted six times a minute forever. This is the same
// defect the menu-bar helper already fixed (`menubar/install-menubar.ts:308`,
// pinned by install-menubar.test.ts's "sets a ThrottleInterval so a startup
// crash-loop cannot respawn every 10s"), applied to the daemon's own plist.
describe('generateLaunchdPlist — crash-loop throttle (RUSH-2418)', () => {
  it('sets a ThrottleInterval so a startup crash-loop cannot respawn every 10s', () => {
    const plist = generateLaunchdPlist();
    expect(plist).toContain('<key>ThrottleInterval</key>');
    const seconds = Number(/<key>ThrottleInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist)?.[1]);
    expect(seconds).toBeGreaterThanOrEqual(30);
  });

  it('still keeps the daemon alive and starts it at load', () => {
    const plist = generateLaunchdPlist();
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>RunAtLoad</key>');
  });
});

// The systemd half of the same guarantee. `Restart=always` with no `StartLimit*`
// is an uncapped loop; the burst limit is what lets systemd give up and put the
// unit in `failed` instead of respawning a broken install forever.
describe.skipIf(process.platform === 'win32')('generateSystemdUnit — crash-loop limits (RUSH-2418)', () => {
  it('caps restarts with StartLimitIntervalSec/StartLimitBurst', () => {
    const unit = generateSystemdUnit();
    const interval = Number(/StartLimitIntervalSec=(\d+)/.exec(unit)?.[1]);
    const burst = Number(/StartLimitBurst=(\d+)/.exec(unit)?.[1]);
    expect(interval).toBeGreaterThan(0);
    expect(burst).toBeGreaterThan(0);
    // A cap only caps if the window is long enough to contain the bursts: burst
    // restarts paced by RestartSec must fit inside the interval, else the
    // counter resets before the limit is reached and nothing is bounded.
    const restartSec = Number(/RestartSec=(\d+)/.exec(unit)?.[1]);
    expect(burst * restartSec).toBeLessThanOrEqual(interval);
  });

  it('declares the limits in [Unit], where systemd reads them', () => {
    // StartLimitIntervalSec/StartLimitBurst moved from [Service] to [Unit] in
    // systemd 229. Left in [Service] they are ignored on every modern system —
    // a cap that reads correct and does nothing.
    const unit = generateSystemdUnit();
    const unitSection = unit.slice(unit.indexOf('[Unit]'), unit.indexOf('[Service]'));
    expect(unitSection).toContain('StartLimitIntervalSec=');
    expect(unitSection).toContain('StartLimitBurst=');
  });
});

describe.skipIf(process.platform === 'win32')('generateSystemdUnit', () => {
  it('never embeds a token Environment line, only PATH', () => {
    expect(generateSystemdUnit()).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('omits the token even when one is configured in the claude bundle', () => {
    seedKeychainBacked('sk-ant-oat01-abc123');
    const unit = generateSystemdUnit();
    expect(unit).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(unit).not.toContain('sk-ant-oat01-abc123');
  });

  // Parse the daemon PATH into ordered segments — robust to whatever
  // `process.execPath` is on the runner (CI's Node is /usr/local/bin/node, a dev
  // box's is deep in nvm), so the assertions test the real invariants, not a
  // substring that only holds for one machine's layout.
  const systemdPath = (unit: string): string[] => {
    const m = unit.match(/^Environment=PATH=(.+)$/m);
    if (!m) throw new Error('no PATH line in systemd unit');
    return m[1].split(':');
  };
  const launchdPath = (plist: string): string[] => {
    const m = plist.match(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/);
    if (!m) throw new Error('no PATH in launchd plist');
    return m[1].split(':');
  };

  it('pins the running Node bin dir first on PATH and drops the stale hardcoded nvm version', () => {
    const segs = systemdPath(generateSystemdUnit());
    expect(segs[0]).toBe(path.dirname(process.execPath));
    expect(segs).toEqual(expect.arrayContaining(['/usr/local/bin', '/usr/bin', '/bin']));
    expect(generateSystemdUnit()).not.toContain('v24.0.0');
  });

  it('also puts the agents shim dir on PATH so a child routine resolves `agents` (exit-127 fix)', () => {
    // A shim installed OUTSIDE the Node bin dir — the ~/.local/bin global-install
    // shape that left the daemon PATH carrying only the Node dir, so every
    // `command` routine shelling out to `agents …` died with exit 127.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shim-'));
    const shimDir = path.join(tmpDir, 'local-bin');
    fs.mkdirSync(shimDir, { recursive: true });
    const shim = path.join(shimDir, 'agents');
    fs.writeFileSync(shim, '');
    try {
      const unitSegs = systemdPath(generateSystemdUnit(shim));
      expect(unitSegs[0]).toBe(path.dirname(process.execPath)); // Node still first
      expect(unitSegs).toContain(shimDir); // the shim's dir is now on PATH — the fix
      expect(launchdPath(generateLaunchdPlist(shim))).toContain(shimDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('dedups the whole PATH — no dir appears twice, even for a /usr/local/bin install', () => {
    // Shim beside Node, and (on CI) Node itself in /usr/local/bin: the assembled
    // list collides with the system dirs. Full-list dedup must collapse them.
    const nodeDir = path.dirname(process.execPath);
    const segs = systemdPath(generateSystemdUnit(path.join(nodeDir, 'agents')));
    expect(segs.length).toBe(new Set(segs).size);
    expect(segs[0]).toBe(nodeDir);
  });

  it('pins a JavaScript install to the Node runtime that installed the service', () => {
    const savedArgv1 = process.argv[1];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents daemon runtime '));
    const indexJs = path.join(tmpDir, 'index.js');
    fs.writeFileSync(indexJs, '');
    process.argv[1] = indexJs;
    try {
      expect(generateSystemdUnit()).toContain(
        `ExecStart=${[process.execPath, indexJs, '__daemon-run'].map(systemdQuote).join(' ')}`,
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

describe('getDaemonLaunch', () => {
  // #556: the detached daemon must be launched as `node <entry> __daemon-run`,
  // not by executing the entry path directly. Executing a `.js`/shim path relies
  // on a shebang (POSIX) or a console-owning shell wrapper (Windows); on Windows
  // that wrapper's exit closes its console and tears the daemon down ~36ms after
  // it binds the browser IPC socket.
  it('launches a .js entry through the Node runtime', () => {
    const { command, args } = getDaemonLaunch('/opt/agents/dist/index.js');
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['/opt/agents/dist/index.js', '__daemon-run']);
  });

  it('launches .mjs and .cjs entries through the Node runtime too', () => {
    expect(getDaemonLaunch('/x/index.mjs').command).toBe(process.execPath);
    expect(getDaemonLaunch('/x/index.mjs').args[0]).toBe('/x/index.mjs');
    expect(getDaemonLaunch('/x/index.cjs').command).toBe(process.execPath);
  });

  it('runs a non-JS launcher (resolved shim) directly', () => {
    const { command, args } = getDaemonLaunch('/usr/local/bin/agents');
    expect(command).toBe('/usr/local/bin/agents');
    expect(args).toEqual(['__daemon-run']);
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
      expect(args).toEqual([link, '__daemon-run']);
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
      expect(args).toEqual([shim, '__daemon-run']);
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
      expect(args).toEqual(['__daemon-run']);
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
    expect(plist).toContain('<string>__daemon-run</string>');
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

// RUSH-2417: `agents daemon start` self-contended on its own lock file.
// `startDaemon` (daemon.ts) and the freshly-launched child's
// `claimDaemonInstance` both resolve `getLockPath()` -> `<daemonDir>/daemon.lock`,
// and the launchd/systemd branches busy-waited on `waitForPid(3000)` while STILL
// holding it (release only happened in startDaemon's outer `finally`). The child
// therefore always hit EEXIST against a holder that was alive — the parent CLI —
// and exited with the false "another daemon is mid-takeover" warning, defeating
// the service-manager fast-start path on every fresh install.
//
// The existing last-wins takeover test above calls `startDetached` directly and
// never opens this window, which is why the bug survived it. These drive the REAL
// `startDaemon()` sequence with `systemctl` / `launchctl` shims on PATH: the shim
// launches a stand-in daemon that records whether the start lock was present when
// it went to claim, then writes the pid file the parent is waiting on.
describe('startDaemon (RUSH-2417: the start lock is released before the child-pid wait)', () => {
  let tmpHome = '';
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'agd-2417-'));
    for (const k of ['HOME', 'PATH', 'AGENTS_DAEMON_DIR']) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'a launchd/systemd-shaped start leaves the lock free, so the launched daemon can claim',
    async () => {
      const daemonDir = path.join(tmpHome, 'daemon');
      const shimDir = path.join(tmpHome, 'bin');
      fs.mkdirSync(daemonDir, { recursive: true });
      fs.mkdirSync(shimDir, { recursive: true });

      const lockPath = path.join(daemonDir, 'daemon.lock');
      const pidPath = path.join(daemonDir, 'daemon.pid');
      const resultPath = path.join(tmpHome, 'claim.json');
      const childPath = path.join(tmpHome, 'fake-daemon.mjs');

      // The stand-in daemon: waits well inside the parent's 3s pid wait, records
      // what `claimDaemonInstance` would have seen, then records its pid.
      fs.writeFileSync(childPath, [
        `import fs from 'fs';`,
        `setTimeout(() => {`,
        `  fs.writeFileSync(process.env.AGD_RESULT, JSON.stringify({ lockPresent: fs.existsSync(process.env.AGD_LOCK) }));`,
        `  fs.writeFileSync(process.env.AGD_PID, String(process.pid));`,
        `  setTimeout(() => {}, 3000);`,
        `}, 400);`,
      ].join('\n'), 'utf-8');

      // One shim serves both managers: launch on the arg that actually starts the
      // service (`systemctl --user start`, `launchctl load`), no-op on the rest
      // (`daemon-reload`, `enable`, `unload`), always exit 0.
      const shim = [
        '#!/bin/sh',
        'for a in "$@"; do',
        '  if [ "$a" = "start" ] || [ "$a" = "load" ]; then',
        `    "${process.execPath}" "${childPath}" >/dev/null 2>&1 &`,
        '  fi',
        'done',
        'exit 0',
      ].join('\n');
      for (const name of ['systemctl', 'launchctl']) {
        const p = path.join(shimDir, name);
        fs.writeFileSync(p, shim, 'utf-8');
        fs.chmodSync(p, 0o755);
      }

      process.env.HOME = tmpHome;
      process.env.AGENTS_DAEMON_DIR = daemonDir;
      process.env.PATH = `${shimDir}${path.delimiter}${saved.PATH ?? ''}`;
      process.env.AGD_LOCK = lockPath;
      process.env.AGD_PID = pidPath;
      process.env.AGD_RESULT = resultPath;

      try {
        const res = startDaemon(DIST_ENTRY);
        expect(res.method).toBe(process.platform === 'darwin' ? 'launchd' : 'systemd');
        expect(res.pid).toBeTruthy();

        // The assertion this test exists for: the child saw NO lock file, so its
        // claim would have succeeded. Pre-fix this read `true`.
        const recorded = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
        expect(recorded.lockPresent).toBe(false);

        // ...and the parent left nothing behind for the next start to trip over.
        expect(fs.existsSync(lockPath)).toBe(false);
      } finally {
        for (const k of ['AGD_LOCK', 'AGD_PID', 'AGD_RESULT']) delete process.env[k];
        const pid = fs.existsSync(pidPath) ? parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10) : NaN;
        if (!isNaN(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      }
    },
    30_000,
  );

  // The early release must not reintroduce the race it guards: two concurrent
  // `agents daemon start` invocations must still not both launch. The entry gate
  // is unchanged — a lock held by a LIVE holder still turns the second caller
  // into a waiter rather than a second launcher.
  it.skipIf(process.platform === 'win32')(
    'a concurrent start still defers instead of launching a second daemon',
    () => {
      const daemonDir = path.join(tmpHome, 'daemon');
      fs.mkdirSync(daemonDir, { recursive: true });
      process.env.HOME = tmpHome;
      process.env.AGENTS_DAEMON_DIR = daemonDir;
      // A live holder: this very process, so the stale-lock reclaim can't fire.
      fs.writeFileSync(path.join(daemonDir, 'daemon.lock'), String(process.pid), 'utf-8');

      // No shim on PATH and no service manifest written: reaching a launch at all
      // would be the regression. `already-starting` proves it did not.
      const res = startDaemon(DIST_ENTRY);
      expect(res.method).toBe('already-starting');
      expect(res.pid).toBeNull();
      expect(fs.existsSync(path.join(daemonDir, 'daemon.pid'))).toBe(false);
    },
    15_000,
  );
});

// #414: enforce a single daemon instance and never report a null PID.
//  - A second concurrent `__daemon-run` must exit without clobbering the live
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

  it('last-wins takeover (RUSH-2352): a second daemon evicts the incumbent and becomes the sole owner', async () => {
    // CI builds before tests; self-heal for a bare `vitest` run.
    if (!fs.existsSync(DIST_ENTRY)) {
      execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
    }

    // Short POSIX base keeps the daemon's AF_UNIX browser socket under the
    // 104-byte sun_path cap.
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

      // Daemon B — a second `__daemon-run` — must EVICT A (last-wins), not defer.
      // claimDaemonInstance SIGTERMs A, waits for its graceful shutdown to
      // release its broker socket + browser IPC, then binds and writes its own
      // pid. Exactly one daemon is ever alive.
      pidB = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(tmpHome, 'b.log'), env: childEnv }).pid!;
      expect(pidB).toBeTruthy();
      expect(pidB).not.toBe(pidA);

      // A is evicted and gone; B owns the pid file and keeps running.
      expect(await waitFor(() => !alive(pidA!), 20_000)).toBe(true);
      expect(await waitFor(() => readPid() === pidB, 20_000)).toBe(true);
      expect(alive(pidB)).toBe(true);
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

  // THE CRITICAL REGRESSION TEST (RUSH-2352 correction). The refuted premise of
  // this ticket's original version was that several `__daemon-run` processes on
  // one box proved cross-install duplicate schedulers — when in fact three of the
  // four ran under separate HOMEs (leaked vitest fixtures) and never shared state.
  // A last-wins takeover that widened its blast radius to "every daemon on the
  // box" would make that misreading real: it would start SIGTERMing genuinely
  // separate daemons. This proves the opposite — a daemon serving its OWN state
  // dir is never a takeover or reap target, no matter what else runs on the box.
  it.skipIf(process.platform === 'win32')(
    'DIFFERENT STATE DIR (the regression this correction exists to prevent): a daemon serving its own HOME survives another pair\'s last-wins takeover completely untouched',
    async () => {
      if (!fs.existsSync(DIST_ENTRY)) {
        execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
      }

      const tmpRoot = '/tmp';
      const tmpHomeAB = fs.mkdtempSync(path.join(tmpRoot, 'agd-ds-ab-'));
      const tmpHomeC = fs.mkdtempSync(path.join(tmpRoot, 'agd-ds-c-'));
      for (const home of [tmpHomeAB, tmpHomeC]) {
        const systemDir = path.join(home, '.agents', '.system');
        fs.mkdirSync(systemDir, { recursive: true });
        execFileSync('git', ['init', '-q', systemDir]);
      }

      const pidFileFor = (home: string) => path.join(home, '.agents', '.cache', 'helpers', 'daemon', 'daemon.pid');
      const envFor = (home: string) => {
        const env = { ...process.env, HOME: home };
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
        return env;
      };
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const readPid = (home: string) => {
        const p = pidFileFor(home);
        return fs.existsSync(p) ? parseInt(fs.readFileSync(p, 'utf-8').trim(), 10) : null;
      };
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
      let pidC: number | null = null;
      try {
        // Daemon C — a completely separate state dir, standing in for a
        // developer's own live daemon or another test's leaked fixture (the real
        // shape behind the refuted premise). Started first and ticking through
        // the whole A/B takeover below.
        pidC = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(tmpHomeC, 'c.log'), env: envFor(tmpHomeC) }).pid!;
        expect(pidC).toBeTruthy();
        expect(await waitFor(() => readPid(tmpHomeC) === pidC, 20_000)).toBe(true);

        // Daemon A, then B — last-wins takeover within their OWN (different from
        // C's) state dir, exactly like the LAST-WINS test above.
        pidA = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(tmpHomeAB, 'a.log'), env: envFor(tmpHomeAB) }).pid!;
        expect(pidA).toBeTruthy();
        expect(await waitFor(() => readPid(tmpHomeAB) === pidA, 20_000)).toBe(true);

        pidB = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(tmpHomeAB, 'b.log'), env: envFor(tmpHomeAB) }).pid!;
        expect(pidB).toBeTruthy();
        expect(await waitFor(() => !alive(pidA!), 20_000)).toBe(true);
        expect(await waitFor(() => readPid(tmpHomeAB) === pidB, 20_000)).toBe(true);

        // C — a different state dir entirely — was never a candidate for either
        // claimDaemonInstance's eviction or B's post-claim reapStrayDaemons()
        // sweep: its pid file and its process are both intact throughout.
        expect(readPid(tmpHomeC)).toBe(pidC);
        expect(alive(pidC)).toBe(true);
      } finally {
        for (const p of [pidA, pidB, pidC]) { try { if (p) process.kill(p, 'SIGKILL'); } catch { /* already gone */ } }
        for (const p of [pidA, pidB, pidC]) { if (p) await waitFor(() => !alive(p), 5_000); }
        for (const home of [tmpHomeAB, tmpHomeC]) {
          for (let attempt = 0; ; attempt++) {
            try { fs.rmSync(home, { recursive: true, force: true }); break; }
            catch (err) {
              if (attempt >= 10) throw err;
              await new Promise((r) => setTimeout(r, 100));
            }
          }
        }
      }
    },
    90_000,
  );
});

/**
 * Self-terminate guard (RUSH-2367). A real daemon whose own state dir
 * disappears out from under it — the exact shape of a leaked test fixture
 * whose /tmp HOME got removed while the process itself somehow survived — has
 * no other way to be reached: a different HOME resolves a different
 * getDaemonDir() and therefore a different instance registry, so no `agents
 * daemon` command, reaper, or takeover can ever see it. Real path: spawns the
 * actual built CLI, deletes its HOME while it is running, and asserts the
 * process exits on its own within a bounded time — no mocking of the check.
 */
describe('daemon self-terminate guard on a missing state dir (RUSH-2367)', () => {
  it.skipIf(process.platform === 'win32')(
    'exits on its own once its state dir is deleted, well inside the check interval',
    async () => {
      if (!fs.existsSync(DIST_ENTRY)) {
        execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
      }

      const tmpHome = fs.mkdtempSync(path.join('/tmp', 'agd-selfterm-'));
      const systemDir = path.join(tmpHome, '.agents', '.system');
      fs.mkdirSync(systemDir, { recursive: true });
      execFileSync('git', ['init', '-q', systemDir]);

      const pidFile = path.join(tmpHome, '.agents', '.cache', 'helpers', 'daemon', 'daemon.pid');
      const stateDir = path.dirname(pidFile);
      const lifetimeFile = path.join(stateDir, 'daemon.lifetime');
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

      const childEnv = {
        ...process.env,
        HOME: tmpHome,
        // Poll every 300ms instead of the 60s production default so the test
        // does not need to wait a full minute for the guard to fire.
        AGENTS_DAEMON_STATE_DIR_CHECK_MS: '300',
      };
      delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

      let pid: number | null = null;
      try {
        pid = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(tmpHome, 'daemon.log'), env: childEnv }).pid!;
        expect(pid).toBeTruthy();
        expect(await waitFor(() => readPid() === pid, 20_000)).toBe(true);
        expect(await waitFor(() => fs.existsSync(lifetimeFile), 20_000)).toBe(true);
        expect(alive(pid)).toBe(true);

        // Removing the lifetime marker is the durable effect of deleting and
        // recreating the state tree, without racing live heartbeat writes during
        // recursive removal. Keep the canonical directory present so the old
        // existsSync(dir) guard would stay alive; only the token guard can exit.
        fs.unlinkSync(lifetimeFile);
        expect(fs.existsSync(stateDir)).toBe(true);
        expect(fs.existsSync(lifetimeFile)).toBe(false);

        // The guard polls every 300ms above; give it several cycles of margin.
        expect(await waitFor(() => !alive(pid!), 10_000)).toBe(true);
      } finally {
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
        if (pid) await waitFor(() => !alive(pid!), 5_000);
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* already gone */ }
      }
    },
    30_000,
  );
});

/**
 * stopDaemon postcondition assertion (RUSH-2355 / SING-12). Real path, no
 * mocking: a genuine `__daemon-run` (or a real SIGTERM-ignoring process) is
 * stopped through the actual `agents daemon stop` command in a subprocess under
 * its OWN HOME, so every path constant (pid file, instance registry, browser
 * socket, broker socket, runs dir) resolves inside the temp state dir and the
 * test can never touch a live daemon on the dev machine.
 */
describe('agents daemon stop — asserts its postcondition (RUSH-2355)', () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitFor = async (cond: () => boolean, timeoutMs: number) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return cond();
  };
  const mkHome = () => {
    const home = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'agd-stop-'));
    const systemDir = path.join(home, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q', systemDir]);
    return home;
  };
  const daemonPidFile = (home: string) => path.join(home, '.agents', '.cache', 'helpers', 'daemon', 'daemon.pid');
  const readDaemonPidOf = (home: string) => {
    const p = daemonPidFile(home);
    return fs.existsSync(p) ? parseInt(fs.readFileSync(p, 'utf-8').trim(), 10) : null;
  };
  const envFor = (home: string) => {
    const env = { ...process.env, HOME: home };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.AGENTS_DAEMON_DIR; // let it derive from HOME
    return env;
  };
  const runStop = (home: string) => {
    const r = spawnSync(process.execPath, [DIST_ENTRY, 'daemon', 'stop', '--json'], {
      env: envFor(home), encoding: 'utf-8',
    });
    // The --json action prints only the result object to stdout; be tolerant of
    // any leading banner by slicing to the JSON braces.
    const out = r.stdout || '';
    const first = out.indexOf('{');
    const last = out.lastIndexOf('}');
    const parsed = first >= 0 && last > first ? JSON.parse(out.slice(first, last + 1)) : null;
    return { status: r.status, result: parsed, stdout: out, stderr: r.stderr || '' };
  };
  const rmHome = async (home: string) => {
    for (let attempt = 0; ; attempt++) {
      try { fs.rmSync(home, { recursive: true, force: true }); break; }
      catch (err) { if (attempt >= 10) throw err; await new Promise((r) => setTimeout(r, 100)); }
    }
  };

  it.skipIf(process.platform === 'win32')(
    'clean stop: releases the daemon, exits 0, and REPORTS an in-flight detached child rather than killing it',
    async () => {
      if (!fs.existsSync(DIST_ENTRY)) execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
      const home = mkHome();
      let daemonPid: number | null = null;
      // A real detached routine child in its OWN process group — survives the
      // daemon's death and must be reported, never killed (SING-11a).
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
      child.unref();
      try {
        expect(child.pid).toBeTruthy();
        daemonPid = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(home, 'd.log'), env: envFor(home) }).pid!;
        expect(await waitFor(() => readDaemonPidOf(home) === daemonPid, 20_000)).toBe(true);

        // Seed a `running` run record pointing at the live detached child, under
        // this HOME's runs dir, so the stop's postcondition enumerates it.
        const runDir = path.join(home, '.agents', '.history', 'runs', 'testjob', 'run-1');
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({
          status: 'running', pid: child.pid, agent: 'claude',
          startedAt: new Date().toISOString(), spawnedAt: Date.now(),
        }));

        const { status, result } = runStop(home);
        expect(result).toBeTruthy();
        expect(result.ok).toBe(true);            // every resource released
        expect(status).toBe(0);                  // clean stop exits 0
        expect(result.stoppedPid).toBe(daemonPid);
        expect(result.surviving).toEqual([]);
        expect(result.released).toContain('daemon process');
        expect(result.detachedChildren).toContain(child.pid);

        // The daemon is gone; the detached child was reported, NOT killed.
        expect(await waitFor(() => !alive(daemonPid!), 10_000)).toBe(true);
        expect(alive(child.pid!)).toBe(true);
      } finally {
        try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
        try { if (daemonPid) process.kill(daemonPid, 'SIGKILL'); } catch { /* gone */ }
        for (const p of [child.pid, daemonPid]) { if (p) await waitFor(() => !alive(p), 5_000); }
        await rmHome(home);
      }
    },
    60_000,
  );

  it.skipIf(process.platform === 'win32')(
    'wedged daemon: escalates past the grace window to killTree, then still verifies nothing survives',
    async () => {
      const home = mkHome();
      // A real process that IGNORES SIGTERM and reads as a `__daemon-run` (its
      // argv carries the token, so isDaemonRunProcess matches it) — the wedge the
      // grace→killTree escalation exists for.
      const wedge = spawn(
        process.execPath,
        ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", '__daemon-run'],
        { detached: true, stdio: 'ignore' },
      );
      wedge.unref();
      try {
        expect(wedge.pid).toBeTruthy();
        // Register the wedge as this state dir's daemon (pid file + instance
        // marker), the way a real daemon would, so stop targets it.
        const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
        fs.mkdirSync(path.join(daemonDir, 'instances'), { recursive: true });
        fs.writeFileSync(daemonPidFile(home), String(wedge.pid));
        fs.writeFileSync(path.join(daemonDir, 'instances', String(wedge.pid)), 'node -e ... __daemon-run');

        const started = Date.now();
        const { status, result } = runStop(home);
        const elapsed = Date.now() - started;

        expect(result).toBeTruthy();
        expect(result.escalated).toBe(true);           // SIGTERM ignored → killTree
        expect(elapsed).toBeGreaterThan(4000);         // it waited out the grace window
        expect(result.ok).toBe(true);                  // killTree got it; nothing survives
        expect(result.surviving).toEqual([]);
        expect(status).toBe(0);
        expect(await waitFor(() => !alive(wedge.pid!), 5_000)).toBe(true);
      } finally {
        try { if (wedge.pid) process.kill(wedge.pid, 'SIGKILL'); } catch { /* gone */ }
        if (wedge.pid) await waitFor(() => !alive(wedge.pid!), 5_000);
        await rmHome(home);
      }
    },
    60_000,
  );

  // RUSH-2421: the postcondition covered the two sockets and the process, but
  // not the three state files a graceful handleShutdown removes — the lifetime
  // marker, the heartbeat, and this pid's instance-registry entry. On the
  // ESCALATED path handleShutdown never runs, so all three outlived the daemon
  // while the stop still reported `ok: true`. They are not cosmetic: a leftover
  // heartbeat is what resolveLiveDaemonPid consults to re-adopt a daemon whose
  // pid file is gone, so a dead daemon can read as running.
  it.skipIf(process.platform === 'win32')(
    'killTree path: reclaims the lifetime marker, heartbeat and registry entry the dead daemon left',
    async () => {
      const home = mkHome();
      const wedge = spawn(
        process.execPath,
        ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", '__daemon-run'],
        { detached: true, stdio: 'ignore' },
      );
      wedge.unref();
      try {
        expect(wedge.pid).toBeTruthy();
        const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
        fs.mkdirSync(path.join(daemonDir, 'instances'), { recursive: true });
        fs.writeFileSync(daemonPidFile(home), String(wedge.pid));
        fs.writeFileSync(path.join(daemonDir, 'instances', String(wedge.pid)), 'node -e ... __daemon-run');
        // Exactly what a live daemon writes: `<pid>:<epochMs>` and a fresh
        // heartbeat naming the same pid.
        const lifetimePath = path.join(daemonDir, 'daemon.lifetime');
        const heartbeatPath = path.join(daemonDir, 'heartbeat.json');
        fs.writeFileSync(lifetimePath, `${wedge.pid}:${Date.now()}`);
        fs.writeFileSync(heartbeatPath, JSON.stringify({ lastTick: new Date().toISOString(), pid: wedge.pid }));

        const { result } = runStop(home);

        expect(result.escalated).toBe(true);   // SIGTERM ignored → killTree, no handleShutdown
        expect(result.ok).toBe(true);
        expect(result.surviving).toEqual([]);
        // Every one of the three is reported AND actually gone from disk.
        expect(result.released).toContain('daemon lifetime marker (reclaimed)');
        expect(result.released).toContain('daemon heartbeat (reclaimed)');
        expect(result.released).toContain('daemon instance registry entry (reclaimed)');
        expect(fs.existsSync(lifetimePath)).toBe(false);
        expect(fs.existsSync(heartbeatPath)).toBe(false);
        expect(fs.existsSync(path.join(daemonDir, 'instances', String(wedge.pid)))).toBe(false);
      } finally {
        try { if (wedge.pid) process.kill(wedge.pid, 'SIGKILL'); } catch { /* gone */ }
        if (wedge.pid) await waitFor(() => !alive(wedge.pid!), 5_000);
        await rmHome(home);
      }
    },
    60_000,
  );

  // The other half of the same rule: reclaim only what a provably DEAD owner
  // left. A successor daemon that started during the stop owns a lifetime marker
  // and heartbeat naming ITS live pid, and deleting those would break it — the
  // same reasoning the broker-socket branch uses for a standalone owner.
  it.skipIf(process.platform === 'win32')(
    'never reclaims a lifetime marker or heartbeat owned by a LIVE daemon',
    async () => {
      const home = mkHome();
      // The daemon being stopped: a wedge that ignores SIGTERM.
      const wedge = spawn(
        process.execPath,
        ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", '__daemon-run'],
        { detached: true, stdio: 'ignore' },
      );
      wedge.unref();
      // A different, genuinely live process standing in for a successor. It is
      // NOT a __daemon-run, so it is not a "surviving daemon" — only the owner
      // recorded in the two state files.
      const successor = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
      successor.unref();
      try {
        const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
        fs.mkdirSync(path.join(daemonDir, 'instances'), { recursive: true });
        fs.writeFileSync(daemonPidFile(home), String(wedge.pid));
        const lifetimePath = path.join(daemonDir, 'daemon.lifetime');
        const heartbeatPath = path.join(daemonDir, 'heartbeat.json');
        fs.writeFileSync(lifetimePath, `${successor.pid}:${Date.now()}`);
        fs.writeFileSync(heartbeatPath, JSON.stringify({ lastTick: new Date().toISOString(), pid: successor.pid }));

        const { result } = runStop(home);

        expect(result.released).toContain('daemon lifetime marker (owned by a live daemon)');
        expect(result.released).toContain('daemon heartbeat (owned by a live daemon)');
        // The live owner's state is untouched — reclaiming it would be the bug.
        expect(fs.existsSync(lifetimePath)).toBe(true);
        expect(fs.existsSync(heartbeatPath)).toBe(true);
      } finally {
        for (const p of [wedge.pid, successor.pid]) {
          try { if (p) process.kill(p, 'SIGKILL'); } catch { /* gone */ }
        }
        for (const p of [wedge.pid, successor.pid]) { if (p) await waitFor(() => !alive(p), 5_000); }
        await rmHome(home);
      }
    },
    60_000,
  );

  // THE regression the awaited close introduced (RUSH-2421 review). A browser
  // client holds its IPC connection open on purpose — the socket stays warm
  // between actions — and `net.Server.close()` does not complete while any
  // connection is open. With the close bounded at the SAME 5s as the daemon's
  // SIGTERM grace window, `handleShutdown` was still inside `browserIPC.stop()`
  // when `stopDaemon` gave up waiting and escalated to killTree. Every graceful
  // stop of a daemon with a browser session attached became a kill, and the
  // residue reclamation added by that same change quietly papered over it.
  it.skipIf(process.platform === 'win32')(
    'graceful stop STAYS graceful when a browser client is holding its IPC connection',
    async () => {
      if (!fs.existsSync(DIST_ENTRY)) execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
      const home = mkHome();
      let daemonPid: number | null = null;
      let held: net.Socket | null = null;
      try {
        daemonPid = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(home, 'd.log'), env: envFor(home) }).pid!;
        expect(await waitFor(() => readDaemonPidOf(home) === daemonPid, 20_000)).toBe(true);

        // Wait for the daemon's browser IPC to be accepting, then hold a real
        // connection open exactly as a warm browser client does.
        const sock = path.join(home, '.agents', '.cache', 'helpers', 'browser', 'browser.sock');
        expect(await waitFor(() => fs.existsSync(sock), 20_000)).toBe(true);
        held = net.createConnection(ipcEndpoint(sock));
        await new Promise<void>((resolve, reject) => {
          held!.on('connect', () => resolve());
          held!.on('error', reject);
        });

        const started = Date.now();
        const { status, result } = runStop(home);
        const elapsed = Date.now() - started;

        // The sharp assertion, and the one that is deterministic: the daemon
        // must release and exit WELL inside the 5s SIGTERM grace window. Pre-fix
        // the close waited out its own 5s timeout — the same 5s — so the stop
        // finished at the boundary and whether it escalated was a coin flip
        // decided by which timer fired first. Asserting `escalated === false`
        // alone would therefore pass on the broken code about half the time;
        // asserting the margin is what actually pins the behaviour.
        expect(elapsed).toBeLessThan(4000);
        expect(result.escalated).toBe(false);
        expect(result.ok).toBe(true);
        expect(result.surviving).toEqual([]);
        expect(status).toBe(0);
        // A graceful exit ran handleShutdown, so there is no residue to reclaim
        // — every resource is reported plainly, none "(reclaimed)".
        expect(result.released.filter((r: string) => r.includes('(reclaimed)'))).toEqual([]);
        expect(await waitFor(() => !alive(daemonPid!), 10_000)).toBe(true);
      } finally {
        try { held?.destroy(); } catch { /* already closed */ }
        try { if (daemonPid) process.kill(daemonPid, 'SIGKILL'); } catch { /* gone */ }
        if (daemonPid) await waitFor(() => !alive(daemonPid!), 5_000);
        await rmHome(home);
      }
    },
    60_000,
  );

});

// The other half of the registry rule (RUSH-2421 review). The marker is named by
// pid, so it is unambiguously the stopped daemon's — but it is only RESIDUE once
// that daemon is DEAD. Deleting it while the process still lives erases the very
// record `findSurvivingStateDirDaemons` enumerates, so the NEXT `agents daemon
// stop` finds an empty registry and a cleared pid file and reports `ok: true`
// with the daemon still running.
//
// Tested against the enumerator directly rather than through `agents daemon
// stop`: driving the whole command would require a pid that survives SIGKILL,
// which nothing does, and pointing it at a live pid we control would SIGTERM the
// test runner itself.
describe('stopResidueArtifacts (RUSH-2421: reclaim only what a DEAD owner left)', () => {
  let dir = '';
  let prev: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'agd-res-'));
    prev = process.env.AGENTS_DAEMON_DIR;
    process.env.AGENTS_DAEMON_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENTS_DAEMON_DIR;
    else process.env.AGENTS_DAEMON_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const artifact = (pid: number | null, label: string, survivors: number[] = []) =>
    stopResidueArtifacts(pid, survivors).find((a) => a.label === label)!;

  const seedMarker = (pid: number) => {
    const markerPath = path.join(dir, 'instances', String(pid));
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, 'node ... __daemon-run');
    return markerPath;
  };

  it.skipIf(process.platform === 'win32')('keeps the entry of a daemon the survivor scan still sees', () => {
    const markerPath = seedMarker(4242);
    // The caller's own postcondition scan says this daemon survived the kill.
    const entry = artifact(4242, 'daemon instance registry entry', [4242]);
    expect(entry.present).toBe(true);
    // The fix: a survivor is not residue. Reclaiming here erased the record the
    // NEXT stop reads, so it reported ok:true with the daemon still running.
    expect(entry.ownedByLiveOther).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('reclaims the entry of a daemon that did not survive', () => {
    const markerPath = seedMarker(4242);
    const entry = artifact(4242, 'daemon instance registry entry', []);
    expect(entry.present).toBe(true);
    expect(entry.ownedByLiveOther).toBe(false);
    entry.reclaim();
    expect(entry.stillPresent()).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('treats a ZOMBIE stopped daemon as dead, not alive', () => {
    // A SIGKILLed child stays in the process table until its parent reaps it,
    // and kill(pid, 0) SUCCEEDS on a zombie — so an isAlive-keyed rule kept the
    // entry of a daemon that was already gone. The survivor scan, which matches
    // a live `__daemon-run`, does not include a zombie.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    child.kill('SIGKILL');
    // Do NOT await 'exit' — that reaps it. Poll until it is a zombie: still
    // signalable, but no longer a running process.
    const deadline = Date.now() + 5_000;
    let zombie = false;
    while (Date.now() < deadline && !zombie) {
      try {
        process.kill(pid, 0);
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
        zombie = / Z /.test(stat) || stat.includes(') Z ');
      } catch { break; }
    }
    if (!zombie) return; // /proc unavailable (macOS) — the assertion below is Linux-specific
    expect(() => process.kill(pid, 0)).not.toThrow(); // isAlive() would say "alive"

    const markerPath = seedMarker(pid);
    const entry = artifact(pid, 'daemon instance registry entry', []); // survivor scan: empty
    expect(entry.ownedByLiveOther).toBe(false);
    entry.reclaim();
    expect(fs.existsSync(markerPath)).toBe(false);
  });
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

// RUSH-2418: `daemon-health.ts`'s `consecutiveFailures` was write-only telemetry
// — recorded, surfaced by `agents daemon status`, and consulted by nothing. So a
// daemon that died on boot was relaunched by EVERY foreground command that
// wanted one (secrets unlock, browser start, watchdog, ...): an application-level
// crash loop the OS supervisor's throttle cannot even see, because each attempt
// is a fresh service start rather than a respawn.
//
// This drives the REAL failure path — an unspawnable daemon binary, five times —
// and asserts the sixth AUTO-start refuses while the explicit override still
// runs.
describe('daemon auto-start circuit breaker (RUSH-2418)', () => {
  let tmpHome = '';
  const saved: Record<string, string | undefined> = {};
  const BAD_BIN = '/nonexistent/agents-cli-does-not-exist';

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'agd-2418-'));
    for (const k of ['HOME', 'PATH', 'AGENTS_DAEMON_DIR']) saved[k] = process.env[k];

    // A service-manager shim that always fails, so every start deterministically
    // falls through to the detached spawn — which then fails on the missing
    // binary. No real launchd/systemd unit is ever touched.
    const shimDir = path.join(tmpHome, 'bin');
    fs.mkdirSync(shimDir, { recursive: true });
    for (const name of ['systemctl', 'launchctl']) {
      const p = path.join(shimDir, name);
      fs.writeFileSync(p, '#!/bin/sh\nexit 1\n', 'utf-8');
      fs.chmodSync(p, 0o755);
    }

    process.env.HOME = tmpHome;
    process.env.AGENTS_DAEMON_DIR = path.join(tmpHome, 'daemon');
    process.env.PATH = `${shimDir}${path.delimiter}${saved.PATH ?? ''}`;
    fs.mkdirSync(process.env.AGENTS_DAEMON_DIR, { recursive: true });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // THE case this breaker exists for, and the one an outcome-shaped check
  // cannot see: a daemon binary that SPAWNS FINE and then dies. `startDetached`
  // returns a real `child.pid`, so the launcher has no error to observe — the
  // first version of this fix counted only unspawnable binaries and let ten
  // consecutive crash-loop starts through with the breaker still closed.
  it.skipIf(process.platform === 'win32')(
    'counts a daemon that spawns successfully and then dies — not just an unspawnable binary',
    () => {
      // Exits 0 immediately: a perfectly spawnable binary that never becomes a
      // daemon, i.e. exactly a startup crash loop.
      const dyingBin = path.join(tmpHome, 'dying-daemon.js');
      fs.writeFileSync(dyingBin, 'process.exit(0);\n', 'utf-8');

      for (let i = 1; i <= DAEMON_AUTOSTART_FAILURE_LIMIT; i++) {
        const res = startDaemon(dyingBin);
        expect(res.pid).toBeTruthy(); // the spawn SUCCEEDS — nothing to catch
        expect(readSubsystemHealth(SUBSYSTEM_DAEMON_START)?.consecutiveFailures).toBe(i);
      }
      expect(isDaemonAutostartCircuitOpen()).toBe(true);
      expect(ensureDaemonStarted()).toBeNull();
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'opens after N consecutive failed starts, and the explicit override is still allowed',
    () => {
      // Nothing recorded yet — the breaker must start closed, or a healthy box
      // would never auto-start at all. (Asserted on the predicate rather than by
      // calling ensureDaemonStarted, which would spawn a real daemon here.)
      expect(isDaemonAutostartCircuitOpen()).toBe(false);

      // Each failed start bumps the streak. Loop from 1 so the assertion below
      // proves the counter tracks attempts rather than merely being non-zero.
      for (let i = 1; i <= DAEMON_AUTOSTART_FAILURE_LIMIT; i++) {
        expect(() => startDaemon(BAD_BIN)).toThrow(/no PID/i);
        expect(readSubsystemHealth(SUBSYSTEM_DAEMON_START)?.consecutiveFailures).toBe(i);
      }
      expect(isDaemonAutostartCircuitOpen()).toBe(true);

      // The point of the ticket: the next AUTO-start refuses instead of
      // re-entering the loop, and says where to look.
      const warnings: string[] = [];
      const realWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: any, ...rest: any[]) => {
        warnings.push(String(chunk));
        return (realWrite as any)(chunk, ...rest);
      }) as typeof process.stderr.write;
      try {
        expect(ensureDaemonStarted()).toBeNull();
      } finally {
        process.stderr.write = realWrite;
      }
      expect(warnings.join('')).toMatch(/agents daemon doctor/);

      // ...while `agents daemon start` — the operator's deliberate override —
      // is NOT gated: it still attempts, and still fails loudly on the real
      // cause rather than on the breaker.
      expect(() => startDaemon(BAD_BIN)).toThrow(/no PID/i);

      // An already-live daemon is still reported while the breaker is open — it
      // gates launching one, not answering "is one up?". Without this ordering a
      // stale streak would make a healthy daemon read as absent to every caller
      // that branches on the return value.
      writeDaemonPid(process.pid);
      expect(ensureDaemonStarted()?.method).toBe('already-running');
      removeDaemonPid();

      // A daemon that actually comes up clears the streak — runDaemon records
      // the success side only once it has claimed — so the breaker closes again.
      recordSubsystemOk(SUBSYSTEM_DAEMON_START);
      expect(isDaemonAutostartCircuitOpen()).toBe(false);
    },
    30_000,
  );

  // The third layer (RUSH-2418): `src/index.ts` awaited runDaemon() with no
  // try/catch and there was no `uncaughtException`/`unhandledRejection` handler
  // anywhere in apps/cli/src, so a startup throw died on Node's default handler
  // — a raw stack to whatever the service manager had on stdout, nothing in
  // logs.jsonl, and an exit code that depended on how it died. Drive the real
  // `__daemon-run` entrypoint into a startup failure and assert it now exits
  // non-zero deterministically with a named reason.
  it.skipIf(process.platform === 'win32')(
    'a startup failure exits non-zero with a named reason instead of a raw stack',
    async () => {
      if (!fs.existsSync(DIST_ENTRY)) {
        execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
      }
      // A daemon dir that is a FILE: getDaemonDir()'s mkdirSync throws on the
      // first thing runDaemon does (claimDaemonInstance -> getLockPath).
      const notADir = path.join(tmpHome, 'daemon-dir-is-a-file');
      fs.writeFileSync(notADir, 'not a directory', 'utf-8');

      const env = { ...process.env, HOME: tmpHome, AGENTS_DAEMON_DIR: notADir };
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      const run = spawnSync(process.execPath, [DIST_ENTRY, '__daemon-run'], {
        env, encoding: 'utf-8', timeout: 30_000,
      });

      expect(run.status).toBe(1);
      expect(`${run.stderr}${run.stdout}`).toMatch(/daemon (startup failure|uncaughtException)/);
    },
    45_000,
  );
});

describe('shouldTakeOverBroker (RUSH-1817: daemon self-heals a dead standalone)', () => {
  it('takes over ONLY when not hosting and no healthy broker answers', () => {
    // The regression that wedged secrets on zion: the daemon deferred to a
    // standalone at startup (not hosting) and that standalone later died
    // (unreachable) — the one state where self-heal must fire.
    expect(shouldTakeOverBroker(false, false)).toBe(true);
  });

  it('never takes over while the daemon is already hosting', () => {
    // Our in-process broker is alive as long as the daemon is; re-hosting would
    // fight our own socket. True regardless of the ping result.
    expect(shouldTakeOverBroker(true, false)).toBe(false);
    expect(shouldTakeOverBroker(true, true)).toBe(false);
  });

  it('never clobbers a reachable (healthy) standalone broker', () => {
    expect(shouldTakeOverBroker(false, true)).toBe(false);
  });
});

describe('anchorDaemonCwd', () => {
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    // The tests below chdir into temp dirs (some deleted); restore a valid cwd so
    // later tests and vitest teardown aren't left standing in a dead directory.
    try {
      process.chdir(originalCwd);
    } catch {
      process.chdir(os.homedir());
    }
  });

  // Windows refuses to remove a directory that is a live process's cwd, so the
  // rmSync below throws EBUSY and the test fails on its own setup. That is not a
  // gap in coverage: the state being reproduced — a process standing in a
  // directory that no longer exists — cannot arise on Windows for the same
  // reason. The recovery this asserts is POSIX-only by construction.
  it.skipIf(process.platform === 'win32')('recovers a deleted working directory by anchoring to home', () => {
    // Reproduce the exact routine-outage failure: the daemon is running with its
    // cwd inside a directory (a git worktree, in the real incident) that then gets
    // removed out from under it. A process cannot chdir out of a deleted directory
    // on its own, so every job it spawns inherits the dead cwd and Bun crashes with
    // `ENOENT: Bun could not find a file` at startup. anchorDaemonCwd must recover.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-cwd-'));
    const realTmp = fs.realpathSync(tmp);
    process.chdir(realTmp);
    fs.rmSync(realTmp, { recursive: true, force: true });

    // Sanity: we are genuinely standing in a deleted directory now. On Linux,
    // process.cwd() throws ENOENT here — the precondition of the outage.
    let cwdBroken = false;
    try {
      process.cwd();
    } catch {
      cwdBroken = true;
    }
    expect(cwdBroken).toBe(true);

    const resolved = anchorDaemonCwd();
    expect(resolved).toBe(os.homedir());
    // cwd() must now succeed and point at home — spawns will inherit a live dir.
    expect(fs.realpathSync(process.cwd())).toBe(fs.realpathSync(os.homedir()));
  });

  it('anchors to home even when launched from an unrelated valid directory', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-cwd-')));
    try {
      process.chdir(tmp);
      const resolved = anchorDaemonCwd();
      expect(resolved).toBe(os.homedir());
      expect(fs.realpathSync(process.cwd())).toBe(fs.realpathSync(os.homedir()));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('describeEphemeralDaemonRoot', () => {
  // A daemon launched from an ephemeral path wedges on every dynamic import once
  // that path is removed — the /tmp/rv-head incident. This predicate is what
  // both the launch-time check (validateDaemonBinary) and the runtime startup
  // self-check (warnEphemeralDaemonRoot) share, so it must classify precisely.
  it('flags a git worktree entry', () => {
    expect(describeEphemeralDaemonRoot('/home/u/.agents/worktrees/rv/apps/cli/src/index.ts')).toBe('a git worktree');
  });

  it('flags /tmp and /private/tmp entries (the /tmp/rv-head case)', () => {
    expect(describeEphemeralDaemonRoot('/tmp/rv-head/apps/cli/src/index.ts')).toBe('a temporary directory');
    expect(describeEphemeralDaemonRoot('/private/tmp/rv-head/apps/cli/src/index.ts')).toBe('a temporary directory');
  });

  it('flags macOS /var/folders and linux /dev/shm entries', () => {
    expect(describeEphemeralDaemonRoot('/var/folders/xy/abc/T/build/index.js')).toBe('a temporary directory');
    expect(describeEphemeralDaemonRoot('/private/var/folders/xy/abc/T/build/index.js')).toBe('a temporary directory');
    expect(describeEphemeralDaemonRoot('/dev/shm/build/index.js')).toBe('a temporary directory');
  });

  it('returns null for stable install roots and normal checkouts', () => {
    // Version home (the real install location), a global npm prefix, and an
    // ordinary source checkout under $HOME must NOT be flagged — else every
    // dev run and every install would emit a spurious wedge warning.
    expect(describeEphemeralDaemonRoot('/home/u/.agents/.history/versions/agents/1.20.88/node_modules/@phnx-labs/agents-cli/dist/index.js')).toBeNull();
    expect(describeEphemeralDaemonRoot('/opt/homebrew/lib/node_modules/@phnx-labs/agents-cli/dist/index.js')).toBeNull();
    expect(describeEphemeralDaemonRoot('/home/u/src/github.com/x/agents-cli/apps/cli/src/index.ts')).toBeNull();
    // A directory merely named "tmp" under $HOME is not a temp root (anchored match).
    expect(describeEphemeralDaemonRoot('/home/u/tmp/agents-cli/dist/index.js')).toBeNull();
  });
});

describe('warnEphemeralDaemonRoot', () => {
  // The runtime startup self-check: it must warn (return the message) for an
  // ephemeral launch root, stay silent (null) for a stable one, and never throw
  // — including when the bin resolver itself throws (getAgentsBinPath can, when a
  // shim's main entry is missing). resolveBin is injected so all three branches
  // hit the real code path without mocking the module.
  it('warns for an ephemeral launch root (the /tmp/rv-head case)', () => {
    const msg = warnEphemeralDaemonRoot(() => '/tmp/rv-head/apps/cli/src/index.ts');
    expect(msg).not.toBeNull();
    expect(msg).toContain('a temporary directory');
    expect(msg).toContain('/tmp/rv-head/apps/cli/src/index.ts');
  });

  it('stays silent for a stable version-home launch root', () => {
    expect(
      warnEphemeralDaemonRoot(() => '/home/u/.agents/.history/versions/agents/1.20.88/dist/index.js'),
    ).toBeNull();
  });

  it('is non-fatal when the bin resolver throws', () => {
    let result: string | null = 'sentinel';
    expect(() => {
      result = warnEphemeralDaemonRoot(() => {
        throw new Error('no main CLI entry');
      });
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it('does not throw when resolving the real launch binary', () => {
    // Default resolver (getAgentsBinPath against the live argv[1]) must run
    // through the try without throwing — this is what runDaemon calls at startup.
    expect(() => warnEphemeralDaemonRoot()).not.toThrow();
  });
});

describe('validateDaemonBinary (ephemeral-root warning)', () => {
  it('warns when the daemon binary is under /tmp', () => {
    const { warnings } = validateDaemonBinary('/tmp/rv-head/apps/cli/src/index.ts');
    expect(warnings.some((w) => w.includes('a temporary directory'))).toBe(true);
  });

  it('warns when the daemon binary is inside a git worktree', () => {
    const { warnings } = validateDaemonBinary('/home/u/.agents/worktrees/rv/apps/cli/src/index.ts');
    expect(warnings.some((w) => w.includes('a git worktree'))).toBe(true);
  });

  it('does not emit a wedge warning for a version-home install', () => {
    const { warnings } = validateDaemonBinary('/home/u/.agents/.history/versions/agents/1.20.88/dist/index.js');
    expect(warnings.some((w) => /worktree|temporary directory/.test(w))).toBe(false);
  });
});

describe('schedulerGateTransition (scheduler.enabled re-evaluated on SIGHUP)', () => {
  it('boots the scheduler when the gate flipped on while the daemon ran scheduler-less', () => {
    expect(schedulerGateTransition(false, true)).toBe('boot');
  });

  it('stops a running scheduler when the gate flipped off', () => {
    expect(schedulerGateTransition(true, false)).toBe('stop');
  });

  it('reloads a running scheduler when the gate is unchanged', () => {
    expect(schedulerGateTransition(true, true)).toBe('reload');
  });

  it('stays dark when the gate is off and nothing runs', () => {
    expect(schedulerGateTransition(false, false)).toBe('none');
  });
});

// The instance registry + reaper are POSIX-only (a no-op on Windows), and these
// tests spawn real child processes — so the whole block is macOS/Linux.
describe.skipIf(process.platform === 'win32')(
  'daemon instance registry — one daemon per device, whatever the launch entry',
  () => {
    const instancesDir = (): string => path.join(getDaemonDir(), 'instances');
    const isChildAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const spawned: Array<ReturnType<typeof spawn>> = [];

    afterEach(() => {
      for (const c of spawned) {
        try {
          c.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      spawned.length = 0;
      try {
        fs.rmSync(instancesDir(), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('registerDaemonInstance writes a pid marker; unregister removes it', () => {
      registerDaemonInstance(4242);
      expect(fs.existsSync(path.join(instancesDir(), '4242'))).toBe(true);
      unregisterDaemonInstance(4242);
      expect(fs.existsSync(path.join(instancesDir(), '4242'))).toBe(false);
    });

    it('reaps a live __daemon-run registrant that is neither self nor the pid-file owner', async () => {
      // A daemon spawned from a DIFFERENT launch entry (here: a bare `node`,
      // not the argv[1] path the old reaper matched on) still registers under
      // the shared device daemon dir, so the reaper finds and kills it.
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', '__daemon-run'], {
        stdio: 'ignore',
      });
      spawned.push(child);
      await new Promise((r) => setTimeout(r, 150));
      expect(child.pid).toBeDefined();
      registerDaemonInstance(child.pid!);

      const result = reapStrayDaemons();
      expect(result.reaped).toBe(1);
      expect(fs.existsSync(path.join(instancesDir(), String(child.pid)))).toBe(false);
      await new Promise((r) => setTimeout(r, 250));
      expect(isChildAlive(child.pid!)).toBe(false);
    });

    it('never kills a live pid that is NOT a daemon (pid-reuse guard); only drops the stale marker', async () => {
      const child = spawn('sleep', ['30'], { stdio: 'ignore' });
      spawned.push(child);
      await new Promise((r) => setTimeout(r, 150));
      registerDaemonInstance(child.pid!);

      const result = reapStrayDaemons();
      expect(result.reaped).toBe(0);
      expect(fs.existsSync(path.join(instancesDir(), String(child.pid)))).toBe(false);
      expect(isChildAlive(child.pid!)).toBe(true); // the innocent process is untouched
    });

    it('garbage-collects a marker whose pid is dead, reaping nothing', () => {
      const deadPid = 2147483000 + (process.pid % 1000);
      registerDaemonInstance(deadPid);
      const result = reapStrayDaemons();
      expect(result.reaped).toBe(0);
      expect(fs.existsSync(path.join(instancesDir(), String(deadPid)))).toBe(false);
    });

    it('never reaps this process, even when it is registered', () => {
      registerDaemonInstance(process.pid);
      const result = reapStrayDaemons();
      expect(result.details.some((d) => d.includes(String(process.pid)))).toBe(false);
      expect(isChildAlive(process.pid)).toBe(true);
      unregisterDaemonInstance(process.pid);
    });
  },
);
