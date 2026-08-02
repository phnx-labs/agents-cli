import { describe, expect, test } from 'bun:test';
import {
  LAUNCH_HEALTH_MAX_AGE_MS,
  LaunchHealthCache,
  LaunchHistory,
  LaunchHistoryRecorder,
  pickCachedLaunchHost,
  recordLaunch,
} from './launchHistory';

const NOW = 1_800_000_000_000;

function cache(devices: LaunchHealthCache['devices']): LaunchHealthCache {
  return { devices, refreshedAt: NOW };
}

describe('pickCachedLaunchHost', () => {
  test('combines successful recent history with cached machine health', () => {
    const health = cache([
      { name: 'familiar', online: true, sshReachable: true, running: 1, loadAvg1: 1, memPercent: 20, usableAgents: { codex: true }, fetchedAt: NOW },
      { name: 'unused', online: true, sshReachable: true, running: 0, loadAvg1: 1, memPercent: 20, usableAgents: { codex: true }, fetchedAt: NOW },
    ]);
    const history = {
      familiar: { launches: 12, successes: 12, lastLaunchAt: NOW - 60_000 },
    };

    expect(pickCachedLaunchHost('codex', health, history, {}, NOW)).toBe('familiar');
  });

  test('never selects offline, SSH-unreachable, or harness-unusable devices', () => {
    const health = cache([
      { name: 'offline', online: false, sshReachable: true, running: 0, usableAgents: { claude: true }, fetchedAt: NOW },
      { name: 'ssh-down', online: true, sshReachable: false, running: 0, usableAgents: { claude: true }, fetchedAt: NOW },
      { name: 'signed-out', online: true, sshReachable: true, running: 0, usableAgents: { claude: false }, fetchedAt: NOW },
      { name: 'ready', online: true, sshReachable: true, running: 3, usableAgents: { claude: true }, fetchedAt: NOW },
    ]);

    expect(pickCachedLaunchHost('claude', health, {}, {}, NOW)).toBe('ready');
  });

  test('cold or stale cache returns null for local fallback', () => {
    expect(pickCachedLaunchHost('gemini', undefined, {}, {}, NOW)).toBeNull();
    const stale = cache([]);
    stale.refreshedAt = NOW - LAUNCH_HEALTH_MAX_AGE_MS - 1;
    expect(pickCachedLaunchHost('gemini', stale, {}, {}, NOW)).toBeNull();
  });

  test('excludes devices disabled for auto-launch', () => {
    const health = cache([
      { name: 'disabled', online: true, sshReachable: true, running: 0, loadAvg1: 1, memPercent: 20, usableAgents: { claude: true }, fetchedAt: NOW },
      { name: 'enabled', online: true, sshReachable: true, running: 3, loadAvg1: 1, memPercent: 20, usableAgents: { claude: true }, fetchedAt: NOW },
    ]);
    const preferences = { disabled: { enabled: false } };

    expect(pickCachedLaunchHost('claude', health, {}, preferences, NOW)).toBe('enabled');
  });

  test('boosts preferred devices in ranking', () => {
    const health = cache([
      { name: 'busy', online: true, sshReachable: true, running: 10, loadAvg1: 1, memPercent: 20, usableAgents: { claude: true }, fetchedAt: NOW },
      { name: 'preferred', online: true, sshReachable: true, running: 10, loadAvg1: 1, memPercent: 20, usableAgents: { claude: true }, fetchedAt: NOW },
    ]);
    const preferences = { preferred: { preferred: true } };

    expect(pickCachedLaunchHost('claude', health, {}, preferences, NOW)).toBe('preferred');
  });
});

test('recordLaunch preserves per-device frequency, recency, and success', () => {
  const first = recordLaunch({}, 'Yosemite-S0', true, NOW - 10);
  const second = recordLaunch(first, 'yosemite-s0', false, NOW);
  expect(second['yosemite-s0']).toEqual({ launches: 2, successes: 1, lastLaunchAt: NOW });
});

test('LaunchHistoryRecorder serializes concurrent read-modify-write updates', async () => {
  let stored: LaunchHistory = {};
  const recorder = new LaunchHistoryRecorder(
    () => stored,
    async (history) => {
      await Bun.sleep(5);
      stored = history;
    },
  );

  await Promise.all([
    recorder.record('yosemite-s0', true, NOW - 1),
    recorder.record('yosemite-s0', true, NOW),
  ]);

  expect(stored['yosemite-s0']).toEqual({ launches: 2, successes: 2, lastLaunchAt: NOW });
});

test('LaunchHistoryRecorder continues after one persistence failure', async () => {
  let stored: LaunchHistory = {};
  let attempts = 0;
  const recorder = new LaunchHistoryRecorder(
    () => stored,
    async (history) => {
      attempts += 1;
      if (attempts === 1) throw new Error('storage unavailable');
      stored = history;
    },
  );

  await expect(recorder.record('yosemite-s0', true, NOW - 1)).rejects.toThrow('storage unavailable');
  await recorder.record('yosemite-s0', true, NOW);

  expect(stored['yosemite-s0']).toEqual({ launches: 1, successes: 1, lastLaunchAt: NOW });
});
