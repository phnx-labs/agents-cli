import { afterEach, describe, expect, it } from 'vitest';
import { validateJob, validateTrigger, normalizeTriggerEvent, jobRunsOnThisDevice, type JobConfig } from './routines.js';

/** Minimal valid schedule-based job. */
function baseJob(partial: Partial<JobConfig> = {}): Partial<JobConfig> {
  return {
    name: 'j',
    agent: 'claude',
    prompt: 'do it',
    ...partial,
  };
}

describe('validateJob — schedule OR trigger', () => {
  it('accepts a schedule-only job (existing cron behavior unchanged)', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *' }))).toEqual([]);
  });

  it('accepts a trigger-only job (no schedule)', () => {
    const errors = validateJob(baseJob({ trigger: { type: 'github_event', event: 'pull_request', repo: 'x/y' } }));
    expect(errors).toEqual([]);
  });

  it('accepts a job with both schedule and trigger', () => {
    const errors = validateJob(baseJob({
      schedule: '0 3 * * *',
      trigger: { type: 'github_event', event: 'push' },
    }));
    expect(errors).toEqual([]);
  });

  it('rejects a job with neither schedule nor trigger', () => {
    const errors = validateJob(baseJob({}));
    expect(errors.some((e) => /schedule .* or trigger is required/.test(e))).toBe(true);
  });

  it('still rejects an invalid cron expression', () => {
    const errors = validateJob(baseJob({ schedule: 'not a cron' }));
    expect(errors.some((e) => /invalid cron expression/.test(e))).toBe(true);
  });

  it('surfaces trigger validation errors', () => {
    const errors = validateJob(baseJob({ trigger: { type: 'github_event', event: 'nope' as never } }));
    expect(errors.some((e) => /trigger\.event must be one of/.test(e))).toBe(true);
  });
});

describe('validateTrigger', () => {
  it('accepts a well-formed github_event trigger', () => {
    expect(validateTrigger({ type: 'github_event', event: 'pull_request', repo: 'x/y', branch: 'main' })).toEqual([]);
  });

  it('rejects a bad type', () => {
    expect(validateTrigger({ type: 'gitlab', event: 'pull_request' })).toContain("trigger.type must be 'github_event'");
  });

  it('rejects an unknown event', () => {
    const errors = validateTrigger({ type: 'github_event', event: 'deploy' });
    expect(errors.some((e) => /trigger\.event must be one of/.test(e))).toBe(true);
  });

  it('rejects a malformed repo', () => {
    const errors = validateTrigger({ type: 'github_event', event: 'push', repo: 'not-a-repo' });
    expect(errors).toContain('trigger.repo must be in owner/name form');
  });
});

describe('normalizeTriggerEvent', () => {
  it('maps canonical names and aliases', () => {
    expect(normalizeTriggerEvent('pull_request')).toBe('pull_request');
    expect(normalizeTriggerEvent('pr')).toBe('pull_request');
    expect(normalizeTriggerEvent('pr_opened')).toBe('pull_request');
    expect(normalizeTriggerEvent('PUSH')).toBe('push');
    expect(normalizeTriggerEvent('comment')).toBe('issue_comment');
    expect(normalizeTriggerEvent('workflow')).toBe('workflow_run');
  });

  it('returns null for unknown events', () => {
    expect(normalizeTriggerEvent('deploy')).toBeNull();
  });
});

describe('validateJob — device', () => {
  it('accepts a job pinned to a device', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *', device: 'yosemite-s0' }))).toEqual([]);
  });

  it('rejects an empty device', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', device: '  ' }));
    expect(errors.some((e) => /device must be a non-empty device name/.test(e))).toBe(true);
  });

  it('rejects a non-string device', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', device: 42 as never }));
    expect(errors.some((e) => /device must be a non-empty device name/.test(e))).toBe(true);
  });
});

describe('jobRunsOnThisDevice', () => {
  const savedId = process.env.AGENTS_SYNC_MACHINE_ID;

  afterEach(() => {
    if (savedId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = savedId;
  });

  it('unpinned jobs run everywhere', () => {
    expect(jobRunsOnThisDevice({})).toBe(true);
    expect(jobRunsOnThisDevice({ device: undefined })).toBe(true);
  });

  it('matches when the pin names this machine', () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'yosemite-s0';
    expect(jobRunsOnThisDevice({ device: 'yosemite-s0' })).toBe(true);
  });

  it('normalizes case and domain suffix on the pin', () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'yosemite-s0';
    expect(jobRunsOnThisDevice({ device: 'Yosemite-S0' })).toBe(true);
    expect(jobRunsOnThisDevice({ device: 'yosemite-s0.tailnet.ts.net' })).toBe(true);
  });

  it('rejects a pin naming another machine', () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    expect(jobRunsOnThisDevice({ device: 'yosemite-s0' })).toBe(false);
  });
});
