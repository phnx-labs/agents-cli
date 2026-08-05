import { describe, it, expect } from 'vitest';
import {
  FLEET_REMOTE_ENV,
  isFleetRemoteInvocation,
  assertRemoteControlAllowed,
} from './remote-control.js';

describe('isFleetRemoteInvocation', () => {
  it('is true only when the marker env is exactly "1"', () => {
    expect(isFleetRemoteInvocation({ [FLEET_REMOTE_ENV]: '1' })).toBe(true);
    expect(isFleetRemoteInvocation({ [FLEET_REMOTE_ENV]: '0' })).toBe(false);
    expect(isFleetRemoteInvocation({ [FLEET_REMOTE_ENV]: 'true' })).toBe(false);
    expect(isFleetRemoteInvocation({})).toBe(false);
  });
});

describe('assertRemoteControlAllowed', () => {
  it('never gates a local (non-fleet) invocation, even with consent off', () => {
    expect(() => assertRemoteControlAllowed({ env: {}, enabled: false })).not.toThrow();
  });

  it('allows a fleet-remote drive when the owner opted in', () => {
    expect(() =>
      assertRemoteControlAllowed({ env: { [FLEET_REMOTE_ENV]: '1' }, enabled: true }),
    ).not.toThrow();
  });

  it('refuses a fleet-remote drive when consent is off, and names how to enable it', () => {
    expect(() =>
      assertRemoteControlAllowed({
        env: { [FLEET_REMOTE_ENV]: '1', AGENTS_ACTOR_HOST: 'yosemite-s0' },
        enabled: false,
      }),
    ).toThrow(/yosemite-s0.*browser --host.*agents browser remote-control on/s);
  });

  it('falls back to a generic actor label when none is forwarded', () => {
    expect(() =>
      assertRemoteControlAllowed({ env: { [FLEET_REMOTE_ENV]: '1' }, enabled: false }),
    ).toThrow(/A fleet machine tried to drive/);
  });
});
