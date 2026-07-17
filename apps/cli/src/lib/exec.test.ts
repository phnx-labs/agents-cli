import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { shouldTapStdout, resolveInteractive, buildExecCommand, nativeResume, resolveShimSpawn, buildExecEnv, shouldWrapInTmux, buildTmuxAgentCommand, formatPaneTail, type TmuxWrapContext } from './exec.js';
import type { ExecOptions } from './exec.js';
import { mailboxDir } from './mailbox.js';

/** Minimal ExecOptions with required fields, overridable per test. */
function execOpts(over: Partial<ExecOptions> & { agent: ExecOptions['agent'] }): ExecOptions {
  return { mode: 'plan', effort: 'auto', ...over } as ExecOptions;
}

/** Find the index of the first occurrence of `tok` in argv (-1 if absent). */
function idx(cmd: string[], tok: string): number {
  return cmd.indexOf(tok);
}

describe('buildExecEnv — AGENTS_MAILBOX_DIR wiring (mailbox loop-closer)', () => {
  it('points the agent at its own box, keyed by sessionId', () => {
    const sid = '96aa7271-0c8f-4ed7-8811-1ad1d305e46e';
    const env = buildExecEnv(execOpts({ agent: 'claude', sessionId: sid }));
    expect(env.AGENTS_MAILBOX_DIR).toBe(mailboxDir(sid));
  });

  it('sets nothing when there is no session id (nothing to key a box on)', () => {
    const env = buildExecEnv(execOpts({ agent: 'claude' }));
    expect(env.AGENTS_MAILBOX_DIR).toBeUndefined();
  });

  it('lets a caller override the box via options.env (how the loop pins the run-level box)', () => {
    const runBox = mailboxDir('loop-1782947000000-abc123');
    const env = buildExecEnv(execOpts({
      agent: 'claude',
      sessionId: 'per-iteration-uuid-aaaa',
      env: { AGENTS_MAILBOX_DIR: runBox },
    }));
    expect(env.AGENTS_MAILBOX_DIR).toBe(runBox);
  });
});

describe('buildExecEnv — outbound feed runtime identity', () => {
  it('labels interactive runs as terminal and prompt runs as headless', () => {
    expect(buildExecEnv(execOpts({ agent: 'claude' })).AGENTS_RUNTIME).toBe('terminal');
    expect(buildExecEnv(execOpts({ agent: 'claude', prompt: 'work' })).AGENTS_RUNTIME).toBe('headless');
  });

  it('lets orchestrators override the runtime identity', () => {
    const env = buildExecEnv(execOpts({
      agent: 'claude',
      prompt: 'team task',
      env: { AGENTS_RUNTIME: 'teams' },
    }));
    expect(env.AGENTS_RUNTIME).toBe('teams');
  });
});

describe('buildExecEnv — Claude Code auto-updater suppression for pinned managed installs', () => {
  it('injects DISABLE_AUTOUPDATER=1 for a managed (pinned) claude version', () => {
    // Pinned per-version installs must never self-mutate: Claude Code's own
    // background auto-updater would rewrite the pinned binary in place.
    const env = buildExecEnv(execOpts({ agent: 'claude', version: '2.1.196' }));
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
  });

  it('does not clobber a DISABLE_AUTOUPDATER already in the environment (the guard)', () => {
    const prev = process.env.DISABLE_AUTOUPDATER;
    process.env.DISABLE_AUTOUPDATER = '0';
    try {
      const env = buildExecEnv(execOpts({ agent: 'claude', version: '2.1.196' }));
      expect(env.DISABLE_AUTOUPDATER).toBe('0');
    } finally {
      if (prev === undefined) delete process.env.DISABLE_AUTOUPDATER;
      else process.env.DISABLE_AUTOUPDATER = prev;
    }
  });

  it('lets a caller override the value via options.env', () => {
    const env = buildExecEnv(execOpts({
      agent: 'claude', version: '2.1.196', env: { DISABLE_AUTOUPDATER: '0' },
    }));
    expect(env.DISABLE_AUTOUPDATER).toBe('0');
  });

  it('leaves codex untouched — no DISABLE_AUTOUPDATER injected', () => {
    const env = buildExecEnv(execOpts({ agent: 'codex', version: '0.20.0' }));
    expect(env.DISABLE_AUTOUPDATER).toBeUndefined();
  });
});

describe('nativeResume (Tier-1 capability derives from the command template)', () => {
  it('claude and codex resume natively', () => {
    expect(nativeResume('claude')).toBe(true);
    expect(nativeResume('codex')).toBe(true);
  });
  it('opencode and gemini do not (they fall back to /continue replay)', () => {
    expect(nativeResume('opencode')).toBe(false);
    expect(nativeResume('gemini')).toBe(false);
  });
});

describe('buildExecCommand — versioned launch target (no unspawnable literal)', () => {
  let tmpHome: string;
  let origHome: string | undefined;

  // state.ts caches HOME at module load, so set HOME then re-import exec.js fresh.
  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-ver-'));
    process.env.HOME = tmpHome;
    vi.resetModules();
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  // Regression for `spawn kimi@0.19.2 ENOENT`: when a specific version is requested
  // and no versioned shim exists on disk, we must resolve the version's REAL binary
  // — never leave the bare `<agent>@<version>` literal as argv[0] (it's not on PATH).
  it('resolves the version binary when no versioned shim exists', async () => {
    const binDir = path.join(tmpHome, '.agents', '.history', 'versions', 'kimi', '0.19.2', 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const realBin = path.join(binDir, 'kimi');
    fs.writeFileSync(realBin, '#!/bin/sh\n', { mode: 0o755 });

    const { buildExecCommand: build } = await import('./exec.js');
    const cmd = build(execOpts({ agent: 'kimi', version: '0.19.2', interactive: true }));
    expect(cmd[0]).toBe(realBin);
    expect(cmd[0]).not.toBe('kimi@0.19.2');
  });

  it('falls back to the bare versioned name only when no binary exists at all', async () => {
    const { buildExecCommand: build } = await import('./exec.js');
    const cmd = build(execOpts({ agent: 'kimi', version: '0.19.2', interactive: true }));
    expect(cmd[0]).toBe('kimi@0.19.2');
  });
});

describe('buildExecCommand — native resume wiring', () => {
  it('claude headless: emits --resume <id> alongside the prompt, not --session-id', () => {
    const cmd = buildExecCommand(execOpts({
      agent: 'claude', resume: true, sessionId: 'abc-123', headless: true, prompt: 'keep going',
    }));
    expect(cmd).toContain('--resume');
    expect(cmd[idx(cmd, '--resume') + 1]).toBe('abc-123');
    expect(cmd).not.toContain('--session-id');
    expect(cmd[idx(cmd, '-p') + 1]).toBe('keep going');
    expect(cmd).toContain('--print');
  });

  it('claude interactive (no prompt): bare --resume <id>, no --print', () => {
    const cmd = buildExecCommand(execOpts({ agent: 'claude', resume: true, sessionId: 'abc-123', interactive: true }));
    expect(cmd[idx(cmd, '--resume') + 1]).toBe('abc-123');
    expect(cmd).not.toContain('--print');
  });

  it('legacy --session-id (no resume) still CREATES with the fixed id', () => {
    const cmd = buildExecCommand(execOpts({ agent: 'claude', sessionId: 'abc-123', headless: true, prompt: 'hi' }));
    expect(cmd).toContain('--session-id');
    expect(cmd[idx(cmd, '--session-id') + 1]).toBe('abc-123');
    expect(cmd).not.toContain('--resume');
  });

  it('codex headless edit resume: `codex exec resume <id> <prompt>` sandboxed via -c, no bypass', () => {
    const cmd = buildExecCommand(execOpts({
      agent: 'codex', mode: 'edit', resume: true, sessionId: 'xyz-9', headless: true, prompt: 'go',
    }));
    expect(cmd.slice(0, 3)).toEqual(['codex', 'exec', 'resume']);
    // Only skip may bypass approvals/sandbox — edit resumes stay sandboxed.
    expect(cmd).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(cmd).toContain('sandbox_mode=workspace-write');
    expect(cmd).toContain('sandbox_workspace_write.network_access=true');
    expect(idx(cmd, 'xyz-9')).toBeGreaterThan(idx(cmd, 'resume'));
    expect(idx(cmd, 'go')).toBeGreaterThan(idx(cmd, 'xyz-9'));
    // codex's `exec resume` does NOT accept --sandbox; it must not leak through.
    expect(cmd).not.toContain('--sandbox');
  });

  it('codex headless skip resume passes the bypass flag', () => {
    const cmd = buildExecCommand(execOpts({
      agent: 'codex', mode: 'skip', resume: true, sessionId: 'xyz-9', headless: true, prompt: 'go',
    }));
    expect(cmd.slice(0, 3)).toEqual(['codex', 'exec', 'resume']);
    expect(cmd).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(cmd).not.toContain('--sandbox');
  });

  it('codex interactive resume drops `exec` and carries the TUI sandbox flags', () => {
    const cmd = buildExecCommand(execOpts({ agent: 'codex', mode: 'plan', resume: true, sessionId: 'xyz-9', interactive: true }));
    expect(cmd).toEqual(['codex', 'resume', '--sandbox', 'read-only', 'xyz-9']);
  });

  it('codex plan-mode headless resume passes no bypass (read-only via -c sandbox_mode)', () => {
    const cmd = buildExecCommand(execOpts({ agent: 'codex', mode: 'plan', resume: true, sessionId: 'xyz-9', headless: true, prompt: 'go' }));
    expect(cmd).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(cmd).toContain('sandbox_mode=read-only');
  });

  it('non-native agent ignores resume in the arg builder (Tier-2 handles it via the prompt)', () => {
    const cmd = buildExecCommand(execOpts({ agent: 'gemini', resume: true, sessionId: 'qqq', headless: true, prompt: 'go' }));
    expect(cmd).not.toContain('--resume');
    expect(cmd).not.toContain('qqq');
  });
});

describe('shouldTapStdout (budget live-watcher attach gating, #346 FIX 3)', () => {
  // The regression FIX 3 fixes: a headless run AT A TERMINAL (piped=false) with
  // caps active used to leave stdout 'inherit', so child.stdout was null and the
  // live hard-cap kill never engaged. The watcher must now attach there too.
  it('TAPS a non-interactive run at a TTY when caps are active (the FIX 3 case)', () => {
    expect(shouldTapStdout(/*interactive*/ false, /*piped*/ false, /*capsActive*/ true)).toBe(true);
  });

  it('does NOT tap a non-interactive run at a TTY when no caps are configured', () => {
    // Zero-overhead for budget non-users: no watcher, no pipe, stdout stays inherit.
    expect(shouldTapStdout(false, false, false)).toBe(false);
  });

  it('still taps a piped non-interactive run regardless of caps (preserve compose path)', () => {
    expect(shouldTapStdout(false, true, false)).toBe(true);
    expect(shouldTapStdout(false, true, true)).toBe(true);
  });

  it('NEVER taps an interactive session even with caps active (human owns the TTY)', () => {
    expect(shouldTapStdout(true, false, true)).toBe(false);
    expect(shouldTapStdout(true, true, true)).toBe(false);
  });

  // Fallback chains need a stdout tail: Claude prints billing refusals (spend
  // limit / out of credits) to stdout, so a stderr-only scan never cascades.
  it('taps when a fallback chain requests a stdout tail, even at a TTY with no caps', () => {
    expect(shouldTapStdout(false, false, false, /*captureTail*/ true)).toBe(true);
  });

  it('captureTail never overrides the interactive guard', () => {
    expect(shouldTapStdout(true, false, false, true)).toBe(false);
  });
});

describe('resolveInteractive (sanity for the gating inputs above)', () => {
  it('a prompt-bearing run is non-interactive (headless), so it is eligible to tap', () => {
    expect(resolveInteractive({ prompt: 'hi' })).toBe(false);
  });
  it('a prompt-less run is interactive (never tapped)', () => {
    expect(resolveInteractive({ prompt: undefined })).toBe(true);
  });
  it('--headless forces non-interactive even without a prompt', () => {
    expect(resolveInteractive({ headless: true, prompt: undefined })).toBe(false);
  });
});

describe('resolveShimSpawn (Windows .cmd shim exec, #shims)', () => {
  it('POSIX execs the binary directly, no shell', () => {
    const r = resolveShimSpawn('linux', '/home/u/.agents/.../claude', ['--help']);
    expect(r).toEqual({ command: '/home/u/.agents/.../claude', args: ['--help'], shell: false });
  });

  it('win32 .cmd path goes through the shell as ONE composed line with empty args (DEP0190-safe)', () => {
    const r = resolveShimSpawn('win32', 'C:\\bin\\claude.cmd', ['run']);
    // No unescaped args array left for Node to concatenate: the command is the
    // whole quoted line and args is empty.
    expect(r.command).toBe('C:\\bin\\claude.cmd run');
    expect(r.args).toEqual([]);
    expect(r.shell).toBe(true);
  });

  it('win32 sends a bare (non-absolute) name to the shell for PATHEXT resolution', () => {
    const r = resolveShimSpawn('win32', 'claude', []);
    expect(r.command).toBe('claude');
    expect(r.args).toEqual([]);
    expect(r.shell).toBe(true);
  });

  it('win32 quotes prompt args with spaces/metachars into the composed line', () => {
    // The injection/splitting surface: a multi-word prompt and cmd metacharacters
    // must survive as ONE argument to the child, not be split or interpreted.
    const r = resolveShimSpawn('win32', 'C:\\bin\\claude.cmd', ['-p', 'review my code & ship']);
    expect(r.command).toBe('C:\\bin\\claude.cmd -p "review my code & ship"');
    expect(r.args).toEqual([]);
    expect(r.shell).toBe(true);
  });
});

describe('shouldWrapInTmux (interactive spawn-wrap gate)', () => {
  /** The wrap-eligible baseline: interactive, macOS, not nested, no opt-out, tmux present. */
  const base: TmuxWrapContext = {
    interactive: true,
    platform: 'darwin',
    inTmux: false,
    raw: false,
    noTmuxEnv: false,
    tmuxAvailable: true,
  };

  it('wraps an interactive macOS/Linux run when tmux is available and nothing opts out', () => {
    expect(shouldWrapInTmux(base)).toBe(true);
    expect(shouldWrapInTmux({ ...base, platform: 'linux' })).toBe(true);
  });

  it('never wraps a headless run (no TTY to attach)', () => {
    expect(shouldWrapInTmux({ ...base, interactive: false })).toBe(false);
  });

  it('never wraps on Windows', () => {
    expect(shouldWrapInTmux({ ...base, platform: 'win32' })).toBe(false);
  });

  it('never double-wraps when already inside tmux', () => {
    expect(shouldWrapInTmux({ ...base, inTmux: true })).toBe(false);
  });

  it('respects the --raw and AGENTS_NO_TMUX escape hatches', () => {
    expect(shouldWrapInTmux({ ...base, raw: true })).toBe(false);
    expect(shouldWrapInTmux({ ...base, noTmuxEnv: true })).toBe(false);
  });

  it('does not wrap when tmux is not installed', () => {
    expect(shouldWrapInTmux({ ...base, tmuxAvailable: false })).toBe(false);
  });
});

describe('formatPaneTail (dead-pane failure recap)', () => {
  it('keeps the last N non-empty lines, right-stripped, in order', () => {
    const raw = 'a  \n\n b\nc\t\n\n';
    expect(formatPaneTail(raw, 2)).toBe(' b\nc');
  });

  it('surfaces the real ENOENT crash a fast-failing agent leaves in the pane', () => {
    // The exact class of output that used to be swallowed by the bare [detached].
    const raw = [
      'Error: spawn /Users/x/.agents/.history/versions/codex/0.116.0/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex ENOENT',
      "    at ChildProcess._handle.onexit (node:internal/child_process:285:19)",
      '',
      'Pane is dead (status 1, Tue Jul  7 07:06:21 2026)',
    ].join('\n');
    const out = formatPaneTail(raw);
    expect(out).toContain('ENOENT');
    expect(out).toContain('Pane is dead (status 1');
    expect(out).not.toMatch(/\n\n/); // blank lines dropped
  });

  it('returns empty string for an all-whitespace capture', () => {
    expect(formatPaneTail('  \n\n\t\n')).toBe('');
  });
});

describe('buildTmuxAgentCommand (env-preserving pane command)', () => {
  it('execs the agent with a full env prefix (bare values need no quoting)', () => {
    const cmd = buildTmuxAgentCommand('claude', ['--permission-mode', 'plan'], {
      CLAUDE_CONFIG_DIR: '/home/me/.agents/versions/claude/2.1/home/.claude',
      PATH: '/usr/bin:/bin',
    });
    expect(cmd.startsWith('exec env ')).toBe(true);
    // Safe values (only [A-Za-z0-9_./:=@%+-]) pass through shellQuote unquoted.
    expect(cmd).toContain('CLAUDE_CONFIG_DIR=/home/me/.agents/versions/claude/2.1/home/.claude');
    expect(cmd).toContain('PATH=/usr/bin:/bin');
    // The agent + its args land after the env prefix.
    expect(cmd).toMatch(/ claude --permission-mode plan$/);
  });

  it('quotes a value containing spaces and single quotes safely', () => {
    const cmd = buildTmuxAgentCommand('claude', ["it's a test"], { FOO: "a b'c" });
    // shellQuote wraps in single quotes and escapes embedded ones — no unquoted breakout.
    expect(cmd).toContain("FOO='a b'\\''c'");
    expect(cmd).toContain("'it'\\''s a test'");
  });

  it('drops non-identifier keys so `env` does not choke on exported shell functions', () => {
    const cmd = buildTmuxAgentCommand('claude', [], {
      GOOD_KEY: '1',
      'BASH_FUNC_foo%%': '() { echo hi; }',
    });
    expect(cmd).toContain('GOOD_KEY=');
    expect(cmd).not.toContain('BASH_FUNC_foo');
  });

  it('does not forward undefined env values', () => {
    const cmd = buildTmuxAgentCommand('claude', [], { SET: 'x', UNSET: undefined });
    expect(cmd).toContain('SET=');
    expect(cmd).not.toContain('UNSET');
  });

  it('redacts secret VALUES but keeps KEY names when redactEnvValues is set (RUSH-1758)', () => {
    const cmd = buildTmuxAgentCommand(
      'claude',
      ['--permission-mode', 'plan'],
      { ANTHROPIC_API_KEY: 'sk-ant-supersecret', PATH: '/usr/bin:/bin' },
      { redactEnvValues: true },
    );
    // Key names + agent command survive for provenance…
    expect(cmd).toContain('ANTHROPIC_API_KEY=<redacted>');
    expect(cmd).toContain('PATH=<redacted>');
    expect(cmd).toMatch(/ claude --permission-mode plan$/);
    // …but no real value leaks into the (persisted) string.
    expect(cmd).not.toContain('sk-ant-supersecret');
    expect(cmd).not.toContain('/usr/bin:/bin');
  });
});
