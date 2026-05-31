import { describe, it, expect } from 'vitest';
import { buildJobCommand } from '../runner.js';
import type { JobConfig } from '../routines.js';

function baseJob(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    name: 'test-job',
    schedule: '0 9 * * 1-5',
    prompt: 'Do the task.',
    mode: 'plan',
    effort: 'auto',
    timeout: '10m',
    enabled: true,
    agent: 'claude',
    ...overrides,
  } as JobConfig;
}

describe('buildJobCommand', () => {
  it('bare-agent claude plan mode includes --permission-mode plan', () => {
    const argv = buildJobCommand(baseJob({ agent: 'claude', mode: 'plan' }), 'Do the task.');
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('plan');
  });

  it('bare-agent claude edit mode includes --permission-mode acceptEdits', () => {
    const argv = buildJobCommand(baseJob({ agent: 'claude', mode: 'edit' }), 'Do the task.');
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('acceptEdits');
  });

  it('workflow plan mode emits exact argv with no --non-interactive and no --permission-mode', () => {
    const argv = buildJobCommand(
      baseJob({ workflow: 'autodev', agent: undefined as unknown as 'claude', mode: 'plan' }),
      '<prompt>',
    );
    expect(argv).toEqual(['agents', 'run', 'autodev', '<prompt>', '--mode', 'plan']);
    expect(argv).not.toContain('--non-interactive');
    expect(argv).not.toContain('--permission-mode');
  });

  it('workflow edit mode emits exact argv with --mode edit', () => {
    const argv = buildJobCommand(
      baseJob({ workflow: 'autodev', agent: undefined as unknown as 'claude', mode: 'edit' }),
      '<prompt>',
    );
    expect(argv).toEqual(['agents', 'run', 'autodev', '<prompt>', '--mode', 'edit']);
    expect(argv).not.toContain('--non-interactive');
  });
});
