import { describe, expect, test } from 'bun:test';
import { CI_CACHE_HIT_BUDGET_MS, CI_P99_BUDGET_MS, RELEASE_P99_BUDGET_MS } from './timing';
import { runExecutorBenchmark } from './benchmark';

describe('executor benchmark', () => {
  test('warm one-use path stays inside CI P99/P99.9/P99.99 and the release budget', () => {
    const report = runExecutorBenchmark(24);
    expect(report.n).toBe(24);
    expect(report.p99).toBeLessThanOrEqual(CI_P99_BUDGET_MS);
    expect(report.p99_9).toBeLessThanOrEqual(CI_P99_BUDGET_MS);
    expect(report.p99_99).toBeLessThanOrEqual(CI_P99_BUDGET_MS);
    expect(report.max).toBeLessThanOrEqual(CI_CACHE_HIT_BUDGET_MS);
    expect(report.withinCiP99).toBe(true);
    expect(report.withinCiP99_9).toBe(true);
    expect(report.withinCiP99_99).toBe(true);
    expect(report.budgets.releaseP99Ms).toBe(RELEASE_P99_BUDGET_MS);
  });
});
