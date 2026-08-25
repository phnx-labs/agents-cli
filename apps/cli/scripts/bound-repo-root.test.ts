import { describe, expect, it } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BOUND = path.resolve(__dirname, 'bound-repo-root.sh');

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8' }).trim();
}
/** Run the REAL remediation script — not a copy of its logic. */
function bound(dir: string): void {
  execFileSync('bash', [BOUND, dir], { stdio: 'pipe' });
}

// RUSH-3178. `test.sh --device` ships the tree without `.git`, and a directory
// with no `.git` sitting under a git ANCESTOR has `rev-parse --show-toplevel`
// escape to that ancestor. In production the ancestor is `~/.agents` (the
// DotAgents repo) and ssh is merely what puts the tree there — the mechanism is
// a plain git/filesystem fact, so any git ancestor reproduces it with no network.
describe('bound-repo-root.sh', () => {
  it('bounds a .git-less tree that would otherwise escape to a git ancestor', () => {
    const ancestor = tmp('bound-ancestor-');
    git('init -q', ancestor); // stands in for ~/.agents
    const shipped = path.join(ancestor, 'test-runs', 'agents-cli');
    fs.mkdirSync(shipped, { recursive: true });
    fs.writeFileSync(path.join(shipped, 'marker.txt'), 'x'); // the rsynced tree, no .git

    // The bug is real, demonstrated without ssh:
    expect(git('rev-parse --show-toplevel', shipped)).toBe(ancestor);

    bound(shipped);

    expect(git('rev-parse --show-toplevel', shipped)).toBe(shipped);
    fs.rmSync(ancestor, { recursive: true, force: true });
  });

  it('repairs a STALE commit-less .git left by an earlier run', () => {
    // A worker last touched by an earlier revision of this fix has a `.git` but
    // no commit. An existence check (`[ ! -e .git ]`) treats that as done and
    // leaves HEAD permanently unresolvable; gating on HEAD does not.
    const shipped = tmp('bound-stale-');
    fs.writeFileSync(path.join(shipped, 'marker.txt'), 'x');
    git('init -q', shipped);
    expect(() => git('rev-parse --verify HEAD', shipped)).toThrow(); // unborn

    bound(shipped);

    expect(() => git('rev-parse --verify HEAD', shipped)).not.toThrow();
    fs.rmSync(shipped, { recursive: true, force: true });
  });

  it('is idempotent — a bounded tree is left exactly as it was', () => {
    const shipped = tmp('bound-idem-');
    fs.writeFileSync(path.join(shipped, 'marker.txt'), 'x');
    bound(shipped);
    const head = git('rev-parse HEAD', shipped);
    bound(shipped);
    // Re-running must not re-init or add an empty commit on top.
    expect(git('rev-parse HEAD', shipped)).toBe(head);
    fs.rmSync(shipped, { recursive: true, force: true });
  });

  it('does not write the caller machine git identity into the tree config', () => {
    const shipped = tmp('bound-ident-');
    fs.writeFileSync(path.join(shipped, 'marker.txt'), 'x');
    bound(shipped);
    // Identity is passed with `git -c`, so it must not be persisted.
    const email = execSync('git config --local --get user.email || true', {
      cwd: shipped, encoding: 'utf-8',
    }).trim();
    expect(email).toBe('');
    fs.rmSync(shipped, { recursive: true, force: true });
  });
});
