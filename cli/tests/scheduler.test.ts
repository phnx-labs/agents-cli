import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { JobScheduler } from '../src/lib/scheduler.js';
import type { JobConfig } from '../src/lib/jobs.js';

const TEST_AGENTS_DIR = join(tmpdir(), 'agents-cli-scheduler-test');

function makeConfig(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    name: 'test-job',
    schedule: '0 9 * * *',
    agent: 'claude',
    mode: 'plan',
    effort: 'default',
    timeout: '30m',
    enabled: true,
    prompt: 'do something',
    ...overrides,
  };
}

afterEach(() => {
  rmSync(TEST_AGENTS_DIR, { recursive: true, force: true });
});

describe('JobScheduler', () => {
  it('schedules a job and reports next run', () => {
    const triggered: string[] = [];
    const scheduler = new JobScheduler(async (config) => {
      triggered.push(config.name);
    });

    scheduler.schedule(makeConfig({ name: 'daily-job', schedule: '0 9 * * *' }));

    const nextRun = scheduler.getNextRun('daily-job');
    expect(nextRun).toBeInstanceOf(Date);
    expect(nextRun!.getTime()).toBeGreaterThan(Date.now());

    scheduler.stopAll();
  });

  it('lists scheduled jobs', () => {
    const scheduler = new JobScheduler(async () => {});

    scheduler.schedule(makeConfig({ name: 'job-a', schedule: '0 9 * * *' }));
    scheduler.schedule(makeConfig({ name: 'job-b', schedule: '0 12 * * *' }));

    const listed = scheduler.listScheduled();
    const names = listed.map((j) => j.name).sort();
    expect(names).toEqual(['job-a', 'job-b']);
    expect(listed.every((j) => j.nextRun instanceof Date)).toBe(true);

    scheduler.stopAll();
  });

  it('unschedules a specific job', () => {
    const scheduler = new JobScheduler(async () => {});

    scheduler.schedule(makeConfig({ name: 'job-a' }));
    scheduler.schedule(makeConfig({ name: 'job-b' }));

    scheduler.unschedule('job-a');

    expect(scheduler.getNextRun('job-a')).toBeNull();
    expect(scheduler.getNextRun('job-b')).not.toBeNull();

    const listed = scheduler.listScheduled();
    expect(listed.length).toBe(1);
    expect(listed[0].name).toBe('job-b');

    scheduler.stopAll();
  });

  it('stopAll clears all jobs', () => {
    const scheduler = new JobScheduler(async () => {});

    scheduler.schedule(makeConfig({ name: 'job-a' }));
    scheduler.schedule(makeConfig({ name: 'job-b' }));

    scheduler.stopAll();

    expect(scheduler.listScheduled()).toEqual([]);
    expect(scheduler.getNextRun('job-a')).toBeNull();
  });

  it('returns null for unknown job name', () => {
    const scheduler = new JobScheduler(async () => {});
    expect(scheduler.getNextRun('nonexistent')).toBeNull();
    scheduler.stopAll();
  });

  it('reschedules job with same name (replaces old)', () => {
    const scheduler = new JobScheduler(async () => {});

    scheduler.schedule(makeConfig({ name: 'dup', schedule: '0 9 * * *' }));
    const firstNextRun = scheduler.getNextRun('dup');

    scheduler.schedule(makeConfig({ name: 'dup', schedule: '0 18 * * *' }));
    const secondNextRun = scheduler.getNextRun('dup');

    expect(firstNextRun).not.toEqual(secondNextRun);

    const listed = scheduler.listScheduled();
    expect(listed.length).toBe(1);

    scheduler.stopAll();
  });
});
