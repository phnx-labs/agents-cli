import { it, expect } from 'vitest';
import * as fs from 'fs';
import {
  describeRoutines,
  makeHome,
  run,
  baseJob,
  registry,
  writeRunMeta,
} from './routines.test-fixture.js';

// `routines status --json` surface (PHNX-3215) — the daemon-owned status view:
// per routine its single owner device, last-fire outcome + error, and any
// in-flight spawn, plus the scheduler block. Distinct from `list --json`
// (definition-shaped). Exercises the real CLI subprocess, no mocking.

describeRoutines('routines status --json', () => {
  it('emits a scheduler block plus per-routine owner device, last fire, and last error', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({
      jobs: [job],
      registry,
      deviceRoutines: { 'yosemite-s0': ['test-job'] },
    });
    try {
      // A failed last fire on THIS device.
      writeRunMeta(home, 'test-job', '2026-07-21T10-00-00-000Z', {
        jobName: 'test-job',
        runId: '2026-07-21T10-00-00-000Z',
        agent: 'claude',
        pid: null,
        status: 'failed',
        startedAt: '2026-07-21T10:00:00.000Z',
        completedAt: '2026-07-21T10:01:00.000Z',
        exitCode: 1,
        errorMessage: 'agent exited non-zero',
      });

      const res = run(home, ['status', '--json'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      expect(parsed.device).toBe('yosemite-s0');
      expect(parsed.scheduler).toBeDefined();
      expect(['running', 'wedged', 'stopped']).toContain(parsed.scheduler.state);
      expect(parsed.scheduler.total).toBe(1);
      expect(parsed.scheduler.enabled).toBe(1);

      const entry = parsed.routines.find((r: Record<string, unknown>) => r.name === 'test-job');
      expect(entry).toBeDefined();
      expect(entry.ownerDevice).toBe('yosemite-s0');
      expect(entry.ambiguousDevicePin).toBe(false);
      expect(entry.enabledDevices).toEqual(['yosemite-s0']);
      expect(entry.runsHere).toBe(true);
      expect(entry.lastStatus).toBe('failed');
      expect(entry.lastError).toBe('agent exited non-zero');
      expect(entry.lastRunCompletedAt).toBe('2026-07-21T10:01:00.000Z');
      expect(entry.inFlight).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('surfaces an in-flight run (live pid, status running) as inFlight', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({
      jobs: [job],
      registry,
      deviceRoutines: { 'yosemite-s0': ['test-job'] },
    });
    try {
      // A run genuinely in flight: status 'running', a pid that is alive (this
      // test process, alive for the whole subprocess call), no spawnedAt so the
      // reaper's liveness check passes on pid alone, and startedAt=now so it is
      // not aged out. monitorRunningJobs() must therefore leave it running.
      writeRunMeta(home, 'test-job', '2026-07-21T12-00-00-000Z', {
        jobName: 'test-job',
        runId: '2026-07-21T12-00-00-000Z',
        agent: 'claude',
        pid: process.pid,
        status: 'running',
        triggerKind: 'schedule',
        startedAt: new Date().toISOString(),
        completedAt: null,
        exitCode: null,
      });

      const res = run(home, ['status', '--json'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      const entry = parsed.routines.find((r: Record<string, unknown>) => r.name === 'test-job');
      expect(entry).toBeDefined();
      expect(entry.lastStatus).toBe('running');
      expect(entry.inFlight).not.toBeNull();
      expect(entry.inFlight.runId).toBe('2026-07-21T12-00-00-000Z');
      expect(entry.inFlight.pid).toBe(process.pid);
      expect(entry.inFlight.triggerKind).toBe('schedule');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports null last status and no in-flight for a routine pinned away from this device', () => {
    const job = { ...baseJob, devices: ['zion'] };
    const home = makeHome({
      jobs: [job],
      registry,
      deviceRoutines: { zion: ['test-job'], 'yosemite-s0': [] },
    });
    try {
      // A run recorded elsewhere must not read as this device's last fire.
      writeRunMeta(home, 'test-job', '2026-07-25T10-00-00-000Z', {
        jobName: 'test-job',
        runId: '2026-07-25T10-00-00-000Z',
        agent: 'claude',
        pid: null,
        status: 'completed',
        startedAt: '2026-07-25T10:00:00.000Z',
        completedAt: '2026-07-25T10:01:00.000Z',
        exitCode: 0,
      });

      const res = run(home, ['status', '--json'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      const entry = parsed.routines.find((r: Record<string, unknown>) => r.name === 'test-job');
      expect(entry).toBeDefined();
      expect(entry.ownerDevice).toBe('zion');
      expect(entry.runsHere).toBe(false);
      expect(entry.lastStatus).toBeNull();
      expect(entry.inFlight).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
