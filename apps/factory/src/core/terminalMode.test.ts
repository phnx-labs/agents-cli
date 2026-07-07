import { describe, it, expect } from 'bun:test';
import { normalizeTerminalMode, resolveTerminalMode } from './terminalMode';

describe('normalizeTerminalMode', () => {
  it('passes through the two explicit non-default modes', () => {
    expect(normalizeTerminalMode('tmux')).toBe('tmux');
    expect(normalizeTerminalMode('native')).toBe('native');
  });

  it('defaults everything else to auto (the new tmux-by-default behavior)', () => {
    expect(normalizeTerminalMode('auto')).toBe('auto');
    expect(normalizeTerminalMode(undefined)).toBe('auto');
    expect(normalizeTerminalMode(null)).toBe('auto');
    expect(normalizeTerminalMode('')).toBe('auto');
    expect(normalizeTerminalMode('TMUX')).toBe('auto'); // case-sensitive
    expect(normalizeTerminalMode(true)).toBe('auto'); // stale legacy boolean
    expect(normalizeTerminalMode(false)).toBe('auto');
    expect(normalizeTerminalMode('bogus')).toBe('auto');
  });
});

describe('resolveTerminalMode', () => {
  it('auto uses tmux when available, native otherwise, never warns', () => {
    expect(resolveTerminalMode('auto', true)).toEqual({ useTmux: true, warnUnavailable: false });
    expect(resolveTerminalMode('auto', false)).toEqual({ useTmux: false, warnUnavailable: false });
  });

  it('tmux forces tmux when available and warns+falls-back when not', () => {
    expect(resolveTerminalMode('tmux', true)).toEqual({ useTmux: true, warnUnavailable: false });
    expect(resolveTerminalMode('tmux', false)).toEqual({ useTmux: false, warnUnavailable: true });
  });

  it('native never uses tmux and never warns, regardless of availability', () => {
    expect(resolveTerminalMode('native', true)).toEqual({ useTmux: false, warnUnavailable: false });
    expect(resolveTerminalMode('native', false)).toEqual({ useTmux: false, warnUnavailable: false });
  });
});
