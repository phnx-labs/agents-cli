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

  // Regression: kimi daemon jobs run headless via `--prompt`, which cannot be
  // combined with --plan/--auto/--yolo (kimi aborts "Cannot combine --prompt
  // with --X"). Write-modes must omit the flag; plan must fail closed.
  it('kimi skip mode omits --yolo (incompatible with headless --prompt)', () => {
    const argv = buildJobCommand(baseJob({ agent: 'kimi', mode: 'skip' }), 'Do the task.');
    expect(argv).toContain('--prompt');
    expect(argv).not.toContain('--yolo');
  });

  it('kimi auto mode omits --auto', () => {
    const argv = buildJobCommand(baseJob({ agent: 'kimi', mode: 'auto' }), 'Do the task.');
    expect(argv).not.toContain('--auto');
  });

  it('kimi plan mode throws (no headless read-only mode)', () => {
    expect(() => buildJobCommand(baseJob({ agent: 'kimi', mode: 'plan' }), 'Do the task.')).toThrow(/read-only/);
  });
});
