import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { executeJob, executeJobDetached } from './runner.js';
import { slotRunId, claimRunSlot, getRunDir, getJobRunsDir, readRunMeta } from './routines.js';
import type { JobConfig, RunMeta } from './routines.js';
import * as activation from './routine-activation.js';

const describeSpawn = process.platform === 'win32' ? describe.skip : describe;

// Exercise definition eligibility directly rather than inheriting this host's
// real device manifest (same seam as runner.test.ts).
beforeEach(() => {
  vi.spyOn(activation, 'routineEnabledOnThisDevice').mockReturnValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function cleanupJobRuns(name: string): void {
  fs.rmSync(getJobRunsDir(name), { recursive: true, force: true });
}

describe('slot claim primitives', () => {
  afterEach(() => cleanupJobRuns('slot-prim'));

  it('slotRunId derives a stable, path-safe id from a UTC time', () => {
    const id = slotRunId('2026-08-07T08:00:00.000Z');
    expect(id).toBe('2026-08-07T08-00-00-000Z');
    expect(slotRunId(new Date('2026-08-07T08:00:00.000Z'))).toBe(id);
  });

  it('claimRunSlot is an atomic test-and-set — the second claim of a slot loses', () => {
    const id = slotRunId('2026-08-07T09:00:00.000Z');
    expect(claimRunSlot('slot-prim', id)).toBe(true);
    expect(claimRunSlot('slot-prim', id)).toBe(false);
    expect(fs.existsSync(getRunDir('slot-prim', id))).toBe(true);
  });
});

describeSpawn('single-fire + overlap + blocked (executeJobDetached)', () => {
  const jobs: string[] = [];
  afterEach(() => { for (const j of jobs.splice(0)) cleanupJobRuns(j); });

  function commandConfig(name: string, command: string): JobConfig {
    jobs.push(name);
    return {
      name, schedule: '0 3 * * *', command,
      mode: 'auto', effort: 'auto', timeout: '1m', enabled: true, prompt: '',
    } as JobConfig;
  }

  async function waitTerminal(name: string, runId: string, ms = 4000): Promise<RunMeta> {
    const metaPath = path.join(getRunDir(name, runId), 'meta.json');
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try {
        const m = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as RunMeta;
        if (m.status !== 'running') return m;
      } catch { /* not written yet */ }
      await new Promise((r) => setTimeout(r, 40));
    }
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as RunMeta;
  }

  it('two deliveries of the same UTC slot produce ONE launch (duplicate links the original)', async () => {
    const cfg = commandConfig('slot-dupe', 'exit 0');
    const scheduledFor = new Date('2026-08-07T10:00:00.000Z');
    const first = await executeJobDetached(cfg, undefined, { kind: 'schedule', scheduledFor });
    await waitTerminal(cfg.name, first.runId);
    // Same slot again — resolves to the SAME run, launches nothing new.
    const second = await executeJobDetached(cfg, undefined, { kind: 'schedule', scheduledFor });
    expect(second.runId).toBe(first.runId);
    expect(first.runId).toBe(slotRunId(scheduledFor));
    expect(first.scheduledFor).toBe(scheduledFor.toISOString());
    expect(first.triggerKind).toBe('schedule');
    // Exactly one run directory exists for this routine.
    const dirs = fs.readdirSync(getJobRunsDir(cfg.name)).filter((d) => !d.startsWith('.'));
    expect(dirs).toEqual([first.runId]);
  });

  it('a later slot while the first run is still active is skipped, linking the active run', async () => {
    const sleep = `${JSON.stringify(process.execPath)} -e "setTimeout(()=>{},4000)"`;
    const cfg = commandConfig('slot-overlap', sleep);
    const first = await executeJobDetached(cfg, undefined, {
      kind: 'schedule', scheduledFor: new Date('2026-08-07T11:00:00.000Z'),
    });
    expect(first.status).toBe('running');
    // A different slot fires while the first is live.
    const later = await executeJobDetached(cfg, undefined, {
      kind: 'schedule', scheduledFor: new Date('2026-08-07T11:05:00.000Z'),
    });
    expect(later.status).toBe('skipped');
    expect(later.skipReason).toBe('active_run');
    expect(later.activeRunId).toBe(first.runId);
    expect(later.pid).toBeNull();
    await waitTerminal(cfg.name, first.runId, 8000);
  });

  it('a concurrent foreground request skips immediately instead of queueing behind the active run', async () => {
    const cfg = commandConfig('foreground-overlap', 'sleep 2');
    const firstPromise = executeJob(cfg, undefined, { kind: 'manual' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await executeJob(cfg, undefined, { kind: 'manual' });
    expect(second.meta.status).toBe('skipped');
    expect(second.meta.skipReason).toBe('active_run');
    expect(second.meta.activeRunId).toBeDefined();
    expect(second.meta.pid).toBeNull();
    const first = await firstPromise;
    expect(first.meta.status).toBe('completed');
    expect(second.meta.activeRunId).toBe(first.meta.runId);
  });

  it('reclaims a provisional active claim whose launcher process is dead', async () => {
    const cfg = commandConfig('dead-launcher-claim', 'exit 0');
    const staleRunId = 'dead-launcher';
    fs.mkdirSync(getRunDir(cfg.name, staleRunId), { recursive: true });
    fs.writeFileSync(path.join(getRunDir(cfg.name, staleRunId), 'meta.json'), JSON.stringify({
      jobName: cfg.name,
      runId: staleRunId,
      pid: 2_147_483_647,
      spawnedAt: Date.now(),
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      exitCode: null,
      timeoutMs: 60_000,
    } satisfies RunMeta));

    const result = await executeJob(cfg, undefined, { kind: 'manual' });
    expect(result.meta.status).toBe('completed');
    expect(result.meta.runId).not.toBe(staleRunId);
  });

  it('treats an old but live launcher identity as active', async () => {
    const cfg = commandConfig('old-live-launcher', 'exit 0');
    const activeRunId = 'old-live-launcher-run';
    fs.mkdirSync(getRunDir(cfg.name, activeRunId), { recursive: true });
    fs.writeFileSync(path.join(getRunDir(cfg.name, activeRunId), 'meta.json'), JSON.stringify({
      jobName: cfg.name,
      runId: activeRunId,
      pid: process.pid,
      spawnedAt: Date.now() - process.uptime() * 1000,
      status: 'running',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      completedAt: null,
      exitCode: null,
      timeoutMs: 60_000,
    } satisfies RunMeta));

    const result = await executeJob(cfg, undefined, { kind: 'manual' });
    expect(result.meta.status).toBe('skipped');
    expect(result.meta.activeRunId).toBe(activeRunId);
  });

  it('an agent routine with no project/cwd is BLOCKED (execution_context_missing), no spawn', async () => {
    jobs.push('ctxless-agent');
    const cfg: JobConfig = {
      name: 'ctxless-agent', schedule: '0 3 * * *', agent: 'claude',
      mode: 'plan', effort: 'auto', timeout: '1m', enabled: true, prompt: 'hi',
    } as JobConfig;
    const meta = await executeJobDetached(cfg, undefined, { kind: 'manual' });
    expect(meta.status).toBe('blocked');
    expect(meta.pid).toBeNull();
    expect(meta.readiness?.code).toBe('execution_context_missing');
    // The blocked attempt is a persisted, visible record.
    const persisted = readRunMeta(cfg.name, meta.runId);
    expect(persisted?.status).toBe('blocked');
  });

  it('a command routine with neither field runs (home fallback) and stamps resolvedCwd', async () => {
    const cfg = commandConfig('cmd-home', 'exit 0');
    const meta = await executeJobDetached(cfg, undefined, { kind: 'manual' });
    const final = await waitTerminal(cfg.name, meta.runId);
    expect(final.status).toBe('completed');
    expect(final.resolvedCwd).toBe('~');
    expect(final.triggerKind).toBe('manual');
  });

  it('a wrong-device request persists a skipped attempt before returning', async () => {
    const cfg = commandConfig('wrong-owner-attempt', 'exit 0');
    cfg.devices = ['definitely-another-device'];
    const meta = await executeJobDetached(cfg, undefined, { kind: 'manual' });
    expect(meta.status).toBe('skipped');
    expect(meta.skipReason).toBe('wrong_owner');
    expect(meta.pid).toBeNull();
    expect(readRunMeta(cfg.name, meta.runId)?.skipReason).toBe('wrong_owner');
  });

  it('an unsupported placement persists a blocked attempt before returning', async () => {
    const cfg = commandConfig('unsupported-placement-attempt', 'exit 0');
    cfg.host = 'some-host';
    const meta = await executeJobDetached(cfg, undefined, { kind: 'manual' });
    expect(meta.status).toBe('blocked');
    expect(meta.readiness?.code).toBe('placement_unsupported');
    expect(meta.pid).toBeNull();
    expect(readRunMeta(cfg.name, meta.runId)?.status).toBe('blocked');
  });
});
