import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `agents teams add <team> <teammate> <task> --device auto` used to reject
 * with "Couldn't resolve --device 'auto'" (RUSH-2185) because only `agents
 * run --device auto` pre-processed the `auto` affinity sentinel before it
 * reached the host resolver. It now resolves through the same shared core
 * (matchHost in ../lib/hosts/registry.ts) that `agents ssh auto` uses.
 *
 * Real CLI, real filesystem, no mocking: drive the built entrypoint against a
 * throwaway HOME with no devices registered under a unique machine id. With no
 * signed-in harness in that isolated home, authoritative placement must reach
 * the shared resolver and fail loud with "no healthy device" — deterministic
 * without needing a real device fleet.
 */
describe.skipIf(process.platform === 'win32')('agents teams add --device auto (RUSH-2185)', () => {
  let home: string;
  const machineId = 'device-auto-test-box';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-device-auto-'));
    // The CLI refuses to run before setup; the gate is just "is
    // ~/.agents/.system a git repo" (same as view.isolated.integration.test.ts).
    const systemDir = path.join(home, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: systemDir, stdio: 'ignore' });
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function runAdd(team: string): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(
      'bun',
      [path.resolve(process.cwd(), 'src/index.ts'), 'teams', 'add', team, 'claude', 'task', '--device', 'auto'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          AGENTS_SYNC_MACHINE_ID: machineId,
          AGENTS_NO_NUDGE: '1',
          FORCE_COLOR: '0',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return {
      status: result.status ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  it('resolves `auto` instead of rejecting "Unknown device" / "Couldn\'t resolve --device"', () => {
    const { status, stdout, stderr } = runAdd('device-auto-add-test');
    const out = stdout + stderr;

    expect(status).not.toBe(0);
    expect(out).not.toContain(`Unknown device 'auto'`);
    expect(out).not.toContain(`Couldn't resolve --device "auto"`);
    expect(out).not.toContain(`Unknown teammate 'claude'`);
    expect(out).not.toContain('device=auto → local');
    expect(out).toContain('agents: no healthy device can run claude');
  });
});
