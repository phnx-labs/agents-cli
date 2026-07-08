import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';

// `config.remote` flows from disk (~/.agents/.cache/drive/config.json) into the
// argv of rsync/ssh. A tampered config could carry shell metacharacters or a
// leading-dash argv flag. These tests exercise the REAL compiled drive-sync
// module against fake `rsync`/`ssh` binaries on PATH and assert two things:
//   1. A tainted remote is rejected by assertValidRemote on EVERY read, before
//      any exec — so the fake binary's `pwned` marker is never created.
//   2. A well-formed remote is handed to rsync/ssh as a single literal argv
//      element, never shell-evaluated.

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-drive-'));
  tempDirs.push(dir);
  return dir;
}

const moduleUrl = pathToFileURL(path.resolve('dist/lib/drive-sync.js')).href;

/** Drive config dir for a given fake HOME (mirrors getDriveDir's layout). */
function driveDir(home: string): string {
  return path.join(home, '.agents', '.cache', 'drive');
}

/** Plant a config.json on disk with the given remote value. */
function writeRemoteConfig(home: string, remote: string | null): void {
  const dir = driveDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ remote, attached: false, previousTargets: null, lastPull: null, lastPush: null }, null, 2),
    'utf-8'
  );
}

/**
 * Write fake `rsync` and `ssh` binaries that log their argv (one ARG per line)
 * and create a `pwned` file iff a shell ever interpolates the remote. Returns
 * the bin dir to prepend to PATH and the marker path that must never appear.
 */
function writeFakeTools(home: string): { binDir: string; logPath: string; pwnedPath: string } {
  const binDir = path.join(home, 'fakebin');
  fs.mkdirSync(binDir, { recursive: true });
  const logPath = path.join(home, 'argv.log');
  const pwnedPath = path.join(home, 'pwned');
  const body = [
    '#!/bin/sh',
    `LOG_FILE='${logPath}'`,
    `printf "CMD:%s\\n" "$0" >> "$LOG_FILE"`,
    'for arg do',
    '  printf "ARG:%s\\n" "$arg" >> "$LOG_FILE"',
    'done',
    'exit 0',
    '',
  ].join('\n');
  for (const name of ['rsync', 'ssh']) {
    const p = path.join(binDir, name);
    fs.writeFileSync(p, body, 'utf-8');
    fs.chmodSync(p, 0o755);
  }
  return { binDir, logPath, pwnedPath };
}

function runDrive(home: string, binDir: string, expression: string): { ok: boolean; error?: string } {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import * as drive from ${JSON.stringify(moduleUrl)};
    try {
      const r = await (${expression});
      console.log(JSON.stringify({ ok: true, result: r }));
    } catch (err) {
      console.log(JSON.stringify({ ok: false, error: err.message }));
    }
  `], {
    env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    encoding: 'utf-8',
  });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// POSIX-only: these tests stand up `#!/bin/sh` fake `rsync`/`ssh` binaries on
// PATH, which Windows can't execute (and rsync/ssh are absent → ENOENT).
describe.skipIf(process.platform === 'win32')('drive sync remote validation', () => {
  const malicious = [
    'evil; touch pwned@host',
    'a@host`touch pwned`',
    'a@host$(touch pwned)',
    'a@host|touch pwned',
    'a@host && touch pwned',
    '-e/bin/sh@host',          // leading-dash argv-flag injection
    '$(touch pwned)@host',
  ];

  for (const remote of malicious) {
    it(`rejects a tainted remote on pull, never reaching rsync: ${JSON.stringify(remote)}`, () => {
      const home = makeTempHome();
      const { binDir, pwnedPath } = writeFakeTools(home);
      writeRemoteConfig(home, remote);

      const outcome = runDrive(home, binDir, "drive.pull()");

      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain('Invalid drive remote');
      // The fake rsync was never invoked, and no shell expanded the metachars.
      expect(fs.existsSync(pwnedPath)).toBe(false);
      expect(fs.existsSync(path.join(home, 'argv.log'))).toBe(false);
    });

    it(`rejects a tainted remote on push, never reaching ssh/rsync: ${JSON.stringify(remote)}`, () => {
      const home = makeTempHome();
      const { binDir, pwnedPath } = writeFakeTools(home);
      writeRemoteConfig(home, remote);

      const outcome = runDrive(home, binDir, "drive.push()");

      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain('Invalid drive remote');
      expect(fs.existsSync(pwnedPath)).toBe(false);
      expect(fs.existsSync(path.join(home, 'argv.log'))).toBe(false);
    });

    it(`rejects a tainted remote at setRemote write-time: ${JSON.stringify(remote)}`, () => {
      const home = makeTempHome();
      const { binDir } = writeFakeTools(home);

      const outcome = runDrive(home, binDir, `(async () => drive.setRemote(${JSON.stringify(remote)}))()`);

      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain('Invalid drive remote');
      // Nothing was persisted.
      expect(fs.existsSync(path.join(driveDir(home), 'config.json'))).toBe(false);
    });
  }

  it('passes a well-formed remote to rsync as one literal argv element', () => {
    const home = makeTempHome();
    const { binDir, logPath, pwnedPath } = writeFakeTools(home);
    writeRemoteConfig(home, 'user@host');

    const outcome = runDrive(home, binDir, "drive.pull()");

    expect(outcome.ok, outcome.error).toBe(true);
    const log = fs.readFileSync(logPath, 'utf-8');
    // The remote spec is exactly one argv element — `:` is not a shell op, and
    // no metacharacters were present to expand. No pwned marker possible.
    expect(log).toContain('ARG:-az');
    expect(log).toContain('ARG:--exclude=config.json');
    expect(log).toContain('ARG:user@host:~/.agents/drive/');
    expect(fs.existsSync(pwnedPath)).toBe(false);
  });

  it('passes a well-formed remote to ssh + rsync as literal argv on push', () => {
    const home = makeTempHome();
    const { binDir, logPath, pwnedPath } = writeFakeTools(home);
    writeRemoteConfig(home, 'user@host');

    const outcome = runDrive(home, binDir, "drive.push()");

    expect(outcome.ok, outcome.error).toBe(true);
    const log = fs.readFileSync(logPath, 'utf-8');
    // ssh gets the remote as a bare argv element and the mkdir command as a
    // single positional string — no local shell sees either.
    expect(log).toContain('ARG:user@host');
    expect(log).toContain('ARG:mkdir -p ~/.agents/drive');
    expect(log).toContain('ARG:user@host:~/.agents/drive/');
    expect(fs.existsSync(pwnedPath)).toBe(false);
  });
});
