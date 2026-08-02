/**
 * The release mutex, exercised against a REAL git remote.
 *
 * No mocking: each test builds an actual bare repo on disk, points two working
 * clones at it as `origin`, and runs the real `release-lease.sh`. That is the
 * whole critical path — the mutual exclusion IS `git push` semantics, so a test
 * that stubbed git would prove nothing.
 *
 * What this pins down is the failure that jammed the pipeline on 2026-08-02:
 * two agents on two machines entered release.sh at once, and the second one only
 * discovered the collision at the publish gate, after the first had already
 * merged and tagged.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, 'release-lease.sh');
const REF = 'refs/release-lock/test-held';

let root: string;
let origin: string;
let boxA: string;
let boxB: string;

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Run the real lease script from `cwd`, as if from that machine. */
function lease(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, RELEASE_LEASE_REF: REF, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Same as `lease`, but genuinely concurrent — for racing two claimants. */
function leaseAsync(cwd: string, args: string[]) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    const p = spawn('bash', [SCRIPT, ...args], {
      cwd,
      env: { ...process.env, RELEASE_LEASE_REF: REF },
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => resolve({ status: status ?? -1, stdout, stderr }));
  });
}

/** A clone that behaves like a distinct release box. */
function makeBox(name: string) {
  const dir = path.join(root, name);
  git(root, 'clone', '--quiet', origin, dir);
  git(dir, 'config', 'user.email', `${name}@test.local`);
  git(dir, 'config', 'user.name', name);
  return dir;
}

/** The `holder:` line the script stamped, as reported back by `status`. */
function currentHolder(cwd: string) {
  const m = /holder=(\S+)/.exec(lease(cwd, ['status']).stdout);
  return m?.[1] ?? '';
}

/**
 * Push a lease that is genuinely `ageMin` minutes old, by backdating the commit
 * exactly the way an abandoned release's lease would look. Using a real old
 * timestamp (rather than `--ttl-min 0`) is what makes the reclaim tests
 * meaningful: with TTL 0 every lease is instantly reclaimable, so a second
 * reclaim succeeds for the wrong reason and the compare-and-swap is never
 * exercised.
 */
function plantStaleLease(
  cwd: string,
  version: string,
  ageMin: number,
  opts: { force?: boolean } = {},
) {
  const when = new Date(Date.now() - ageMin * 60_000).toISOString();
  const tree = git(cwd, 'hash-object', '-t', 'tree', '/dev/null');
  const msg = `release lease\n\nversion: ${version}\nholder: dead-box/pid-1\nclaimed: ${when}\n`;
  const r = spawnSync('git', ['commit-tree', tree, '-m', msg], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when },
  });
  if (r.status !== 0) throw new Error(`commit-tree failed: ${r.stderr}`);
  const sha = r.stdout.trim();
  git(cwd, 'push', '--quiet', ...(opts.force ? ['--force'] : []), 'origin', `${sha}:${REF}`);
  return sha;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-lease-'));
  origin = path.join(root, 'origin.git');
  git(root, 'init', '--quiet', '--bare', origin);

  // origin needs at least one commit for `git clone` to produce a usable tree.
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '--quiet');
  git(seed, 'config', 'user.email', 'seed@test.local');
  git(seed, 'config', 'user.name', 'seed');
  fs.writeFileSync(path.join(seed, 'README.md'), '# seed\n');
  git(seed, 'add', 'README.md');
  git(seed, 'commit', '--quiet', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');

  boxA = makeBox('box-a');
  boxB = makeBox('box-b');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('release-lease: mutual exclusion across machines', () => {
  it('lets exactly one of two concurrent claimants win', () => {
    const a = lease(boxA, ['claim', '1.20.82']);
    const b = lease(boxB, ['claim', '1.20.82']);

    expect(a.status).toBe(0);
    expect(b.status).toBe(1);
    // The loser must say WHY, naming the holder — a bare failure would send the
    // agent hunting for a cause and it would race instead.
    expect(b.stderr).toContain('release already in flight');
  });

  it('names the holder and the version in the refusal', () => {
    lease(boxA, ['claim', '1.20.82']);
    const holder = currentHolder(boxA);
    expect(holder).not.toBe('');

    const b = lease(boxB, ['claim', '1.20.83']);

    expect(b.status).toBe(1);
    expect(b.stdout + b.stderr).toContain('version=1.20.82');
    expect(b.stdout + b.stderr).toContain(holder);
  });

  it('frees the lease for the next releaser once released', () => {
    expect(lease(boxA, ['claim', '1.20.82']).status).toBe(0);
    expect(lease(boxB, ['claim', '1.20.82']).status).toBe(1);

    expect(lease(boxA, ['release']).status).toBe(0);
    expect(lease(boxB, ['claim', '1.20.83']).status).toBe(0);
  });
});

describe('release-lease: a dead run must not wedge the pipeline', () => {
  it('refuses to reclaim a lease that is younger than the TTL', () => {
    plantStaleLease(boxA, '1.20.82', 10);
    const b = lease(boxB, ['claim', '1.20.82', '--ttl-min', '45']);
    expect(b.status).toBe(1);
    expect(b.stderr).toContain('release already in flight');
  });

  it('reclaims a lease older than the TTL, and says whose it was', () => {
    plantStaleLease(boxA, '1.20.82', 90);
    const b = lease(boxB, ['claim', '1.20.83', '--ttl-min', '45']);

    expect(b.status).toBe(0);
    expect(b.stdout).toContain('reclaiming a stale release lease');
    // The dead holder must be named, not silently overwritten — otherwise a
    // wedged pipeline leaves no trace of what wedged it.
    expect(b.stdout).toContain('dead-box/pid-1');
    expect(b.stdout).toContain('version=1.20.82');

    // And the reclaimer now genuinely holds it.
    expect(lease(boxA, ['claim', '1.20.84']).status).toBe(1);
  });

  it('gives one stale lease to exactly one of two simultaneous reclaimers', async () => {
    const boxC = makeBox('box-c');
    plantStaleLease(boxA, '1.20.82', 90);

    // Both read the SAME stale sha and both try to reclaim it. Only the
    // --force-with-lease pin can decide this; a plain delete+push would let
    // both through and hand two agents the same release.
    const [b, c] = await Promise.all([
      leaseAsync(boxB, ['claim', '1.20.83', '--ttl-min', '45']),
      leaseAsync(boxC, ['claim', '1.20.84', '--ttl-min', '45']),
    ]);

    const winners = [b, c].filter((r) => r.status === 0);
    expect(winners).toHaveLength(1);
  });
});

describe('release-lease: releasing what you do not own', () => {
  it('will not drop a lease this box never claimed', () => {
    lease(boxA, ['claim', '1.20.82']);

    // box-b holds no token, so it has nothing to drop — and must not reach for
    // the remote ref anyway.
    const b = lease(boxB, ['release']);
    expect(b.status).toBe(0);
    expect(b.stdout).toContain('no release lease to drop');

    // box-a still holds it, so a claim from box-b still fails.
    expect(lease(boxB, ['claim', '1.20.83']).status).toBe(1);
  });

  it('will not drop a lease that was reclaimed out from under it', () => {
    lease(boxA, ['claim', '1.20.82']);
    // box-a's run overran the TTL and box-b reclaimed the lease.
    plantStaleLease(boxB, '1.20.83', 0, { force: true });

    const a = lease(boxA, ['release']);
    expect(a.status).toBe(0);
    expect(a.stdout).toContain('no longer ours');

    // box-b's lease survived box-a's cleanup — the pipeline stays exclusive.
    expect(lease(boxA, ['claim', '1.20.83']).status).toBe(1);
  });

  it('is a no-op when nothing is held', () => {
    const r = lease(boxA, ['release']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no release lease to drop');
  });
});

describe('release-lease: status', () => {
  it('reports unheld, then the holder', () => {
    expect(lease(boxA, ['status']).stdout.trim()).toBe('unheld');

    lease(boxA, ['claim', '1.20.82']);
    const s = lease(boxB, ['status']);
    expect(s.stdout).toContain('held');
    expect(s.stdout).toContain('version=1.20.82');
  });
});
