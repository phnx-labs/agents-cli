import { describe, expect, it, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * `agents secrets` is now a thin exec passthrough to the standalone `secrets`
 * CLI (PHNX-3989, DIST-1) — no fallback engine, so a missing binary fails loud
 * with install guidance rather than falling back to the retired in-repo one.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome = '';

afterEach(() => {
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
  testHome = '';
});

function guardedHome(): void {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-passthrough-'));
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
      USERPROFILE: testHome,
      AGENTS_NO_UPDATE_CHECK: '1',
      AGENTS_NO_USAGE_TRACK: '1',
      SECRETS_BIN: '',
      ...extraEnv,
    },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

describe('agents secrets passthrough', () => {
  it('fails loud with install guidance when the standalone is not on PATH', () => {
    guardedHome();
    const r = run(['secrets', 'list']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('not installed');
    expect(r.stderr).toContain('npm i -g @phnx-labs/secrets-cli');
  });
});

const REAL_BIN = process.env.AGENTS_TEST_SECRETS_BIN;

describe.skipIf(!REAL_BIN)('agents secrets passthrough (real standalone)', () => {
  it('forwards a subcommand + flags verbatim and reports the standalone bundle list', () => {
    guardedHome();
    const env = {
      SECRETS_BIN: REAL_BIN!,
      SECRETS_HOME: path.join(testHome, '.agents'),
      AGENTS_SECRETS_PASSPHRASE: 'passthrough-test',
      SECRETS_NO_AGENT: '1',
    };

    const createRes = run(['secrets', 'create', 'passthrough-test-bundle', '--backend', 'file'], env);
    expect(createRes.status, createRes.stderr).toBe(0);

    const listRes = run(['secrets', 'list', '--json'], env);
    expect(listRes.status, listRes.stderr).toBe(0);
    const parsed = JSON.parse(listRes.stdout) as Array<{ name: string }>;
    expect(parsed.some((b) => b.name === 'passthrough-test-bundle')).toBe(true);
  });
});
