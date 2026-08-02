import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as state from '../state.js';
import {
  hasCompletedOneShotRun,
  isOneShotLikeSchedule,
  isPastOneShotRoutine,
  oneShotScheduleFireDate,
  parseOneShotLikeSchedule,
} from '../routines.js';

let tmpDir = '';
let runsDir = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routines-one-shot-test-'));
  runsDir = path.join(tmpDir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  vi.spyOn(state, 'getRunsDir').mockReturnValue(runsDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeRun(jobName: string, runId: string, startedAt: string): void {
  const runDir = path.join(runsDir, jobName, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({
    jobName,
    runId,
    agent: 'claude',
    pid: null,
    status: 'completed',
    startedAt,
    completedAt: startedAt,
    exitCode: 0,
  }));
}

describe('date-specific one-shot cron detection', () => {
  it('detects fixed minute/hour/day/month with wildcard weekday', () => {
    expect(parseOneShotLikeSchedule('0 14 29 7 *')).toEqual({
      minute: 0,
      hour: 14,
      day: 29,
      month: 7,
    });
    expect(isOneShotLikeSchedule('0 14 29 7 *')).toBe(true);
  });

  it('rejects recurring cron shapes', () => {
    expect(isOneShotLikeSchedule('0 14 29 7 1')).toBe(false);
    expect(isOneShotLikeSchedule('0 14 * 7 *')).toBe(false);
    expect(isOneShotLikeSchedule('0 14 29 * *')).toBe(false);
    expect(isOneShotLikeSchedule('*/5 14 29 7 *')).toBe(false);
  });

  it('computes whether the single fire time has passed', () => {
    const schedule = '0 14 29 7 *';
    expect(isPastOneShotRoutine({ schedule }, new Date('2026-07-29T13:59:00'))).toBe(false);
    expect(isPastOneShotRoutine({ schedule }, new Date('2026-07-29T14:00:00'))).toBe(true);
  });

  it('respects the routine timezone when computing the yearly fire date', () => {
    const fireAt = oneShotScheduleFireDate(
      '0 14 29 7 *',
      new Date('2026-08-01T00:00:00.000Z'),
      'America/Los_Angeles',
    );
    expect(fireAt?.toISOString()).toBe('2026-07-29T21:00:00.000Z');
  });

  it('requires a terminal run at or after the fire time before cleanup', () => {
    const job = { name: 'followup', schedule: '0 14 29 7 *', timezone: 'America/Los_Angeles' };
    expect(hasCompletedOneShotRun(job, new Date('2026-08-01T00:00:00.000Z'))).toBe(false);

    writeRun('followup', '2026-07-29T21-00-01-000Z', '2026-07-29T21:00:01.000Z');
    expect(hasCompletedOneShotRun(job, new Date('2026-08-01T00:00:00.000Z'))).toBe(true);
  });
});
