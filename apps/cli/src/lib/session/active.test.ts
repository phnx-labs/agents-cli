import { describe, it, expect } from 'vitest';
import { resolveCwds, LSOF_CONCURRENCY, agentKindFromComm, activeStatusFromCloudStatus } from './active.js';

describe('agentKindFromComm', () => {
  it('matches a real agent CLI by basename (absolute path or bare name)', () => {
    expect(agentKindFromComm('/Users/u/.bun/bin/codex')).toBe('codex');
    expect(agentKindFromComm('claude')).toBe('claude');
    expect(agentKindFromComm('claude.exe')).toBe('claude');
  });

  it('does NOT match the Codex desktop app-server bundled inside Codex.app', () => {
    // The desktop app ships a binary literally named `codex`; without the bundle
    // guard its `app-server` (cwd '/') surfaces as a phantom agent session.
    expect(agentKindFromComm('/Applications/Codex.app/Contents/Resources/codex')).toBeUndefined();
  });

  it('does NOT match the Claude desktop app (named Claude, not the CLI claude)', () => {
    expect(agentKindFromComm('/Applications/Claude.app/Contents/MacOS/Claude')).toBeUndefined();
  });
});

describe('activeStatusFromCloudStatus', () => {
  it('preserves resumable idle cloud tasks as idle sessions', () => {
    expect(activeStatusFromCloudStatus('idle')).toBe('idle');
  });

  it('maps cloud statuses into the active-session status vocabulary', () => {
    expect(activeStatusFromCloudStatus('running')).toBe('running');
    expect(activeStatusFromCloudStatus('input_required')).toBe('input_required');
    expect(activeStatusFromCloudStatus('queued')).toBe('queued');
    expect(activeStatusFromCloudStatus('allocating')).toBe('queued');
  });
});

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
