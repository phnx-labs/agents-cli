import { describe, expect, it } from 'vitest';
import { classifyHostLink, HOST_HEARTBEAT_STALE_MS } from './host-link.js';

const NOW = 1_700_000_000_000;
const fresh = NOW - 30_000;
const stale = NOW - HOST_HEARTBEAT_STALE_MS - 1;

/**
 * The decision table behind the `crashed` / `orphaned` statuses. Each case is a
 * scenario a user hits, not a permutation for its own sake — the point of the
 * classifier is that it never cries wolf on a session that is fine, and never
 * stays silent on one that has genuinely lost its human.
 */
describe('classifyHostLink', () => {
  it('reports a healthy session as connected', () => {
    expect(classifyHostLink({ pidAlive: true, windowHeartbeatMs: fresh, nowMs: NOW })).toBe('connected');
    expect(classifyHostLink({ pidAlive: true, tmuxClients: 1, nowMs: NOW })).toBe('connected');
  });

  it('calls a dead agent under a dead window `host-gone` — VS Code crashed and took it down', () => {
    expect(classifyHostLink({ pidAlive: false, windowHeartbeatMs: stale, nowMs: NOW })).toBe('host-gone');
  });

  it('does NOT call an ordinary close a crash — the window is still alive and republishing', () => {
    expect(classifyHostLink({ pidAlive: false, windowHeartbeatMs: fresh, nowMs: NOW })).toBe('connected');
    // No window at all (a bare terminal / team spawn): a dead pid is just closed.
    expect(classifyHostLink({ pidAlive: false, nowMs: NOW })).toBe('connected');
  });

  it('calls a live agent with zero tmux clients `no-client`', () => {
    expect(classifyHostLink({ pidAlive: true, tmuxClients: 0, nowMs: NOW })).toBe('no-client');
  });

  it('calls a live agent whose owning window stopped republishing `no-client`', () => {
    expect(classifyHostLink({ pidAlive: true, windowHeartbeatMs: stale, nowMs: NOW })).toBe('no-client');
  });

  it('never flags a deliberately detached session — it is supposed to have no client', () => {
    expect(
      classifyHostLink({ pidAlive: true, tmuxClients: 0, deliberatelyDetached: true, nowMs: NOW }),
    ).toBe('connected');
    expect(
      classifyHostLink({ pidAlive: false, windowHeartbeatMs: stale, deliberatelyDetached: true, nowMs: NOW }),
    ).toBe('connected');
  });

  it('treats an unknown client count as unknown, not as zero', () => {
    // A tmux server too old to report `session_attached` (or a parse miss) must
    // not read as "nobody is attached" and orphan every tmux session on the box.
    // That invariant is unchanged — an absent count is still never `no-client`.
    // What changed (RUSH-3125) is how the non-orphan case is EXPRESSED: it used
    // to borrow `connected`, asserting health it had not observed. `unknown`
    // says the same "do not orphan this" without the false claim.
    const link = classifyHostLink({ pidAlive: true, tmuxClients: undefined, nowMs: NOW });
    expect(link).not.toBe('no-client');
    expect(link).toBe('unknown');
  });

  // RUSH-3125. This case used to return `connected`, which reads as "verified
  // fine" when the truth is "nobody looked". Neither input exists for a bare
  // terminal, a team spawn, a cloud task, or any session whose pane lives on
  // another machine — every signal this function keys on is local.
  it('says `unknown` when it has no signal at all, rather than defaulting to healthy', () => {
    expect(classifyHostLink({ pidAlive: true, nowMs: NOW })).toBe('unknown');
  });

  it('still says `connected` on POSITIVE evidence, not on absence', () => {
    // A counted client, or a window that is republishing, is a real observation.
    expect(classifyHostLink({ pidAlive: true, tmuxClients: 2, nowMs: NOW })).toBe('connected');
    expect(classifyHostLink({ pidAlive: true, windowHeartbeatMs: fresh, nowMs: NOW })).toBe('connected');
  });

  it('a deliberate detach still wins over `unknown` — no signal is not a false alarm either way', () => {
    expect(classifyHostLink({ pidAlive: true, deliberatelyDetached: true, nowMs: NOW })).toBe('connected');
  });

  it('holds at the exact staleness boundary', () => {
    const atBoundary = NOW - HOST_HEARTBEAT_STALE_MS;
    expect(classifyHostLink({ pidAlive: true, windowHeartbeatMs: atBoundary, nowMs: NOW })).toBe('no-client');
    expect(classifyHostLink({ pidAlive: true, windowHeartbeatMs: atBoundary + 1, nowMs: NOW })).toBe('connected');
  });
});
