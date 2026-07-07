import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { migrateAgentsYaml } from '../migrate.js';

// Regression coverage for the v11 split migration wedging the system mirror.
//
// The system repo (~/.agents/.system) is a pull-only git mirror of the
// npm-shipped defaults. A prior version of migrateAgentsYaml() moved/deleted the
// TRACKED agents.yaml out of it, leaving ` D agents.yaml` in the working tree.
// Because the mirror sync refuses a dirty tree, that single deletion permanently
// broke `agents setup`, `agents sync`, and background auto-pull with
// "Working tree has uncommitted changes." The migration must treat the mirror as
// read-only.

let tmp: string;
let systemDir: string;
let userDir: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function porcelain(cwd: string): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf-8' }).trim();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-mirror-'));
  systemDir = path.join(tmp, '.agents', '.system');
  userDir = path.join(tmp, '.agents');
  fs.mkdirSync(systemDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('migrateAgentsYaml — system mirror is read-only', () => {
  it('never dirties the tracked agents.yaml in a pull-only system mirror', () => {
    // Build the mirror as a real git repo with a committed agents.yaml (the
    // npm-shipped defaults).
    const shipped = 'hooks:\n  session-start:\n    events:\n      - SessionStart\n';
    fs.writeFileSync(path.join(systemDir, 'agents.yaml'), shipped);
    git(systemDir, 'init', '-q');
    git(systemDir, 'add', 'agents.yaml');
    git(systemDir, 'commit', '-q', '-m', 'ship defaults', '--no-gpg-sign');

    expect(porcelain(systemDir)).toBe(''); // clean baseline

    migrateAgentsYaml(systemDir, userDir);

    // The tracked file must still exist AND the working tree must stay clean —
    // otherwise the mirror sync wedges every subsequent run.
    expect(fs.existsSync(path.join(systemDir, 'agents.yaml'))).toBe(true);
    expect(fs.readFileSync(path.join(systemDir, 'agents.yaml'), 'utf-8')).toBe(shipped);
    expect(porcelain(systemDir)).toBe('');

    // The shipped defaults are read in place by readMeta(); the migration must
    // NOT seed a duplicate into the user dir (that would freeze the defaults).
    expect(fs.existsSync(path.join(userDir, 'agents.yaml'))).toBe(false);
  });

  it('is idempotent against a tracked mirror across repeated runs', () => {
    fs.writeFileSync(path.join(systemDir, 'agents.yaml'), 'hooks: {}\n');
    git(systemDir, 'init', '-q');
    git(systemDir, 'add', 'agents.yaml');
    git(systemDir, 'commit', '-q', '-m', 'ship', '--no-gpg-sign');

    migrateAgentsYaml(systemDir, userDir);
    migrateAgentsYaml(systemDir, userDir);

    expect(fs.existsSync(path.join(systemDir, 'agents.yaml'))).toBe(true);
    expect(porcelain(systemDir)).toBe('');
  });

  it('still migrates an UNTRACKED legacy agents.yaml out of a non-git system dir', () => {
    // Pre-split residue: the system dir is not a git repo, so the file is safe
    // to move into the user dir.
    fs.writeFileSync(path.join(systemDir, 'agents.yaml'), 'agents:\n  claude: "1.0.0"\n');

    migrateAgentsYaml(systemDir, userDir);

    expect(fs.existsSync(path.join(systemDir, 'agents.yaml'))).toBe(false);
    expect(fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf-8')).toContain('claude');
  });
});
