import { describe, test, expect } from 'bun:test';
import { latestActivity } from './floorData';

describe('latestActivity', () => {
  test('picks the chronologically latest timestamp', () => {
    expect(
      latestActivity(['2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z', '2026-03-01T00:00:00Z']),
    ).toBe('2026-06-01T00:00:00Z');
  });

  test('compares by real time, not lexically (mixed offsets)', () => {
    // Lexically "2026-07-09T09:00:00-05:00" > "2026-07-09T10:00:00Z", but the
    // -05:00 instant (14:00Z) is actually later than 10:00Z.
    expect(
      latestActivity(['2026-07-09T10:00:00Z', '2026-07-09T09:00:00-05:00']),
    ).toBe('2026-07-09T09:00:00-05:00');
  });

  test('skips empty / missing entries', () => {
    expect(latestActivity(['', '2026-02-01T00:00:00Z', ''])).toBe('2026-02-01T00:00:00Z');
  });

  test('falls back to a fresh ISO timestamp when nothing usable', () => {
    const out = latestActivity([]);
    expect(Number.isNaN(new Date(out).getTime())).toBe(false);
  });
});
