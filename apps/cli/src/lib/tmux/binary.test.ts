import { describe, expect, it } from 'vitest';
import { isTmuxVersionSupported } from './binary.js';

describe('isTmuxVersionSupported', () => {
  it('accepts tmux 3.2 and newer, including patch suffixes', () => {
    expect(isTmuxVersionSupported('tmux 3.2')).toBe(true);
    expect(isTmuxVersionSupported('tmux 3.3a')).toBe(true);
    expect(isTmuxVersionSupported('tmux 3.6a')).toBe(true);
    expect(isTmuxVersionSupported('tmux 4.0')).toBe(true);
  });

  it('rejects older, missing, and unparseable versions', () => {
    expect(isTmuxVersionSupported('tmux 3.1c')).toBe(false);
    expect(isTmuxVersionSupported('tmux 2.9')).toBe(false);
    expect(isTmuxVersionSupported('tmux unknown')).toBe(false);
    expect(isTmuxVersionSupported(null)).toBe(false);
  });
});
