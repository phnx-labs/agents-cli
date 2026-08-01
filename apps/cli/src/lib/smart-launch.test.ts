import { describe, expect, it } from 'vitest';
import {
  affinityWeights,
  sampleWeighted,
  resolveDeviceAffinity,
  isDeviceAuto,
  applyDeviceAutoToOptions,
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

describe('applyDeviceAutoToOptions', () => {
  it('rewrites --device auto to a concrete remote host and enables balanced', () => {
    const options = { device: 'auto' as string | undefined };
    const result = applyDeviceAutoToOptions(options, {
      resolve: () => ({
        host: 'yosemite-s1',
        deviceCandidates: [
          { key: 'yosemite-s1', launches: 50, weight: 50 },
          { key: 'yosemite-s0', launches: 5, weight: 5 },
        ],
        pickedDeviceKey: 'yosemite-s1',
      }),
    });
    expect(options.device).toBe('yosemite-s1');
    expect(options.balanced).toBe(true);
    expect(result.attempted).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(result.banner?.hostLabel).toBe('yosemite-s1');
    expect(result.banner?.deviceHint).toContain('yosemite-s1:50');
    expect(result.banner?.acctNote).toBe('accounts=balanced');
  });

  it('rewrites auto on every host slot alias once', () => {
    const options = {
      host: 'auto' as string | undefined,
      device: 'auto' as string | undefined,
    };
    applyDeviceAutoToOptions(options, {
      resolve: () => ({
        host: 'mac-mini',
        deviceCandidates: [{ key: 'mac-mini', launches: 3, weight: 3 }],
        pickedDeviceKey: 'mac-mini',
      }),
    });
    expect(options.host).toBe('mac-mini');
    expect(options.device).toBe('mac-mini');
  });

  it('maps local pick to undefined host (no --host)', () => {
    const options = { device: 'auto' as string | undefined };
    const result = applyDeviceAutoToOptions(options, {
      resolve: () => ({
        host: null,
        deviceCandidates: [{ key: 'yosemite-s0', launches: 10, weight: 10 }],
        pickedDeviceKey: 'yosemite-s0',
      }),
    });
    expect(options.device).toBeUndefined();
    expect(result.banner?.hostLabel).toBe('local');
  });

  it('maps deprecated --smart to --device auto when no host given', () => {
    const options: { smart?: boolean; device?: string } = { smart: true };
    applyDeviceAutoToOptions(options, {
      resolve: () => ({
        host: 'zion',
        deviceCandidates: [{ key: 'zion', launches: 1, weight: 1 }],
        pickedDeviceKey: 'zion',
      }),
    });
    expect(options.device).toBe('zion');
  });

  it('does not override an explicit host when --smart is also set', () => {
    const options = { smart: true, device: 'gpu-box' as string | undefined };
    const result = applyDeviceAutoToOptions(options, {
      resolve: () => {
        throw new Error('should not resolve');
      },
    });
    expect(options.device).toBe('gpu-box');
    expect(result.attempted).toBe(false);
    expect(result.deprecationSmart).toBe(true);
  });

  it('degrades to local on resolve failure without throwing', () => {
    const options = { device: 'auto' as string | undefined, balanced: undefined as boolean | undefined };
    const result = applyDeviceAutoToOptions(options, {
      resolve: () => {
        throw new Error('db locked');
      },
    });
    expect(result.skipped).toBe('db locked');
    expect(options.device).toBeUndefined();
    expect(options.balanced).toBeUndefined();
    expect(result.banner).toBeUndefined();
  });

  it('preserves strategy override and account-picker note', () => {
    const options = {
      device: 'auto' as string | undefined,
      strategy: 'round-robin',
    };
    const result = applyDeviceAutoToOptions(options, {
      accountPickerRequested: true,
      resolve: () => ({
        host: null,
        deviceCandidates: [],
        pickedDeviceKey: 'local',
      }),
    });
    expect(options.strategy).toBe('round-robin');
    expect(options.balanced).toBeUndefined();
    expect(result.banner?.acctNote).toBe('accounts=picker');
  });
});
