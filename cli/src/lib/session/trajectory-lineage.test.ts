import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _resetTeamOriginIndex } from './team-filter.js';
import { buildLineage } from './trajectory-lineage.js';
import { renderLineageText } from './trajectory-text.js';
import { renderLineageHtml } from './trajectory-html.js';
import type { SessionMeta } from './types.js';

const NOW = Date.parse('2026-08-23T12:00:00Z');
const T = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function meta(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: T(60),
    lastActivity: T(1),
    filePath: `/tmp/${id}.jsonl`,
    toolCallCount: 10,
    durationMs: 60_000,
    ...overrides,
  };
}

/**
 * A real teammate row: `teamOrigin.source === 'meta'` is what tells an
 * `agents teams` teammate apart from a bare SDK spawn (team-filter.ts:224).
 */
function teammate(id: string, handle: string, parent: string | undefined, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return meta(id, {
    isTeamOrigin: true,
    teamOrigin: { handle, team: 'fleet-resume', mode: 'auto', parentSessionId: parent, startedAt: T(50), source: 'meta' },
    ...overrides,
  });
}

describe('buildLineage — the delegation graph from the session index', () => {
  it('roots at the orchestrator and draws one node per spawned session', () => {
    const root = meta('e0ffab12-0000-0000-0000-000000000000');
    const a = teammate('4f21aaaa-0000-0000-0000-000000000000', 'auth', root.id, { agent: 'codex', toolCallCount: 31 });
    const b = teammate('a90cbbbb-0000-0000-0000-000000000000', 'ui', root.id, { toolCallCount: 18 });
    const c = teammate('c7d2cccc-0000-0000-0000-000000000000', 'api', root.id, { agent: 'grok', toolCallCount: 44 });

    const lineage = buildLineage([b, root, c, a], { rootId: root.id, now: NOW });

    expect(lineage.rootId).toBe(root.id);
    // Root first, then the teammates in spawn order (equal startedAt -> id order).
    expect(lineage.nodes.map((n) => n.id)).toEqual([root.id, a.id, b.id, c.id]);
    expect(lineage.nodes[0].id).toBe(root.id);
    expect(lineage.nodes[0].role).toBe('orchestrator');
    expect(lineage.nodes[0].childCount).toBe(3);
    expect(lineage.nodes.slice(1).map((n) => n.role)).toEqual(['teammate', 'teammate', 'teammate']);
    expect(lineage.nodes.slice(1).every((n) => n.depth === 1)).toBe(true);
    expect(lineage.edges).toHaveLength(3);
    expect(lineage.edges.every((e) => e.parent === root.id && e.source === 'parentSessionId')).toBe(true);
    expect(lineage.teams).toEqual(['fleet-resume']);
  });

  it('carries the real per-node numbers off the session row', () => {
    const root = meta('11111111-0000-0000-0000-000000000000', { toolCallCount: 22, durationMs: 14 * 60_000 });
    const kid = teammate('22222222-0000-0000-0000-000000000000', 'auth', root.id, {
      agent: 'codex',
      toolCallCount: 31,
      durationMs: 12 * 60_000,
      prNumber: 2931,
      lastActivity: T(90),
    });

    const lineage = buildLineage([root, kid], { rootId: root.id, now: NOW });
    const [r, k] = lineage.nodes;

    expect(r.toolCount).toBe(22);
    expect(r.activity).toBe('active'); // lastActivity 1 minute ago
    expect(k.toolCount).toBe(31);
    expect(k.durationMs).toBe(12 * 60_000);
    expect(k.prNumber).toBe(2931);
    expect(k.handle).toBe('auth');
    expect(k.team).toBe('fleet-resume');
    expect(k.mode).toBe('auto');
    expect(k.activity).toBe('idle'); // 90 minutes ago: past active, inside 24h
  });

  it('classifies recency: active / idle / stale', () => {
    const root = meta('aaaa1111-0000-0000-0000-000000000000', { lastActivity: T(0) });
    const fresh = teammate('bbbb1111-0000-0000-0000-000000000000', 'a', root.id, { lastActivity: T(2) });
    const old = teammate('cccc1111-0000-0000-0000-000000000000', 'b', root.id, { lastActivity: T(60 * 48) });

    const lineage = buildLineage([root, fresh, old], { rootId: root.id, now: NOW });
    const byId = new Map(lineage.nodes.map((n) => [n.id, n]));
    expect(byId.get(root.id)!.activity).toBe('active');
    expect(byId.get(fresh.id)!.activity).toBe('active');
    expect(byId.get(old.id)!.activity).toBe('stale');
  });

  it('nests a teammate that itself spawned a team, ordered by spawn time', () => {
    const root = meta('root0000-0000-0000-0000-000000000000');
    const mid = teammate('mid00000-0000-0000-0000-000000000000', 'api', root.id);
    const leafLate = teammate('leaf2222-0000-0000-0000-000000000000', 'late', mid.id, {
      teamOrigin: { handle: 'late', team: 'sub', parentSessionId: 'mid00000-0000-0000-0000-000000000000', startedAt: T(10), source: 'meta' },
    });
    const leafEarly = teammate('leaf1111-0000-0000-0000-000000000000', 'early', mid.id, {
      teamOrigin: { handle: 'early', team: 'sub', parentSessionId: 'mid00000-0000-0000-0000-000000000000', startedAt: T(40), source: 'meta' },
    });

    const lineage = buildLineage([root, mid, leafLate, leafEarly], { rootId: root.id, now: NOW });

    expect(lineage.nodes.map((n) => n.depth)).toEqual([0, 1, 2, 2]);
    // Siblings ordered by spawn time (startedAt), earliest first — not input order.
    expect(lineage.nodes.slice(2).map((n) => n.handle)).toEqual(['early', 'late']);
    expect(lineage.nodes[1].role).toBe('orchestrator'); // mid has children
    expect(lineage.teams).toEqual(['fleet-resume', 'sub']);
  });

  it('falls back to the team-agreed spawner for a teammate whose own record names no parent', () => {
    const root = meta('sp000000-0000-0000-0000-000000000000');
    const named = teammate('kid00001-0000-0000-0000-000000000000', 'named', root.id);
    const parentless = teammate('kid00002-0000-0000-0000-000000000000', 'orphan', undefined);

    const lineage = buildLineage([root, named, parentless], { rootId: root.id, now: NOW });

    expect(lineage.nodes).toHaveLength(3);
    const inherited = lineage.edges.find((e) => e.child === parentless.id);
    expect(inherited).toEqual({ parent: root.id, child: parentless.id, source: 'teamSpawner' });
  });

  it('does NOT adopt a parentless teammate from a different run that shares the team name', () => {
    // groupSessionsByTeam buckets by team NAME alone and --tree scans all-time,
    // so without a spawn window the older run's teammates became this run's kids.
    const root = meta('now00000-0000-0000-0000-000000000000');
    const sameRun = teammate('same0000-0000-0000-0000-000000000000', 'auth', root.id);
    const otherRun = meta('old00000-0000-0000-0000-000000000000', {
      isTeamOrigin: true,
      // Same team name, spawned three days earlier, no parent of its own.
      teamOrigin: { handle: 'stale-auth', team: 'fleet-resume', startedAt: T(60 * 72), source: 'meta' },
    });

    const lineage = buildLineage([root, sameRun, otherRun], { rootId: root.id, now: NOW });
    expect(lineage.nodes.map((n) => n.id)).toEqual([root.id, sameRun.id]);
    expect(lineage.edges.some((e) => e.child === otherRun.id)).toBe(false);
  });

  it('still adopts a parentless teammate spawned inside its own run window', () => {
    const root = meta('win00000-0000-0000-0000-000000000000');
    const named = teammate('namd0000-0000-0000-0000-000000000000', 'auth', root.id); // startedAt T(50)
    const parentless = meta('pless000-0000-0000-0000-000000000000', {
      isTeamOrigin: true,
      teamOrigin: { handle: 'ui', team: 'fleet-resume', startedAt: T(48), source: 'meta' },
    });

    const lineage = buildLineage([root, named, parentless], { rootId: root.id, now: NOW });
    expect(lineage.edges.find((e) => e.child === parentless.id)?.source).toBe('teamSpawner');
  });

  it('roots at the topmost ancestor when a CHILD is selected, so --tree always shows the whole team', () => {
    const root = meta('top00000-0000-0000-0000-000000000000');
    const kid = teammate('kid00003-0000-0000-0000-000000000000', 'auth', root.id);

    const lineage = buildLineage([root, kid], { rootId: kid.id, now: NOW });
    expect(lineage.rootId).toBe(root.id);
    expect(lineage.nodes).toHaveLength(2);
  });

  it('excludes sessions unrelated to the root — the pool supplies edges, not nodes', () => {
    const root = meta('own00000-0000-0000-0000-000000000000');
    const mine = teammate('mine0000-0000-0000-0000-000000000000', 'mine', root.id);
    const otherRoot = meta('oth00000-0000-0000-0000-000000000000');
    const theirs = teammate('their000-0000-0000-0000-000000000000', 'theirs', otherRoot.id);

    const lineage = buildLineage([root, mine, otherRoot, theirs], { rootId: root.id, now: NOW });
    expect(lineage.nodes.map((n) => n.id)).toEqual([root.id, mine.id]);
  });

  it('surfaces a parent that is not in the pool instead of dropping the edge silently', () => {
    const orphan = teammate('lone0000-0000-0000-0000-000000000000', 'auth', 'missing0-0000-0000-0000-000000000000');

    const lineage = buildLineage([orphan], { rootId: orphan.id, now: NOW });
    expect(lineage.rootId).toBe(orphan.id);
    expect(lineage.nodes).toHaveLength(1);
    expect(lineage.unresolvedParentIds).toEqual(['missing0-0000-0000-0000-000000000000']);
  });

  it('never makes a session its own parent, and survives a cyclic pair', () => {
    const selfParent = teammate('self0000-0000-0000-0000-000000000000', 'me', 'self0000-0000-0000-0000-000000000000');
    const a = teammate('cyc00001-0000-0000-0000-000000000000', 'a', 'cyc00002-0000-0000-0000-000000000000');
    const b = teammate('cyc00002-0000-0000-0000-000000000000', 'b', 'cyc00001-0000-0000-0000-000000000000');

    expect(buildLineage([selfParent], { rootId: selfParent.id, now: NOW }).nodes).toHaveLength(1);
    const cyc = buildLineage([a, b], { rootId: a.id, now: NOW });
    expect(cyc.nodes).toHaveLength(2);
    expect(cyc.nodes.map((n) => n.depth)).toEqual([0, 1]);
  });

  it('an ordinary session with no team is a lone `session` node', () => {
    const solo = meta('solo0000-0000-0000-0000-000000000000');
    const lineage = buildLineage([solo], { rootId: solo.id, now: NOW });
    expect(lineage.nodes).toHaveLength(1);
    expect(lineage.nodes[0].role).toBe('session');
    expect(lineage.teams).toEqual([]);
  });

  it('an SDK spawn with no teammate record reads as `subagent`, not `teammate`', () => {
    const root = meta('sdk00000-0000-0000-0000-000000000000');
    const bare = meta('bare0000-0000-0000-0000-000000000000', {
      isTeamOrigin: true,
      teamOrigin: { handle: 'bare0000', parentSessionId: root.id, source: 'entrypoint' },
    });
    const lineage = buildLineage([root, bare], { rootId: root.id, now: NOW });
    expect(lineage.nodes[1].role).toBe('subagent');
  });

  it('fails loud when the requested root is not in the pool, never rooting somewhere else', () => {
    // The regression this guards: an id-shaped selector resolves through the
    // session index, which reaches rows the scanned pool does not hold. Rooting
    // at the pool's first row instead rendered a completely unrelated session.
    const other = meta('else0000-0000-0000-0000-000000000000');
    expect(() => buildLineage([other], { rootId: 'absent00-0000-0000-0000-000000000000', now: NOW }))
      .toThrow(/root session absent00.* is not in the pool/);
  });

  it('returns an empty graph for an empty pool rather than throwing', () => {
    expect(buildLineage([], {})).toEqual({ rootId: '', nodes: [], edges: [], teams: [], unresolvedParentIds: [] });
  });
});

describe('buildLineage — enriches teamOrigin from the on-disk teammate records', () => {
  let tmpDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-lineage-'));
    savedEnv = process.env.AGENTS_TEAMS_DIR;
    process.env.AGENTS_TEAMS_DIR = tmpDir;
    _resetTeamOriginIndex();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AGENTS_TEAMS_DIR;
    else process.env.AGENTS_TEAMS_DIR = savedEnv;
    _resetTeamOriginIndex();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads the edge from a real teammate meta.json the caller never enriched', () => {
    const root = meta('disk0000-0000-0000-0000-000000000000');
    const kidId = 'diskkid0-0000-0000-0000-000000000000';
    const agentDir = path.join(tmpDir, 'agent-1');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'meta.json'),
      JSON.stringify({
        name: 'auth',
        mode: 'auto',
        task_name: 'lineage-team',
        parent_session_id: root.id,
        started_at: T(30),
        remote_session_id: kidId,
      }),
    );

    // The rows come in BARE — exactly as discoverSessions returns them.
    const lineage = buildLineage([root, meta(kidId, { isTeamOrigin: true })], { rootId: root.id, now: NOW });

    expect(lineage.nodes).toHaveLength(2);
    expect(lineage.edges).toEqual([{ parent: root.id, child: kidId, source: 'parentSessionId' }]);
    expect(lineage.nodes[1].handle).toBe('auth');
    expect(lineage.teams).toEqual(['lineage-team']);
  });
});

describe('renderLineageText — the indented tree an agent reads', () => {
  it('prints the header, one indented line per node, and stays ANSI-free', () => {
    const root = meta('e0ffab12-0000-0000-0000-000000000000', { toolCallCount: 22, durationMs: 14 * 60_000 });
    const a = teammate('4f21aaaa-0000-0000-0000-000000000000', 'auth', root.id, { agent: 'codex', toolCallCount: 31, prNumber: 2931 });
    const nested = teammate('deadbeef-0000-0000-0000-000000000000', 'probe', a.id, {
      teamOrigin: { handle: 'probe', team: 'fleet-resume', parentSessionId: a.id, startedAt: T(20), source: 'meta' },
    });

    const out = renderLineageText(buildLineage([root, a, nested], { rootId: root.id, now: NOW }));

    expect(out).toContain('lineage: claude e0ffab12 · team "fleet-resume" · 2 spawned sessions');
    expect(out).toContain('e0ffab12 · claude · orchestrator · 22 tools');
    expect(out).toContain('└─ auth · 4f21aaaa · codex · orchestrator · 31 tools');
    expect(out).toContain('PR #2931');
    expect(out).toMatch(/\n {3}└─ probe · deadbeef/); // nested under its own parent
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\[/);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('nests each child under ITS OWN parent, never under whichever sibling printed last', () => {
    // The regression: indenting by depth alone put B1 under A, so a nested
    // teammate read as a child of its aunt and its real parent was unrecoverable.
    const root = meta('root2222-0000-0000-0000-000000000000');
    const a = teammate('aaaa0000-0000-0000-0000-000000000000', 'A', root.id);
    const b = teammate('bbbb0000-0000-0000-0000-000000000000', 'B', root.id);
    const a1 = teammate('a1110000-0000-0000-0000-000000000000', 'A1', a.id, {
      teamOrigin: { handle: 'A1', team: 'fleet-resume', parentSessionId: a.id, startedAt: T(40), source: 'meta' },
    });
    const b1 = teammate('b1110000-0000-0000-0000-000000000000', 'B1', b.id, {
      teamOrigin: { handle: 'B1', team: 'fleet-resume', parentSessionId: b.id, startedAt: T(40), source: 'meta' },
    });

    const out = renderLineageText(buildLineage([root, a, b, a1, b1], { rootId: root.id, now: NOW }));
    const lines = out.split('\n');
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));

    // A1 prints directly after A (and before B), under A's branch.
    expect(at('A1 · a1110000')).toBe(at('A · aaaa0000') + 1);
    expect(at('B · bbbb0000')).toBe(at('A1 · a1110000') + 1);
    expect(at('B1 · b1110000')).toBe(at('B · bbbb0000') + 1);
    // A is not the last child, so its branch carries a continuation bar.
    expect(lines[at('A · aaaa0000')].startsWith('├─ ')).toBe(true);
    expect(lines[at('A1 · a1110000')].startsWith('│  └─ ')).toBe(true);
    expect(lines[at('B · bbbb0000')].startsWith('└─ ')).toBe(true);
    expect(lines[at('B1 · b1110000')].startsWith('   └─ ')).toBe(true);
  });

  it('says so plainly when the session spawned nothing', () => {
    const solo = meta('solo1111-0000-0000-0000-000000000000');
    const out = renderLineageText(buildLineage([solo], { rootId: solo.id, now: NOW }));
    expect(out).toContain('0 spawned sessions');
    expect(out).toContain('solo1111 · claude · session');
  });

  it('names an unresolved parent instead of hiding the gap', () => {
    const orphan = teammate('lone1111-0000-0000-0000-000000000000', 'auth', 'gone0000-0000-0000-0000-000000000000');
    const out = renderLineageText(buildLineage([orphan], { rootId: orphan.id, now: NOW }));
    expect(out).toContain('unresolved parent (not in the scanned pool): gone0000-0000-0000-0000-000000000000');
  });
});

describe('renderLineageHtml — self-contained node graph', () => {
  const root = meta('e0ffab12-0000-0000-0000-000000000000', { project: 'agents-cli', toolCallCount: 22 });
  const kid = teammate('4f21aaaa-0000-0000-0000-000000000000', 'auth', root.id, { agent: 'codex', prNumber: 2931 });
  const html = renderLineageHtml(buildLineage([root, kid], { rootId: root.id, now: NOW }));

  it('draws every node and edge as inline SVG with no external asset', () => {
    expect(html).toContain('<svg');
    expect((html.match(/class="lnode"/g) ?? [])).toHaveLength(2);
    expect(html).toContain('class="ledge"');
    expect(html).toContain('data-id="e0ffab12-0000-0000-0000-000000000000"');
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/); // no CDN, no remote font
    expect(html).not.toContain('<img');
  });

  it('ships one clickable card per node, with the root shown by default', () => {
    expect(html).toContain('id="lcard-e0ffab12-0000-0000-0000-000000000000"');
    expect(html).toContain('id="lcard-4f21aaaa-0000-0000-0000-000000000000"');
    expect(html).toContain('class="lcard shown"'); // the root card
    expect(html).toContain("addEventListener('click'");
  });

  it('never renders a local transcript path — the page is shareable', () => {
    expect(html).not.toContain('/tmp/');
    expect(html).toContain('agents-cli'); // the project chip IS rendered
  });

  it('escapes transcript-derived text', () => {
    const nasty = teammate('bad00000-0000-0000-0000-000000000000', '<script>x</script>', root.id);
    const out = renderLineageHtml(buildLineage([root, nasty], { rootId: root.id, now: NOW }));
    expect(out).not.toContain('<script>x</script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('footer honors the redaction flag (RUSH-3077)', () => {
    const lineage = buildLineage([root, kid], { rootId: root.id, now: NOW });
    // Default and explicit-true keep the redacted claim.
    expect(renderLineageHtml(lineage)).toContain('Secret-redacted lineage rendered');
    expect(renderLineageHtml(lineage, true)).toContain('Secret-redacted lineage rendered');
    // --no-redact must read honestly, never claim redaction that did not happen.
    const unredacted = renderLineageHtml(lineage, false);
    expect(unredacted).toContain('Unredacted (local only) lineage rendered');
    expect(unredacted).not.toContain('Secret-redacted');
  });
});
