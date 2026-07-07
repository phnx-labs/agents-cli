import { describe, it, expect } from 'vitest';
import { shouldTapStdout, resolveInteractive, buildExecCommand, nativeResume, resolveShimSpawn, buildExecEnv, shouldWrapInTmux, buildTmuxAgentCommand, type TmuxWrapContext } from './exec.js';
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

  it('codex headless: `codex exec resume <id> <prompt>` with the bypass flag, id before prompt', () => {
    const cmd = buildExecCommand(execOpts({
      agent: 'codex', mode: 'edit', resume: true, sessionId: 'xyz-9', headless: true, prompt: 'go',
    }));
    expect(cmd.slice(0, 3)).toEqual(['codex', 'exec', 'resume']);
    expect(cmd).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(idx(cmd, 'xyz-9')).toBeGreaterThan(idx(cmd, 'resume'));
    expect(idx(cmd, 'go')).toBeGreaterThan(idx(cmd, 'xyz-9'));
    // codex's `exec resume` does NOT accept --sandbox; it must not leak through.
    expect(cmd).not.toContain('--sandbox');
  });

  it('codex interactive resume drops `exec`: `codex resume <id>`, no sandbox flags', () => {
    const cmd = buildExecCommand(execOpts({ agent: 'codex', mode: 'plan', resume: true, sessionId: 'xyz-9', interactive: true }));
    expect(cmd).toEqual(['codex', 'resume', 'xyz-9']);
  });

  it('codex plan-mode headless resume passes no bypass (read-only intent inherits sandbox)', () => {
    const cmd = buildExecCommand(execOpts({ agent: 'codex', mode: 'plan', resume: true, sessionId: 'xyz-9', headless: true, prompt: 'go' }));
    expect(cmd).not.toContain('--dangerously-bypass-approvals-and-sandbox');
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
});
