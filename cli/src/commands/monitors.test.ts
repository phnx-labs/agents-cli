/**
 * End-to-end CLI subprocess tests for `agents monitors` inspection output.
 *
 * Each test spawns the real CLI against an isolated HOME with real monitor YAML
 * and history files. This catches Commander flag wiring plus stdout/stderr
 * stream regressions without mocking monitor internals.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-monitors-test-'));
  const agentsDir = path.join(home, '.agents');
  fs.mkdirSync(path.join(agentsDir, 'monitors'), { recursive: true });
  fs.mkdirSync(path.join(agentsDir, '.system', '.git'), { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'agents.yaml'), 'agents: {}\n');
  return home;
}

function writeMonitor(home: string, monitor: Record<string, unknown>): void {
  const monitorsDir = path.join(home, '.agents', 'monitors');
  fs.writeFileSync(path.join(monitorsDir, `${monitor.name}.yml`), yaml.stringify(monitor));
}

function writeState(home: string, name: string): void {
  const dir = path.join(home, '.agents', '.history', 'monitors', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      monitorName: name,
      lastHash: 'hash',
      lastValue: 'previous build output',
      lastSeenAt: '2026-07-21T12:00:00.000Z',
      lastFiredAt: '2026-07-21T12:01:00.000Z',
    }),
  );
}

function writeFire(home: string, name: string): void {
  const dir = path.join(home, '.agents', '.history', 'monitors', name, 'fires', '2026-07-21T12-01-00-000Z');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'event.json'),
    JSON.stringify({
      monitorName: name,
      firedAt: '2026-07-21T12:01:00.000Z',
      summary: 'build failed',
      payload: { exitCode: 1 },
      action: 'notify',
      ok: true,
    }),
  );
}

function statePath(home: string, name: string): string {
  return path.join(home, '.agents', '.history', 'monitors', name, 'state.json');
}

function writeSystemMonitor(home: string, monitor: Record<string, unknown>): void {
  const dir = path.join(home, '.agents', '.system', 'monitors');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${monitor.name}.yml`), yaml.stringify(monitor));
}

function run(home: string, args: string[], extraEnv: Record<string, string> = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', 'monitors', ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...extraEnv,
      HOME: home,
      // os.homedir() reads USERPROFILE on Windows, so HOME alone leaves the
      // spawned CLI resolving the real profile ('agents-cli is not set up').
      USERPROFILE: home,
      // The pinned PATH keeps the run hermetic on POSIX — it must NOT be
      // widened to include the running node's dir, because that also exposes a
      // second globally-installed `agents` (e.g. /opt/homebrew/bin) and the CLI
      // then prints "Multiple agents-cli installs detected" on stderr. Fixtures
      // that need node spell it absolutely instead. The pin can't apply on
      // Windows, where those directories don't exist and the child would lose
      // node/git entirely (that failure showed as empty stderr).
      PATH: process.platform === 'win32' ? (process.env.PATH ?? '') : '/usr/local/bin:/usr/bin:/bin',
      AGENTS_SKIP_MIGRATION: '1',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

describe('monitors inspection JSON and stderr', () => {
  it('view --json prints config, state, and recent fires as clean JSON on stdout', () => {
    const home = makeHome();
    writeMonitor(home, {
      name: 'ci',
      enabled: true,
      source: { type: 'poll', command: 'echo fail', interval: '30s' },
      condition: { mode: 'match', match: 'fail' },
      action: { type: 'notify', notifyChannel: 'telegram' },
    });
    writeState(home, 'ci');
    writeFire(home, 'ci');

    const res = run(home, ['view', 'ci', '--json']);

    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    expect(res.stdout).not.toContain('Monitor:');
    const payload = JSON.parse(res.stdout);
    expect(payload.name).toBe('ci');
    expect(payload.monitor.source.command).toBe('echo fail');
    expect(payload.state.lastValue).toBe('previous build output');
    expect(payload.recentFires).toHaveLength(1);
    expect(payload.recentFires[0].summary).toBe('build failed');
  });

  it('test --json evaluates once, prints the dry-run decision as JSON, and writes no state', () => {
    const home = makeHome();
    // The monitor command runs through the host shell, so it has to be
    // shell-portable. printf doesn't exist on cmd.exe, and node -e "..." loses
    // its quoting there (node received a literal leading quote and threw
    // SyntaxError). A script file sidesteps shell quoting entirely: the command
    // doesn't open with a quote, and run() puts the running node's directory on
    // PATH so the bare name resolves on both platforms.
    const emitter = path.join(home, 'emit-fixture.cjs');
    fs.writeFileSync(emitter, "process.stdout.write('build fail\\nnext\\n');\n");
    writeMonitor(home, {
      name: 'ci',
      enabled: true,
      // Unquoted: on Windows the quotes survive into the argument and node
      // looks for a path with literal quote characters in it. mkdtemp paths
      // carry no spaces on either platform, so they aren't needed.
      //
      // POSIX spells node absolutely because the pinned PATH above deliberately
      // excludes it. Windows can't: process.execPath there is
      // "C:\Program Files\nodejs\node.exe" and cmd.exe mangles a command line
      // opening with a quoted path containing spaces — but PATH is inherited on
      // Windows, so the bare name resolves.
      source: {
        type: 'command',
        command: process.platform === 'win32' ? `node ${emitter}` : `${process.execPath} ${emitter}`,
      },
      condition: { mode: 'match', match: 'fail' },
      action: { type: 'notify', notifyChannel: 'telegram' },
    });

    const res = run(home, ['test', 'ci', '--json']);

    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    expect(res.stdout).not.toContain('Dry-run:');
    const payload = JSON.parse(res.stdout);
    expect(payload.name).toBe('ci');
    expect(payload.dryRun).toBe(true);
    expect(payload.observation.raw).toBe('build fail\nnext');
    expect(payload.observation.meta.exitCode).toBe(0);
    expect(payload.wouldFire).toBe(true);
    expect(payload.decision.value).toBe('fail');
    expect(payload.decision.event.summary).toBe('fail');
    expect(fs.existsSync(statePath(home, 'ci'))).toBe(false);
  });

  it('missing monitor errors go to stderr, including in --json mode', () => {
    const home = makeHome();

    for (const cmd of ['view', 'test']) {
      const res = run(home, [cmd, 'missing', '--json']);
      expect(res.status).toBe(1);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain("Monitor 'missing' not found");
    }
  });

  it('add validation errors go to stderr and leave stdout clean', () => {
    const home = makeHome();

    const res = run(home, ['add', 'bad', '--poll', 'echo fail', '30s', '--run', 'claude']);

    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('Validation errors:');
    expect(res.stderr).toContain("action.type 'run' requires action.prompt");
  });

  it('add does not auto-start the daemon when daemon.enabled=false (PHNX-2637)', () => {
    const home = makeHome();
    const deviceDir = path.join(home, '.agents', 'devices', 'testbox');
    fs.mkdirSync(deviceDir, { recursive: true });
    fs.writeFileSync(path.join(deviceDir, 'agents.yaml'), 'config:\n  daemonEnabled: false\n');

    const res = run(home, ['add', 'ci', '--poll', 'echo fail', '30s', '--match', 'fail', '--notify'], {
      AGENTS_SYNC_MACHINE_ID: 'testbox',
      AGENTS_MONITORS_LOCAL: '1',
    });
    const out = `${res.stdout}${res.stderr}`;
    const pidPath = path.join(home, '.agents', '.cache', 'helpers', 'daemon', 'daemon.pid');

    try {
      expect(res.status).toBe(0);
      expect(out).toContain("Monitor 'ci' added");
      expect(out).toContain('daemon.enabled=false');
      expect(out).toContain('agents daemon enable');
      expect(out).not.toContain('Daemon started');
      // Refused auto-start must skip the 12s engine-pickup wait.
      expect(out).not.toContain('waiting for the engine');
      expect(fs.existsSync(path.join(home, '.agents', 'monitors', 'ci.yml'))).toBe(true);
      expect(fs.existsSync(pidPath)).toBe(false);
    } finally {
      if (fs.existsSync(pidPath)) {
        try {
          const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
          if (Number.isFinite(pid) && pid > 0) process.kill(pid, 'SIGTERM');
        } catch { /* already gone */ }
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // POSIX-only: uses `true` as a no-op $EDITOR; cmd.exe has no equivalent.
  it.skipIf(process.platform === 'win32')(
    'edit on a system built-in materializes a user copy and never writes the system mirror',
    () => {
      const home = makeHome();
      const sysFile = path.join(home, '.agents', '.system', 'monitors', 'ci-built-in.yml');
      // A built-in with no `enabled:` field (opt-in) and no user copy.
      writeSystemMonitor(home, {
        name: 'ci-built-in',
        source: { type: 'poll', command: 'echo hi', interval: '30s' },
        condition: { mode: 'on-change' },
        action: { type: 'notify', notifyChannel: 'telegram' },
      });
      const sysBefore = fs.readFileSync(sysFile, 'utf-8');

      // `true` ignores its file arg and exits 0, so the editor is a no-op.
      const res = run(home, ['edit', 'ci-built-in'], { EDITOR: 'true' });
      expect(res.status).toBe(0);

      // A user copy now exists, prefilled from the built-in's own config.
      const userFile = path.join(home, '.agents', 'monitors', 'ci-built-in.yml');
      expect(fs.existsSync(userFile)).toBe(true);
      expect(yaml.parse(fs.readFileSync(userFile, 'utf-8')).source.command).toBe('echo hi');

      // The system mirror is byte-for-byte untouched.
      expect(fs.readFileSync(sysFile, 'utf-8')).toBe(sysBefore);
    },
  );
});

/**
 * PHNX-2842: `agents monitors runs` used to print `ok` for a completed agent
 * that did nothing. Real CLI subprocess against an isolated HOME: fire
 * recorded ok:true off a running snapshot, run later settled completed, and
 * the postcondition (a real node process exiting 1) proves the intended
 * effect did not happen.
 */
describe('monitors runs postcondition (PHNX-2842)', () => {
  function writeRun(home: string, name: string, runId: string, status: string): void {
    const dir = path.join(home, '.agents', '.history', 'runs', name, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      jobName: name,
      runId,
      agent: 'claude',
      pid: null,
      status,
      startedAt: '2026-08-20T16:48:18.000Z',
      completedAt: status === 'running' ? null : '2026-08-20T16:50:00.000Z',
      exitCode: status === 'completed' ? 0 : 1,
    }));
  }

  function writeRunFire(home: string, name: string, runId: string, postcondition: string): void {
    const dir = path.join(home, '.agents', '.history', 'monitors', name, 'fires', '2026-08-20T16-48-18-000Z');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'event.json'), JSON.stringify({
      monitorName: name,
      firedAt: '2026-08-20T16:48:18.000Z',
      summary: 'phnx-labs/agents-cli#1682',
      payload: {},
      runId,
      action: 'run',
      ok: true,
      runStatusAtFire: 'running',
      postcondition,
    }));
  }

  function failPostcondition(): string {
    return process.platform === 'win32'
      ? `"${process.execPath}" -e "process.exit(1)"`
      : `${JSON.stringify(process.execPath)} -e 'process.exit(1)'`;
  }

  it('runs prints "no effect" when the agent completed but the postcondition failed', () => {
    const home = makeHome();
    writeMonitor(home, {
      name: 'merge-pr-1682',
      enabled: true,
      source: { type: 'poll', command: 'echo x', interval: '5m' },
      condition: { mode: 'every' },
      action: { type: 'run', agent: 'claude', prompt: 'merge {event}', postcondition: failPostcondition() },
    });
    writeRun(home, 'merge-pr-1682', 'run-noop', 'completed');
    writeRunFire(home, 'merge-pr-1682', 'run-noop', failPostcondition());

    const res = run(home, ['runs', 'merge-pr-1682']);
    expect(res.status).toBe(0);
    // Before the fix this line was `ok`. After: the postcondition failed, so
    // the fire is visibly not success.
    expect(res.stdout).toContain('no effect');
    expect(res.stdout).not.toMatch(/\bok\b/);
    expect(res.stdout).toContain('postcondition not met');
  });

  it('add --postcondition persists the command on the run action', () => {
    const home = makeHome();
    const deviceDir = path.join(home, '.agents', 'devices', 'testbox');
    fs.mkdirSync(deviceDir, { recursive: true });
    fs.writeFileSync(path.join(deviceDir, 'agents.yaml'), 'config:\n  daemonEnabled: false\n');

    const res = run(home, [
      'add', 'merge-check',
      '--poll', 'echo x', '5m',
      '--every',
      '--run', 'claude',
      '--prompt', 'merge {event}',
      '--postcondition', 'exit 0',
    ], {
      AGENTS_SYNC_MACHINE_ID: 'testbox',
      AGENTS_MONITORS_LOCAL: '1',
    });
    const file = path.join(home, '.agents', 'monitors', 'merge-check.yml');
    expect(fs.existsSync(file), `${res.stdout}\n${res.stderr}`).toBe(true);
    const parsed = yaml.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.action.postcondition).toBe('exit 0');
    expect(`${res.stdout}${res.stderr}`).not.toContain('no --postcondition');
  });

  it('add --run without --postcondition warns that completed-exit-0 still records as ok', () => {
    const home = makeHome();
    const deviceDir = path.join(home, '.agents', 'devices', 'testbox');
    fs.mkdirSync(deviceDir, { recursive: true });
    fs.writeFileSync(path.join(deviceDir, 'agents.yaml'), 'config:\n  daemonEnabled: false\n');

    const res = run(home, [
      'add', 'investigate',
      '--poll', 'echo fail', '30s',
      '--match', 'fail',
      '--run', 'claude',
      '--prompt', 'diagnose {event}',
    ], {
      AGENTS_SYNC_MACHINE_ID: 'testbox',
      AGENTS_MONITORS_LOCAL: '1',
    });
    expect(res.status).toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain('no --postcondition');
  });
});
