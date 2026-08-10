// Rows here mirror real `agents sessions --all --json` / `--active --json`
// output (field names and values copied from live CLI payloads), so the join
// under test is the same one the picker runs against the real CLI.

import { describe, it, expect } from 'bun:test';
import {
  abandonedCandidates,
  buildResumeCandidates,
  classifyResumeState,
  defaultPickedIds,
  distinctiveTopic,
  nextPreselection,
  sharedTopicPrefixes,
  sortResumeCandidates,
  stripSharedPrefix,
  type RecentSessionRow,
  type ResumeCandidate,
} from './resumePicker';
import type { RawActiveSession } from './remoteSessions';

function recent(over: Partial<RecentSessionRow> = {}): RecentSessionRow {
  return {
    id: '97646f02-60f4-4d2d-bb63-00909441a446',
    shortId: '97646f02',
    agent: 'claude',
    version: '2.1.220',
    account: 'muqsitnawaz@gmail.com',
    project: 'agents-cli',
    cwd: '/Users/muqsit/src/github.com/muqsitnawaz/agents-cli',
    topic: 'Fix session resume with batch selection',
    timestamp: '2026-08-03T06:19:04.997Z',
    lastActivity: '2026-08-03T06:20:08.089Z',
    machine: 'zion',
    ...over,
  };
}

function live(over: Partial<RawActiveSession> = {}): RawActiveSession {
  return {
    context: 'terminal',
    kind: 'claude',
    pid: 74893,
    sessionId: '97646f02-60f4-4d2d-bb63-00909441a446',
    cwd: '/Users/muqsit/src/github.com/muqsitnawaz/agents-cli',
    machine: 'zion',
    status: 'running',
    lastActivityMs: Date.parse('2026-08-03T06:20:08.089Z'),
    viewingIn: 'codium tab 3',
    ...over,
  };
}

describe('classifyResumeState', () => {
  it('is idle with no live process', () => {
    expect(classifyResumeState(undefined)).toBe('idle');
  });

  it('is detached when the CLI found the pane but no client on it', () => {
    expect(classifyResumeState(live({ viewingIn: 'detached' }))).toBe('detached');
  });

  it('treats retained closed panes and dead pids as inactive transcripts', () => {
    expect(classifyResumeState(live({ viewingIn: 'detached', status: 'closed' }))).toBe('idle');
    expect(classifyResumeState(live({ viewingIn: 'detached', status: 'crashed' }))).toBe('idle');
    expect(classifyResumeState(live({ viewingIn: 'detached', pid: 0 }))).toBe('idle');
    expect(classifyResumeState(live({ viewingIn: 'detached', pidAlive: false }))).toBe('idle');
  });

  it('is watched when a client is attached', () => {
    expect(classifyResumeState(live({ viewingIn: 'ghostty tab 2' }))).toBe('watched');
  });

  it('honours the deliberate detach/attach axis over the viewer lookup', () => {
    expect(classifyResumeState(live({ presence: 'background', viewingIn: 'detached' }))).toBe('background');
    expect(classifyResumeState(live({ presence: 'parked', viewingIn: 'detached' }))).toBe('parked');
  });
});

describe('buildResumeCandidates', () => {
  it('joins the durable row with its live row and marks a dead terminal detached', () => {
    const out = buildResumeCandidates([recent()], [live({ viewingIn: 'detached' })], 'zion');
    expect(out).toHaveLength(1);
    expect(out[0].state).toBe('detached');
    expect(out[0].viewingIn).toBe('');
    expect(out[0].pid).toBe(74893);
    expect(out[0].version).toBe('2.1.220');
    expect(out[0].host).toBe('');
  });

  it('keeps a live session that fell outside the recent listing cap', () => {
    const orphan = live({ sessionId: 'aaaabbbb-1111-2222-3333-444455556666', viewingIn: 'detached' });
    const out = buildResumeCandidates([], [orphan], 'zion');
    expect(out.map(c => c.shortId)).toEqual(['aaaabbbb']);
    expect(out[0].state).toBe('detached');
    expect(out[0].project).toBe('agents-cli');
  });

  it('carries a session on another machine as a host so it resumes over SSH', () => {
    const out = buildResumeCandidates(
      [recent({ machine: 'yosemite-s0' })],
      [live({ machine: 'yosemite-s0', viewingIn: 'detached' })],
      'zion',
    );
    expect(out[0].host).toBe('yosemite-s0');
  });

  it('orders detached first, then background, parked, recent, and already-open last', () => {
    const rows: RecentSessionRow[] = [
      recent({ id: 'w', shortId: 'w', lastActivity: '2026-08-03T06:00:00.000Z' }),
      recent({ id: 'd', shortId: 'd', lastActivity: '2026-08-01T06:00:00.000Z' }),
      recent({ id: 'i', shortId: 'i', lastActivity: '2026-08-02T06:00:00.000Z' }),
      recent({ id: 'b', shortId: 'b', lastActivity: '2026-08-01T05:00:00.000Z' }),
      recent({ id: 'p', shortId: 'p', lastActivity: '2026-08-01T04:00:00.000Z' }),
    ];
    const actives: RawActiveSession[] = [
      live({ sessionId: 'w', viewingIn: 'codium tab 1' }),
      live({ sessionId: 'd', viewingIn: 'detached' }),
      live({ sessionId: 'b', presence: 'background' }),
      live({ sessionId: 'p', presence: 'parked' }),
    ];
    const out = buildResumeCandidates(rows, actives, 'zion');
    expect(out.map(c => c.shortId)).toEqual(['d', 'b', 'p', 'i', 'w']);
  });

  it('sorts most-recent-first inside one state group', () => {
    const older = recent({ id: 'old', shortId: 'old', lastActivity: '2026-08-01T00:00:00.000Z' });
    const newer = recent({ id: 'new', shortId: 'new', lastActivity: '2026-08-03T00:00:00.000Z' });
    const out = buildResumeCandidates([older, newer], [], 'zion');
    expect(out.map(c => c.shortId)).toEqual(['new', 'old']);
  });

  it('drops rows with no id and never emits the same session twice', () => {
    const dup = recent();
    const out = buildResumeCandidates([dup, dup, recent({ id: undefined })], [live()], 'zion');
    expect(out).toHaveLength(1);
  });

  it('prefers an explicit label over the inferred topic and strips markup', () => {
    const out = buildResumeCandidates(
      [recent({ label: 'agents-cli-43', topic: 'inferred' })],
      [],
      'zion',
    );
    expect(out[0].topic).toBe('agents-cli-43');
    const tagged = buildResumeCandidates(
      [recent({ label: undefined, topic: 'ref: <system-reminder>x</system-reminder> fix resume' })],
      [],
      'zion',
    );
    expect(tagged[0].topic).toBe('ref: x fix resume');
  });
});

describe('abandonedCandidates', () => {
  it('drops sessions that already have a terminal somewhere, keeping rank order', () => {
    const candidates: ResumeCandidate[] = sortResumeCandidates([
      { id: 'd', shortId: 'd', agent: 'claude', state: 'detached', viewingIn: '', host: '', lastActivityMs: 5, pid: 1 },
      { id: 'b', shortId: 'b', agent: 'codex', state: 'background', viewingIn: '', host: 'zion', lastActivityMs: 4, pid: 2 },
      { id: 'p', shortId: 'p', agent: 'claude', state: 'parked', viewingIn: '', host: '', lastActivityMs: 3, pid: 0 },
      { id: 'i', shortId: 'i', agent: 'grok', state: 'idle', viewingIn: '', host: '', lastActivityMs: 2, pid: 0 },
      { id: 'w', shortId: 'w', agent: 'claude', state: 'watched', viewingIn: 'codium tab 1', host: '', lastActivityMs: 6, pid: 3 },
    ]);
    expect(abandonedCandidates(candidates).map(c => c.shortId)).toEqual(['d', 'b', 'p', 'i']);
  });

  it('returns an empty list when every session is watched', () => {
    const candidates: ResumeCandidate[] = [
      { id: 'w', shortId: 'w', agent: 'claude', state: 'watched', viewingIn: 'ghostty tab 2', host: '', lastActivityMs: 1, pid: 3 },
    ];
    expect(abandonedCandidates(candidates)).toEqual([]);
  });
});

describe('defaultPickedIds', () => {
  it('starts every batch resume with an explicit selection', () => {
    const candidates: ResumeCandidate[] = sortResumeCandidates([
      { id: 'd', shortId: 'd', agent: 'claude', state: 'detached', viewingIn: '', host: '', lastActivityMs: 3, pid: 1 },
      { id: 'b', shortId: 'b', agent: 'claude', state: 'background', viewingIn: '', host: '', lastActivityMs: 2, pid: 2 },
      { id: 'w', shortId: 'w', agent: 'claude', state: 'watched', viewingIn: 'codium tab 1', host: '', lastActivityMs: 1, pid: 3 },
    ]);
    expect(defaultPickedIds(candidates)).toEqual([]);
  });
});

describe('device id normalization', () => {
  it('uses the same normalizer as the rest of the extension, so a local session never looks remote', () => {
    // os.hostname() shapes that a hand-rolled lowercase+split(".") would leave
    // different from normalizeHost, marking a LOCAL session remote and sending
    // the resume over SSH.
    const out = buildResumeCandidates(
      [recent({ machine: 'Mac_Mini.local' })],
      [live({ machine: 'Mac_Mini.local' })],
      'mac-mini',
    );
    expect(out[0].host).toBe('');
  });

  it('still reports a genuinely different machine as a host', () => {
    const out = buildResumeCandidates([recent({ machine: 'yosemite-s0' })], [], 'mac-mini');
    expect(out[0].host).toBe('yosemite-s0');
  });
});

// The topic strings below are verbatim from a real 222-session listing on this
// fleet, where 15 rows led with "Resume previous work:" and 11 with
// "## Apps (Connectors)" — the boilerplate that made the picker unreadable.
describe('shared-topic boilerplate stripping', () => {
  const REAL_TOPICS = [
    'Resume previous work: zion:/Users/muqsit/Screenshots/CleanShot 2026',
    'Resume previous work: 4db0440e-d69c-4873-9ef5-56fc350ae9cc',
    'Resume previous work: agents-cli spec conflicts',
    'Review OpenPRs and agents-cli spec conflicts',
    'Agents Doctor Issues Diagnosis Fix Plan',
  ];

  it('finds the phrase that leads several topics', () => {
    const prefixes = sharedTopicPrefixes(REAL_TOPICS);
    expect(prefixes).toContain('Resume previous work:');
  });

  it('leaves a phrase that leads only one topic alone', () => {
    const prefixes = sharedTopicPrefixes(REAL_TOPICS);
    expect(prefixes.some((p) => p.startsWith('Review OpenPRs'))).toBe(false);
  });

  it('strips the longest match, not a shorter phrase nested in it', () => {
    const prefixes = sharedTopicPrefixes(REAL_TOPICS);
    expect(stripSharedPrefix('Resume previous work: agents-cli spec conflicts', prefixes))
      .toBe('agents-cli spec conflicts');
  });

  it('never blanks a topic whose every word is shared', () => {
    // 'New Session' recurred 4x in the real listing; stripping the whole string
    // would leave an unidentifiable empty row.
    const topics = ['New Session', 'New Session', 'New Session', 'New Session'];
    expect(stripSharedPrefix('New Session', sharedTopicPrefixes(topics))).toBe('New Session');
  });

  it('keeps a topic that is entirely a shared phrase rather than blanking it', () => {
    // A longer topic can mint a phrase equal to a shorter topic's whole text.
    // Three "Fix login bug …" sessions make "Fix login" shared; a fourth session
    // genuinely called "Fix login" must not lose its only distinguishing text.
    const topics = ['Fix login bug', 'Fix login bug urgently', 'Fix login bug now', 'Fix login'];
    const prefixes = sharedTopicPrefixes(topics);
    expect(prefixes).toContain('Fix login');
    expect(stripSharedPrefix('Fix login', prefixes)).toBe('Fix login');
  });

  it('does not fall through to a shorter phrase when the longest covers the whole topic', () => {
    // Regression: with prefixes ['Resume previous work:', 'Resume previous'],
    // rejecting the exact match and continuing the loop stripped the SHORTER
    // phrase and rendered the row as 'work:' — a fragment of the boilerplate.
    const topics = [
      'Resume previous work: alpha',
      'Resume previous work: beta',
      'Resume previous work: gamma',
      'Resume previous work:',
    ];
    const prefixes = sharedTopicPrefixes(topics);
    expect(prefixes).toEqual(['Resume previous work:', 'Resume previous']);
    expect(stripSharedPrefix('Resume previous work:', prefixes)).toBe('Resume previous work:');
  });

  it('matches per word, not per character, so a plural does not lose its stem', () => {
    // Prefixes are mined per word; a bare startsWith lands mid-word on a
    // singular/plural pair and rendered 'Fix bugs reported by QA' as
    // 's reported by QA'.
    const topics = ['Fix bug in auth', 'Fix bug in ui', 'Fix bug in db', 'Fix bugs reported by QA'];
    const prefixes = sharedTopicPrefixes(topics);
    expect(prefixes).toEqual(['Fix bug in', 'Fix bug']);
    expect(stripSharedPrefix('Fix bugs reported by QA', prefixes)).toBe('Fix bugs reported by QA');
    // The genuine members of the family still strip.
    expect(stripSharedPrefix('Fix bug in auth', prefixes)).toBe('auth');
  });

  it('does not eat content that legitimately starts with punctuation', () => {
    const prefixes = ['Resume previous work:'];
    expect(stripSharedPrefix('Resume previous work: -1 open issue', prefixes)).toBe('-1 open issue');
    expect(stripSharedPrefix('Resume previous work: --verbose flag broken', prefixes))
      .toBe('--verbose flag broken');
  });

  it('falls back to the cwd leaf when there is no topic and no project', () => {
    const c = { cwd: '/home/muqsit/src/github.com/muqsitnawaz' } as ResumeCandidate;
    expect(distinctiveTopic(c, [])).toBe('muqsitnawaz');
  });

  it('reports nothing distinctive rather than a misleading fragment', () => {
    expect(distinctiveTopic({} as ResumeCandidate, [])).toBe('');
  });
});

// The selection bookkeeping behind `Agents: Resume`. These run the real
// function the picker calls; only `quickPick.selectedItems` is stood in for,
// since that value is supplied by VS Code and is a plain list of ids.
// The first case reproduces the fixed bug (it fails against the pre-fix
// algorithm); the rest pin invariants that must hold either way.
describe('nextPreselection — selection across list swaps', () => {
  const c = (id: string, state: ResumeCandidate['state']) => ({ id, state }) as ResumeCandidate;

  it('does not add a newly detached session during a refresh', () => {
    const unticked = new Set<string>();
    const first = [c('A', 'detached'), c('X', 'idle')];
    const p1 = nextPreselection({ previous: [], checked: new Set(), next: first, unticked });
    expect([...p1]).toEqual([]);

    const second = [c('A', 'detached'), c('X', 'detached')];
    const p2 = nextPreselection({ previous: first, checked: p1, next: second, unticked });
    expect(p2.has('X')).toBe(false);
    expect(p2.has('A')).toBe(false);
  });

  it('keeps an explicit selection across a refresh', () => {
    const unticked = new Set<string>();
    const rows = [c('A', 'detached'), c('B', 'detached')];
    nextPreselection({ previous: [], checked: new Set(['A', 'B']), next: rows, unticked });
    const p2 = nextPreselection({ previous: rows, checked: new Set(['B']), next: rows, unticked });
    expect(p2.has('A')).toBe(false);
    expect(p2.has('B')).toBe(true);
  });

  it('keeps a user deselection across a later swap', () => {
    const unticked = new Set<string>();
    const rows = [c('A', 'detached'), c('B', 'detached')];
    nextPreselection({ previous: [], checked: new Set(['A', 'B']), next: rows, unticked });
    const p2 = nextPreselection({ previous: rows, checked: new Set(['B']), next: rows, unticked });
    const p3 = nextPreselection({ previous: rows, checked: p2, next: rows, unticked });
    expect(p3.has('A')).toBe(false);
  });

  it('keeps a user selection when the same row remains visible', () => {
    const unticked = new Set<string>();
    const rows = [c('A', 'detached')];
    nextPreselection({ previous: [], checked: new Set(['A']), next: rows, unticked });
    nextPreselection({ previous: rows, checked: new Set(['A']), next: rows, unticked });
    const p3 = nextPreselection({ previous: rows, checked: new Set(['A']), next: rows, unticked });
    expect(p3.has('A')).toBe(true);
  });
});
