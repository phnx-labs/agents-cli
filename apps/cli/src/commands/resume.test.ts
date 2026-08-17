import { describe, expect, it, afterEach } from 'vitest';
import { buildResumeRunArgs, buildResumeRemoteArgs } from './resume.js';
import { consumeResumePinned, RESUME_PINNED_ENV } from '../lib/session/resume-owner.js';

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

describe('buildResumeRemoteArgs — the hop to the owning device (RUSH-2022)', () => {
  const id = '019fd0c8-b3e9-77a2-a1a4-444698c4d897';

  it('re-runs `agents sessions resume` on the owner, forwarding the caller flags verbatim', () => {
    expect(buildResumeRemoteArgs(id, 'finish the tests', { mode: 'edit', headless: true, quiet: true }))
      .toEqual(['sessions', 'resume', id, 'finish the tests', '--mode', 'edit', '--headless', '--quiet']);
  });

  it('carries NO loop-guard flag — a peer on an older CLI would die on an unknown option', () => {
    // The pin rides RESUME_PINNED_ENV instead; every token here must exist in
    // the released `agents sessions resume` surface.
    const args = buildResumeRemoteArgs(id, undefined, {});
    expect(args).toEqual(['sessions', 'resume', id]);
    expect(args).not.toContain('--here');
  });
});

describe('consumeResumePinned', () => {
  afterEach(() => {
    delete process.env[RESUME_PINNED_ENV];
  });

  it('reads the pin the SSH hop exports and clears it so children never inherit it', () => {
    process.env[RESUME_PINNED_ENV] = '1';
    expect(consumeResumePinned()).toBe(true);
    expect(process.env[RESUME_PINNED_ENV]).toBeUndefined();
    // A nested `agents sessions resume` inside the running agent routes normally again.
    expect(consumeResumePinned()).toBe(false);
  });

  it('is false when unset', () => {
    expect(consumeResumePinned()).toBe(false);
  });
});
