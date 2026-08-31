/**
 * Real OpenSSH regression for the daemon-safe secret push.
 *
 * TEST-NET-3 is reserved for documentation and cannot be a real destination.
 * The production `ssh` binary is started against it, then the auth-sync deadline
 * must stop that process while a timer proves the JavaScript event loop kept
 * advancing. No transport function or subprocess API is mocked.
 */
import { describe, expect, it } from 'vitest';

import { pushResolvedBundleToHostAsync } from './push.js';

describe.skipIf(process.platform === 'win32')('pushResolvedBundleToHostAsync (real OpenSSH)', () => {
  it('bounds an unreachable auth push without blocking daemon timers', async () => {
    let heartbeats = 0;
    const heartbeat = setInterval(() => { heartbeats += 1; }, 20);
    const startedAt = Date.now();
    try {
      const result = await pushResolvedBundleToHostAsync(
        {
          env: { ANTHROPIC_AUTH_TOKEN: 'not-a-live-token' },
          dotenv: 'ANTHROPIC_AUTH_TOKEN="not-a-live-token"\n',
          keyCount: 1,
        },
        'auth',
        '203.0.113.1',
        {
          remoteBackend: 'file',
          operation: 'auth-sync-test',
          timeoutMs: 150,
        },
      );
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/timed out|remote import failed|ssh failed/i);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(heartbeats).toBeGreaterThanOrEqual(2);
    } finally {
      clearInterval(heartbeat);
    }
  });
});
