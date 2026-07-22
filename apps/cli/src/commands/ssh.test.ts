import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

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
