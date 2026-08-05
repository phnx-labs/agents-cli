import { describe, expect, it } from 'vitest';
import { buildResumeRunArgs } from './resume.js';

describe('buildResumeRunArgs', () => {
  const session = {
    id: '019fd0c8-b3e9-77a2-a1a4-444698c4d897',
    agent: 'codex',
    version: '0.146.0',
  };

  it('pins the original harness/version and delegates to the canonical run resume path', () => {
    expect(buildResumeRunArgs(session, undefined, {})).toEqual([
      'run',
      'codex@0.146.0',
      '--resume',
      session.id,
    ]);
  });

  it('forwards a follow-up prompt and deliberate mode override', () => {
    expect(buildResumeRunArgs(session, 'finish the tests', { mode: 'edit', headless: true })).toEqual([
      'run',
      'codex@0.146.0',
      'finish the tests',
      '--resume',
      session.id,
      '--mode',
      'edit',
      '--headless',
    ]);
  });
});
