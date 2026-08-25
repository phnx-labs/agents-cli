import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { buildExecEnv, isHarnessKnownSessionId } from './exec.js';

// The launchId join only works if AGENT_LAUNCH_ID actually reaches the agent
// process (so its SessionStart hook records the same id). spawnAgent injects it
// into options.env before every env build; buildExecEnv must therefore carry it
// through into the child's environment — for BOTH the bare spawn and the tmux
// `env KEY=VAL` prefix (which is built from this same map). This exercises the
// real cross-process delivery, not a mock.
describe('AGENT_LAUNCH_ID propagation', () => {
  it('carries options.env.AGENT_LAUNCH_ID into a spawned child', () => {
    const env = buildExecEnv({
      agent: 'codex',
      cwd: process.cwd(),
      mode: 'auto',
      effort: 'auto',
      env: { AGENT_LAUNCH_ID: 'LID-test-abc' },
    });
    const r = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.AGENT_LAUNCH_ID || "MISSING")'],
      { env, encoding: 'utf8' },
    );
    expect(r.stdout).toBe('LID-test-abc');
  });
});

// A session id is only a real handle when the HARNESS received it. The launcher
// pre-assigns one for claude and generates a throwaway for the tmux wrapper
// name otherwise, and both look like 8 hex characters in a status bar.
describe('isHarnessKnownSessionId', () => {
  it('accepts claude, which is created with --session-id', () => {
    expect(isHarnessKnownSessionId('claude', 'abc-123', false)).toBe(true);
  });

  it('accepts a native resume on any harness with a resume spec', () => {
    // codex resumes by positional id, so a resumed id IS the harness's own.
    expect(isHarnessKnownSessionId('codex', 'abc-123', true)).toBe(true);
  });

  it('rejects a fresh non-claude launch, whose real id only arrives later', () => {
    // `agents run codex --session-id X` never puts X on codex's command line;
    // publishing it would show a handle `ag focus` rejects.
    expect(isHarnessKnownSessionId('codex', 'abc-123', false)).toBe(false);
  });

  it('rejects an absent id', () => {
    expect(isHarnessKnownSessionId('claude', undefined, false)).toBe(false);
    expect(isHarnessKnownSessionId('codex', undefined, true)).toBe(false);
  });
});
