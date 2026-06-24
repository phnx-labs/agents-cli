import { describe, it, expect } from 'vitest';
import {
  costOfUsage,
  costOfSession,
  formatUsd,
  estimateCost,
  actualCost,
  isModelPriced,
} from './cost.js';

describe('costOfUsage', () => {
  it('computes a known token->cost fixture (claude-opus-4)', () => {
    // 1000 in @ $5/M = $0.005, 2000 out @ $25/M = $0.05 => $0.055
    const usd = costOfUsage({ model: 'claude-opus-4', inputTokens: 1000, outputTokens: 2000 });
    expect(usd).toBeCloseTo(0.055, 10);
  });

  it('prices cache read and cache write at their dedicated rates', () => {
    // opus: cacheRead $0.5/M, cacheWrite $6.25/M
    const usd = costOfUsage({
      model: 'claude-opus-4',
      cacheReadTokens: 10_000,    // 10000 * 5e-7 = 0.005
      cacheCreationTokens: 1_000, // 1000 * 6.25e-6 = 0.00625
    });
    expect(usd).toBeCloseTo(0.005 + 0.00625, 10);
  });

  it('falls back to input rate for cache tokens when no cache price (gpt-4o-mini cacheWrite)', () => {
    // gpt-4o-mini has cacheRead but no cacheWrite -> cacheWrite uses input rate (1.5e-7).
    const usd = costOfUsage({ model: 'gpt-4o-mini', cacheCreationTokens: 1_000_000 });
    expect(usd).toBeCloseTo(0.00000015 * 1_000_000, 10);
  });

  it('returns 0 for unknown model', () => {
    expect(costOfUsage({ model: 'nope-9000', inputTokens: 1_000_000 })).toBe(0);
  });

  it('returns 0 when model is missing', () => {
    expect(costOfUsage({ inputTokens: 1_000_000 })).toBe(0);
  });
});

describe('costOfSession', () => {
  it('sums a multi-model session', () => {
    const usd = costOfSession([
      { model: 'claude-opus-4', inputTokens: 1000, outputTokens: 1000 },  // 5e-3 + 2.5e-2 = 0.03
      { model: 'claude-haiku-4', inputTokens: 1000, outputTokens: 1000 }, // 1e-3 + 5e-3 = 0.006
      { model: 'unknown-model', inputTokens: 999999 },                     // 0
    ]);
    expect(usd).toBeCloseTo(0.03 + 0.006, 10);
  });
});

describe('formatUsd', () => {
  it('formats cents-precise dollars', () => {
    expect(formatUsd(1.23)).toBe('$1.23');
    expect(formatUsd(1.236)).toBe('$1.24');
  });
  it('floors tiny nonzero costs to <$0.01', () => {
    expect(formatUsd(0.004)).toBe('<$0.01');
  });
  it('renders exact zero and negatives as $0.00', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(-5)).toBe('$0.00');
  });
});

describe('estimateCost', () => {
  it('returns usd + matched model for a priced model', () => {
    const r = estimateCost('claude-sonnet-4', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(r.usd).toBeCloseTo(3, 10); // $3/M input
    expect(r.modelMatched).toBe('claude-sonnet-4');
  });
  it('returns 0 usd + null match for an unpriced model', () => {
    const r = estimateCost('nope-9000', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(r.usd).toBe(0);
    expect(r.modelMatched).toBeNull();
  });
});

describe('actualCost', () => {
  it('matches costOfUsage for the same inputs', () => {
    const r = actualCost('gpt-4.1', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(r.usd).toBeCloseTo(
      costOfUsage({ model: 'gpt-4.1', inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      10,
    );
  });
});

describe('isModelPriced', () => {
  it('true for known, false for unknown', () => {
    expect(isModelPriced('claude-opus-4-8')).toBe(true);
    expect(isModelPriced('nope-9000')).toBe(false);
  });
});
