import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { renderLeasedBoxesSection, raceFleetPingDeadline } from './ssh.js';
import type { CrabboxBox } from '../lib/crabbox/cli.js';
import { fanOutDevices, type FanOutDeviceTarget } from '../lib/devices/fleet.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome = '';

// On macOS, seeding a bundle via `secrets create --backend file` stores its
// metadata in the Keychain, which needs the signed `Agents CLI.app` helper.
// GitHub macOS CI can't codesign that helper, so a fresh CLI subprocess fails
// with "Source Agents CLI.app not found". Skip helper-dependent subprocess
// tests when the helper bundle is absent (its resolver paths, per
// install-helper.ts: dist/lib/secrets sibling or <repo>/bin). Linux has no
// keychain gate; local macOS with the helper installed also runs.
const keychainHelperAvailable =
  process.platform !== 'darwin' ||
  fs.existsSync(path.resolve(__dirname, '../lib/secrets/Agents CLI.app')) ||
  fs.existsSync(path.resolve(__dirname, '../../bin/Agents CLI.app')) ||
  fs.existsSync(path.resolve(__dirname, '../../dist/lib/secrets/Agents CLI.app'));

afterEach(() => {
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
  testHome = '';
});

function guardedHome(): void {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devices-home-'));
  const systemDir = path.join(testHome, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
}

function run(args: string[], extraEnv: Record<string, string> = {}): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('bun', [INDEX, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: testHome,
      // os.homedir() reads USERPROFILE on Windows, so HOME alone leaves the
      // spawned CLI resolving the real profile ('agents-cli is not set up').
      USERPROFILE: testHome,
      AGENTS_NO_UPDATE_CHECK: '1',
      AGENTS_NO_USAGE_TRACK: '1',
      ...extraEnv,
    },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

describe('devices command', () => {
  it('runs the list action when invoked without a subcommand', () => {
    guardedHome();
    const { stdout, status } = run(['devices']);

    expect(status).toBe(0);
    expect(stdout).toContain("No devices. Run 'agents devices sync'");
    expect(stdout).not.toContain('Usage: agents devices');
  });
});

describe('ssh askpass', () => {
  it.skipIf(!keychainHelperAvailable)('resolves an account-suffixed bundle key by exact storage name', ({ skip }) => {
    // Belt-and-suspenders: the release matrix has shown `it.skipIf` failing to
    // keep a test off a runner, so also skip explicitly at runtime.
    if (!keychainHelperAvailable) {
      skip();
      return;
    }
    guardedHome();
    const env = { AGENTS_SECRETS_PASSPHRASE: 'rush-668-test' };

    expect(run(['secrets', 'create', 'github.com', '--backend', 'file'], env).status).toBe(0);
    expect(run(['secrets', 'add', 'github.com', 'password.work', '--value', 'secret-pass'], env).status).toBe(0);

    const askpass = run(['ssh', '__askpass'], {
      ...env,
      AGENTS_SSH_BUNDLE: 'github.com',
      AGENTS_SSH_KEY: 'password.work',
    });

    expect(askpass.status, askpass.stderr).toBe(0);
    expect(askpass.stdout).toBe('secret-pass');
  });
});

describe('runFleetPing overall-deadline (RUSH-2041)', () => {
  // Calls the real exported raceFleetPingDeadline with a genuinely hanging
  // fanOut promise. The only test double is the fanOut (the network boundary) —
  // the deadline logic itself is the shipped code path, not a reimplementation.
  it('exits promptly and marks all remotes failed/skipped when the overall deadline fires before probes settle', async () => {
    const OVERALL_TIMEOUT_MS = 50;

    const remoteTargets: FanOutDeviceTarget[] = [
      { name: 'worker-a' },                            // probeable: hangs forever
      { name: 'worker-b' },                            // probeable: hangs forever
      { name: 'offline-c', skip: 'offline' as const }, // pre-skipped
    ];

    // A fanOut that never settles — stands in for a hung sshExecAsync call.
    // The per-device timeout is longer than OVERALL_TIMEOUT_MS so it can't
    // resolve the race before the overall deadline fires.
    const hangingFanOut = new Promise<Awaited<ReturnType<typeof fanOutDevices<string[], FanOutDeviceTarget>>>>(() => {
      /* intentionally never resolves */
    });

    const start = Date.now();
    const remote = await raceFleetPingDeadline(hangingFanOut, remoteTargets, OVERALL_TIMEOUT_MS);
    const elapsed = Date.now() - start;

    // Must resolve well inside the overall budget — not hang indefinitely.
    expect(elapsed).toBeLessThan(OVERALL_TIMEOUT_MS + 50);

    // Every remote target comes back as failed or skipped — none are missing.
    expect(remote).toHaveLength(3);
    const byName = Object.fromEntries(remote.map((r) => [r.name, r]));

    expect(byName['worker-a'].status).toBe('failed');
    expect(byName['worker-a'].error).toBe('fleet ping overall deadline exceeded');

    expect(byName['worker-b'].status).toBe('failed');
    expect(byName['worker-b'].error).toBe('fleet ping overall deadline exceeded');

    // The pre-skipped device keeps its skip status and reason, no error.
    expect(byName['offline-c'].status).toBe('skipped');
    expect(byName['offline-c'].reason).toBe('offline');
    expect(byName['offline-c'].error).toBeUndefined();
  }, 2000);
});

describe('renderLeasedBoxesSection — F4 devices "Leased boxes" (RUSH-1923)', () => {
  const NOW = 1_700_000_000;
  const box = (over: Partial<CrabboxBox> = {}): CrabboxBox => ({
    name: 'crabbox-x',
    status: 'running',
    slug: 'x',
    lease: 'cbx_x',
    state: 'ready',
    ready: true,
    keep: false,
    createdAt: NOW - 600,
    expiresAt: NOW + 600,
    lastTouchedAt: NOW - 60,
    idleTimeoutSecs: 1800,
    ...over,
  });

  it('is empty when there are no boxes (section omitted entirely)', () => {
    expect(renderLeasedBoxesSection([], NOW)).toEqual([]);
  });

  it('renders a header, one row per box (tailnet address), and reuse/stop hints', () => {
    const lines = renderLeasedBoxesSection(
      [box({ slug: 'blue-hermit', class: 'cpu-4', tailscaleFQDN: 'bh.ts.net', ip: '203.0.113.9' })],
      NOW,
    );
    const flat = lines.join('\n');
    expect(flat).toContain('Leased boxes');
    expect(flat).toContain('ephemeral · via crabbox');
    expect(flat).toContain('blue-hermit');
    expect(flat).toContain('cpu-4');
    expect(flat).toContain('bh.ts.net'); // tailnet FQDN preferred over public IP
    expect(flat).not.toContain('203.0.113.9');
    expect(flat).toContain('agents run --box <slug>');
    expect(flat).toContain('agents lease stop <slug>');
  });
});
