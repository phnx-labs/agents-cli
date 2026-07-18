import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { executeJob, executeJobDetached, monitorRunningJobs } from './runner.js';
import { getRunDir, writeRunMeta } from './routines.js';
import type { JobConfig, RunMeta } from './routines.js';
import { saveTask, hostsCacheDir } from './hosts/tasks.js';

/** Remove every run directory for a job (its parent dir), best-effort. */
function cleanupJobRuns(jobName: string): void {
  const jobRunsDir = path.dirname(getRunDir(jobName, 'x'));
  try { fs.rmSync(jobRunsDir, { recursive: true, force: true }); } catch { /* nothing to clean */ }
}

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

describe('command-mode routines (executeJob foreground)', () => {
  const jobs: string[] = [];
  afterEach(() => {
    for (const j of jobs.splice(0)) cleanupJobRuns(j);
  });

  /** A command-mode job (no agent) that runs a plain shell command. */
  function commandConfig(name: string, command: string): JobConfig {
    jobs.push(name);
    return {
      name,
      schedule: '0 3 * * *',
      command,
      mode: 'auto',
      effort: 'auto',
      timeout: '1m',
      enabled: true,
      // command routines carry no prompt; the runner never dereferences it.
      prompt: '',
    } as JobConfig;
  }

  it('runs a successful shell command → status completed, exitCode 0, no agent', async () => {
    const config = commandConfig('cmd-ok', 'exit 0');
    const result = await executeJob(config);

    expect(result.meta.status).toBe('completed');
    expect(result.meta.exitCode).toBe(0);
    expect(result.meta.command).toBe('exit 0');
    expect(result.meta.agent).toBeUndefined();
    expect(result.meta.duration).toBeGreaterThanOrEqual(0);
    expect(result.meta.errorMessage).toBeUndefined();
    expect(result.reportPath).toBeNull();

    // A real run record was written and is readable from disk.
    const metaOnDisk = JSON.parse(
      fs.readFileSync(path.join(getRunDir('cmd-ok', result.meta.runId), 'meta.json'), 'utf-8'),
    );
    expect(metaOnDisk.status).toBe('completed');
    expect(metaOnDisk.command).toBe('exit 0');
    expect(metaOnDisk.agent).toBeUndefined();
    expect(metaOnDisk.duration).toBeGreaterThanOrEqual(0);
    expect(metaOnDisk.errorMessage).toBeUndefined();
  });

  it('propagates a non-zero exit → status failed, exitCode preserved', async () => {
    const config = commandConfig('cmd-fail', 'exit 3');
    const result = await executeJob(config);

    expect(result.meta.status).toBe('failed');
    expect(result.meta.exitCode).toBe(3);
    expect(result.meta.command).toBe('exit 3');
    expect(result.meta.agent).toBeUndefined();
    expect(result.meta.duration).toBeGreaterThanOrEqual(0);
    expect(result.meta.errorMessage).toBeUndefined();
  });

  it('captures command stdout to the run log', async () => {
    const config = commandConfig('cmd-stdout', 'echo command-mode-ran');
    const result = await executeJob(config);

    expect(result.meta.status).toBe('completed');
    const log = fs.readFileSync(path.join(getRunDir('cmd-stdout', result.meta.runId), 'stdout.log'), 'utf-8');
    expect(log).toContain('command-mode-ran');
  });
});

describe('command-mode routines (executeJobDetached — daemon/cron path)', () => {
  const jobs: string[] = [];
  afterEach(() => {
    for (const j of jobs.splice(0)) cleanupJobRuns(j);
  });

  function commandConfig(name: string, command: string): JobConfig {
    jobs.push(name);
    return {
      name, schedule: '0 3 * * *', command,
      mode: 'auto', effort: 'auto', timeout: '1m', enabled: true, prompt: '',
    } as JobConfig;
  }

  async function waitTerminal(name: string, runId: string, ms = 4000): Promise<Record<string, unknown>> {
    const metaPath = path.join(getRunDir(name, runId), 'meta.json');
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try {
        const m = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (m.status !== 'running') return m;
      } catch { /* meta not yet written */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  }

  // Regression: a detached (daemon-scheduled) command run must record its REAL
  // terminal status. The first cut relied on monitorRunningJobs, which only infers
  // status for agent jobs — so every successful command cron run was mis-recorded
  // as 'failed'. child.on('exit') now writes the true status.
  it('records completed / exitCode 0 on a successful detached run (not failed)', async () => {
    const meta = await executeJobDetached(commandConfig('cmd-det-ok', 'exit 0'));
    const final = await waitTerminal('cmd-det-ok', meta.runId);
    expect(final.status).toBe('completed');
    expect(final.exitCode).toBe(0);
    expect(final.command).toBe('exit 0');
    expect(final.duration).toBeGreaterThanOrEqual(0);
    expect(final.errorMessage).toBeUndefined();
    // exit-code file is the posix restart-recovery source of truth (the sh subshell
    // wrapper writes it). Windows records status via child.on('exit') only — no file.
    if (process.platform !== 'win32') {
      expect(
        fs.readFileSync(path.join(getRunDir('cmd-det-ok', meta.runId), 'exit-code'), 'utf-8').trim(),
      ).toBe('0');
    }
  });

  it('records failed / exitCode 3 on a non-zero detached run', async () => {
    const meta = await executeJobDetached(commandConfig('cmd-det-fail', 'exit 3'));
    const final = await waitTerminal('cmd-det-fail', meta.runId);
    expect(final.status).toBe('failed');
    expect(final.exitCode).toBe(3);
    expect(final.duration).toBeGreaterThanOrEqual(0);
    expect(final.errorMessage).toBeUndefined();
  });
});
