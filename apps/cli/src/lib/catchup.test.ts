/**
 * Catch-up tests — a missed fire is recorded, and re-run unless opted out.
 *
 * These drive the real module against a real `~/.agents` tree in an isolated
 * mkdtemp HOME: real routine YAML on disk, real run records, real
 * `detectOverdueJobs`. The only seam is the injected clock. Nothing is mocked.
 *
 * The scenario is the one that cost real time: zion's daemon was down at
 * 2026-08-03T04:00Z when `weekly-fleet-retro` came due, croner rescheduled
 * forward on restart, and the fire was simply lost.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';

let home: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

/** Write a routine YAML into the isolated HOME's routines dir. */
function writeRoutine(job: Record<string, unknown>): void {
  const dir = path.join(home, '.agents', 'routines');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${job.name}.yml`), yaml.stringify(job));
}

/** Write a completed run record so a routine is not seen as never-run. */
function writeRun(jobName: string, startedAt: string): void {
  const runId = startedAt.replace(/[:.]/g, '-');
  const dir = path.join(home, '.agents', '.history', 'runs', jobName, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      jobName, runId, agent: 'claude', pid: null, status: 'completed',
      startedAt, completedAt: startedAt, exitCode: 0,
    }),
  );
}

function readRuns(jobName: string): Record<string, unknown>[] {
  const dir = path.join(home, '.agents', '.history', 'runs', jobName);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().map((runId) =>
    JSON.parse(fs.readFileSync(path.join(dir, runId, 'meta.json'), 'utf-8')));
}

beforeEach(() => {
  // The state module resolves ~/.agents paths into consts at import time, so a
  // cached module would still point at a previous test's HOME. Reset the module
  // registry so each test imports against the temp HOME set below. Not a mock —
  // the real path resolution runs, just against a fresh root.
  vi.resetModules();
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-catchup-test-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents: {}\n');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('recordMissedFire', () => {
  it('writes a missed run stamped at the time the fire was due', async () => {
    const { recordMissedFire } = await import('./catchup.js');
    const job = {
      name: 'weekly-fleet-retro', schedule: '0 21 * * 0', agent: 'claude' as const,
      mode: 'auto' as const, effort: 'auto' as const, timeout: '10m', enabled: true, prompt: 'noop',
    };
    writeRoutine(job);

    const expectedAt = new Date('2026-08-03T04:00:00.000Z');
    const meta = recordMissedFire(job, expectedAt);

    expect(meta.status).toBe('missed');
    // Stamped when it was DUE, not when it was noticed — so the gap lands at
    // the right point in history.
    expect(meta.startedAt).toBe('2026-08-03T04:00:00.000Z');
    expect(meta.pid).toBeNull();
    expect(meta.exitCode).toBeNull();

    const runs = readRuns('weekly-fleet-retro');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('missed');
  });

  it('is idempotent for the same missed fire', async () => {
    const { recordMissedFire } = await import('./catchup.js');
    const job = {
      name: 'nightly', schedule: '0 2 * * *', agent: 'claude' as const,
      mode: 'auto' as const, effort: 'auto' as const, timeout: '10m', enabled: true, prompt: 'noop',
    };
    writeRoutine(job);
    const expectedAt = new Date('2026-08-02T09:00:00.000Z');

    recordMissedFire(job, expectedAt);
    recordMissedFire(job, expectedAt);

    // Same fire, same derived run id — one record, not a duplicate per pass.
    expect(readRuns('nightly')).toHaveLength(1);
  });
});

describe('runCatchup', () => {
  /** A routine due daily at 02:00 UTC whose last run was two days before "now". */
  // timezone pinned so the cron occurrences line up with the UTC instants the
  // fixtures use, whatever TZ the test machine runs in.
  const nightly = {
    name: 'nightly', schedule: '0 2 * * *', timezone: 'UTC', agent: 'claude' as const,
    mode: 'auto' as const, effort: 'auto' as const, timeout: '10m', enabled: true, prompt: 'noop',
  };
  const now = new Date('2026-08-03T09:00:00.000Z');

  it('records the miss and does not re-run when catchup is false', async () => {
    const { runCatchup } = await import('./catchup.js');
    writeRoutine({ ...nightly, catchup: false });
    writeRun('nightly', '2026-08-01T02:00:00.000Z');

    const outcomes = await runCatchup({ now });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].name).toBe('nightly');
    expect(outcomes[0].result).toBe('recorded');

    const runs = readRuns('nightly');
    // The original completed run plus exactly one missed record — no late run.
    expect(runs.map((r) => r.status)).toEqual(['completed', 'missed']);
  });

  it('stops reporting the same missed fire on a second pass', async () => {
    const { runCatchup } = await import('./catchup.js');
    const { detectOverdueJobs } = await import('./overdue.js');
    writeRoutine({ ...nightly, catchup: false });
    writeRun('nightly', '2026-08-01T02:00:00.000Z');

    expect(detectOverdueJobs(now)).toHaveLength(1);
    await runCatchup({ now });

    // The `missed` record advances getLatestRun past the expected fire, so the
    // same miss is never processed twice — no separate ledger needed. This is
    // what stops a restart storm from re-firing a routine on every boot.
    expect(detectOverdueJobs(now)).toHaveLength(0);
    const second = await runCatchup({ now });
    expect(second).toHaveLength(0);
    expect(readRuns('nightly')).toHaveLength(2);
  });

  it('dry run records the miss without starting a late run', async () => {
    const { runCatchup } = await import('./catchup.js');
    writeRoutine(nightly);
    writeRun('nightly', '2026-08-01T02:00:00.000Z');

    const outcomes = await runCatchup({ now, dryRun: true });

    expect(outcomes[0].result).toBe('recorded');
    expect(outcomes[0].runId).toBeUndefined();
    expect(readRuns('nightly').map((r) => r.status)).toEqual(['completed', 'missed']);
  });

  it('leaves a routine that ran on schedule alone', async () => {
    const { runCatchup } = await import('./catchup.js');
    writeRoutine(nightly);
    // Ran at its most recent expected fire (02:00 today) — nothing was missed.
    writeRun('nightly', '2026-08-03T02:00:00.000Z');

    expect(await runCatchup({ now })).toHaveLength(0);
    expect(readRuns('nightly').map((r) => r.status)).toEqual(['completed']);
  });
});

describe('shouldCatchUp', () => {
  it('defaults to true so a scheduled routine is never silently skipped', async () => {
    const { shouldCatchUp } = await import('./catchup.js');
    expect(shouldCatchUp({})).toBe(true);
    expect(shouldCatchUp({ catchup: undefined })).toBe(true);
    expect(shouldCatchUp({ catchup: true })).toBe(true);
    expect(shouldCatchUp({ catchup: false })).toBe(false);
  });
});
