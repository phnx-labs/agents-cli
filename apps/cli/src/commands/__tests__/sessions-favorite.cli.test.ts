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

  // `--favorites` was wired into the interactive BROWSER only, so on every path
  // that skips the browser — --json, --waiting, a pipe, a multi-host scope, an
  // SSH-fanout peer — the flag silently did nothing and `--active --favorites`
  // returned the whole fleet. That is the exact command the browser's own `y`
  // copy-cmd hands to an agent.
  it('narrows --active to the starred sessions, not just in the browser', () => {
    const registry = path.join(home, '.agents', '.cache', 'terminals', 'live-terminals.json');
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    const starred = 'aaaaaaaa-0000-0000-0000-000000000001';
    const other = 'bbbbbbbb-0000-0000-0000-000000000002';
    fs.writeFileSync(
      registry,
      JSON.stringify({
        w: {
          at: new Date().toISOString(),
          entries: [starred, other].map((sessionId) => ({
            sessionId,
            pid: process.pid,
            kind: 'claude',
            cwd: home,
            startedAtMs: Date.now(),
          })),
        },
      }),
    );

    const all = JSON.parse(run(['sessions', '--active', '--local', '--json']).stdout) as { sessionId?: string }[];
    expect(all.filter((r) => r.sessionId === starred || r.sessionId === other)).toHaveLength(2);

    expect(run(['sessions', 'favorite', starred]).status).toBe(0);
    const only = JSON.parse(run(['sessions', '--active', '--favorites', '--local', '--json']).stdout) as {
      sessionId?: string;
    }[];
    expect(only.map((r) => r.sessionId)).toEqual([starred]);

    // Leave the store clean for the other cases in this file.
    run(['sessions', 'favorite', starred, '--remove']);
    fs.rmSync(registry, { force: true });
  });

  it('stars a complete id with no transcript row — a live session may not be indexed yet', () => {
    const fresh = 'cccccccc-0000-0000-0000-000000000003';
    expect(run(['sessions', 'favorite', fresh]).status).toBe(0);
    expect(JSON.parse(run(['sessions', 'favorite', '--list', '--json']).stdout)).toEqual({ favorites: [fresh] });
    run(['sessions', 'favorite', fresh, '--remove']);
  });

  it('still refuses a partial id that resolves to nothing', () => {
    // Only a COMPLETE id skips the index; a short prefix must still fail loudly
    // rather than starring an id that names no session at all.
    const res = run(['sessions', 'favorite', 'ccccc']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('No session matches');
  });

  it('lists the favorite flag on its own --help', () => {
    const res = run(['sessions', 'favorite', '--help']);
    expect(res.stdout).toContain('--json');
    expect(res.stdout).toContain('--remove');
  });
});
