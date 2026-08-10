import { test, expect } from 'bun:test';
import { parseLstart, resolveStartedAtMs } from './processStartTime';

test('parseLstart parses ps lstart output to epoch ms', () => {
  // `ps -o lstart=` format on macOS/Linux.
  const ms = parseLstart('Sat Jun 28 11:02:13 2026');
  expect(ms).toBe(Date.parse('Sat Jun 28 11:02:13 2026'));
  expect(parseLstart('not a date')).toBeUndefined();
});

// This is the regression test for the startedAtMs bug: snapshotOwnTerminals used
// to stamp `Date.now()` on every republish, so a terminal's startedAtMs was
// identical across terminals and changed on every write. resolveStartedAtMs must
// instead return a STABLE value reflecting the process's REAL start time.
test('resolveStartedAtMs is stable per pid and reflects the real start, not now', async () => {
  const pid = process.pid; // a real, live process — no mocks

  const first = await resolveStartedAtMs(pid);
  await new Promise((r) => setTimeout(r, 40));
  const second = await resolveStartedAtMs(pid);

  // Core of the bug: two snapshots must NOT drift. The old code returned two
  // different Date.now() values here.
  expect(second).toBe(first);

  // A start time can never be in the future, and must be a real epoch (in the
  // past, well after 2020). That it reflects the REAL start (not a fresh
  // Date.now() each call) is pinned by the stability assertion above plus the
  // "different processes get different, ordered starts" test below.
  expect(first).toBeLessThanOrEqual(Date.now());
  expect(first).toBeGreaterThan(Date.parse('2020-01-01'));
});

// Distinct live processes must get distinct start times (the bug collapsed them
// all onto one identical timestamp). Spawn two short-lived sleeps a beat apart.
test('resolveStartedAtMs distinguishes processes started at different times', async () => {
  const { spawn } = await import('child_process');
  const a = spawn('sleep', ['5']);
  await new Promise((r) => setTimeout(r, 1100)); // > 1s so ps 1s-granularity differs
  const b = spawn('sleep', ['5']);
  try {
    const [sa, sb] = await Promise.all([
      resolveStartedAtMs(a.pid as number),
      resolveStartedAtMs(b.pid as number),
    ]);
    expect(sb).toBeGreaterThan(sa);
  } finally {
    a.kill();
    b.kill();
  }
});
