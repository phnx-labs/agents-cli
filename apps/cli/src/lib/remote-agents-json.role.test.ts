/**
 * Regression for the prix-cloud finding on RUSH-1733: `agents sessions --active`
 * and `agents go` fan out via gatherRemoteAgentsJson, which must skip control
 * devices by ROLE (not just the incidental `unknown` platform). A control device
 * that is online with a real platform must never be dialed. Temp HOME + dynamic
 * import so the registry reads the throwaway root.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-fanout-role-'));
process.env.HOME = TEST_HOME;

const { upsertDevice } = await import('./devices/registry.js');
const { gatherRemoteAgentsJson } = await import('./remote-agents-json.js');

afterAll(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

describe('gatherRemoteAgentsJson device filter', () => {
  it('skips a control device even when it is online with a real platform', async () => {
    // Online, linux platform (not the incidental `unknown`), non-routable IP so
    // a dial would be an observable failure — but role=control must prevent it.
    await upsertDevice('test-cockpit', {
      platform: 'linux',
      role: 'control',
      address: { via: 'tailscale', ip: '203.0.113.1' }, // TEST-NET-3, unroutable
      tailscale: { online: true, direct: true },
    });

    const res = await gatherRemoteAgentsJson<never>({
      args: ['sessions', '--active', '--json'],
      noFanoutEnv: 'AGENTS_SESSIONS_LOCAL',
      parse: () => [],
    });

    // The control device is the only peer and must be filtered out — so no dial
    // happens and the count is 0. Without the role skip this would be 1 (a real
    // SSH attempt against the unroutable IP).
    expect(res.deviceCount).toBe(0);
    expect(res.items).toEqual([]);
  });
});
