import { describe, it, expect } from 'vitest';
import {
  FLEET_REMOTE_ENV,
  isFleetRemoteInvocation,
  assertRemoteControlAllowed,
  assertRemoteControlAllowedForRequest,
} from './remote-control.js';
import { vi, afterEach } from 'vitest';

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
    ).toThrow(/yosemite-s0.*browser --device.*agents browser remote-control on/s);
  });

  it('falls back to a generic actor label when none is forwarded', () => {
    expect(() =>
      assertRemoteControlAllowed({ env: { [FLEET_REMOTE_ENV]: '1' }, enabled: false }),
    ).toThrow(/A fleet machine tried to drive/);
  });
});

// The daemon-side gate. This is the authoritative one: `browser start` was the
// only gated COMMAND, but 18 page verbs create a browser implicitly, so every
// one of them could open a browser on a machine that never opted in.
describe('assertRemoteControlAllowedForRequest', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('never gates a local request', () => {
    expect(() => assertRemoteControlAllowedForRequest(undefined, { enabled: false })).not.toThrow();
    expect(() => assertRemoteControlAllowedForRequest(false, { enabled: false })).not.toThrow();
  });

  it('refuses a fleet-remote request when consent is off, naming the actor and the fix', () => {
    expect(() =>
      assertRemoteControlAllowedForRequest(true, { enabled: false, actor: 'yosemite-s0' }),
    ).toThrow(/yosemite-s0.*browser --device.*agents browser remote-control on/s);
  });

  it('allows a fleet-remote request once the owner opted in', () => {
    expect(() => assertRemoteControlAllowedForRequest(true, { enabled: true })).not.toThrow();
  });

  it('IGNORES the daemon own environment — a leaked marker must not gate local drives', () => {
    // The browser daemon is shared and long-lived, and startDetached passes
    // `env: opts.env ?? process.env`. A daemon auto-started by a fleet-remote CLI
    // therefore inherits AGENTS_FLEET_REMOTE=1 for its whole life. If this gate
    // read process.env it would refuse every subsequent LOCAL drive on this
    // machine until the daemon restarted.
    vi.stubEnv(FLEET_REMOTE_ENV, '1');
    expect(() => assertRemoteControlAllowedForRequest(undefined, { enabled: false })).not.toThrow();
  });
});
