/**
 * PHNX-3503 review follow-up — the CLI wiring for `agents worktree`.
 *
 * `reclaim.ts` holds the safety gate and is well covered; the bugs found in
 * review were all in this layer, which had none. These drive the real binary
 * against a real repo with real worktrees, because the thing under test IS the
 * argument plumbing — a unit test of the predicate would have missed all of it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

const G = ['-c', 'user.email=t@t.dev', '-c', 'user.name=t', '-c', 'init.defaultBranch=main'];
const git = async (cwd: string, args: string[]) =>
  (await execFileAsync('git', [...G, ...args], { cwd })).stdout.trim();

/**
 * A disposable HOME that satisfies the CLI's setup gate, same shape as
 * `alias.test.ts` — without it every spawn exits 1 with "agents-cli is not set
 * up" and asserts nothing about the command under test.
 */
function guardedHome(base: string): string {
  const home = path.join(base, 'home');
  const systemDir = path.join(home, '.agents', '.system');
  fsSync.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fsSync.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
  return home;
}

let home: string;

function run(args: string[], cwd: string) {
  return spawnSync('bun', [INDEX, ...args], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      AGENTS_NO_UPDATE_CHECK: '1',
      AGENTS_SECRETS_PASSPHRASE: '',
    },
  });
}

describe('agents worktree (CLI wiring)', () => {
  let base: string;
  let origin: string;
  let repo: string;

  beforeAll(async () => {
    // NOT under /tmp — main-branch-guard treats a git primary there as
    // protected (PHNX-2732), same reasoning as reclaim.test.ts.
    base = await fs.mkdtemp(path.join(os.homedir(), '.agents-wt-cli-test-'));
    home = guardedHome(base);
    origin = path.join(base, 'origin.git');
    repo = path.join(base, 'repo');
    await execFileAsync('git', [...G, 'init', '--bare', '-b', 'main', origin]);
    await execFileAsync('git', [...G, 'clone', origin, repo]);
    await fs.writeFile(path.join(repo, 'a.txt'), 'one\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'init']);
    await git(repo, ['push', '-u', 'origin', 'main']);
  }, 60_000);

  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('sweep --json WITHOUT --yes removes nothing', async () => {
    // The bug: the gate read `!opts.yes && !opts.json`, so passing --json —
    // the shape any script or routine reaches for — skipped confirmation and
    // fell straight through to the destructive loop.
    const wt = path.join(repo, '.agents', 'worktrees', 'gated');
    await git(repo, ['worktree', 'add', '-b', 'feat/gated', wt, 'origin/main']);

    const r = run(['worktree', 'sweep', '--older-than', '0', '--json'], repo);
    const out = JSON.parse(r.stdout);

    expect(out.confirmationRequired).toBe(true);
    expect(out.reclaimed).toEqual([]);
    expect(r.status).not.toBe(0); // loud, not a silent clean sweep
    await fs.access(wt); // still on disk — nothing was removed
  }, 120_000);

  it('sweep --dry-run --json reports without removing', async () => {
    const wt = path.join(repo, '.agents', 'worktrees', 'gated');
    const r = run(['worktree', 'sweep', '--older-than', '0', '--dry-run', '--json'], repo);
    const out = JSON.parse(r.stdout);
    expect(Array.isArray(out.reclaimable)).toBe(true);
    await fs.access(wt);
  }, 120_000);

  it('done reclaims the worktree you are IN, never its name-prefix neighbour', async () => {
    // `process.cwd().startsWith(f.path)` made `.../fix-1103` look like it lived
    // inside `.../fix-110`. `find()` returns the FIRST match and fix-110 is
    // registered first, so `done` run from fix-1103 reclaimed fix-110 — the
    // wrong worktree, and one the user never named.
    const a = path.join(repo, '.agents', 'worktrees', 'fix-110');
    const b = path.join(repo, '.agents', 'worktrees', 'fix-1103');
    await git(repo, ['worktree', 'add', '-b', 'feat/fix-110', a, 'origin/main']);
    await git(repo, ['worktree', 'add', '-b', 'feat/fix-1103', b, 'origin/main']);

    const r = run(['worktree', 'done'], b);
    expect(r.status).toBe(0);

    // The neighbour is untouched — this is the assertion the bug violated.
    await fs.access(a);
    expect(await git(repo, ['branch', '--list', 'feat/fix-110'])).toContain('feat/fix-110');

    // ...and the worktree actually stood in was the one reclaimed.
    await expect(fs.access(b)).rejects.toThrow();
  }, 120_000);

  it('list --json always holds the primary checkout, whatever the grace window', async () => {
    const r = run(['worktree', 'list', '--older-than', '0', '--json'], repo);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as Array<{
      path: string;
      isPrimary: boolean;
      reclaimable: boolean;
      blockers: string[];
    }>;
    const primary = out.find((w) => w.isPrimary)!;
    expect(primary.path).toBe(repo);
    // --older-than 0 removes the grace window; the primary must STILL be held.
    expect(primary.reclaimable).toBe(false);
    expect(primary.blockers).toContain('primary-checkout');
  }, 120_000);
});
