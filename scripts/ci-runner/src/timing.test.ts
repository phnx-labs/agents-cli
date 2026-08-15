import { describe, expect, test } from 'bun:test';
import { CI_P99_BUDGET_MS, RELEASE_P99_BUDGET_MS, eventToTerminalMs, percentile, phaseMs, summarize } from './timing';
import { emptyTimings } from './types';

describe('timing', () => {
  test('splits queue/setup/exec/report and event-to-terminal', () => {
    const timings = emptyTimings(1000);
    timings.admittedAtMs = 1100;
    timings.setupStartedAtMs = 1100;
    timings.setupEndedAtMs = 1400;
    timings.execStartedAtMs = 1400;
    timings.execEndedAtMs = 5000;
    timings.reportedAtMs = 5050;
    expect(phaseMs(timings, 'queue')).toBe(100);
    expect(phaseMs(timings, 'setup')).toBe(300);
    expect(phaseMs(timings, 'exec')).toBe(3600);
    expect(phaseMs(timings, 'report')).toBe(50);
    expect(eventToTerminalMs(timings)).toBe(4050);
  });

  test('percentiles stay inside the RUSH-2666 budgets for a fast sample', () => {
    const samples = Array.from({ length: 200 }, (_, i) => 20 + (i % 7));
    const stats = summarize(samples);
    expect(stats.p99).toBeLessThanOrEqual(CI_P99_BUDGET_MS);
    expect(stats.p99_9).toBeLessThanOrEqual(CI_P99_BUDGET_MS);
    expect(stats.p99_99).toBeLessThanOrEqual(CI_P99_BUDGET_MS);
    expect(RELEASE_P99_BUDGET_MS).toBe(180_000);
    expect(percentile([1, 2, 3, 4], 1)).toBe(4);
  });
});
