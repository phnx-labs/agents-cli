import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { executeJob, executeJobDetached, monitorRunningJobs } from './runner.js';
import { getRunDir, writeRunMeta } from './routines.js';
import type { JobConfig, RunMeta } from './routines.js';
import { saveTask, hostsCacheDir } from './hosts/tasks.js';

function baseConfig(partial: Partial<JobConfig> = {}): JobConfig {
  return {
    name: 'test-job',
    schedule: '0 3 * * *',
    agent: 'claude',
    mode: 'plan',
    effort: 'auto',
    timeout: '10m',
    enabled: true,
    prompt: 'do it',
    ...partial,
  } as JobConfig;
}

describe('runner device enforcement', () => {
  const savedId = process.env.AGENTS_SYNC_MACHINE_ID;

  afterEach(() => {
    if (savedId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = savedId;
  });

  it('executeJob throws the canonical message when this machine is not in the devices allowlist', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    const config = baseConfig({ devices: ['yosemite-s0', 'mac-mini'] });
    await expect(executeJob(config)).rejects.toThrow("Job 'test-job' can only run on: yosemite-s0, mac-mini");
  });

  it('executeJobDetached throws the canonical message; no run directory is created', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    const config = baseConfig({ name: 'guard-reject', devices: ['yosemite-s0'] });

    await expect(executeJobDetached(config)).rejects.toThrow("Job 'guard-reject' can only run on: yosemite-s0");

    const runDir = path.dirname(getRunDir(config.name, 'any'));
    expect(fs.existsSync(runDir)).toBe(false);
  });
});

describe('runner host placement', () => {
  it('executeJob refuses host+workflow before any dispatch or run dir', async () => {
    const config = baseConfig({ name: 'host-wf', host: 'gpu-box', workflow: 'autodev', agent: undefined as never });
    await expect(executeJob(config)).rejects.toThrow(/workflow bundle, which can't execute on a host yet/);
    expect(fs.existsSync(path.dirname(getRunDir(config.name, 'any')))).toBe(false);
  });

  it('executeJob refuses host+loop before any dispatch or run dir', async () => {
    const config = baseConfig({ name: 'host-loop', host: 'gpu-box', loop: { maxIterations: 3 } });
    await expect(executeJob(config)).rejects.toThrow(/uses 'loop:', which can't execute on a host yet/);
    expect(fs.existsSync(path.dirname(getRunDir(config.name, 'any')))).toBe(false);
  });

  it('monitorRunningJobs finalizes a host-placed run from its terminal sidecar (no local pid)', () => {
    // A terminal sidecar means reconcileTask returns without any ssh probe —
    // this exercises the exact daemon path that used to strand host runs at
    // 'running' forever (the monitor skipped every pid-less meta).
    const taskId = 'ffff0001';
    const jobName = 'host-monitor-test';
    const runId = 'run-hm-1';
    saveTask({
      id: taskId,
      host: 'gpu-box',
      target: 'taylor@gpu-box.tail.ts.net',
      agent: 'claude',
      prompt: 'p',
      remoteLog: `$HOME/.agents/.cache/hosts/${taskId}.log`,
      remoteExit: `$HOME/.agents/.cache/hosts/${taskId}.exit`,
      status: 'completed',
      exitCode: 0,
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    const meta: RunMeta = {
      jobName,
      runId,
      agent: 'claude',
      pid: null,
      spawnedAt: Date.now(),
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      exitCode: null,
      host: 'gpu-box',
      hostTaskId: taskId,
    };
    const runDir = getRunDir(jobName, runId);
    fs.mkdirSync(runDir, { recursive: true });
    try {
      writeRunMeta(meta);
      monitorRunningJobs();
      const healed = JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf-8')) as RunMeta;
      expect(healed.status).toBe('completed');
      expect(healed.exitCode).toBe(0);
      expect(healed.completedAt).not.toBeNull();
    } finally {
      fs.rmSync(path.dirname(runDir), { recursive: true, force: true });
      fs.rmSync(path.join(hostsCacheDir(), `${taskId}.json`), { force: true });
    }
  });
});
