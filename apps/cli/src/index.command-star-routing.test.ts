import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Real-CLI regression test (RUSH-2022 review r2): a 1-edit-distance typo of a
 * host-routable command (e.g. `docto` for `doctor`) combined with `--host`
 * must not silently run LOCALLY once the auto-correct handler re-parses with
 * the corrected name. The router only ever saw the ORIGINAL (unknown) name
 * before commander parsing, so without re-checking after auto-correct, a
 * routing flag on the corrected name was dropped with no error at all -
 * worse than the pre-fix "does not support --host" message, which was at
 * least a loud failure. No mocks: spawns the actual built CLI.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

function seedHome(): string {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cmdstar-home-'));
  const userDir = path.join(testHome, '.agents');
  const systemDir = path.join(userDir, '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
  return testHome;
}

function run(testHome: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bun', [INDEX, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: testHome,
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_DEVICES_DIR: path.join(testHome, '.agents', '.history', 'devices'),
    },
    encoding: 'utf-8',
    timeout: 20_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('command:* auto-correct re-checks --host routing (RUSH-2022 review r2)', () => {
  it('a typo of a host-routable command with --host does not silently run locally', () => {
    const testHome = seedHome();
    try {
      // `docto` is 1 edit from `doctor`, which is host-routable via
      // REMOTE_PASSTHROUGH but NOT in OWN_HOST_COMMANDS. An unreachable host
      // name forces a real SSH resolution attempt if (and only if) routing
      // was actually retried after the correction.
      const r = run(testHome, 'docto', '--host', 'nonexistent-host-xyz-regression-test');

      // Must NOT look like a successful local doctor report.
      expect(r.stdout).not.toContain('CRITICAL');
      expect(r.stdout).not.toContain('Installed Agent CLIs');
      // Must show real routing was attempted (SSH resolution failure), not a
      // silent local run and not the old "does not support --host" message.
      expect(r.stderr.toLowerCase()).not.toContain('does not support --host');
      const routed =
        r.stderr.toLowerCase().includes('nonexistent-host-xyz-regression-test') ||
        r.stderr.toLowerCase().includes('ssh') ||
        r.stderr.toLowerCase().includes('unreachable');
      expect(routed).toBe(true);
    } finally {
      fs.rmSync(testHome, { recursive: true, force: true });
    }
  });

  it('a typo with no routing flag still auto-corrects and runs locally as before', () => {
    const testHome = seedHome();
    try {
      // `vew` (typo of `view`) with NO --host must behave exactly as the
      // pre-existing auto-correct did: run locally, no SSH attempt.
      const r = run(testHome, 'vew', '--help');
      expect(r.stderr).not.toContain("unknown command 'vew'");
    } finally {
      fs.rmSync(testHome, { recursive: true, force: true });
    }
  });
});
