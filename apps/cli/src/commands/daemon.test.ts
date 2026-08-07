/**
 * End-to-end CLI subprocess tests for `agents daemon` (RUSH-2354).
 *
 * Every test spawns the real CLI against an isolated mkdtemp HOME with no
 * daemon running — no mocks. Modeled on routines.test.ts. Replaces
 * daemon-removal.test.ts, which pinned the command group as intentionally
 * absent; it is absent no longer.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const TSX_IMPORT = pathToFileURL(require.resolve('tsx')).href;
const CLI_ENTRYPOINT = path.join(REPO_ROOT, 'src', 'index.ts');

// win32: subprocess CLI + process-group signals / path spawn assumptions (RUSH-2215).
const describeDaemon = process.platform === 'win32' ? describe.skip : describe;

/** Provision an isolated HOME with just enough scaffolding for the CLI to boot. */
function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-daemon-test-'));
  fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents: {}\n');
  return home;
}

/** Run `agents daemon <args>` against an isolated HOME — no daemon process ever started. */
function run(home: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('node', ['--import', TSX_IMPORT, CLI_ENTRYPOINT, 'daemon', ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENTS_SKIP_MIGRATION: '1',
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
      AGENTS_DAEMON_DIR: path.join(home, '.agents', '.cache', 'helpers', 'daemon'),
    },
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

describeDaemon('agents daemon', () => {
  it('resolves as a real command — the group daemon-removal.test.ts used to pin absent', () => {
    const res = run(makeHome(), ['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("unknown command 'daemon'");
    expect(res.stdout).toContain('status');
    expect(res.stdout).toContain('services');
    expect(res.stdout).toContain('logs');
    expect(res.stdout).toContain('doctor');
    // No `jobs` subcommand — scheduled work is `agents routines`, always.
    expect(res.stdout).not.toMatch(/^\s*jobs\b/m);
  });

  it('status --json reports stopped with no pid when no daemon is running for THIS install', () => {
    const res = run(makeHome(), ['status', '--json']);
    expect(res.status).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.state).toBe('stopped');
    expect(payload.pid).toBeNull();
    // `duplicates` scans every __daemon-run process on the BOX, not scoped to
    // this test's isolated HOME (that is the point of the duplicates check —
    // it must see stray daemons from other installs). On a dev machine with a
    // real daemon running this is legitimately non-empty; assert the shape,
    // not host-dependent contents.
    expect(Array.isArray(payload.duplicates)).toBe(true);
    for (const d of payload.duplicates) {
      expect(typeof d.pid).toBe('number');
    }
    expect(payload.daemonEnabled).toBe(true);
    expect(payload.services.secretsBroker).toHaveProperty('reachable', false);
    expect(payload.services.browserIpc).toHaveProperty('bound', false);
    expect(payload.scheduler).toEqual(
      expect.objectContaining({ routineCount: 0, enabledCount: 0, failingCount: 0 }),
    );
  });

  it('bare `agents daemon` (no subcommand) is the same as `status`', () => {
    const home = makeHome();
    const bare = run(home, ['--json']);
    const status = run(home, ['status', '--json']);
    expect(JSON.parse(bare.stdout).state).toBe(JSON.parse(status.stdout).state);
  });

  it('disable persists daemon.enabled: false and status reflects it as "disabled"', () => {
    const home = makeHome();
    const disable = run(home, ['disable']);
    expect(disable.status).toBe(0);
    expect(disable.stdout).toContain('daemon.enabled: false');

    const status = run(home, ['status', '--json']);
    const payload = JSON.parse(status.stdout);
    expect(payload.state).toBe('disabled');
    expect(payload.daemonEnabled).toBe(false);

    // Persisted to disk, not just in-process — a fresh CLI invocation (the
    // status call above) reads it back, and the on-disk device doc exists.
    const devicesDir = path.join(home, '.agents', 'devices');
    expect(fs.existsSync(devicesDir)).toBe(true);
    const [device] = fs.readdirSync(devicesDir);
    const doc = fs.readFileSync(path.join(devicesDir, device, 'agents.yaml'), 'utf-8');
    expect(doc).toContain('daemonEnabled: false');
  });

  it('enable clears the kill switch again', () => {
    const home = makeHome();
    run(home, ['disable']);
    const enable = run(home, ['enable']);
    expect(enable.status).toBe(0);
    expect(enable.stdout).toContain('daemon.enabled: true');
    const status = run(home, ['status', '--json']);
    expect(JSON.parse(status.stdout).daemonEnabled).toBe(true);
    expect(JSON.parse(status.stdout).state).toBe('stopped');
  });

  it('a disabled device refuses `agents routines start` with a message naming the fix', () => {
    const home = makeHome();
    run(home, ['disable']);
    const res = spawnSync('node', ['--import', TSX_IMPORT, CLI_ENTRYPOINT, 'routines', 'start'], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: home, USERPROFILE: home, AGENTS_SKIP_MIGRATION: '1', AGENTS_NO_AUTOPULL: '1', AGENTS_CLI_DISABLE_AUTO_UPDATE: '1' },
      encoding: 'utf-8',
      timeout: 30_000,
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr + res.stdout).toContain('daemon.enabled=false');
    expect(res.stderr + res.stdout).toContain('agents daemon enable');
  });

  it('services --json reports both hosted services with a socket path even when unreachable', () => {
    const res = run(makeHome(), ['services', '--json']);
    expect(res.status).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.secretsBroker.reachable).toBe(false);
    expect(typeof payload.secretsBroker.socketPath).toBe('string');
    expect(payload.browserIpc.bound).toBe(false);
    expect(typeof payload.browserIpc.socketPath).toBe('string');
  });

  it('logs reports no matching lines when no daemon has ever logged', () => {
    const res = run(makeHome(), ['logs']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('No matching log lines');
  });

  it('logs --json returns an empty array, not a crash, with no log file', () => {
    const res = run(makeHome(), ['logs', '--json']);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual([]);
  });

  it('doctor exits non-zero and names the problem when the daemon should be running but is not', () => {
    const res = run(makeHome(), ['doctor']);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('Daemon is not running');
  });

  it('doctor does not flag "not running" once the daemon is disabled for this device', () => {
    // Duplicate-process and hosted-service problems can still fire here — the
    // scan is box-wide (see the status --json test) and this dev machine may
    // have a real daemon running under a different install. What disabling
    // controls is specifically the "should be running but isn't" check.
    const home = makeHome();
    run(home, ['disable']);
    const res = run(home, ['doctor']);
    expect(res.stdout).not.toContain('Daemon is not running');
  });

  it('stop on a device with no running daemon is a clean no-op', () => {
    const res = run(makeHome(), ['stop']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('not running');
  });

  it('reload with no running daemon reports nothing to reload rather than crashing', () => {
    const res = run(makeHome(), ['reload']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('not running');
  });
});
