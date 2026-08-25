import { describe, it, expect } from 'vitest';
import { shouldOpenInteractiveComputerSessions } from './computer-sessions-picker.js';

describe('shouldOpenInteractiveComputerSessions', () => {
  it('opens on a bare TTY invocation', () => {
    expect(shouldOpenInteractiveComputerSessions({}, true)).toBe(true);
  });

  it('never opens off a TTY, regardless of flags', () => {
    expect(shouldOpenInteractiveComputerSessions({}, false)).toBe(false);
  });

  it('--json always falls through to the static printer', () => {
    expect(shouldOpenInteractiveComputerSessions({ json: true }, true)).toBe(false);
  });

  it('--no-interactive (interactive: false) opts out even on a TTY with no other flags', () => {
    expect(shouldOpenInteractiveComputerSessions({ interactive: false }, true)).toBe(false);
  });

  it('interactive: true is a no-op — TTY + no disqualifying flags still governs', () => {
    expect(shouldOpenInteractiveComputerSessions({ interactive: true }, true)).toBe(true);
  });

  it('a --machine filter alone does not disqualify the interactive picker', () => {
    expect(shouldOpenInteractiveComputerSessions({ machine: 'zion' }, true)).toBe(true);
  });
});
