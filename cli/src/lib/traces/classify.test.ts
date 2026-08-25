import { describe, expect, it } from 'vitest';
import { classifyCause, classifyTopic, computeDriftSignal, type BucketStats } from './classify.js';

describe('classifyCause', () => {
  it('buckets real tool_calls guard, hook, and ordinary failures', () => {
    expect(classifyCause({ tool: 'exec_command', error: 'git-guard blocked git push' })).toBe('guard');
    expect(classifyCause({ tool: 'Bash', error_code: 'main-branch-guard' })).toBe('guard');
    expect(classifyCause({
      tool: 'Bash',
      error: 'Permission for this action was denied by the Claude Code auto mode classifier. The user can add a Bash permission rule.',
    })).toBe('hook');
    expect(classifyCause({ tool: 'Bash', exit_code: 1, error: 'command failed' })).toBe('real');
  });
});

describe('classifyTopic', () => {
  it('uses repository metadata and tool mix without transcript content', () => {
    expect(classifyTopic({ gitBranch: 'fix/session-cache', toolMix: { Edit: 3 } })).toEqual({
      group: 'code', key: 'engineering', label: 'Engineering',
    });
    expect(classifyTopic({ label: 'Review PR 123' })).toEqual({
      group: 'review', key: 'code-review', label: 'Code review',
    });
  });
});

describe('computeDriftSignal', () => {
  function makeHistory(errorRates: number[], stallRates: number[], key = 'engineering'): BucketStats[][] {
    return errorRates.map((errorRate, i) => [
      { key, date: `2026-08-${String(i + 1).padStart(2, '0')}`, count: 10, errorRate, stallRate: stallRates[i] },
    ]);
  }

  it('returns degrading when errorDelta exceeds threshold', () => {
    // history: 7 days of 10% error rate; today: 35% → delta +0.25 → degrading
    const history = makeHistory([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], [0, 0, 0, 0, 0, 0, 0]);
    const today: BucketStats[] = [{ key: 'engineering', date: '2026-08-08', count: 10, errorRate: 0.35, stallRate: 0 }];
    const signals = computeDriftSignal(history, today);
    expect(signals).toHaveLength(1);
    expect(signals[0].severity).toBe('degrading');
    expect(signals[0].errorDelta).toBeCloseTo(0.25);
  });

  it('returns improving when errorDelta is below negative threshold', () => {
    // history: 7 days of 40% error rate; today: 10% → delta −0.30 → improving
    const history = makeHistory([0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4], [0, 0, 0, 0, 0, 0, 0]);
    const today: BucketStats[] = [{ key: 'engineering', date: '2026-08-08', count: 10, errorRate: 0.1, stallRate: 0 }];
    const signals = computeDriftSignal(history, today);
    expect(signals[0].severity).toBe('improving');
    expect(signals[0].errorDelta).toBeCloseTo(-0.30);
  });

  it('returns stable when deltas are within threshold', () => {
    const history = makeHistory([0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2], [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
    const today: BucketStats[] = [{ key: 'engineering', date: '2026-08-08', count: 10, errorRate: 0.22, stallRate: 0.12 }];
    const signals = computeDriftSignal(history, today);
    expect(signals[0].severity).toBe('stable');
  });

  it('skips buckets with fewer than 3 historical days', () => {
    // Only 2 days of history for this bucket
    const history = makeHistory([0.1, 0.1], [0, 0]);
    const today: BucketStats[] = [{ key: 'engineering', date: '2026-08-03', count: 10, errorRate: 0.9, stallRate: 0.9 }];
    expect(computeDriftSignal(history, today)).toHaveLength(0);
  });

  it('sorts output by errorDelta descending', () => {
    const history: BucketStats[][] = [
      [
        { key: 'engineering', date: '2026-08-01', count: 5, errorRate: 0.1, stallRate: 0 },
        { key: 'operations', date: '2026-08-01', count: 5, errorRate: 0.1, stallRate: 0 },
      ],
      [
        { key: 'engineering', date: '2026-08-02', count: 5, errorRate: 0.1, stallRate: 0 },
        { key: 'operations', date: '2026-08-02', count: 5, errorRate: 0.1, stallRate: 0 },
      ],
      [
        { key: 'engineering', date: '2026-08-03', count: 5, errorRate: 0.1, stallRate: 0 },
        { key: 'operations', date: '2026-08-03', count: 5, errorRate: 0.1, stallRate: 0 },
      ],
    ];
    const today: BucketStats[] = [
      { key: 'engineering', date: '2026-08-04', count: 5, errorRate: 0.5, stallRate: 0 },
      { key: 'operations', date: '2026-08-04', count: 5, errorRate: 0.35, stallRate: 0 },
    ];
    const signals = computeDriftSignal(history, today);
    expect(signals[0].bucket).toBe('engineering');
    expect(signals[1].bucket).toBe('operations');
  });
});
