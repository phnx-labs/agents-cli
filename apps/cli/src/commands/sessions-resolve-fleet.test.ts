/**
 * `agents sessions <uuid>` must resolve a session that lives ONLY on a remote
 * machine — the RUSH-2024 bug, where a UUID absent from the local disk fell back
 * to an FTS content search and surfaced unrelated sessions that merely MENTION
 * the id (a watchdog `/continue <uuid>` reference echoes the parent id into many
 * later transcripts).
 *
 * These exercise the two seams that own the remote path — `fleetHitsById` (pure
 * grouping) and `resolveSessionAcrossFleet` (the orchestration) — with the
 * SSH/peer boundary (`gatherRemoteList`/`runOnPeer`) FAKED via injected deps, so
 * no tailnet, no network, no real ssh. The fakes stand in for what a peer would
 * actually return over SSH.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fleetHitsById, resolveSessionAcrossFleet, shouldFanOutForId, type FleetResolveDeps } from './sessions.js';
type SessionMeta = import('../lib/session/types.js').SessionMeta;

const UUID = 'd3470b57-2af6-4c11-b1de-3fab94f43603';

function row(id: string, machine: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: new Date().toISOString(),
    filePath: `/home/user/.claude/${id}.jsonl`,
    machine,
    _remote: true,
    ...extra,
  };
}

/** A deps double that records what the sweep forwarded and what peer was asked
 * to render, so a test can assert BOTH the routing and that no render happened. */
function fakeDeps(opts: {
  remoteRows: SessionMeta[];
  peerResult?: 'ok' | 'no-target';
  onGather?: (args: string[], hosts?: string[]) => void;
}): FleetResolveDeps & { rendered: Array<{ args: string[]; machine: string }> } {
  const rendered: Array<{ args: string[]; machine: string }> = [];
  return {
    rendered,
    gatherRemoteList: async (args: string[], hosts?: string[]) => {
      opts.onGather?.(args, hosts);
      return { sessions: opts.remoteRows, deviceCount: 1 };
    },
    runOnPeer: async (args: string[], machine: string) => {
      rendered.push({ args, machine });
      return opts.peerResult ?? 'ok';
    },
  };
}

describe('shouldFanOutForId — the --local / recursion / id-shape gate', () => {
  const origEnv = process.env.AGENTS_SESSIONS_LOCAL;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.AGENTS_SESSIONS_LOCAL;
    else process.env.AGENTS_SESSIONS_LOCAL = origEnv;
  });

  it('fans out for a bare UUID with no --local and not a peer', () => {
    delete process.env.AGENTS_SESSIONS_LOCAL;
    expect(shouldFanOutForId(UUID, undefined)).toBe(true);
    expect(shouldFanOutForId(UUID, false)).toBe(true);
  });

  it('--local restricts the lookup to the local machine (no fan-out)', () => {
    delete process.env.AGENTS_SESSIONS_LOCAL;
    expect(shouldFanOutForId(UUID, true)).toBe(false);
  });

  it('a peer answering a parent sweep (AGENTS_SESSIONS_LOCAL=1) never recurses', () => {
    process.env.AGENTS_SESSIONS_LOCAL = '1';
    expect(shouldFanOutForId(UUID, false)).toBe(false);
  });

  it('a non-id search phrase never fans out even without --local', () => {
    delete process.env.AGENTS_SESSIONS_LOCAL;
    expect(shouldFanOutForId('fix the login bug', undefined)).toBe(false);
  });
});

describe('fleetHitsById — exact id only, one hit per machine', () => {
  it('keeps only rows whose id EXACTLY equals the query (drops content mentioners)', () => {
    const rows = [
      row(UUID, 'yosemite-s0', { topic: 'the real session' }),
      // A different session that merely echoes the UUID in its body — the exact
      // shape of the RUSH-2024 false match. It must NOT be treated as a hit.
      row('ffd7ed24-0840-4c11-b1de-3fab94f43603', 'zion', { topic: `watchdog /continue ${UUID}` }),
    ];
    const hits = fleetHitsById(rows, UUID);
    expect(hits.map(h => h.machine)).toEqual(['yosemite-s0']);
    expect(hits[0].session.id).toBe(UUID);
  });

  it('collapses a machine that returned the id twice (live + synced mirror) to one hit', () => {
    const rows = [row(UUID, 'yosemite-s0', { topic: 'live' }), row(UUID, 'yosemite-s0', { topic: 'mirror' })];
    const hits = fleetHitsById(rows, UUID);
    expect(hits).toHaveLength(1);
    expect(hits[0].machine).toBe('yosemite-s0');
  });

  it('surfaces DISTINCT machines when the same id is on more than one box', () => {
    const rows = [row(UUID, 'yosemite-s0'), row(UUID, 'mac-mini')];
    const hits = fleetHitsById(rows, UUID);
    expect(hits.map(h => h.machine).sort()).toEqual(['mac-mini', 'yosemite-s0']);
  });

  it('drops an untagged row (no machine to route a render back to)', () => {
    const rows = [{ ...row(UUID, ''), machine: undefined } as SessionMeta];
    expect(fleetHitsById(rows, UUID)).toEqual([]);
  });

  it('is case-insensitive on the id', () => {
    const hits = fleetHitsById([row(UUID, 'yosemite-s0')], UUID.toUpperCase());
    expect(hits.map(h => h.machine)).toEqual(['yosemite-s0']);
  });
});

describe('resolveSessionAcrossFleet — remote UUID resolution', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => true); });
  afterEach(() => { errSpy.mockRestore(); vi.restoreAllMocks(); });

  it('a UUID on exactly ONE remote machine renders from that peer', async () => {
    const deps = fakeDeps({ remoteRows: [row(UUID, 'yosemite-s0')] });
    const outcome = await resolveSessionAcrossFleet(UUID, 'summary', undefined, deps);
    expect(outcome).toBe('rendered');
    // Rendering was delegated to the owning peer, locally-pinned so it doesn't recurse.
    expect(deps.rendered).toHaveLength(1);
    expect(deps.rendered[0].machine).toBe('yosemite-s0');
    expect(deps.rendered[0].args).toContain('--local');
    expect(deps.rendered[0].args).toContain(UUID);
    // summary is the peer's default — no mode flag appended.
    expect(deps.rendered[0].args).not.toContain('--markdown');
    expect(deps.rendered[0].args).not.toContain('--json');
  });

  it('forwards a UUID sweep as an id lookup (--json --all --local), NEVER a content search', async () => {
    let forwarded: string[] = [];
    const deps = fakeDeps({ remoteRows: [row(UUID, 'yosemite-s0')], onGather: (a) => { forwarded = a; } });
    await resolveSessionAcrossFleet(UUID, 'summary', undefined, deps);
    expect(forwarded).toEqual(['sessions', UUID, '--json', '--all', '--local']);
  });

  it('carries the render mode to the peer (markdown → --markdown)', async () => {
    const deps = fakeDeps({ remoteRows: [row(UUID, 'yosemite-s0')] });
    await resolveSessionAcrossFleet(UUID, 'markdown', undefined, deps);
    expect(deps.rendered[0].args).toContain('--markdown');
  });

  it('a content-only sweep result (no exact id) is NOT rendered — reports not-found', async () => {
    // Reproduces the bug at the remote layer: a peer that (wrongly) returned a
    // mentioner instead of the id must not be treated as the session. fleetHitsById
    // drops it, so the fleet resolve is not-found and no peer render fires.
    const mentioner = row('ffd7ed24-0840-4c11-b1de-3fab94f43603', 'zion', { topic: `/continue ${UUID}` });
    const deps = fakeDeps({ remoteRows: [mentioner] });
    const outcome = await resolveSessionAcrossFleet(UUID, 'summary', undefined, deps);
    expect(outcome).toBe('not-found');
    expect(deps.rendered).toHaveLength(0);
  });

  it('the same UUID on MULTIPLE machines surfaces a labeled conflict, renders nothing', async () => {
    const deps = fakeDeps({ remoteRows: [row(UUID, 'yosemite-s0'), row(UUID, 'mac-mini')] });
    const outcome = await resolveSessionAcrossFleet(UUID, 'summary', undefined, deps);
    expect(outcome).toBe('conflict');
    expect(deps.rendered).toHaveLength(0);
    const printed = errSpy.mock.calls.flat().join('\n');
    expect(printed).toContain('multiple machines');
    expect(printed).toContain('yosemite-s0');
    expect(printed).toContain('mac-mini');
  });

  it('found-but-unreachable peer (no-target) is a definitive conflict, not a silent fall-through', async () => {
    const deps = fakeDeps({ remoteRows: [row(UUID, 'yosemite-s0')], peerResult: 'no-target' });
    const outcome = await resolveSessionAcrossFleet(UUID, 'summary', undefined, deps);
    expect(outcome).toBe('conflict');
  });

  it('a UUID absent from the whole fleet reports not-found (no fallback rendering)', async () => {
    const deps = fakeDeps({ remoteRows: [] });
    const outcome = await resolveSessionAcrossFleet(UUID, 'summary', undefined, deps);
    expect(outcome).toBe('not-found');
    expect(deps.rendered).toHaveLength(0);
  });

  it('an explicit --device host set is passed straight through to the sweep', async () => {
    let seenHosts: string[] | undefined;
    const deps = fakeDeps({ remoteRows: [row(UUID, 'yosemite-s0')], onGather: (_a, h) => { seenHosts = h; } });
    await resolveSessionAcrossFleet(UUID, 'summary', ['yosemite-s0'], deps);
    expect(seenHosts).toEqual(['yosemite-s0']);
  });

  it('a sweep that throws is swallowed to not-found, never a crash', async () => {
    const deps: FleetResolveDeps = {
      gatherRemoteList: async () => { throw new Error('ssh exploded'); },
      runOnPeer: async () => 'ok',
    };
    const outcome = await resolveSessionAcrossFleet(UUID, 'summary', undefined, deps);
    expect(outcome).toBe('not-found');
  });
});
