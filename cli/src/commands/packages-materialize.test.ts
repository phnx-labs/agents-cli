/**
 * Real-CLI tests for `agents packages materialize` (PHNX-3838).
 *
 * Drives the entrypoint as a subprocess. No mocks. Writes only under a temp
 * output home — never the live user harness dirs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { PORTABLE_HARNESSES, type MaterializeReceipt } from './packages-materialize.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'testdata',
  'portable-agent-package',
);

const tempDirs: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-packages-materialize-home-'));
  tempDirs.push(home);
  const systemDir = path.join(home, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
  return home;
}

function runCli(
  home: string,
  args: string[],
): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('bun', [INDEX, ...args], {
    encoding: 'utf-8',
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_SKIP_MIGRATION: '1',
      AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
      AGENTS_NO_UPDATE_CHECK: '1',
    },
    timeout: 30_000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('agents packages materialize help', () => {
  it('teaches the Factory workflow before the flag list', () => {
    const home = makeHome();
    const { stdout, stderr, status } = runCli(home, ['packages', 'materialize', '--help']);
    const help = `${stdout}${stderr}`;
    expect(status).toBe(0);
    expect(help).toContain('--json');
    expect(help).toMatch(/Factory/);
    expect(help).toContain('--harness');
    expect(help).toContain('--output-home');
    expect(help).toContain('claude');
    expect(help).toContain('codex');
    expect(help).toContain('opencode');
    const examplesAt = help.indexOf('Examples:');
    const optionsAt = help.indexOf('Options:');
    expect(examplesAt).toBeGreaterThan(-1);
    expect(optionsAt).toBeGreaterThan(-1);
    expect(examplesAt).toBeLessThan(optionsAt);
  });
});

describe('agents packages materialize', () => {
  it.each(PORTABLE_HARNESSES)('emits a JSON receipt for %s without touching the live home', (harness) => {
    const home = makeHome();
    const outputHome = fs.mkdtempSync(path.join(os.tmpdir(), `agents-mat-${harness}-`));
    tempDirs.push(outputHome);

    const { stdout, stderr, status } = runCli(home, [
      'packages',
      'materialize',
      FIXTURE,
      '--harness',
      harness,
      '--harness-version',
      '1.2.3',
      '--output-home',
      outputHome,
      '--json',
    ]);

    expect(status, stderr).toBe(0);
    const receipt = JSON.parse(stdout) as MaterializeReceipt;
    expect(receipt.package).toBe('reviewer');
    expect(receipt.harness).toBe(harness);
    expect(receipt.version).toBe('1.2.3');
    expect(receipt.outputHome).toBe(path.resolve(outputHome));
    expect(receipt.targets.length).toBeGreaterThan(0);
    expect(receipt.resourceHashes['agent.yaml']).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(path.join(outputHome, 'agent.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(home, `.${harness}`))).toBe(false);
    expect(stderr).not.toMatch(/secret/i);
  });

  it('rejects an invalid package', () => {
    const home = makeHome();
    const outputHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mat-invalid-'));
    tempDirs.push(outputHome);
    const bogus = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mat-not-a-pkg-'));
    tempDirs.push(bogus);

    const { stdout, stderr, status } = runCli(home, [
      'packages',
      'materialize',
      bogus,
      '--harness',
      'claude',
      '--harness-version',
      '1.0.0',
      '--output-home',
      outputHome,
      '--json',
    ]);

    expect(status).not.toBe(0);
    const payload = JSON.parse(stdout) as { error: string };
    expect(payload.error).toMatch(/Invalid package/i);
    expect(stderr + stdout).toMatch(/Invalid package/i);
  });

  it('rejects an unsupported capability', () => {
    const home = makeHome();
    const outputHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mat-unsup-'));
    tempDirs.push(outputHome);

    const { stdout, status } = runCli(home, [
      'packages',
      'materialize',
      FIXTURE,
      '--harness',
      'gemini',
      '--harness-version',
      '1.0.0',
      '--output-home',
      outputHome,
      '--json',
    ]);

    expect(status).not.toBe(0);
    const payload = JSON.parse(stdout) as { error: string };
    expect(payload.error).toMatch(/Unsupported capability/i);
    expect(payload.error).toMatch(/gemini/);
  });

  it('rejects an output-path escape', () => {
    const home = makeHome();
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mat-escape-'));
    tempDirs.push(sandbox);
    const outputHome = path.join(sandbox, 'home');
    fs.mkdirSync(outputHome);
    // Keep the literal `..` segment; path.join() would normalize it away.
    const escaped = `${outputHome}/../outside`;

    const { stdout, stderr, status } = runCli(home, [
      'packages',
      'materialize',
      FIXTURE,
      '--harness',
      'claude',
      '--harness-version',
      '1.0.0',
      '--output-home',
      escaped,
      '--json',
    ]);

    expect(status).not.toBe(0);
    const payload = JSON.parse(stdout) as { error: string };
    expect(payload.error).toMatch(/Path escape/i);
    expect(fs.existsSync(path.join(sandbox, 'outside', 'agent.yaml'))).toBe(false);
  });
});
