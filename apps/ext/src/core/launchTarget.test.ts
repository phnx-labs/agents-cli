import { describe, it, expect } from 'vitest';
import {
  resolveLaunchTarget,
  launchOptsForTarget,
  launchOptsForHarnessCommand,
  DEFAULT_LAUNCH_TARGET,
} from './launchTarget';

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

describe('launchOptsForHarnessCommand', () => {
  it('default auto-picks the device and asks for its account/version', () => {
    expect(launchOptsForHarnessCommand('default', 'auto')).toEqual({ accountPicker: true });
  });

  it('preserves explicit local or ask placement while still asking for the account/version', () => {
    expect(launchOptsForHarnessCommand('default', 'local')).toEqual({ local: true, accountPicker: true });
    expect(launchOptsForHarnessCommand('default', 'ask')).toEqual({ pickHost: true, accountPicker: true });
  });

  it('Pick Host asks for both layers while Auto asks for neither', () => {
    expect(launchOptsForHarnessCommand('pick-host')).toEqual({ pickHost: true, accountPicker: true });
    expect(launchOptsForHarnessCommand('auto')).toEqual({});
  });
});
