import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildBootstrapScript, leaseAndRun } from './lease.js';
import { LEASE_AGENT_MARKER, leasePhaseSentinel } from './progress.js';
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

  it('emits ordered phase sentinels around each setup block', () => {
    const script = buildBootstrapScript({ agent: 'claude', prompt: 'hi', runtimes: ['claude'], detected });
    const order = ['sync', 'install', 'runtime', 'creds', 'copy-setup'].map((n) =>
      script.indexOf(`echo '${leasePhaseSentinel(n)}'`),
    );
    for (const at of order) expect(at).toBeGreaterThan(-1);
    // Strictly increasing — sentinels appear in block order.
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
    // install sentinel precedes the node bootstrap; creds precedes the marker.
    expect(script.indexOf(`echo '${leasePhaseSentinel('install')}'`)).toBeLessThan(script.indexOf('command -v node'));
    expect(script.indexOf(`echo '${leasePhaseSentinel('copy-setup')}'`)).toBeLessThan(
      script.indexOf(`echo '${LEASE_AGENT_MARKER}'`),
    );
  });

  it('omits the copy-setup sentinel when copySetup is false (--bare)', () => {
    const script = buildBootstrapScript({ agent: 'claude', prompt: 'hi', runtimes: ['claude'], detected, copySetup: false });
    expect(script).not.toContain(`echo '${leasePhaseSentinel('copy-setup')}'`);
    // The other sentinels still fire.
    expect(script).toContain(`echo '${leasePhaseSentinel('sync')}'`);
    expect(script).toContain(`echo '${leasePhaseSentinel('creds')}'`);
  });

  it('emits the joined-tailnet sentinel only for a tailscale lease', () => {
    const pub = buildBootstrapScript({ agent: 'claude', prompt: 'hi', runtimes: ['claude'], detected });
    expect(pub).not.toContain(`echo '${leasePhaseSentinel('joined-tailnet')}'`);
    const ts = buildBootstrapScript({ agent: 'claude', prompt: 'hi', runtimes: ['claude'], detected, netMode: 'tailscale' });
    expect(ts).toContain(`echo '${leasePhaseSentinel('joined-tailnet')}'`);
    // It sits before the install block (the box joined during warmup).
    expect(ts.indexOf(`echo '${leasePhaseSentinel('joined-tailnet')}'`)).toBeLessThan(
      ts.indexOf(`echo '${leasePhaseSentinel('install')}'`),
    );
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

describe('leaseAndRun reused crabbox boxes', () => {
  const detected: DetectedRuntime[] = [
    { id: 'claude', label: 'Claude Code', email: 'a@b.com', signedIn: true, credPath: null },
  ];

  function writeFakeCrabbox(tmpDir: string): { log: string; script: string; list: string } {
    const bin = path.join(tmpDir, 'crabbox');
    const log = path.join(tmpDir, 'crabbox.log');
    const script = path.join(tmpDir, 'remote.sh');
    const list = path.join(tmpDir, 'boxes.json');
    fs.writeFileSync(
      list,
      JSON.stringify([
        {
          name: 'crabbox-warm-one',
          status: 'running',
          labels: {
            slug: 'warm-one',
            lease: 'cbx_warmone',
            state: 'ready',
            keep: 'true',
            created_at: '1800000000',
            expires_at: '1800003600',
            last_touched_at: '1800000100',
            idle_timeout_secs: '1800',
          },
          public_net: { ipv4: { ip: '203.0.113.10' } },
        },
      ]),
      'utf-8',
    );
    fs.writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'printf "%s\\n" "$*" >> "$CRABBOX_LOG"',
        'case "$1" in',
        '  --help) exit 0 ;;',
        '  list) cat "$CRABBOX_LIST"; exit 0 ;;',
        '  run) cat > "$CRABBOX_SCRIPT"; printf "%s\\nagent ok\\n" "' + LEASE_AGENT_MARKER + '"; exit 7 ;;',
        '  warmup) echo "unexpected warmup" >&2; exit 55 ;;',
        '  stop) echo "unexpected stop" >&2; exit 66 ;;',
        '  *) echo "unexpected command: $*" >&2; exit 1 ;;',
        'esac',
      ].join('\n'),
      'utf-8',
    );
    fs.chmodSync(bin, 0o755);
    return { log, script, list };
  }

  it('finds an existing warm box, runs the bootstrap script, and never warms or stops it', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-reuse-'));
    const fake = writeFakeCrabbox(tmpDir);
    const oldEnv = {
      PATH: process.env.PATH,
      CRABBOX_LOG: process.env.CRABBOX_LOG,
      CRABBOX_LIST: process.env.CRABBOX_LIST,
      CRABBOX_SCRIPT: process.env.CRABBOX_SCRIPT,
    };
    process.env.PATH = `${tmpDir}${path.delimiter}${oldEnv.PATH ?? ''}`;
    process.env.CRABBOX_LOG = fake.log;
    process.env.CRABBOX_LIST = fake.list;
    process.env.CRABBOX_SCRIPT = fake.script;
    const phases: string[] = [];
    let output = '';

    try {
      const result = await leaseAndRun({
        agent: 'claude',
        prompt: 'reuse the box',
        runtimes: ['claude'],
        detected,
        reuseBox: 'warm-one',
        onData: (chunk) => { output += chunk; },
        onPhase: (phase) => { phases.push(phase.kind); },
      });

      expect(result.box.slug).toBe('warm-one');
      expect(result.exitCode).toBe(7);
      expect(result.toreDown).toBe(false);
      expect(phases).toEqual(['reuse', 'ready']);
      expect(output).toContain('agent ok');

      const calls = fs.readFileSync(fake.log, 'utf-8').trim().split('\n');
      expect(calls).toContain('list --json');
      expect(calls).toContain('run --id warm-one --reclaim --script-stdin');
      expect(calls.some((line) => line.startsWith('warmup'))).toBe(false);
      expect(calls.some((line) => line.startsWith('stop'))).toBe(false);

      const remoteScript = fs.readFileSync(fake.script, 'utf-8');
      expect(remoteScript).toContain("agents run 'claude' 'reuse the box' --quiet");
    } finally {
      for (const [key, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
