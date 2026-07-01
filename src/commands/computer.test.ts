import { describe, expect, it } from 'vitest';
import { shouldBlockOffPlatform } from './computer.js';

// The `computer` preAction hook calls process.exit(1) exactly when
// shouldBlockOffPlatform() is true. These cases pin the rule that off-macOS
// invocations are NOT blocked once a remote daemon is reachable.
describe('shouldBlockOffPlatform', () => {
  it('never blocks on macOS (local Accessibility path)', () => {
    expect(shouldBlockOffPlatform({ platform: 'darwin', tcpConfigured: false })).toBe(false);
    expect(shouldBlockOffPlatform({ platform: 'darwin', tcpConfigured: true, host: 'win-mini' })).toBe(false);
  });

  it('blocks off macOS with no remote path configured', () => {
    expect(shouldBlockOffPlatform({ platform: 'linux', tcpConfigured: false })).toBe(true);
    expect(shouldBlockOffPlatform({ platform: 'win32', tcpConfigured: false })).toBe(true);
  });

  it('does NOT block off macOS when COMPUTER_HELPER_TCP is configured', () => {
    // This is the regression the transport fix targets: a Linux host with a
    // tunnel to a Windows daemon must be allowed to drive it.
    expect(shouldBlockOffPlatform({ platform: 'linux', tcpConfigured: true })).toBe(false);
  });

  it('does NOT block off macOS when a --host remote device is given', () => {
    // The remote path resolves its own endpoint before the client opens.
    expect(shouldBlockOffPlatform({ platform: 'linux', tcpConfigured: false, host: 'win-mini' })).toBe(false);
  });
});
