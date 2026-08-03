import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const cliEntry = path.join(repoRoot, 'src', 'index.ts');
// Run tsx via `node node_modules/tsx/dist/cli.mjs`, not the .bin/tsx shim: on
// Windows the shim is tsx.cmd, which spawnSync cannot exec without a shell.
const tsxBin = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

let home: string;

function run(args: string[]) {
  return spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, AGENTS_SKIP_MIGRATION: '1', NODE_NO_WARNINGS: '1' },
    encoding: 'utf-8',
  });
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fav-cli-' + crypto.randomBytes(4).toString('hex') + '-'));
  // ensureInitialized() looks for ~/.agents/.system/.git as the setup marker.
  fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * Drives the REAL CLI, because the bug this pins lives in argument parsing and
 * is invisible to a direct call of the action.
 *
 * `agents sessions` declares `--json` AND takes a positional `[query]`, so
 * commander keeps matching parent-known options past the subcommand name and
 * binds `--json` to the PARENT. `sessions favorite --list --json` therefore
 * printed the human listing while the subcommand's own `options.json` sat
 * undefined — a machine caller silently got prose. Only a real spawn sees it.
 */
describe('agents sessions favorite (real CLI parse)', () => {
  it('honors --json even though the parent command also declares it', () => {
    const res = run(['sessions', 'favorite', '--list', '--json']);
    expect(res.status).toBe(0);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
    expect(JSON.parse(res.stdout)).toEqual({ favorites: [] });
  });

  it('defaults to listing when given no ids', () => {
    const res = run(['sessions', 'favorite', '--json']);
    expect(JSON.parse(res.stdout)).toEqual({ favorites: [] });
  });

  it('exits non-zero on an id that resolves to nothing, so a script cannot read success', () => {
    const res = run(['sessions', 'favorite', 'nosuchsession99']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('No session matches');
  });

  it('reports the failure in --json too, not just on stderr', () => {
    const res = run(['sessions', 'favorite', 'nosuchsession99', '--json']);
    expect(res.status).toBe(1);
    const parsed = JSON.parse(res.stdout) as { results: { error?: string }[] };
    expect(parsed.results[0].error).toContain('No session matches');
  });

  it('lists the favorite flag on its own --help', () => {
    const res = run(['sessions', 'favorite', '--help']);
    expect(res.stdout).toContain('--json');
    expect(res.stdout).toContain('--remove');
  });
});
