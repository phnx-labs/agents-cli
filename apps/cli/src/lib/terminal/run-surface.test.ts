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

  it('does not eat a following prompt when no value was consumed', () => {
    // `--terminal` took no value, so the next token is the user's, not the flag's.
    expect(stripTerminalFlag(['run', 'claude', '--terminal', 'fix the bug'])).toEqual([
      'run', 'claude', 'fix the bug',
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
