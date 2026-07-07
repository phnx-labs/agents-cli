import { describe, it, expect } from 'vitest';
import { resolveCwds, LSOF_CONCURRENCY } from './active.js';

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('resolveCwds', () => {
  it('bounds the lsof fan-out to LSOF_CONCURRENCY (no simultaneous burst)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const pids = Array.from({ length: 30 }, (_, i) => i + 1000);
    // Probe outlasts the stagger so windows overlap — this is what would let an
    // unbounded fan-out (Promise.all) pile all 30 up at once. The bound must cap it.
    const probe = async (pid: number): Promise<string | undefined> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(30);
      inFlight--;
      return `/cwd/${pid}`;
    };

    const cwds = await resolveCwds(pids, probe);

    // The whole point of the mitigation: never all-at-once (unbounded => 30).
    expect(maxInFlight).toBeLessThanOrEqual(LSOF_CONCURRENCY);
    expect(maxInFlight).toBeGreaterThan(1); // still concurrent within the bound, not serial
    // Contract preserved: one cwd per pid, in input order.
    expect(cwds).toEqual(pids.map(p => `/cwd/${p}`));
  });

  it('preserves per-pid alignment even when probes finish out of order', async () => {
    const pids = [5, 4, 3, 2, 1];
    const probe = async (pid: number): Promise<string | undefined> => {
      await delay(pid * 3); // pid 1 finishes last though it may start first
      return `cwd-${pid}`;
    };
    const cwds = await resolveCwds(pids, probe);
    expect(cwds).toEqual(['cwd-5', 'cwd-4', 'cwd-3', 'cwd-2', 'cwd-1']);
  });
});
