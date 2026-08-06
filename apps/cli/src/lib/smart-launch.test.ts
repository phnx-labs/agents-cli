import { describe, expect, it } from 'vitest';
import {
  affinityWeights,
  sampleWeighted,
  resolveDeviceAffinity,
  isDeviceAuto,
  applyDeviceAutoToOptions,
  resolveDeviceAuto,
  type WeightedCandidate,
} from './smart-launch.js';
import type { AffinityRow } from './session/db.js';

function row(key: string, launches: number): AffinityRow {
  return { key, launches, durationMs: 0, tokenCount: 0, costUsd: 0 };
}

describe('affinityWeights', () => {
  it('gives higher weight to more launches', () => {
    const w = affinityWeights([row('s1', 10), row('m0', 1)], 1.0);
    expect(w.find((c) => c.key === 's1')!.weight).toBeGreaterThan(
      w.find((c) => c.key === 'm0')!.weight,
    );
  });

  it('drops unknown / zero-launch keys', () => {
    const w = affinityWeights([row('(unknown)', 5), row('s1', 0), row('s1', 3)]);
    expect(w.every((c) => c.key !== '(unknown)')).toBe(true);
    expect(w.every((c) => c.launches > 0)).toBe(true);
  });
});

describe('sampleWeighted', () => {
  it('returns null for empty candidates', () => {
    expect(sampleWeighted([])).toBeNull();
  });

  it('always picks the only candidate', () => {
    expect(sampleWeighted([{ key: 'only', launches: 1, weight: 1 }])).toBe('only');
  });

  it('prefers the heavier weight with a deterministic rng', () => {
    const cands: WeightedCandidate[] = [
      { key: 's1', launches: 90, weight: 90 },
      { key: 'm0', launches: 10, weight: 10 },
    ];
    expect(sampleWeighted(cands, () => 0.5)).toBe('s1');
    expect(sampleWeighted(cands, () => 0.95)).toBe('m0');
  });
});

describe('isDeviceAuto', () => {
  it('matches auto case-insensitively', () => {
    expect(isDeviceAuto('auto')).toBe(true);
    expect(isDeviceAuto('AUTO')).toBe(true);
    expect(isDeviceAuto(' Auto ')).toBe(true);
    expect(isDeviceAuto('yosemite-s1')).toBe(false);
    expect(isDeviceAuto(undefined)).toBe(false);
  });
});

describe('resolveDeviceAffinity', () => {
  it('samples most-used online host', () => {
    const plan = resolveDeviceAffinity({
      localMachine: 'yosemite-s0',
      eligibleHosts: ['yosemite-s0', 'yosemite-s1', 'yosemite-m0'],
      deviceAffinity: [
        row('yosemite-s1', 50),
        row('yosemite-s0', 5),
        row('yosemite-m0', 1),
      ],
      rng: () => 0.5,
    });
    expect(plan.host).toBe('yosemite-s1');
  });

  it('returns host null when local machine is picked', () => {
    const plan = resolveDeviceAffinity({
      localMachine: 'yosemite-s0',
      eligibleHosts: ['yosemite-s0'],
      deviceAffinity: [row('yosemite-s0', 10)],
      rng: () => 0.5,
    });
    expect(plan.host).toBeNull();
  });

  it('excludes offline hosts from affinity', () => {
    const plan = resolveDeviceAffinity({
      localMachine: 'yosemite-s0',
      eligibleHosts: ['yosemite-s0'],
      deviceAffinity: [row('yosemite-s1', 100), row('yosemite-s0', 2)],
      rng: () => 0.5,
    });
    expect(plan.host).toBeNull();
    expect(plan.pickedDeviceKey).toBe('yosemite-s0');
  });
});

describe('resolveDeviceAuto', () => {
  it('picks the least-loaded reachable device with the requested agent installed', async () => {
    const plan = await resolveDeviceAuto('codex', {
      localMachine: 'local',
      eligibleHosts: ['local', 'busy', 'idle-no-codex', 'idle'],
      probe: async () => new Map([
        ['local', { reachable: true, loadPercent: 30, memPercent: 20, headroom: 'light', installed: true, signedIn: true }],
        ['busy', { reachable: true, loadPercent: 80, memPercent: 20, headroom: 'loaded', installed: true }],
        ['idle-no-codex', { reachable: true, loadPercent: 2, memPercent: 5, headroom: 'idle', installed: false }],
        ['idle', { reachable: true, loadPercent: 5, memPercent: 5, headroom: 'idle', installed: true, signedIn: true }],
      ]),
    });
    expect(plan.host).toBe('idle');
    expect(plan.pickedDeviceKey).toBe('idle');
  });

  it('falls back to local when live probing cannot produce a viable remote', async () => {
    const plan = await resolveDeviceAuto('codex', {
      localMachine: 'local',
      eligibleHosts: ['local', 'remote'],
      probe: async () => {
        throw new Error('probe unavailable');
      },
    });
    expect(plan.host).toBeNull();
    expect(plan.pickedDeviceKey).toBe('local');
  });

  it('keeps live load placement when run auto has not selected a harness yet', async () => {
    const plan = await resolveDeviceAuto(undefined, {
      localMachine: 'local',
      eligibleHosts: ['local', 'idle'],
      probe: async (_pool, agent) => {
        expect(agent).toBeUndefined();
        return new Map([
          ['local', { reachable: true, loadPercent: 40, memPercent: 20, headroom: 'light' }],
          ['idle', { reachable: true, loadPercent: 5, memPercent: 10, headroom: 'idle' }],
        ]);
      },
    });
    expect(plan.host).toBe('idle');
    expect(plan.pickedDeviceKey).toBe('idle');
  });
});

describe('applyDeviceAutoToOptions', () => {
  it('rewrites --device auto to a concrete remote host and enables balanced', async () => {
    const options = { device: 'auto' as string | undefined };
    const result = await applyDeviceAutoToOptions(options, {
      resolve: () => ({
        host: 'yosemite-s1',
        candidates: [
          { key: 'yosemite-s1', loadPercent: 5 },
          { key: 'yosemite-s0', loadPercent: 50 },
        ],
        pickedDeviceKey: 'yosemite-s1',
      }),
    });
    expect(options.device).toBe('yosemite-s1');
    expect(options.balanced).toBe(true);
    expect(result.attempted).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(result.banner?.hostLabel).toBe('yosemite-s1');
    expect(result.banner?.deviceHint).toContain('yosemite-s1:5%');
    expect(result.banner?.acctNote).toBe('accounts=balanced');
  });

  it('rewrites auto on every host slot alias once', async () => {
    const options = {
      host: 'auto' as string | undefined,
      device: 'auto' as string | undefined,
    };
    await applyDeviceAutoToOptions(options, {
      resolve: () => ({
        host: 'mac-mini',
        candidates: [{ key: 'mac-mini', loadPercent: 3 }],
        pickedDeviceKey: 'mac-mini',
      }),
    });
    expect(options.host).toBe('mac-mini');
    expect(options.device).toBe('mac-mini');
  });

  it('maps local pick to undefined host (no --host)', async () => {
    const options = { device: 'auto' as string | undefined };
    const result = await applyDeviceAutoToOptions(options, {
      resolve: () => ({
        host: null,
        candidates: [{ key: 'yosemite-s0', loadPercent: 10 }],
        pickedDeviceKey: 'yosemite-s0',
      }),
    });
    expect(options.device).toBeUndefined();
    expect(result.banner?.hostLabel).toBe('local');
  });

  it('maps deprecated --smart to --device auto when no host given', async () => {
    const options: { smart?: boolean; device?: string } = { smart: true };
    await applyDeviceAutoToOptions(options, {
      resolve: () => ({
        host: 'zion',
        candidates: [{ key: 'zion', loadPercent: 1 }],
        pickedDeviceKey: 'zion',
      }),
    });
    expect(options.device).toBe('zion');
  });

  it('does not override an explicit host when --smart is also set', async () => {
    const options = { smart: true, device: 'gpu-box' as string | undefined };
    const result = await applyDeviceAutoToOptions(options, {
      resolve: () => {
        throw new Error('should not resolve');
      },
    });
    expect(options.device).toBe('gpu-box');
    expect(result.attempted).toBe(false);
    expect(result.deprecationSmart).toBe(true);
  });

  it('degrades to local on resolve failure without throwing', async () => {
    const options = { device: 'auto' as string | undefined, balanced: undefined as boolean | undefined };
    const result = await applyDeviceAutoToOptions(options, {
      resolve: () => {
        throw new Error('db locked');
      },
    });
    expect(result.skipped).toBe('db locked');
    expect(options.device).toBeUndefined();
    expect(options.balanced).toBeUndefined();
    expect(result.banner).toBeUndefined();
  });

  it('preserves strategy override and account-picker note', async () => {
    const options = {
      device: 'auto' as string | undefined,
      strategy: 'round-robin',
    };
    const result = await applyDeviceAutoToOptions(options, {
      accountPickerRequested: true,
      resolve: () => ({
        host: null,
        candidates: [],
        pickedDeviceKey: 'local',
      }),
    });
    expect(options.strategy).toBe('round-robin');
    expect(options.balanced).toBeUndefined();
    expect(result.banner?.acctNote).toBe('accounts=picker');
  });
});
