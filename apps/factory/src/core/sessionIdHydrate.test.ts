import { describe, test, expect, beforeEach } from 'bun:test';
import {
  activeMapCacheKey,
  fetchTerminalIdSessionMap,
  needsSessionIdHydrate,
  resetSessionIdHydrateCacheForTests,
  resolveSessionIdForTerminal,
  ACTIVE_MAP_TTL_REMOTE_MS,
} from './sessionIdHydrate';

beforeEach(() => {
  resetSessionIdHydrateCacheForTests();
});

describe('activeMapCacheKey', () => {
  test('undefined host → local key', () => {
    expect(activeMapCacheKey(undefined, 'yosemite-s1', 'yosemite-s1')).toBe('__local__');
  });

  test('same-machine --device collapses to local (no self-SSH)', () => {
    expect(activeMapCacheKey('yosemite-s1', 'yosemite-s1', 'yosemite-s1')).toBe('__local__');
    expect(activeMapCacheKey('yosemite-s1', 'yosemite-s1.tailnet', 'yosemite-s1')).toBe('__local__');
  });

  test('different device stays as a host key', () => {
    expect(activeMapCacheKey('yosemite-s0', 'yosemite-s1', 'yosemite-s1')).toBe('yosemite-s0');
  });
});

describe('fetchTerminalIdSessionMap / resolveSessionIdForTerminal', () => {
  test('15 concurrent tabs on one host share ONE CLI invocation', async () => {
    let calls = 0;
    const runAgents = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return {
        stdout: JSON.stringify([
          { terminalId: 'GK-1', sessionId: '019fd199-da69-7c21-9477-5577a6dd725d' },
          { terminalId: 'GK-2', sessionId: '019fd178-2fab-7d60-857a-53f3dc793303' },
        ]),
        stderr: '',
      };
    };
    const now = 1_000;
    const results = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        resolveSessionIdForTerminal(`GK-${(i % 2) + 1}`, 'yosemite-s0', {
          runAgents,
          now,
          localHostname: 'zion',
        }),
      ),
    );
    expect(calls).toBe(1);
    expect(results.filter((r) => r === '019fd199-da69-7c21-9477-5577a6dd725d').length).toBe(8);
    expect(results.filter((r) => r === '019fd178-2fab-7d60-857a-53f3dc793303').length).toBe(7);
  });

  test('TTL cache: second wave inside TTL does not re-fetch', async () => {
    let calls = 0;
    const runAgents = async () => {
      calls++;
      return {
        stdout: JSON.stringify([
          { terminalId: 'CX-1', sessionId: 'rollout-2026-08-05T02-03-01-019fd129-6e9f-7082-ad08-9c22de9f1234' },
        ]),
        stderr: '',
      };
    };
    const t0 = 5_000;
    expect(
      await resolveSessionIdForTerminal('CX-1', 'box-a', {
        runAgents,
        now: t0,
        localHostname: 'zion',
      }),
    ).toBe('019fd129-6e9f-7082-ad08-9c22de9f1234');
    expect(
      await resolveSessionIdForTerminal('CX-1', 'box-a', {
        runAgents,
        now: t0 + ACTIVE_MAP_TTL_REMOTE_MS - 1,
        localHostname: 'zion',
      }),
    ).toBe('019fd129-6e9f-7082-ad08-9c22de9f1234');
    expect(calls).toBe(1);
  });

  test('CLI failure → empty map (unmapped, not wrong)', async () => {
    const runAgents = async () => {
      throw new Error('ssh timeout');
    };
    const map = await fetchTerminalIdSessionMap('dead-box', {
      runAgents,
      now: 1,
      localHostname: 'zion',
    });
    expect(map.size).toBe(0);
    expect(
      await resolveSessionIdForTerminal('GK-1', 'dead-box', {
        runAgents,
        now: 1,
        localHostname: 'zion',
      }),
    ).toBeUndefined();
  });

  test('local path uses --local (no --host) via isLocal key', async () => {
    let seenArgs = '';
    const runAgents = async (args: string) => {
      seenArgs = args;
      return { stdout: '[]', stderr: '' };
    };
    await fetchTerminalIdSessionMap(undefined, {
      runAgents,
      now: 1,
      localHostname: 'yosemite-s1',
    });
    expect(seenArgs).toContain('--local');
    expect(seenArgs).not.toContain('--host');
    expect(seenArgs).not.toContain('--where');
  });
});

describe('needsSessionIdHydrate', () => {
  test('true when missing or rollout stem', () => {
    expect(needsSessionIdHydrate(undefined)).toBe(true);
    expect(needsSessionIdHydrate('')).toBe(true);
    expect(needsSessionIdHydrate('rollout-2026-08-05T00-00-00-aaaa-bbbb-cccc-ddddeeee')).toBe(true);
  });

  test('false for a clean UUID', () => {
    expect(needsSessionIdHydrate('019fd199-da69-7c21-9477-5577a6dd725d')).toBe(false);
  });
});
