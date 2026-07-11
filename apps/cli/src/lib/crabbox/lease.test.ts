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

  it('bootstraps node user-level and fails loud when agents-cli is not runnable', () => {
    const script = buildBootstrapScript({
      agent: 'claude',
      prompt: 'print hostname',
      runtimes: ['claude'],
      detected,
    });
    // Fresh crabbox images ship without node; everything must land in ~/.local.
    expect(script).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(script).toContain('command -v node');
    expect(script).toContain('nodejs.org/dist/latest-v22.x');
    expect(script).toContain('npm config set prefix "$HOME/.local"');
    // A missing CLI must abort with a diagnostic, not run into `agents: command not found`.
    expect(script).toContain('exit 96');
    // First-run setup, same guard as the hosts bootstrap (hosts/ready.ts).
    expect(script).toContain('agents setup');
    // Node bootstrap runs before the credential write — never after.
    expect(script.indexOf('command -v node')).toBeLessThan(script.indexOf("agents run 'claude'"));
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
