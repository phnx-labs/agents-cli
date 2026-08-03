import { describe, it, expect } from 'vitest';
import {
  parseTerminalFlag,
  stripTerminalFlag,
  buildRunCommand,
  openRunInTerminal,
  TERMINAL_FLAG_BACKENDS,
} from './run-surface.js';

describe('parseTerminalFlag', () => {
  it('accepts the bare flag as auto-detect', () => {
    expect(parseTerminalFlag(true)).toEqual({});
    expect(parseTerminalFlag(undefined)).toEqual({});
  });

  it('accepts every registered backend id', () => {
    for (const id of TERMINAL_FLAG_BACKENDS) {
      expect(parseTerminalFlag(id)).toEqual({ backend: id });
    }
  });

  it('rejects an unknown backend instead of silently auto-detecting', () => {
    const { backend, error } = parseTerminalFlag('warp');
    expect(backend).toBeUndefined();
    expect(error).toContain("Unknown --terminal backend 'warp'");
    expect(error).toContain('ghostty');
    expect(error).not.toContain('looks like a prompt');
  });

  it('explains the swallowed prompt, since the optional value eats it', () => {
    // commander assigns the next non-option token to `--terminal [backend]`, so
    // `agents run claude --terminal "fix the bug"` arrives here as the value.
    const { error } = parseTerminalFlag('fix the bug');
    expect(error).toContain('That looks like a prompt');
    expect(error).toContain('put it BEFORE the flag');
  });
});

describe('stripTerminalFlag', () => {
  it('removes the bare flag and keeps every other argument', () => {
    expect(stripTerminalFlag(['run', 'claude', '--terminal', '--mode', 'auto'])).toEqual([
      'run', 'claude', '--mode', 'auto',
    ]);
  });

  it('removes the =value form', () => {
    expect(stripTerminalFlag(['run', 'claude', '--terminal=ghostty'])).toEqual(['run', 'claude']);
  });

  it('removes the value commander consumed, but only that token', () => {
    expect(stripTerminalFlag(['run', 'claude', '--terminal', 'ghostty', '--mode', 'edit'], 'ghostty'))
      .toEqual(['run', 'claude', '--mode', 'edit']);
  });

  it('strips only the flag when the next token is another option', () => {
    // commander assigns an optional value only from a non-option token, so here
    // `--mode` is not the flag's value and must survive.
    expect(stripTerminalFlag(['run', 'claude', '--terminal', '--mode', 'auto'])).toEqual([
      'run', 'claude', '--mode', 'auto',
    ]);
  });

  it('removes a consumed prompt-shaped value exactly once, not every match', () => {
    // `--terminal "fix the bug"` makes commander hand the PROMPT over as the
    // value (parseTerminalFlag rejects it with a hint). If that argv ever reaches
    // the stripper, only the token after the flag goes — a later identical
    // operand is the user's and stays.
    expect(stripTerminalFlag(['run', 'claude', '--terminal', 'auto', 'auto'], 'auto')).toEqual([
      'run', 'claude', 'auto',
    ]);
  });

  it('preserves a -- passthrough tail', () => {
    expect(stripTerminalFlag(['run', 'kimi', '--terminal', '--', '--plan'])).toEqual([
      'run', 'kimi', '--', '--plan',
    ]);
  });

  it('never rewrites past --, where the tokens belong to the agent CLI', () => {
    // `--terminal` after `--` is the AGENT's flag, forwarded verbatim. Stripping
    // it here would silently corrupt the passthrough.
    expect(stripTerminalFlag(['run', 'kimi', '--terminal', '--', '--terminal', 'x'])).toEqual([
      'run', 'kimi', '--', '--terminal', 'x',
    ]);
    expect(stripTerminalFlag(['run', 'kimi', '--', '--terminal=ghostty'])).toEqual([
      'run', 'kimi', '--', '--terminal=ghostty',
    ]);
  });
});

describe('buildRunCommand', () => {
  it('shell-quotes every argument so a prompt with spaces stays one argument', () => {
    const cmd = buildRunCommand(['run', 'claude', 'fix the bug']);
    // A prompt with spaces is quoted; plain tokens are left bare.
    expect(cmd.at(-1)).toBe("'fix the bug'");
    expect(cmd).toContain('run');
    expect(cmd).toContain('claude');
  });
});

describe('openRunInTerminal', () => {
  it('reports a clear failure instead of launching when no terminal can be driven', async () => {
    // Linux, no tmux: nothing in the registry is available.
    const res = await openRunInTerminal({
      argv: ['run', 'claude', '--terminal'],
      cwd: '/tmp',
      sessions: [{ host: 'iterm' }],
      ctx: { platform: 'linux', env: {} },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('No terminal this machine can drive');
  });

  it('refuses a forced backend that is not available here', async () => {
    const res = await openRunInTerminal({
      argv: ['run', 'claude', '--terminal', 'ghostty'],
      forced: 'ghostty',
      consumedValue: 'ghostty',
      cwd: '/tmp',
      sessions: [],
      ctx: { platform: 'linux', env: {} },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not available here');
  });
});
