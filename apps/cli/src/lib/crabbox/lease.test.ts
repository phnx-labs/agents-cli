import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildBootstrapScript } from './lease.js';
import { LEASE_AGENT_MARKER } from './progress.js';
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

  it('emits the agent-output marker immediately before the run (splits setup from output)', () => {
    const script = buildBootstrapScript({ agent: 'claude', prompt: 'hi', runtimes: ['claude'], detected });
    const markerAt = script.indexOf(`echo '${LEASE_AGENT_MARKER}'`);
    const runAt = script.indexOf("agents run 'claude' 'hi' --quiet");
    expect(markerAt).toBeGreaterThan(-1);
    // Marker is emitted after credential setup and directly before the agent run.
    expect(markerAt).toBeLessThan(runAt);
    expect(script.slice(markerAt, runAt).trim()).toBe(`echo '${LEASE_AGENT_MARKER}'`);
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

  it('shreds the claude OAuth token file after the run, regardless of --keep-box', () => {
    for (const keep of [false, true]) {
      const script = buildBootstrapScript({
        agent: 'claude',
        prompt: 'print hostname',
        runtimes: ['claude'],
        detected,
        keep,
      });
      // Both the config AND the token file are removed post-run (shred is in the
      // box body, not teardown — a kept box still loses the token).
      expect(script).toContain('rm -f "$HOME/.claude.json"');
      expect(script).toContain('rm -f "$HOME/.claude/.credentials.json"');
    }
  });

  it('materializes a profile-dispatch run without copying Claude OAuth when the profile has its own auth', () => {
    const script = buildBootstrapScript({
      agent: 'kimi',
      prompt: 'hi',
      runtimes: ['claude'],
      credentialRuntimes: [],
      detected,
      dispatchProfile: {
        name: 'kimi',
        agent: 'claude',
        env: {
          ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
          ANTHROPIC_MODEL: 'moonshotai/kimi-k2.5',
          ANTHROPIC_AUTH_TOKEN: 'sk-or-profile',
        },
        provider: 'openrouter',
        preset: 'kimi',
      },
    });
    expect(script).toContain("agents add 'claude'");
    expect(script).toContain('cat > "$HOME/.agents/profiles/kimi.yml" <<');
    expect(script).toContain('ANTHROPIC_AUTH_TOKEN: sk-or-profile');
    expect(script).toContain("agents run 'kimi' 'hi' --quiet");
    expect(script).not.toContain('cat > "$HOME/.claude.json"');
    expect(script).not.toContain('cat > "$HOME/.claude/.credentials.json"');
    expect(script).toContain('rm -f "$HOME/.agents/profiles/kimi.yml"');
  });

  it('installs the pinned base runtime version for a profile-dispatch run', () => {
    const script = buildBootstrapScript({
      agent: 'kimi',
      prompt: 'hi',
      runtimes: ['claude'],
      credentialRuntimes: [],
      detected,
      dispatchProfile: {
        name: 'kimi',
        agent: 'claude',
        version: '2.1.113',
        env: {
          ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
          ANTHROPIC_MODEL: 'moonshotai/kimi-k2.5',
          ANTHROPIC_AUTH_TOKEN: 'sk-or-profile',
        },
      },
    });
    expect(script).toContain("agents add 'claude@2.1.113'");
    expect(script).toContain('version: 2.1.113');
    expect(script.indexOf("agents add 'claude@2.1.113'")).toBeLessThan(
      script.indexOf('cat > "$HOME/.agents/profiles/kimi.yml"'),
    );
    expect(script).toContain("agents run 'kimi' 'hi' --quiet");
  });

  it('copies base runtime credentials for a profile only when requested', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-profile-'));
    const credPath = path.join(tmpDir, 'claude.json');
    fs.writeFileSync(credPath, '{"oauthAccount":{"emailAddress":"a@b.com"}}');
    const detectedWithCred: DetectedRuntime[] = [{ ...detected[0], credPath }];
    const script = buildBootstrapScript({
      agent: 'internal-claude',
      prompt: 'hi',
      runtimes: ['claude'],
      credentialRuntimes: ['claude'],
      detected: detectedWithCred,
      claudeCredentialsJson: '{"claudeAiOauth":{"accessToken":"tok"}}',
      dispatchProfile: {
        name: 'internal-claude',
        agent: 'claude',
        env: {
          ANTHROPIC_BASE_URL: 'https://gateway.example.test',
          ANTHROPIC_MODEL: 'claude-sonnet-4-5',
        },
      },
    });
    try {
      expect(script).toContain('cat > "$HOME/.claude/.credentials.json" <<');
      expect(script).toContain('rm -f "$HOME/.claude/.credentials.json"');
      expect(script).toContain('rm -f "$HOME/.agents/profiles/internal-claude.yml"');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
