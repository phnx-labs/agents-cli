import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
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
 * throwaway HOME with no devices registered under a unique machine id, which
 * makes the affinity engine's only eligible candidate "this machine" —
 * deterministic without needing a real device fleet. The teammate name is
 * deliberately invalid so the command fails fast on `unknown-teammate`
 * *after* device resolution, instead of spawning a real agent process.
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
    try {
      const stdout = execFileSync(
        'bun',
        [path.resolve(process.cwd(), 'src/index.ts'), 'teams', 'add', team, 'not-a-real-agent-xyz', 'task', '--device', 'auto'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: home,
            AGENTS_SYNC_MACHINE_ID: machineId,
            AGENTS_NO_NUDGE: '1',
            FORCE_COLOR: '0',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ).toString('utf-8');
      return { status: 0, stdout, stderr: '' };
    } catch (e) {
      const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
      return {
        status: err.status ?? 1,
        stdout: err.stdout?.toString('utf-8') ?? '',
        stderr: err.stderr?.toString('utf-8') ?? '',
      };
    }
  }

  it('resolves `auto` instead of rejecting "Unknown device" / "Couldn\'t resolve --device"', () => {
    const { status, stdout, stderr } = runAdd('device-auto-add-test');
    const out = stdout + stderr;

    expect(out).not.toContain(`Unknown device 'auto'`);
    expect(out).not.toContain(`Couldn't resolve --device "auto"`);
    // The affinity engine's only eligible candidate is this machine (unique
    // AGENTS_SYNC_MACHINE_ID, nothing registered under it) — banner confirms
    // the sentinel was actually resolved, not silently ignored.
    expect(out).toContain('device=auto → local');
    // Fails later, on the deliberately-invalid teammate name — proves device
    // resolution got out of the way rather than being the failure itself.
    expect(status).not.toBe(0);
    expect(out).toContain(`Unknown teammate 'not-a-real-agent-xyz'`);
  });
});
