import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  mapStatusToPhase,
  normalizeHost,
  projectFromCwd,
  resolveProject,
  normalizeActiveSession,
  normalizeActiveSessions,
  dedupeSessions,
  enrichWithSessionContent,
  groupByHost,
  reconcileHosts,
  isStaleSession,
  filterStaleSessions,
  sessionLastActivityMs,
  STALE_SESSION_THRESHOLD_MS,
  type RemoteSession,
  type RawActiveSession,
  type ProjectRule,
} from './remoteSessions';

const TESTDATA = path.join(__dirname, 'testdata');
const ACTIVE = JSON.parse(
  fs.readFileSync(path.join(TESTDATA, 'active-sessions.json'), 'utf-8')
) as RawActiveSession[];

// Fixed fetch clock so sinceMs assertions are deterministic. Chosen just after
// the newest startedAtMs in the fixture.
const FETCHED_AT = 1782865920000;

describe('normalizeHost', () => {
  test('collapses FQDN, case, and separators to the agents-cli device label', () => {
    // Matches an `agents devices` registry name for the local machine so the
    // HOSTS sidebar folds this-mac into it instead of double-listing.
    expect(normalizeHost('zion')).toBe('zion');
    expect(normalizeHost('zion.local')).toBe('zion');
    expect(normalizeHost('ZION')).toBe('zion');
    expect(normalizeHost('zion.tail1a85a1.ts.net')).toBe('zion');
    expect(normalizeHost("Muqsit's Mac mini")).toBe('muqsit-s-mac-mini');
    expect(normalizeHost('')).toBe('');
  });
});

describe('mapStatusToPhase', () => {
  test('maps the real CLI status values', () => {
    expect(mapStatusToPhase('running')).toBe('running');
    expect(mapStatusToPhase('queued')).toBe('running');
    expect(mapStatusToPhase('input_required')).toBe('waiting');
    expect(mapStatusToPhase('failed')).toBe('failed');
    expect(mapStatusToPhase('completed')).toBe('done');
    expect(mapStatusToPhase('idle')).toBe('idle');
    expect(mapStatusToPhase(undefined)).toBe('idle');
    expect(mapStatusToPhase('nonsense')).toBe('idle');
  });
});

describe('projectFromCwd', () => {
  test('folds a worktree path to its repo', () => {
    expect(
      projectFromCwd('/Users/muqsit/src/github.com/muqsitnawaz/swarmify/.agents/worktrees/factory-floor-port')
    ).toBe('swarmify');
  });
  test('uses the basename for a plain repo path', () => {
    expect(projectFromCwd('/Users/muqsit/src/github.com/muqsitnawaz/agents')).toBe('agents');
  });
  test('tolerates trailing slashes and empty input', () => {
    expect(projectFromCwd('/a/b/repo/')).toBe('repo');
    expect(projectFromCwd('')).toBe('');
  });
});

describe('resolveProject', () => {
  const RULES: ProjectRule[] = [
    { pattern: '**/agents/prix/api', project: 'Prix API' },
    { pattern: '**/agents/prix/app', project: 'Prix App' },
    { pattern: '/home/muqsit/src/monorepo', project: 'Monorepo Root' },
  ];

  test('a user rule wins over every default (glob match, first match wins)', () => {
    // Both prix rules could conceptually apply to a deep path; the FIRST listed wins.
    expect(resolveProject('/home/muqsit/src/github.com/o/agents/prix/api', RULES)).toBe('Prix API');
    expect(resolveProject('/home/muqsit/src/github.com/o/agents/prix/app', RULES)).toBe('Prix App');
  });

  test('a glob rule also captures work inside the matched directory', () => {
    expect(resolveProject('/x/y/agents/prix/api/src/routes', RULES)).toBe('Prix API');
  });

  test('a path-prefix rule (no glob) matches the dir and its descendants', () => {
    expect(resolveProject('/home/muqsit/src/monorepo', RULES)).toBe('Monorepo Root');
    expect(resolveProject('/home/muqsit/src/monorepo/packages/api', RULES)).toBe('Monorepo Root');
    // A sibling that only shares a prefix string but not a path boundary must NOT match.
    expect(resolveProject('/home/muqsit/src/monorepo-two', RULES)).toBe('monorepo-two');
  });

  test('rules take precedence over the git-repo-root default', () => {
    expect(
      resolveProject('/home/muqsit/src/github.com/o/agents/prix/api', RULES, '/home/muqsit/src/github.com/o/agents')
    ).toBe('Prix API');
  });

  test('a monorepo subdir with no rule folds to its git repo root basename', () => {
    // Without a rule, the leaf-dir default would say "api"; repoRoot folds it to the repo.
    expect(resolveProject('/home/muqsit/src/github.com/o/agents/prix/api', [], '/home/muqsit/src/github.com/o/agents')).toBe('agents');
  });

  test('worktree folding beats the git-repo-root default', () => {
    // A git worktree root basename is the slug; the path fold must win and yield the repo.
    expect(
      resolveProject(
        '/Users/muqsit/src/github.com/muqsitnawaz/swarmify/.agents/worktrees/floor-port',
        [],
        '/Users/muqsit/src/github.com/muqsitnawaz/swarmify/.agents/worktrees/floor-port'
      )
    ).toBe('swarmify');
  });

  test('with no rules and no repoRoot it is the legacy last-segment behavior', () => {
    expect(resolveProject('/home/muqsit/src/github.com/o/prix-api')).toBe('prix-api');
    expect(resolveProject('')).toBe('');
  });

  test('normalizeActiveSession applies the rules to the session project', () => {
    const s = normalizeActiveSession(
      { kind: 'claude', status: 'running', cwd: '/x/y/agents/prix/api', sessionFile: '/x/aaaaaaaa.jsonl' } as RawActiveSession,
      'zion',
      FETCHED_AT,
      RULES
    );
    expect(s.project).toBe('Prix API');
  });
});

describe('normalizeActiveSession', () => {
  test('uses the queried host, not the payload host field', () => {
    // The terminal record carries host:"ghostty" (the emulator). Identity must
    // come from the machine we queried.
    const terminal = ACTIVE.find((r) => r.context === 'terminal')!;
    const s = normalizeActiveSession(terminal, 'mac-mini', FETCHED_AT);
    expect(s.host).toBe('mac-mini');
    expect(s.agentType).toBe('codex');
  });

  test('coerces object-shaped ticket/branch/topic to strings (React #31 guard)', () => {
    // The session JSON is not schema-validated; the CLI has been observed emitting
    // `ticket` as an object `{ id }` instead of a string. Those fields flow into the
    // Floor card's name/summary and are rendered as React children, so a non-string
    // must never survive normalization (else "Objects are not valid as a React child").
    const base = ACTIVE.find((r) => r.context === 'terminal')!;
    const bad = {
      ...base,
      ticket: { id: 'RUSH-1262' },
      branch: { id: 'abc' },
      topic: { id: 'xyz' },
      prUrl: { id: 'p' },
    } as unknown as RawActiveSession;
    const s = normalizeActiveSession(bad, 'this-mac', FETCHED_AT);
    expect(typeof s.branch).toBe('string');
    expect(typeof s.topic).toBe('string');
    expect(s.ticket === null || typeof s.ticket === 'string').toBe(true);
    expect(s.prUrl === null || typeof s.prUrl === 'string').toBe(true);
    // No object leaked through under the guise of a string.
    for (const v of [s.ticket, s.branch, s.topic, s.prUrl]) {
      expect(typeof v === 'object' && v !== null).toBe(false);
    }
  });

  test('input_required becomes waiting + waitingForInput', () => {
    const terminal = ACTIVE.find((r) => r.status === 'input_required')!;
    const s = normalizeActiveSession(terminal, 'this-mac', FETCHED_AT);
    expect(s.phase).toBe('waiting');
    expect(s.waitingForInput).toBe(true);
  });

  test('derives sessionId from the session file when absent', () => {
    const terminal = ACTIVE.find((r) => r.context === 'terminal')!;
    expect(terminal.sessionId).toBeUndefined();
    const s = normalizeActiveSession(terminal, 'this-mac', FETCHED_AT);
    expect(s.sessionId).toBe('d71b62ce-01d1-40ae-af9d-8ed34275234b');
  });

  test('falls back to cloudTaskId for cloud records with no sessionId/file', () => {
    const cloud = ACTIVE.find((r) => r.context === 'cloud' && r.status === 'queued')!;
    const s = normalizeActiveSession(cloud, 'cloud', FETCHED_AT);
    expect(s.sessionId).toBe('task_e');
    expect(s.phase).toBe('running');
  });

  test('carries cloud task id + provider + context through for the reply channel', () => {
    const cloud = ACTIVE.find((r) => r.context === 'cloud' && r.status === 'queued')!;
    const s = normalizeActiveSession(cloud, 'cloud', FETCHED_AT);
    expect(s.context).toBe('cloud');
    expect(s.cloudTaskId).toBe('task_e');
    expect(s.cloudProvider).toBe(cloud.cloudProvider ?? '');
  });

  test('carries pid for terminal records (0 when absent)', () => {
    const terminal = ACTIVE.find((r) => r.context === 'terminal')!;
    const s = normalizeActiveSession(terminal, 'this-mac', FETCHED_AT);
    expect(s.pid).toBe(typeof terminal.pid === 'number' ? terminal.pid : 0);
    expect(s.teamName).toBe(terminal.teamName ?? '');
  });

  test('captures the tmux reply rail (socket + pane) from provenance', () => {
    const s = normalizeActiveSession(
      { context: 'terminal', kind: 'claude', sessionId: 'abc', status: 'running',
        provenance: { transport: 'ssh', reply: { rail: 'tmux', target: '%65', socket: '/tmp/tmux-1000/default' } } },
      'yosemite-s0', FETCHED_AT,
    );
    expect(s.transport).toBe('ssh');
    expect(s.replyRail).toBe('tmux');
    expect(s.replyMuxTarget).toBe('%65');
    expect(s.replyMuxSocket).toBe('/tmp/tmux-1000/default');
  });

  test('a raw TTY with reply=null carries no rail', () => {
    const s = normalizeActiveSession(
      { context: 'terminal', kind: 'claude', sessionId: 'ghost', status: 'running',
        provenance: { transport: 'local', reply: null } },
      'this-mac', FETCHED_AT,
    );
    expect(s.replyRail).toBe('');
    expect(s.replyMuxTarget).toBe('');
  });

  test('extracts a ticket id from label/topic', () => {
    const backend = ACTIVE.find((r) => r.label === 'backend')!;
    const s = normalizeActiveSession(backend, 'this-mac', FETCHED_AT);
    expect(s.ticket).toBe('RUSH-812');
  });

  test('computes skew-free elapsed from the fetch clock', () => {
    const backend = ACTIVE.find((r) => r.label === 'backend')!;
    const s = normalizeActiveSession(backend, 'this-mac', FETCHED_AT);
    expect(s.sinceMs).toBe(FETCHED_AT - 1782865917676);
    expect(s.startedAtMs).toBe(1782865917676);
  });
});

describe('normalizeActiveSessions', () => {
  test('parses the whole fixture (string or array) to one record each', () => {
    const fromArray = normalizeActiveSessions(ACTIVE, 'this-mac', FETCHED_AT);
    const fromString = normalizeActiveSessions(
      JSON.stringify(ACTIVE),
      'this-mac',
      FETCHED_AT
    );
    expect(fromArray.length).toBe(ACTIVE.length);
    expect(fromString.length).toBe(ACTIVE.length);
    expect(fromString[0].sessionId).toBe(fromArray[0].sessionId);
  });

  test('malformed payload yields [] rather than throwing', () => {
    expect(normalizeActiveSessions('not json', 'h', FETCHED_AT)).toEqual([]);
    expect(normalizeActiveSessions('{"not":"an array"}', 'h', FETCHED_AT)).toEqual([]);
    expect(normalizeActiveSessions([null as unknown as object, 42 as unknown as object], 'h', FETCHED_AT)).toEqual([]);
  });
});

describe('enrichWithSessionContent', () => {
  const now = Date.parse('2026-06-30T12:00:30.000Z');
  const base: RemoteSession = {
    host: 'this-mac',
    sessionId: 'x',
    agentType: 'claude',
    cwd: '/repo',
    project: 'repo',
    phase: 'running',
    activity: '',
    tokPerSec: 0,
    waitingForInput: false,
    lastResponse: '',
    prUrl: null,
    ticket: null,
    branch: '',
    sinceMs: 0,
    startedAtMs: 0,
  };

  test('derives activity + throughput from real Claude JSONL', () => {
    const content = fs.readFileSync(path.join(TESTDATA, 'claude-session.jsonl'), 'utf-8');
    const s = enrichWithSessionContent(base, content, now);
    expect(s.activity).toBe('bun test');
    expect(s.tokPerSec).toBe(3); // (120 + 80) / 60 rounded
    expect(s.waitingForInput).toBe(false);
    expect(s.phase).toBe('running');
  });

  test('promotes a trailing question to waiting', () => {
    const content = fs.readFileSync(path.join(TESTDATA, 'claude-waiting.jsonl'), 'utf-8');
    const s = enrichWithSessionContent(base, content, now);
    expect(s.waitingForInput).toBe(true);
    expect(s.phase).toBe('waiting');
  });

  test('leaves non-parsable agent types untouched', () => {
    const cursor = { ...base, agentType: 'cursor' };
    const s = enrichWithSessionContent(cursor, 'irrelevant', now);
    expect(s).toEqual(cursor);
  });
});

describe('groupByHost', () => {
  test('keeps offline hosts as empty groups and folds sessions in', () => {
    const sessions = normalizeActiveSessions(ACTIVE, 'this-mac', FETCHED_AT);
    const groups = groupByHost(
      sessions,
      [
        { name: 'this-mac', online: true },
        { name: 'mac-mini', online: false },
      ],
      FETCHED_AT
    );
    const local = groups.find((g) => g.host === 'this-mac')!;
    const remote = groups.find((g) => g.host === 'mac-mini')!;
    expect(local.online).toBe(true);
    expect(local.sessions.length).toBe(ACTIVE.length);
    expect(local.fetchedAt).toBe(FETCHED_AT);
    expect(remote.online).toBe(false);
    expect(remote.sessions).toEqual([]);
  });

  test('surfaces sessions from a host missing from the roster', () => {
    const orphan = normalizeActiveSessions(ACTIVE, 'rogue-host', FETCHED_AT);
    const groups = groupByHost(orphan, [{ name: 'this-mac', online: true }], FETCHED_AT);
    expect(groups.find((g) => g.host === 'rogue-host')?.sessions.length).toBe(ACTIVE.length);
  });
});

describe('normalizeActiveSession — topic', () => {
  test('carries the topic (or falls back to the cloud label) so remote cards are not blank', () => {
    const term = normalizeActiveSession(
      { kind: 'claude', status: 'running', sessionFile: '/x/aaaaaaaa.jsonl', topic: 'Add a pre-commit hook' } as RawActiveSession,
      'zion',
      FETCHED_AT
    );
    expect(term.topic).toBe('Add a pre-commit hook');
    const cloud = normalizeActiveSession(
      { kind: 'codex', status: 'queued', cloudTaskId: 'task_e', label: 'Read README and summarize' } as RawActiveSession,
      'this-mac',
      FETCHED_AT
    );
    expect(cloud.topic).toBe('Read README and summarize');
  });
});

describe('dedupeSessions', () => {
  // Real-world: `agents sessions --active` reports one record per live process,
  // but many processes (shell, node, agent binary, extra tabs) share one session
  // file. Nine pids resolving to one session must collapse to one card, or the
  // header count and the feed diverge.
  const many = (sessionFile: string, statuses: string[]): RemoteSession[] =>
    statuses.map((status) =>
      normalizeActiveSession(
        { kind: 'claude', status, sessionFile, topic: 'shared session' } as RawActiveSession,
        'zion',
        FETCHED_AT
      )
    );

  test('collapses processes that share one session file into a single session', () => {
    const sessions = many('/x/24d7304d.jsonl', ['running', 'running', 'running', 'running']);
    const unique = dedupeSessions(sessions);
    expect(unique.length).toBe(1);
    expect(unique[0].sessionId).toBe('24d7304d');
  });

  test('keeps the most attention-worthy phase (waiting beats running)', () => {
    const sessions = many('/x/24d7304d.jsonl', ['running', 'running', 'input_required', 'running']);
    const unique = dedupeSessions(sessions);
    expect(unique.length).toBe(1);
    expect(unique[0].phase).toBe('waiting');
  });

  test('does not merge distinct sessions, and passes through records with no id', () => {
    const a = many('/x/aaaaaaaa.jsonl', ['running']);
    const b = many('/x/bbbbbbbb.jsonl', ['running', 'idle']);
    const noId = normalizeActiveSession({ kind: 'claude', status: 'running' } as RawActiveSession, 'zion', FETCHED_AT);
    expect(noId.sessionId).toBe('');
    const unique = dedupeSessions([...a, ...b, noId]);
    // 2 distinct session files collapse to 2; the id-less record is kept as-is.
    expect(unique.length).toBe(3);
  });

  test('collapses the SAME session id reported by two different hosts into one', () => {
    // The reported bug: session 667403f9 was counted on BOTH yosemite-s1 and zion.
    // dedupeSessions keys purely by sessionId, so run over the merged cross-host set
    // it collapses the pair to one — the attention-worthy phase (waiting) survives.
    const onHostA = normalizeActiveSession(
      { kind: 'claude', status: 'running', sessionFile: '/x/667403f9.jsonl' } as RawActiveSession,
      'yosemite-s1',
      FETCHED_AT,
    );
    const onHostB = normalizeActiveSession(
      { kind: 'claude', status: 'input_required', sessionFile: '/x/667403f9.jsonl' } as RawActiveSession,
      'zion',
      FETCHED_AT,
    );
    const unique = dedupeSessions([onHostA, onHostB]);
    expect(unique.length).toBe(1);
    expect(unique[0].sessionId).toBe('667403f9');
    expect(unique[0].phase).toBe('waiting');
  });
});

describe('reconcileHosts — scope the roster to the device registry + local machine', () => {
  test('surfaces only registered devices + the always-online local machine', () => {
    const hosts = reconcileHosts(
      [
        { name: 'mac-mini', address: 'mac-mini.tail.ts.net', online: true },
        { name: 'zion', address: 'zion.tail.ts.net', online: false },
      ],
      'yosemite-s1',
    );
    const byName = new Map(hosts.map((h) => [h.name, h]));
    expect([...byName.keys()].sort()).toEqual(['mac-mini', 'yosemite-s1', 'zion']);
    // Local machine: always online, queried directly (no ssh address).
    expect(byName.get('yosemite-s1')).toEqual({ name: 'yosemite-s1', address: '', online: true, isLocal: true });
    // Registered remote: ssh reachable at its dnsName, online flag honored.
    expect(byName.get('mac-mini')).toEqual({ name: 'mac-mini', address: 'mac-mini.tail.ts.net', online: true, isLocal: false });
    expect(byName.get('zion')!.online).toBe(false);
  });

  test('does NOT surface ssh-config aliases or tailnet peers (the phantom hosts)', () => {
    // reconcileHosts is fed ONLY the device registry, so aliases/peers never reach it.
    const hosts = reconcileHosts([{ name: 'mac-mini', online: true }], 'zion');
    const names = hosts.map((h) => h.name);
    for (const phantom of ['mark', 'mark-aws', 'phoenix', 'pi', 'localhost']) {
      expect(names).not.toContain(phantom);
    }
  });

  test('an FQDN / case-variant local hostname folds onto its registry device', () => {
    const hosts = reconcileHosts(
      [{ name: 'zion', address: 'zion.tail.ts.net', online: true }],
      'ZION.local',
    );
    // Only one 'zion' row, and it is the local machine (address '', isLocal true) —
    // the registry entry was folded in, not listed a second time over ssh.
    const zions = hosts.filter((h) => h.name === 'zion');
    expect(zions.length).toBe(1);
    expect(zions[0]).toEqual({ name: 'zion', address: '', online: true, isLocal: true });
  });
});

describe('staleness — long-dead sessions drop out of running / needs-you', () => {
  const NOW = 1_700_000_000_000;
  const mk = (over: Partial<RemoteSession>): RemoteSession => ({
    ...normalizeActiveSession(
      { kind: 'claude', status: 'input_required', sessionFile: '/x/abcd1234.jsonl' } as RawActiveSession,
      'zion',
      NOW,
    ),
    ...over,
  });

  test('sessionLastActivityMs is the observed-activity mtime ONLY — never start time', () => {
    expect(sessionLastActivityMs(mk({ lastActivityMs: 500, startedAtMs: 100 }))).toBe(500);
    // startedAtMs is NOT a fallback: a session that started at 100 with no observed
    // activity has last-activity 0, so it can never be aged out on start time alone.
    expect(sessionLastActivityMs(mk({ lastActivityMs: 0, startedAtMs: 100 }))).toBe(0);
    expect(sessionLastActivityMs(mk({ lastActivityMs: 0, startedAtMs: 0 }))).toBe(0);
  });

  test('a session whose file was last written past the threshold is stale (kills the 11-day session)', () => {
    const elevenDays = 11 * 24 * 60 * 60 * 1000;
    const dead = mk({ lastActivityMs: NOW - elevenDays });
    expect(isStaleSession(dead, NOW)).toBe(true);
  });

  test('a session active within the threshold is NOT stale', () => {
    const fresh = mk({ lastActivityMs: NOW - (STALE_SESSION_THRESHOLD_MS - 1000) });
    expect(isStaleSession(fresh, NOW)).toBe(false);
  });

  test('a session STARTED long ago but ACTIVE right now is NOT stale (the review defect)', () => {
    // A remote agent that started days ago but wrote to its session file seconds ago
    // must be retained. This is the case start-time-based staleness would wrongly hide.
    const oldStartFreshActivity = mk({ startedAtMs: NOW - 5 * 24 * 60 * 60 * 1000, lastActivityMs: NOW - 3000 });
    expect(isStaleSession(oldStartFreshActivity, NOW)).toBe(false);
  });

  test('a status-only remote session (no activity signal) is never staled, even if started days ago', () => {
    // Remote/ssh sessions are status-only: lastActivityMs stays 0. An old startedAtMs
    // must NOT age them out — we have no evidence they are idle.
    const remoteOldStart = mk({ startedAtMs: NOW - 30 * 24 * 60 * 60 * 1000, lastActivityMs: 0 });
    expect(isStaleSession(remoteOldStart, NOW)).toBe(false);
  });

  test('a session with no timestamp at all is never forced stale', () => {
    const unknown = mk({ lastActivityMs: 0, startedAtMs: 0 });
    expect(isStaleSession(unknown, NOW)).toBe(false);
  });

  test('filterStaleSessions drops only the aged-out sessions', () => {
    const fresh = mk({ sessionId: 'aaaa1111', lastActivityMs: NOW - 1000 });
    const stale = mk({ sessionId: 'bbbb2222', lastActivityMs: NOW - 2 * STALE_SESSION_THRESHOLD_MS });
    const unknown = mk({ sessionId: 'cccc3333', lastActivityMs: 0, startedAtMs: 0 });
    const kept = filterStaleSessions([fresh, stale, unknown], NOW);
    expect(kept.map((s) => s.sessionId).sort()).toEqual(['aaaa1111', 'cccc3333']);
  });
});
