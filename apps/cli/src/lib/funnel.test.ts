import { describe, expect, it } from 'vitest';
import { buildFunnelStatusCommand, buildFunnelUpCommand, parseFunnelPort } from './funnel.js';

describe('funnel command builders', () => {
  it('accepts only Tailscale Funnel public ports', () => {
    expect(parseFunnelPort('443')).toBe(443);
    expect(parseFunnelPort('8443')).toBe(8443);
    expect(parseFunnelPort('10000')).toBe(10000);
    expect(() => parseFunnelPort('8787')).toThrow(/443, 8443, 10000/);
  });

  it('builds status and up commands for ssh execution', () => {
    expect(buildFunnelStatusCommand()).toBe('tailscale funnel status');
    expect(buildFunnelUpCommand(443, 8787)).toBe('tailscale funnel --bg --https=443 http://localhost:8787');
    expect(() => buildFunnelUpCommand(443, 70000)).toThrow(/Local port/);
  });
});
