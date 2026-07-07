import { describe, it, expect } from 'vitest';
import { buildBootstrapScript } from './lease.js';
import type { DetectedRuntime } from './runtimes.js';

describe('buildBootstrapScript', () => {
  const detected: DetectedRuntime[] = [
    { id: 'claude', label: 'Claude Code', email: 'a@b.com', signedIn: true, credPath: null },
  ];

  it('ensures agents-cli, installs runtimes, runs the agent, and shreds creds', () => {
    const script = buildBootstrapScript({
      agent: 'claude',
      prompt: 'print hostname',
      runtimes: ['claude'],
      detected,
    });
    expect(script).toContain('command -v agents');
    expect(script).toContain('npm install -g @phnx-labs/agents-cli');
    expect(script).toContain("agents add 'claude'");
    expect(script).toContain("agents run 'claude' 'print hostname' --quiet");
    expect(script).toContain('rm -f "$HOME/.claude.json"'); // shred
    expect(script).toContain('exit $rc');
  });

  it('threads mode/model into the remote run', () => {
    const script = buildBootstrapScript({
      agent: 'codex',
      prompt: 'fix it',
      mode: 'edit',
      model: 'gpt-5',
      runtimes: ['codex'],
      detected,
    });
    expect(script).toContain("agents run 'codex' 'fix it' --quiet --mode 'edit' --model 'gpt-5'");
  });

  it('single-quote-escapes a prompt containing quotes (no argv injection)', () => {
    const script = buildBootstrapScript({
      agent: 'claude',
      prompt: "don't break; rm -rf /",
      runtimes: [],
      detected,
    });
    // The dangerous prompt is fully contained in a single-quoted argument.
    expect(script).toContain("'don'\\''t break; rm -rf /'");
  });
});
