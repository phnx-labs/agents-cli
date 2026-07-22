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

function run(home: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', 'monitors', ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: '/usr/local/bin:/usr/bin:/bin',
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
    writeMonitor(home, {
      name: 'ci',
      enabled: true,
      source: { type: 'command', command: "printf 'build fail\\nnext\\n'" },
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
});
