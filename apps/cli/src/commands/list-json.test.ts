import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Real-CLI contract test for the machine-readable `--json` output of the two
 * "list" commands (`repos list`, `plugins list`). No mocks: we run the actual
 * command tree in a subprocess against a guarded temp HOME and assert stdout
 * parses as JSON.
 *
 * This exists to catch a specific wiring regression: declaring `--json` on both a
 * parent command and its subcommand makes commander bind the flag to the parent,
 * so `plugins list --json` silently falls back to the human table. A unit test on
 * the action can't see that — only driving the parsed command tree does.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');
const ANSI_ESCAPE = String.fromCharCode(27); // the ESC byte chalk color codes start with

let testHome: string;

afterEach(() => {
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
});

/** A temp HOME with the network/update probes guarded so the CLI runs offline. */
function guardedHome(): void {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-listjson-home-'));
  const systemDir = path.join(testHome, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
}

function run(args: string[]): { stdout: string; status: number | null } {
  const r = spawnSync('bun', [INDEX, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: testHome, AGENTS_NO_UPDATE_CHECK: '1' },
  });
  return { stdout: r.stdout ?? '', status: r.status };
}

describe('list commands emit valid JSON with --json (not the human table)', () => {
  it('repos list --json prints a JSON array with no ANSI color leaking in', () => {
    guardedHome();
    const { stdout } = run(['repos', 'list', '--json']);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    // The `raw` field for a missing/no-git repo is chalk-colored in the human view;
    // --json must strip it so downstream parsers get clean strings.
    expect(stdout).not.toContain(ANSI_ESCAPE);
  });

  it('plugins list --json prints a JSON array — the flag reaches the subcommand action', () => {
    guardedHome();
    const { stdout } = run(['plugins', 'list', '--json']);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    // The regression this guards: a table would start with the "Name" header, not JSON.
    expect(stdout.trimStart().startsWith('[')).toBe(true);
  });
});
