import { describe, expect, it } from 'vitest';
import {
  affinityWeights,
  sampleWeighted,
  resolveSmartLaunch,
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
    // filter is per-row; s1 with 0 dropped, (unknown) dropped
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
    // total = 90 + 10 = 100; rng 0.5 → roll 50 → first candidate (weight 90)
    const cands: WeightedCandidate[] = [
      { key: 's1', launches: 90, weight: 90 },
      { key: 'm0', launches: 10, weight: 10 },
    ];
    expect(sampleWeighted(cands, () => 0.5)).toBe('s1');
    // rng near 1 → second candidate
    expect(sampleWeighted(cands, () => 0.95)).toBe('m0');
  });
});

describe('resolveSmartLaunch', () => {
  it('samples most-used online host and keeps agent fixed', () => {
    const plan = resolveSmartLaunch({
      agent: 'claude',
      localMachine: 'yosemite-s0',
      eligibleHosts: ['yosemite-s0', 'yosemite-s1', 'yosemite-m0'],
      deviceAffinity: [
        row('yosemite-s1', 50),
        row('yosemite-s0', 5),
        row('yosemite-m0', 1),
      ],
      // total ≈ 5^α + 50^α + 1; mid roll lands in the heavy s1 bucket
      rng: () => 0.5,
    });
    expect(plan.agent).toBe('claude');
    expect(plan.accountStrategy).toBe('balanced');
    expect(plan.host).toBe('yosemite-s1'); // not local
  });

  it('returns host null when local machine is picked', () => {
    const plan = resolveSmartLaunch({
      agent: 'codex',
      localMachine: 'yosemite-s0',
      eligibleHosts: ['yosemite-s0'],
      deviceAffinity: [row('yosemite-s0', 10)],
      rng: () => 0.5,
    });
    expect(plan.host).toBeNull();
    expect(plan.agent).toBe('codex');
  });

  it('excludes offline hosts from affinity', () => {
    const plan = resolveSmartLaunch({
      agent: 'claude',
      localMachine: 'yosemite-s0',
      eligibleHosts: ['yosemite-s0'], // s1 not online
      deviceAffinity: [row('yosemite-s1', 100), row('yosemite-s0', 2)],
      rng: () => 0.5,
    });
    expect(plan.host).toBeNull(); // only local eligible
    expect(plan.pickedDeviceKey).toBe('yosemite-s0');
  });

  it('picks harness from allowlist when pickHarness is true', () => {
    const plan = resolveSmartLaunch({
      pickHarness: true,
      allowAgents: ['claude', 'codex', 'kimi'],
      localMachine: 'zion',
      eligibleHosts: ['zion'],
      deviceAffinity: [row('zion', 3)],
      harnessAffinity: [row('codex', 40), row('claude', 10), row('kimi', 1)],
      rng: () => 0.01,
    });
    expect(plan.agent).toBe('codex');
    expect(plan.accountStrategy).toBe('balanced');
  });
});
