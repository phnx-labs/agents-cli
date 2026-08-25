import { describe, expect, it } from 'vitest';
import { classifyCause, classifyTopic } from './classify.js';

describe('classifyCause', () => {
  it('buckets real tool_calls guard, hook, and ordinary failures', () => {
    expect(classifyCause({ tool: 'exec_command', error: 'git-guard blocked git push' })).toBe('guard');
    expect(classifyCause({ tool: 'Bash', error_code: 'main-branch-guard' })).toBe('guard');
    expect(classifyCause({
      tool: 'Bash',
      error: 'Permission for this action was denied by the Claude Code auto mode classifier. The user can add a Bash permission rule.',
    })).toBe('hook');
    expect(classifyCause({ tool: 'Bash', exit_code: 1, error: 'command failed' })).toBe('real');
  });
});

describe('classifyTopic', () => {
  it('uses repository metadata and tool mix without transcript content', () => {
    expect(classifyTopic({ gitBranch: 'fix/session-cache', toolMix: { Edit: 3 } })).toEqual({
      group: 'code', key: 'engineering', label: 'Engineering',
    });
    expect(classifyTopic({ label: 'Review PR 123' })).toEqual({
      group: 'review', key: 'code-review', label: 'Code review',
    });
  });
});
