import { describe, it, expect } from 'vitest';
import { validateJob } from '../routines.js';
import type { JobConfig } from '../routines.js';

function baseJob(overrides: Partial<JobConfig> = {}): Partial<JobConfig> {
  return {
    name: 'test-job',
    schedule: '0 9 * * 1-5',
    prompt: 'Pick up the task and complete it.',
    mode: 'edit',
    ...overrides,
  };
}

describe('validateJob — workflow field', () => {
  it('accepts workflow with no agent', () => {
    const errors = validateJob(baseJob({ workflow: 'autodev' }));
    expect(errors).toEqual([]);
  });

  it('rejects both agent and workflow set', () => {
    const errors = validateJob(baseJob({ agent: 'claude', workflow: 'autodev' }));
    expect(errors.some((e) => e.includes('exactly one of agent or workflow'))).toBe(true);
  });

  it('rejects neither agent nor workflow', () => {
    const errors = validateJob(baseJob());
    expect(errors.some((e) => e.includes('exactly one of agent or workflow'))).toBe(true);
  });

  it('rejects workflow with uppercase or spaces', () => {
    const errors = validateJob(baseJob({ workflow: 'Bad Name' }));
    expect(errors.some((e) => e.includes('workflow'))).toBe(true);
  });
});
