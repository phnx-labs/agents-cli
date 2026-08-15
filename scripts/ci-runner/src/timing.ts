import type { Timings } from './types';

export type TimingPhase = 'queue' | 'setup' | 'exec' | 'report';

export function phaseMs(timings: Timings, phase: TimingPhase): number | null {
  switch (phase) {
    case 'queue':
      return timings.admittedAtMs == null ? null : timings.admittedAtMs - timings.enqueuedAtMs;
    case 'setup':
      return timings.setupStartedAtMs == null || timings.setupEndedAtMs == null
        ? null
        : timings.setupEndedAtMs - timings.setupStartedAtMs;
    case 'exec':
      return timings.execStartedAtMs == null || timings.execEndedAtMs == null
        ? null
        : timings.execEndedAtMs - timings.execStartedAtMs;
    case 'report':
      return timings.execEndedAtMs == null || timings.reportedAtMs == null
        ? null
        : timings.reportedAtMs - timings.execEndedAtMs;
  }
}

export function eventToTerminalMs(timings: Timings): number | null {
  if (timings.reportedAtMs == null) return null;
  return timings.reportedAtMs - timings.enqueuedAtMs;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error('percentile of empty sample');
  if (p < 0 || p > 1) throw new Error(`percentile out of range: ${p}`);
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const w = idx - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
}

export function summarize(samples: readonly number[]): {
  n: number;
  p50: number;
  p99: number;
  p99_9: number;
  p99_99: number;
  max: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
    p99_9: percentile(sorted, 0.999),
    p99_99: percentile(sorted, 0.9999),
    max: sorted[sorted.length - 1]!,
  };
}

export const CI_P99_BUDGET_MS = 90_000;
export const CI_CACHE_HIT_BUDGET_MS = 10_000;
export const RELEASE_P99_BUDGET_MS = 180_000;
