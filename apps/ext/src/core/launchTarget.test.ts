import { describe, it, expect } from 'vitest';
import { resolveLaunchTarget, launchOptsForTarget, DEFAULT_LAUNCH_TARGET } from './launchTarget';

describe('resolveLaunchTarget', () => {
  it('defaults to auto when unset', () => {
    expect(resolveLaunchTarget(undefined)).toBe('auto');
    expect(DEFAULT_LAUNCH_TARGET).toBe('auto');
  });

  it('accepts the three configured values', () => {
    expect(resolveLaunchTarget('auto')).toBe('auto');
    expect(resolveLaunchTarget('local')).toBe('local');
    expect(resolveLaunchTarget('ask')).toBe('ask');
  });

  it('falls back to the default on an unrecognized value instead of failing the launch', () => {
    expect(resolveLaunchTarget('worker')).toBe('auto');
    expect(resolveLaunchTarget(42)).toBe('auto');
    expect(resolveLaunchTarget(null)).toBe('auto');
  });
});

describe('launchOptsForTarget', () => {
  it('auto sets neither flag, so the launch emits --device auto', () => {
    expect(launchOptsForTarget('auto')).toEqual({});
  });

  it('local pins this machine', () => {
    expect(launchOptsForTarget('local')).toEqual({ local: true });
  });

  it('ask prompts for the host', () => {
    expect(launchOptsForTarget('ask')).toEqual({ pickHost: true });
  });
});
