/**
 * End-to-end CLI subprocess tests for `agents daemon` (RUSH-2354).
 *
 * Every test spawns the real CLI against an isolated mkdtemp HOME with no
 * daemon running — no mocks. Modeled on routines.test.ts. Replaces
 * daemon-removal.test.ts, which pinned the command group as intentionally
 * absent; it is absent no longer.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'child_process';
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

/**
 * Spawn a real, long-lived process whose command line ends in `__daemon-run`
 * (so `isDaemonRunProcess`'s `ps` check accepts it — see
 * `lib/daemon.test.ts`'s "reaps a live __daemon-run registrant" test, same
 * technique) and register it in `home`'s OWN instance registry, exactly the
 * marker `registerDaemonInstance` would write. A real live process, not a
 * mock — `agents daemon status` reads it through the actual registry +
 * `ps`-liveness path, the same one the reaper and `stopDaemon`'s postcondition
 * use.
 */
async function spawnFakeRegisteredDaemon(home: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', '__daemon-run'], {
    stdio: 'ignore',
  });
  // Give the exec a moment to land before `ps` (read by the status command's
  // isDaemonRunProcess check) is asked to see its real argv — mirrors
  // lib/daemon.test.ts's identical fake-daemon technique.
  await new Promise((r) => setTimeout(r, 150));
  const instancesDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon', 'instances');
  fs.mkdirSync(instancesDir, { recursive: true });
  fs.writeFileSync(path.join(instancesDir, String(child.pid)), '__daemon-run', 'utf-8');
  return child;
}

function killFakeDaemon(child: ChildProcess): void {
  try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
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
    // `duplicates` is scoped to THIS install's instance registry (RUSH-2368),
    // which lives inside the isolated AGENTS_DAEMON_DIR this test set. Nothing
    // has ever registered there, so it is always empty here — whatever else is
    // running on the dev machine (or on another test's isolated HOME) is a
    // different registry and never appears, by construction, not by luck.
    expect(payload.duplicates).toEqual([]);
    expect(payload.daemonEnabled).toBe(true);
    expect(payload.services.secretsBroker).toHaveProperty('reachable', false);
    expect(payload.services.browserIpc).toHaveProperty('bound', false);
    // Daemon housekeeping (watchdog, device-probe, ...) are plain daemon-core
    // timers, NOT routines (RUSH-2495), so a fresh install with nothing on disk
    // carries zero scheduled routines.
    expect(payload.scheduler).toEqual(
      expect.objectContaining({
        routineCount: 0,
        enabledCount: 0,
        failingCount: 0,
      }),
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

    // Persisted to disk, not just in-process — the status call above is a fresh
    // CLI invocation that read it back. It lands in THIS machine's own doc, not
    // the fleet-shared agents.yaml: the kill switch is machine-local, so syncing
    // it would disable the daemon on every box that pulls.
    // The doc is keyed by this machine's id, which the test does not pin — read
    // whichever device dir the CLI created rather than hardcoding a name.
    const devicesDir = path.join(home, '.agents', 'devices');
    const [machineDir] = fs.readdirSync(devicesDir);
    const localDoc = fs.readFileSync(path.join(devicesDir, machineDir, 'agents.yaml'), 'utf-8');
    expect(localDoc).toContain('daemonEnabled: false');
    const central = fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
    expect(central).not.toContain('daemonEnabled');
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

  // RUSH-2418: the auto-start circuit breaker tells the operator to "Run
  // 'agents daemon doctor'", so doctor has to be able to answer them. Before
  // this, `runDoctor` read only the secrets-broker and browser-IPC health
  // records, so following that instruction produced "Daemon is not running.
  // Start it: agents daemon start" — the exact action the breaker had just
  // refused, with no mention of a breaker, a streak, or the cause.
  it('doctor reports an open auto-start circuit breaker, with the recorded cause', () => {
    const home = makeHome();
    const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
    fs.mkdirSync(daemonDir, { recursive: true });
    // The record a run of failed starts leaves behind, written in the same shape
    // recordSubsystemError produces.
    fs.writeFileSync(path.join(daemonDir, 'health.json'), JSON.stringify({
      'daemon-start': {
        subsystem: 'daemon-start',
        lastError: 'start issued; no daemon has reported healthy since',
        lastErrorAt: new Date().toISOString(),
        consecutiveFailures: 5,
        lastOkAt: null,
      },
    }), 'utf-8');

    const res = run(home, ['doctor', '--json']);
    expect(res.status).toBe(1);
    const problems: string[] = JSON.parse(res.stdout).problems;
    const breaker = problems.find((p) => p.includes('auto-start is disabled'));
    expect(breaker).toBeDefined();
    expect(breaker).toContain('5 consecutive');
    expect(breaker).toContain('start issued; no daemon has reported healthy since');
  });

  // A start is marked failed the moment it is issued and cleared once the daemon
  // finishes booting, so a sub-threshold streak on a LIVE daemon is just the boot
  // window — reporting it would be a false alarm that clears itself a second
  // later. The open breaker is still reported unconditionally; only the
  // sub-threshold warning is scoped to a daemon that is actually down.
  it('doctor does not report a sub-threshold start streak while the daemon is running', () => {
    const home = makeHome();
    const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.writeFileSync(path.join(daemonDir, 'health.json'), JSON.stringify({
      'daemon-start': {
        subsystem: 'daemon-start',
        lastError: 'start issued; no daemon has reported healthy since',
        lastErrorAt: new Date().toISOString(),
        consecutiveFailures: 1,
        lastOkAt: null,
      },
    }), 'utf-8');
    // A live "daemon": this test process, recorded as the pid-file owner, so
    // getDaemonStatus() reports running against a real live pid.
    fs.writeFileSync(path.join(daemonDir, 'daemon.pid'), String(process.pid), 'utf-8');

    const res = run(home, ['doctor', '--json']);
    const problems: string[] = JSON.parse(res.stdout).problems;
    expect(problems.some((p) => p.includes('consecutive failure'))).toBe(false);
    expect(problems.some((p) => p.includes('Daemon is not running'))).toBe(false);
  });

  it('doctor does not flag "not running" once the daemon is disabled for this device', () => {
    // Hosted-service problems can still fire here — the secrets broker/browser
    // IPC probes are real sockets, not scoped to this install. Duplicate-process
    // problems cannot: they are scoped to THIS install's instance registry
    // (RUSH-2368), which is always empty for a fresh isolated HOME. What
    // disabling controls is specifically the "should be running but isn't" check.
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

  it(
    'duplicates come from THIS install\'s instance registry — a fixture daemon under a separate ' +
    'AGENTS_DAEMON_DIR never appears, even though a genuine same-registry duplicate does (RUSH-2368)',
    async () => {
      const home = makeHome();
      const otherHome = makeHome();
      let ownDuplicate: ChildProcess | undefined;
      let foreignFixture: ChildProcess | undefined;
      try {
        // A real __daemon-run process registered in `home`'s OWN registry — a
        // genuine duplicate (e.g. a predecessor that crashed without cleanup).
        ownDuplicate = await spawnFakeRegisteredDaemon(home);
        // A real __daemon-run process registered in a COMPLETELY SEPARATE
        // registry (`otherHome`) — standing in for the leaked vitest fixture
        // this ticket was filed over: same box, different HOME, therefore a
        // different getDaemonDir() and a different registry. A raw `ps` scan
        // sees both processes identically; the registry does not.
        foreignFixture = await spawnFakeRegisteredDaemon(otherHome);

        const res = run(home, ['status', '--json']);
        expect(res.status).toBe(0);
        const payload = JSON.parse(res.stdout);
        const duplicatePids = payload.duplicates.map((d: { pid: number }) => d.pid);
        expect(duplicatePids).toContain(ownDuplicate.pid);
        expect(duplicatePids).not.toContain(foreignFixture.pid);
      } finally {
        if (ownDuplicate) killFakeDaemon(ownDuplicate);
        if (foreignFixture) killFakeDaemon(foreignFixture);
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(otherHome, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    'a subsystem whose last-ok record is stale but is unreachable RIGHT NOW never renders "healthy" (RUSH-2368)',
    () => {
      const home = makeHome();
      try {
        // Simulate a daemon that hosted the secrets broker earlier in its life
        // (recordSubsystemOk at startup) and has since gone unreachable — the
        // exact shape of the real bug: `health.json` still says "last ok" with
        // zero consecutive failures, while nothing is listening on the socket
        // right now. Written directly in the persisted format `daemon-health.ts`
        // itself writes, read back through the real `readSubsystemHealth` path.
        const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
        fs.mkdirSync(daemonDir, { recursive: true });
        fs.writeFileSync(
          path.join(daemonDir, 'health.json'),
          JSON.stringify({
            'secrets-broker': {
              subsystem: 'secrets-broker',
              lastError: null,
              lastErrorAt: null,
              consecutiveFailures: 0,
              lastOkAt: new Date(Date.now() - 60_000).toISOString(),
            },
          }),
          'utf-8',
        );

        const res = run(home, ['services']);
        expect(res.status).toBe(0);
        // The old bug: a line reading "healthy  secrets broker  (unreachable)".
        // No daemon is listening on this socket, so the live probe MUST win —
        // the record's stale zero-failure streak must never render "healthy".
        expect(res.stdout).not.toMatch(/healthy\s+secrets broker/);
        expect(res.stdout).toContain('(unreachable)');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
