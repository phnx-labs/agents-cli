import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'ci-runner@example.invalid',
      GIT_AUTHOR_NAME: 'CI Runner Test',
      GIT_COMMITTER_EMAIL: 'ci-runner@example.invalid',
      GIT_COMMITTER_NAME: 'CI Runner Test',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new Error(Buffer.from(proc.stderr).toString('utf8') || `git ${args.join(' ')} failed`);
  }
  return Buffer.from(proc.stdout).toString('utf8').trim();
}

export function initRepo(root: string, name: string): { dir: string; gitDir: string; commit: string; tree: string } {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init']);
  git(dir, ['checkout', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), `${name}\n`);
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'seed']);
  const commit = git(dir, ['rev-parse', 'HEAD']);
  const tree = git(dir, ['rev-parse', 'HEAD^{tree}']);
  return { dir, gitDir: dir, commit, tree };
}
