import { describe, expect, it } from 'vitest';
import {
  affinityWeights,
  sampleWeighted,
  resolveDeviceAffinity,
  isDeviceAuto,
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
