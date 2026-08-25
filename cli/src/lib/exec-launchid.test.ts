import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { buildExecEnv } from './exec.js';

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
