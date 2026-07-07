import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatRelativeTime } from './relative-time.js';

// Times are pinned at 12:00Z so the local calendar day matches the UTC day in
// every timezone the tests might run in (no midnight rollover), keeping the
// month/day assertions deterministic on CI (UTC) and locally alike.
describe('formatRelativeTime', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps relative buckets for recent times', () => {
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
    expect(formatRelativeTime('2026-07-04T11:59:10.000Z')).toBe('just now');
    expect(formatRelativeTime('2026-07-04T11:30:00.000Z')).toBe('30 min ago');
    expect(formatRelativeTime('2026-07-04T09:00:00.000Z')).toBe('3 hours ago');
    expect(formatRelativeTime('2026-07-02T12:00:00.000Z')).toBe('2 days ago');
  });

  it('shows a bare month/day for an older date in the current year', () => {
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
    expect(formatRelativeTime('2026-06-01T12:00:00.000Z')).toBe('Jun 1');
  });

  it("appends a 2-digit year for a date outside the current year", () => {
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
    expect(formatRelativeTime('2025-06-28T12:00:00.000Z')).toBe("Jun 28 '25");
  });
});
