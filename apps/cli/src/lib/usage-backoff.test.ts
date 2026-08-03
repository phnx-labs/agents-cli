import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  formatBackoffRemaining,
  noteUsageRateLimited,
  parseRetryAfterMs,
  setUsageBackoffPathForTest,
  usageRateLimitedUntil,
} from './usage-backoff.js';

const NOW = 1_800_000_000_000;

describe('parseRetryAfterMs', () => {
  it('reads delta-seconds — the form the usage endpoint actually sent', () => {
    // Measured on yosemite-s1: `retry-after: 2678`, about 45 minutes. Ignoring
    // this is what let a 3-minute probe cadence re-arm the penalty forever.
    expect(parseRetryAfterMs('2678', NOW)).toBe(2678 * 1000);
  });

  it('reads an HTTP-date, the other form the spec allows', () => {
    const at = new Date(NOW + 10 * 60 * 1000).toUTCString();
    // toUTCString drops sub-second precision, so allow the rounding.
    expect(parseRetryAfterMs(at, NOW)).toBeGreaterThan(9 * 60 * 1000);
    expect(parseRetryAfterMs(at, NOW)).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('caps a hostile or mistaken value at an hour', () => {
    // A provider (or a typo) must not be able to park usage reads for a week.
    expect(parseRetryAfterMs('99999999', NOW)).toBe(60 * 60 * 1000);
  });

  it('returns null for a missing, empty, elapsed, or unparseable header', () => {
    expect(parseRetryAfterMs(null, NOW)).toBeNull();
    expect(parseRetryAfterMs('', NOW)).toBeNull();
    expect(parseRetryAfterMs('0', NOW)).toBeNull();
    expect(parseRetryAfterMs('later please', NOW)).toBeNull();
    // An HTTP-date already in the past is not a reason to wait.
    expect(parseRetryAfterMs(new Date(NOW - 60_000).toUTCString(), NOW)).toBeNull();
  });
});

describe('the recorded backoff survives across processes', () => {
  // The whole point of putting this on disk: the offenders are separate
  // processes — the long-lived daemon on a 3-minute timer, and every one-shot
  // `agents view` / `agents run`. An in-memory guard would fix neither.
  // The cache dir is a module-level constant resolved at import, so overriding
  // HOME does NOT redirect the file — the first version of this test wrote into
  // the real ~/.agents/.cache/ and parked live usage reads behind a 45-minute
  // penalty. Use the explicit seam.
  let dir: string;
  let prevPath: string | null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-backoff-'));
    prevPath = setUsageBackoffPathForTest(path.join(dir, '.usage-backoff.json'));
  });

  afterEach(() => {
    setUsageBackoffPathForTest(prevPath);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes to the overridden path and NOT the real cache dir', () => {
    noteUsageRateLimited('claude', '2678');
    expect(fs.existsSync(path.join(dir, '.usage-backoff.json'))).toBe(true);
  });

  it('holds a provider off for the window the server asked for', () => {
    expect(usageRateLimitedUntil('claude')).toBeNull();

    noteUsageRateLimited('claude', '2678');

    const until = usageRateLimitedUntil('claude');
    expect(until).not.toBeNull();
    // ~45 minutes out, not the next 3-minute tick.
    expect(until! - Date.now()).toBeGreaterThan(40 * 60 * 1000);
  });

  it('still backs off when the server sends no usable Retry-After', () => {
    // Continuing to poll an endpoint that just said 429 is what created the
    // loop; a missing header is not permission to keep going.
    noteUsageRateLimited('claude', null);
    expect(usageRateLimitedUntil('claude')).not.toBeNull();
  });

  it('never shortens an existing longer penalty', () => {
    noteUsageRateLimited('claude', '2678');
    const long = usageRateLimitedUntil('claude')!;

    noteUsageRateLimited('claude', '10');

    // A second 429 carrying a smaller header must not put us back on the wire.
    expect(usageRateLimitedUntil('claude')).toBe(long);
  });

  it('reads as free once the window has elapsed', () => {
    noteUsageRateLimited('claude', '1', { now: Date.now() - 60_000 });
    expect(usageRateLimitedUntil('claude')).toBeNull();
  });

  it('is per-provider — one throttled endpoint does not mute the others', () => {
    noteUsageRateLimited('claude', '2678');
    expect(usageRateLimitedUntil('kimi')).toBeNull();
    expect(usageRateLimitedUntil('droid')).toBeNull();
  });
});

describe('formatBackoffRemaining', () => {
  it('reads like a person wrote it, not a duration serializer', () => {
    expect(formatBackoffRemaining(NOW + 45 * 60 * 1000, NOW)).toBe('45 minutes');
    expect(formatBackoffRemaining(NOW + 30 * 1000, NOW)).toBe('under a minute');
    expect(formatBackoffRemaining(NOW + 60 * 60 * 1000, NOW)).toBe('about an hour');
    expect(formatBackoffRemaining(NOW + 3 * 60 * 60 * 1000, NOW)).toBe('about 3 hours');
  });
});
