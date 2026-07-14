import { describe, expect, it } from 'vitest';
import { isSessionActivityFresh } from './db.js';

describe('isSessionActivityFresh', () => {
  const nowMs = Date.parse('2026-07-12T12:00:00.000Z');

  it('accepts a transcript inside the explicit freshness bound', () => {
    expect(isSessionActivityFresh(
      { last_activity: '2026-07-12T11:30:00.000Z', timestamp: '2026-07-01T00:00:00.000Z', file_mtime_ms: null },
      60 * 60_000,
      nowMs,
    )).toBe(true);
  });

  it('rejects a stale transcript even when its session was created recently', () => {
    expect(isSessionActivityFresh(
      { last_activity: '2026-05-16T12:00:00.000Z', timestamp: '2026-07-12T11:00:00.000Z', file_mtime_ms: null },
      24 * 60 * 60_000,
      nowMs,
    )).toBe(false);
  });

  it('accepts a transcript exactly on the freshness boundary', () => {
    expect(isSessionActivityFresh(
      { last_activity: '2026-07-11T12:00:00.000Z', timestamp: '2026-07-01T00:00:00.000Z', file_mtime_ms: null },
      24 * 60 * 60_000,
      nowMs,
    )).toBe(true);
  });

  it('uses file mtime only when timestamp strings are unusable', () => {
    expect(isSessionActivityFresh(
      { last_activity: null, timestamp: 'not-a-date', file_mtime_ms: nowMs - 5_000 },
      10_000,
      nowMs,
    )).toBe(true);
  });

  it('rejects a row with no usable activity timestamp', () => {
    expect(isSessionActivityFresh(
      { last_activity: null, timestamp: 'not-a-date', file_mtime_ms: null },
      10_000,
      nowMs,
    )).toBe(false);
  });
});
