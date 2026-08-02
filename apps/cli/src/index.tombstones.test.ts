import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Real-CLI tests for the removed-command tombstones (RUSH-1234). `agents check`
 * and `agents resources` were deleted when their behavior folded into
 * `agents doctor --check` and `agents view --merged`; the hidden alias commands
 * in index.ts must (1) print a deprecation notice to STDERR — never stdout, so a
 * `--json` consumer's stdout stays clean — and (2) forward into the replacement,
 * preserving flags and the drift-gate exit code. No mocks: we build a temp HOME
 * with a real installed version + a real source command, then drive the actual
 * CLI in a subprocess.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome: string;
let projectDir: string;

afterEach(() => {
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
  if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
});

/** Temp HOME with an installed claude@2.0.0 and one user-layer source command. */
function seedHome(): void {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-tombstone-home-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-tombstone-proj-'));

  const userDir = path.join(testHome, '.agents');
  const systemDir = path.join(userDir, '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
  fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'agents:\n  claude: "2.0.0"\n');

  const binDir = path.join(userDir, '.history', 'versions', 'claude', '2.0.0', 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(binDir, 'claude'), 0o755);

  const commandsDir = path.join(userDir, 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.writeFileSync(path.join(commandsDir, 'demo.md'), '---\ndescription: demo\n---\n\n# demo\n');
}

// Note: no implicit --cwd here. `doctor` accepts --cwd (the check test passes it
// explicitly); `view` does not, and neither did the old `resources` — view resolves
// the resource surface from HOME + process.cwd().
function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bun', [INDEX, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: testHome,
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_DEVICES_DIR: path.join(testHome, '.agents', '.history', 'devices'),
    },
    encoding: 'utf-8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('removed-command tombstones (RUSH-1234)', () => {
  it('`agents check` forwards to `doctor --check`: notice on stderr, JSON on stdout, exit code preserved', () => {
    seedHome(); // installed but never-synced → doctor --check must exit non-zero

    // --cwd points doctor at the empty project dir; the tombstone must forward it
    // through to `doctor --check --json --cwd <dir>`.
    const r = run('check', '--json', '--cwd', projectDir);

    // Notice is on stderr, NOT stdout — stdout must be parseable JSON for CI.
    expect(r.stderr).toContain('Deprecated');
    expect(r.stderr).toContain('doctor --check');
    expect(r.stdout).not.toContain('Deprecated');

    const parsed = JSON.parse(r.stdout); // proves it reached doctor --check's JSON path
    expect(parsed).toHaveProperty('hasDrift');
    expect(parsed.hasDrift).toBe(true); // never-synced version → drift
    expect(r.status).not.toBe(0); // the gate exit code survived the rename
  });

  it('`agents resources` forwards to `view --merged`: notice on stderr, merged table on stdout', () => {
    seedHome();

    const r = run('resources');

    expect(r.stderr).toContain('Deprecated');
    expect(r.stderr).toContain('view --merged');
    expect(r.stderr).toContain('inspect'); // points at inspect for per-target detail
    expect(r.stdout).not.toContain('Deprecated');
    // The merged first-wins renderer prints a "… merged" header and per-kind rows.
    expect(r.stdout.toLowerCase()).toContain('merged');
    expect(r.status).toBe(0);
  });

  it('neither removed name appears as "unknown command"', () => {
    seedHome();
    for (const name of ['check', 'resources']) {
      const r = run(name, '--help');
      expect(r.stderr).not.toContain(`unknown command '${name}'`);
    }
  });
});
