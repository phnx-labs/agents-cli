import { describe, it, expect } from 'vitest';
import { isTierToken, tierizeModels, resolveTierMap, resolveTier, MODEL_TIERS } from './model-tiers.js';
import { getModelCatalog, type ModelInfo } from './models.js';
import { listInstalledVersions } from './versions.js';
import { buildExecCommand } from './exec.js';
import { setTierOverride, clearTierOverride } from './model-tier-overrides.js';

describe('curated Kimi ladder + override application (gated on a Kimi install)', () => {
  const kimi = listInstalledVersions('kimi');
  const v = kimi[kimi.length - 1];

  it.runIf(kimi.length > 0)('curated ladder: best=K3, cheap=highspeed, ultra clamps, all [curated]', () => {
    const m = resolveTierMap('kimi', v);
    expect(m.best.model).toMatch(/k3/);
    expect(m.cheap.model).toMatch(/highspeed/);
    expect(m.ultra.clampedFrom).toBe('best');
    expect(m.best.source).toBe('curated');
  });

  it.runIf(kimi.length > 0)('an override present in the catalog is used and marked [override]; clears cleanly', () => {
    try {
      setTierOverride('kimi', 'cheap', 'kimi-code/k3');
      const r = resolveTier('kimi', v, 'cheap');
      expect(r.model).toBe('kimi-code/k3');
      expect(r.source).toBe('override');
    } finally {
      clearTierOverride('kimi');
    }
    expect(resolveTier('kimi', v, 'cheap').source).toBe('curated'); // back to auto
  });
});

const m = (ids: string[]): ModelInfo[] => ids.map((id) => ({ id }));

describe('isTierToken', () => {
  it('accepts the four tiers, rejects ids and unknown words', () => {
    for (const t of MODEL_TIERS) expect(isTierToken(t)).toBe(true);
    expect(isTierToken('claude-opus-5')).toBe(false);
    expect(isTierToken('sonnet')).toBe(false);
    expect(isTierToken(undefined)).toBe(false);
  });
});

describe('tierizeModels — provider lineup (Claude)', () => {
  it('maps haiku/sonnet/opus and picks the newest opus for the family', () => {
    const map = tierizeModels('claude', m(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-1', 'claude-opus-4-8']));
    expect(map.cheap.model).toContain('haiku');
    expect(map.default.model).toContain('sonnet');
    // family-collapse keeps the newest concrete id, not opus-4-1
    expect(map.best.model).toBe('claude-opus-4-8');
  });

  it('clamps ultra down to best when the version has no Fable', () => {
    const map = tierizeModels('claude', m(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8']));
    expect(map.ultra.clampedFrom).toBe('best'); // borrowed best's rung
    expect(map.ultra.model).toBe('claude-opus-4-8');
  });

  it('picks the dash-separated newer id (sonnet-5 beats sonnet-4-6)', () => {
    // compareVersions splits only on '.', so it used to rank claude-sonnet-5
    // *below* claude-sonnet-4-6. default must resolve to the genuinely newer id.
    const map = tierizeModels('claude', m(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8']));
    expect(map.default.model).toBe('claude-sonnet-5');
  });

  it('resolves ultra to Fable when present, without clamping', () => {
    const map = tierizeModels('claude', m(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5']));
    expect(map.ultra.model).toBe('claude-fable-5');
    expect(map.ultra.clampedFrom).toBeUndefined();
  });
});

describe('tierizeModels — single-model harness maps tiers to effort', () => {
  it('resolves every tier to the one model with ascending reasoning effort', () => {
    const map = tierizeModels('grok', m(['grok-4.5']));
    for (const t of MODEL_TIERS) expect(map[t].model).toBe('grok-4.5');
    expect(map.cheap.effort).toBe('low');
    expect(map.default.effort).toBe('medium');
    expect(map.best.effort).toBe('high');
    expect(map.ultra.effort).toBe('xhigh');
  });
});

describe('tierizeModels — price path (no lineup) ranks and buckets by $/token', () => {
  it('cheapest priced model is cheap, dearest is ultra', () => {
    // opencode has no family lineup and no descriptions -> falls to price ranking.
    const map = tierizeModels('opencode', m(['gpt-5.6-sol', 'gpt-4o-mini', 'gpt-5', 'gpt-4o']));
    expect(map.cheap.model).toBe('gpt-4o-mini'); // cheapest per prices.json
    expect(map.ultra.model).toBe('gpt-5.6-sol'); // dearest
    // distinct-priced models must not collapse into a single rung
    const distinct = new Set(MODEL_TIERS.map((t) => map[t].model));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('does not merge two DIFFERENT models that share the same price', () => {
    // gpt-5.5 and gpt-5.6-sol are byte-identical in prices.json; collapsing by
    // price would drop one entirely. Both must remain reachable as distinct rungs.
    const map = tierizeModels('opencode', m(['gpt-4o-mini', 'gpt-5.4', 'gpt-5.5', 'gpt-5.6-sol']));
    const picked = new Set(MODEL_TIERS.map((t) => map[t].model));
    expect(picked.has('gpt-5.5')).toBe(true);
    expect(picked.has('gpt-5.6-sol')).toBe(true);
  });
});

describe('resolveTierMap — Droid curated credit-multiplier map', () => {
  it('is a fixed 2x-capped map regardless of version', () => {
    const map = resolveTierMap('droid', '0.0.0');
    expect(map.cheap.model).toBe('glm-5.2');
    expect(map.default.model).toBe('kimi-k3');
    expect(map.best.model).toBe('claude-opus-5');
    expect(map.ultra.model).toBe('claude-opus-5'); // clamped, avoids 4x
    expect(map.ultra.clampedFrom).toBe('best');
  });
});

describe('buildExecCommand — a tier token reaches the argv (gated on Grok install)', () => {
  const grok = listInstalledVersions('grok');
  it.runIf(grok.length > 0)('single-model tier forwards the model AND steers reasoning effort', () => {
    const argv = buildExecCommand({
      agent: 'grok', version: grok[grok.length - 1], prompt: 'x', mode: 'auto', effort: 'auto', model: 'best', headless: true,
    } as Parameters<typeof buildExecCommand>[0]);
    expect(argv).toContain('grok-4.5'); // concrete model forwarded, not "best"
    expect(argv).not.toContain('best'); // no literal tier token leaked
    const i = argv.indexOf('--reasoning-effort');
    expect(i).toBeGreaterThan(-1); // effort actually wired (Blocker 2 regression)
    expect(argv[i + 1]).toBe('high'); // best -> high
  });
});

describe('resolveTier / extraction — real installed Claude (gated)', () => {
  const versions = listInstalledVersions('claude');
  it.runIf(versions.length > 0)('yields a non-empty catalog and a Fable-or-clamped ultra', () => {
    const v = versions[versions.length - 1];
    const cat = getModelCatalog('claude', v);
    expect(cat && cat.models.length).toBeGreaterThan(0); // id-scan floor: never 0 on a native binary
    const ultra = resolveTier('claude', v, 'ultra');
    expect(ultra.model).toBeTruthy();
    expect(ultra.model!.startsWith('claude-')).toBe(true);
  });
});
