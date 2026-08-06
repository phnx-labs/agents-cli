import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { archiveRoutineTranscripts, buildJobCommand, executeJob, executeJobDetached, monitorRunningJobs, resolveRoutineLaunch, RoutineAlreadyRunningError, routineSpawnCwd } from './runner.js';
import { getRunDir, writeRunMeta } from './routines.js';
import type { JobConfig, RunMeta } from './routines.js';
import type { RotateCandidate, RotateResult } from './rotate.js';
import { saveTask, hostsCacheDir } from './hosts/tasks.js';
import { _resetPerfDbForTest, aggregateSamples } from './perf/db.js';
import * as activation from './routine-activation.js';

beforeEach(() => {
  // These tests pass synthetic definitions directly to the runner. Exercise
  // legacy definition eligibility explicitly instead of inheriting the host's
  // real device manifest from a reused local/CI worker.
  vi.spyOn(activation, 'routineEnabledOnThisDevice').mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe('Codex routine permission profiles', () => {
  it('keeps plan read-only with network and on-request approvals', () => {
    const cmd = buildJobCommand(baseConfig({ agent: 'codex', mode: 'plan' }), 'inspect');
    expect(cmd).toContain('approval_policy="on-request"');
    expect(cmd).toContain('default_permissions="agents-plan"');
    expect(cmd.join(' ')).toContain('extends = ":read-only"');
    expect(cmd.join(' ')).toContain('network = { enabled = true, allow_local_binding = true }');
  });

  it('uses the writable profile for edit and preserves explicit skip', () => {
    const edit = buildJobCommand(baseConfig({ agent: 'codex', mode: 'edit', allow: { dirs: ['/tmp/routine'] } }), 'edit');
    expect(edit).toContain('default_permissions="agents-edit"');
    expect(edit.join(' ')).toContain('"/tmp/routine" = true');
    expect(edit).not.toContain('--dangerously-bypass-approvals-and-sandbox');

    const skip = buildJobCommand(baseConfig({ agent: 'codex', mode: 'skip' }), 'skip');
    expect(skip).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(skip).not.toContain('default_permissions="agents-edit"');
  });
});

describe('routine spawn cwd', () => {
  it('uses the existing home directory when no repo is declared', () => {
    const cwd = routineSpawnCwd({});
    expect(cwd).toBe(os.homedir());
    expect(fs.statSync(cwd).isDirectory()).toBe(true);
  });

  it('resolves owner/repo against the configured owner project root', () => {
    expect(routineSpawnCwd(
      { repo: 'phnx-labs/agents-cli' },
      path.join(os.homedir(), 'src', 'github.com', 'phnx-labs'),
    )).toBe(path.join(os.homedir(), 'src', 'github.com', 'phnx-labs', 'agents-cli'));
  });
});

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

describe('routine transcript archiving', () => {
  const jobName = 'archive-routine-test';
  const runId = 'run-archive-1';

  afterEach(() => {
    cleanupJobRuns(jobName);
  });

  it('copies sandboxed agent transcripts into the stable run directory', () => {
    const overlayHome = path.join(getRunDir(jobName, runId), 'overlay-home');
    const sourceDir = path.join(overlayHome, '.claude', 'projects', 'tmp-project');
    const sourcePath = path.join(sourceDir, 'sess-archive.jsonl');
    const runDir = getRunDir(jobName, runId);
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourcePath, '{"type":"user","message":{"content":"hi"}}\n', 'utf-8');

    archiveRoutineTranscripts({ jobName, runId, agent: 'claude' }, runDir, overlayHome);
    fs.rmSync(overlayHome, { recursive: true, force: true });

    const archived = path.join(runDir, 'sessions', 'claude', 'projects', 'tmp-project', 'sess-archive.jsonl');
    expect(fs.readFileSync(archived, 'utf-8')).toContain('"content":"hi"');
  });

  // Regression: Kimi splits a session across state.json (metadata) and
  // agents/main/wire.jsonl (the actual conversation) — see
  // session/discover.ts:4382-4384. A ROUTINE_TRANSCRIPT_SPECS entry that only
  // matched `.json` archived the metadata shell and silently dropped every
  // message; both extensions must be captured.
  it('archives BOTH state.json and wire.jsonl for a kimi routine session', () => {
    const kimiJobName = 'archive-kimi-test';
    const kimiRunId = 'run-kimi-1';
    const overlayHome = path.join(getRunDir(kimiJobName, kimiRunId), 'overlay-home');
    const sessionDir = path.join(overlayHome, '.kimi-code', 'sessions', 'workdir-hash', 'session_abc123');
    const runDir = getRunDir(kimiJobName, kimiRunId);
    fs.mkdirSync(path.join(sessionDir, 'agents', 'main'), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'state.json'), '{"title":"demo"}', 'utf-8');
    fs.writeFileSync(
      path.join(sessionDir, 'agents', 'main', 'wire.jsonl'),
      '{"role":"user","content":"the actual conversation"}\n',
      'utf-8',
    );

    try {
      archiveRoutineTranscripts({ jobName: kimiJobName, runId: kimiRunId, agent: 'kimi' }, runDir, overlayHome);

      const archivedState = path.join(runDir, 'sessions', 'kimi', 'sessions', 'workdir-hash', 'session_abc123', 'state.json');
      const archivedWire = path.join(runDir, 'sessions', 'kimi', 'sessions', 'workdir-hash', 'session_abc123', 'agents', 'main', 'wire.jsonl');
      expect(fs.readFileSync(archivedState, 'utf-8')).toContain('demo');
      expect(fs.readFileSync(archivedWire, 'utf-8')).toContain('the actual conversation');
    } finally {
      fs.rmSync(overlayHome, { recursive: true, force: true });
      cleanupJobRuns(kimiJobName);
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
    expect(final.timeoutMs).toBe(60_000);
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

  it('allows only one detached execution of the same routine at a time', async () => {
    const command = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 600)"`;
    const config = commandConfig('cmd-det-single-flight', command.replace('600)', '5000)'));

    const first = await executeJobDetached(config);
    await expect(executeJobDetached(config)).rejects.toBeInstanceOf(RoutineAlreadyRunningError);

    const final = await waitTerminal(config.name, first.runId, 7000);
    expect(final.status).toBe('completed');
  });

  it('blocks a replacement while a failed record still owns a live process', async () => {
    const command = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 5000)"`;
    const config = commandConfig('cmd-det-failed-live', command);
    const first = await executeJobDetached(config);
    writeRunMeta({ ...first, status: 'failed', completedAt: new Date().toISOString(), exitCode: 1 });

    await expect(executeJobDetached(config)).rejects.toBeInstanceOf(RoutineAlreadyRunningError);
    await waitTerminal(config.name, first.runId, 7000);
  });

  it('monitorRunningJobs kills a detached process after its persisted deadline', async () => {
    const jobName = 'cmd-det-restart-timeout';
    jobs.push(jobName);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const runId = 'restart-timeout-run';
    const meta: RunMeta = {
      jobName,
      runId,
      command: 'long-running command',
      pid: child.pid ?? null,
      spawnedAt: Date.now(),
      timeoutMs: 25,
      status: 'running',
      startedAt: new Date(Date.now() - 100).toISOString(),
      completedAt: null,
      exitCode: null,
    };
    fs.mkdirSync(getRunDir(jobName, runId), { recursive: true });
    writeRunMeta(meta);

    monitorRunningJobs();

    const final = JSON.parse(
      fs.readFileSync(path.join(getRunDir(jobName, runId), 'meta.json'), 'utf-8'),
    );
    expect(final.status).toBe('timeout');
    expect(final.errorMessage).toBe('exceeded configured timeout');
    await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed-out child stayed alive')), 1000)),
    ]);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });
});

// Regression: executeJobDetached / executeCommandJobDetached (the daemon's
// normal firing path) never wrapped their settle() with createTimer(...).end(),
// unlike executeJob/executeJobOnCloud/executeJobOnHost — so every routine that
// actually fired off the daemon's own schedule emitted ZERO perf.timing
// samples, and `agents perf run` / `agents routines stats` had nothing to show
// for the most common firing path. Verifies against the REAL disposable perf
// warehouse (recordPerfTiming's dynamic import into perf/spool.ts respects the
// same _resetPerfDbForTest override db.test.ts uses), not a mock.
describe('detached routine fires record a perf.timing sample (agent.run)', () => {
  const jobs: string[] = [];
  let tmp: string;

  function commandConfig(name: string, command: string): JobConfig {
    jobs.push(name);
    return {
      name, schedule: '0 3 * * *', command,
      mode: 'auto', effort: 'auto', timeout: '1m', enabled: true, prompt: '',
    } as JobConfig;
  }

  async function waitForPerfSample(label: string, ms = 4000): Promise<ReturnType<typeof aggregateSamples>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const rows = aggregateSamples({ days: 1, kinds: ['perf.timing'], label });
      if (rows.length > 0 || Date.now() > deadline) return rows;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-perf-'));
    process.env.AGENTS_PERF_DB = path.join(tmp, 'perf.db');
    _resetPerfDbForTest(process.env.AGENTS_PERF_DB);
  });

  afterEach(() => {
    for (const j of jobs.splice(0)) cleanupJobRuns(j);
    _resetPerfDbForTest(null);
    delete process.env.AGENTS_PERF_DB;
    delete process.env.AGENTS_PERF_SPOOL;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('executeCommandJobDetached records an agent.run sample with status + jobName on success', async () => {
    await executeJobDetached(commandConfig('cmd-perf-ok', 'exit 0'));
    const rows = await waitForPerfSample('agent.run');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('executeCommandJobDetached records the sample on a FAILED run too (not just success)', async () => {
    await executeJobDetached(commandConfig('cmd-perf-fail', 'exit 5'));
    const rows = await waitForPerfSample('agent.run');
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('resolveRoutineLaunch — zero-healthy accounts fail the routine loud (RUSH-2132)', () => {
  function acct(version: string): RotateCandidate {
    return {
      agent: 'claude',
      version,
      accountKey: `claude:account=${version}`,
      accountLabel: `${version}@example.com`,
      email: `${version}@example.com`,
      usageKey: `claude:org=${version}`,
      usageStatus: 'rate_limited',
      usageSnapshot: null,
      usageError: null,
      plan: 'Max',
      signedIn: true,
      lastActive: null,
    };
  }

  it('throws the watchdog contract error (no healthy + resets + pinned escape hatch) when the strategy exhausts', async () => {
    const err = await resolveRoutineLaunch(baseConfig(), process.cwd(), {
      resolveRunVersion: async () => ({ version: '2.1.207', rotation: null, exhausted: [acct('2.1.207')] }),
    }).then(() => null, (e: unknown) => e as Error);
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/no healthy claude account under strategy '\w+'/);
    expect(err!.message).toContain('excluded: 2.1.207 (rate_limited)');
    expect(err!.message).toContain('resets');
    expect(err!.message).toContain('Use --strategy pinned to force the default.');
  });

  it('a healthy pick proceeds with the rotated version (no throw)', async () => {
    const healthy = { ...acct('2.1.219'), usageStatus: 'available' as const };
    const rotation: RotateResult = { picked: healthy, healthy: [healthy], excluded: [] };
    const plan = await resolveRoutineLaunch(baseConfig(), process.cwd(), {
      resolveRunVersion: async () => ({ version: '2.1.219', rotation }),
    });
    expect(plan.chain[0]).toEqual({ agent: 'claude', version: '2.1.219' });
    expect(plan.rotation).toBe(rotation);
  });

  it('a non-exhausted null rotation (pinned-shaped) proceeds with the resolved version — unchanged', async () => {
    const plan = await resolveRoutineLaunch(baseConfig(), process.cwd(), {
      resolveRunVersion: async () => ({ version: '2.1.207', rotation: null }),
    });
    expect(plan.chain[0]).toEqual({ agent: 'claude', version: '2.1.207' });
    expect(plan.rotation).toBeNull();
  });
});
