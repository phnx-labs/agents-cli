import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Real-filesystem, real-CLI tests for `agents check` — the scriptable CI drift
 * gate. No mocks: we build a temp HOME with a real installed version + real
 * source resources, drive the actual `agents sync` to snapshot the manifest,
 * then run `agents check` in a subprocess and assert the EXIT CODE.
 *
 * The contract (issue #329): a clean, in-sync install exits 0; drift (a source
 * changed since last sync) exits non-zero. This is the gap `agents doctor` left
 * — it returned 0 even under drift, so CI could never gate on it.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome: string;
let projectDir: string;

afterEach(() => {
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
  if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
});

/** Build a temp HOME with an installed claude@2.0.0 and one source command. */
function seedHome(): { commandSrc: string } {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-check-home-'));
  // A separate, empty project dir so the project layer resolves to nothing —
  // both `sync` and `check` are pointed at it via --cwd so they see the same
  // (user-only) source set.
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-check-proj-'));

  const userDir = path.join(testHome, '.agents');
  const systemDir = path.join(userDir, '.system');
  // `.system/.git` keeps ensureInitialized() from blocking; `.update-check`
  // keeps the update probe from reaching the network.
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
  fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'agents:\n  claude: "2.0.0"\n');

  // A fake installed version: a binary so listInstalledVersions() sees it.
  const binDir = path.join(userDir, '.history', 'versions', 'claude', '2.0.0', 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(binDir, 'claude'), 0o755);

  // One user-layer source command.
  const commandsDir = path.join(userDir, 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  const commandSrc = path.join(commandsDir, 'demo.md');
  fs.writeFileSync(commandSrc, '---\ndescription: demo\n---\n\n# demo\n');

  return { commandSrc };
}

/** Snapshot the manifest so the version reads as `fresh` (real sync, no mocks). */
function syncSnapshot(): void {
  execFileSync('bun', [INDEX, 'sync', 'claude@2.0.0', '-y', '--cwd', projectDir], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: testHome },
    stdio: 'ignore',
  });
}

function runCheck(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bun', [INDEX, 'check', '--cwd', projectDir, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: testHome },
    encoding: 'utf-8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('agents check — CI drift gate exit code', () => {
  it('exits 0 when the install is clean (synced, sources unchanged)', () => {
    seedHome();
    syncSnapshot();

    const r = runCheck();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('in sync');
  });

  it('exits non-zero when a source drifted since last sync', () => {
    const { commandSrc } = seedHome();
    syncSnapshot();
    // Change the SOURCE after the snapshot — the exact drift doctor detects but
    // never failed on.
    fs.writeFileSync(commandSrc, '---\ndescription: demo CHANGED\n---\n\n# demo v2\n');

    const r = runCheck();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('drift');
  });

  it('exits non-zero for a never-synced installed version (no manifest)', () => {
    seedHome();
    // No syncSnapshot() → no manifest → the version reads as never-synced.
    const r = runCheck();
    expect(r.status).not.toBe(0);
  });

  it('--json reports hasDrift and mirrors the exit code', () => {
    const { commandSrc } = seedHome();
    syncSnapshot();

    const clean = runCheck('--json');
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.stdout).hasDrift).toBe(false);

    fs.writeFileSync(commandSrc, '---\ndescription: changed again\n---\n\n# v3\n');
    const drifted = runCheck('--json');
    expect(drifted.status).not.toBe(0);
    const parsed = JSON.parse(drifted.stdout);
    expect(parsed.hasDrift).toBe(true);
    expect(parsed.stale).toBe(1);
  });

  it('--devices exits non-zero when any registered device is unreachable', () => {
    seedHome();
    const registryDir = path.join(testHome, '.agents', '.history', 'devices');
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, 'registry.json'), JSON.stringify({
      deadbox: {
        name: 'deadbox',
        platform: 'linux',
        shell: 'posix',
        user: 'muqsit',
        address: { via: 'manual', dnsName: 'deadbox.example.invalid' },
        auth: { method: 'key' },
        tailscale: { online: false, direct: false, lastSeen: '2026-07-17T00:00:00.000Z' },
        createdAt: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T00:00:00.000Z',
      },
    }, null, 2));

    const r = runCheck('--devices', '--json');
    expect(r.status).not.toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.hasDrift).toBe(true);
    expect(parsed.devices.some((d: any) => d.device === 'deadbox' && d.error === 'offline')).toBe(true);
  });
});
