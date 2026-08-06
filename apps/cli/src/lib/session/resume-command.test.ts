import { describe, expect, it } from 'vitest';
import { buildCanonicalResumeCommand } from './resume-command.js';

describe('buildCanonicalResumeCommand', () => {
  it('delegates every lifecycle decision to agents resume', () => {
    expect(buildCanonicalResumeCommand('019fd114-4689-7df1-963f-ce06e5a36aeb')).toEqual([
      'agents',
      'resume',
      '019fd114-4689-7df1-963f-ce06e5a36aeb',
    ]);
  });
});
