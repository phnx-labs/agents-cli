// Rows here mirror real `agents sessions --all --json` / `--active --json`
// output (field names and values copied from live CLI payloads), so the join
// under test is the same one the picker runs against the real CLI.

import { describe, it, expect } from 'bun:test';
import {
  abandonedCandidates,
  buildResumeCandidates,
  classifyResumeState,
  defaultPickedIds,
  sortResumeCandidates,
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
  it('pre-selects only the crashed sessions', () => {
    const candidates: ResumeCandidate[] = sortResumeCandidates([
      { id: 'd', shortId: 'd', agent: 'claude', state: 'detached', viewingIn: '', host: '', lastActivityMs: 3, pid: 1 },
      { id: 'b', shortId: 'b', agent: 'claude', state: 'background', viewingIn: '', host: '', lastActivityMs: 2, pid: 2 },
      { id: 'w', shortId: 'w', agent: 'claude', state: 'watched', viewingIn: 'codium tab 1', host: '', lastActivityMs: 1, pid: 3 },
    ]);
    expect(defaultPickedIds(candidates)).toEqual(['d']);
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
