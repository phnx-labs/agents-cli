import { describe, expect, test } from 'bun:test';
import { buildAgentLaunchCommand } from './agents';
import { buildForkSessionRequest } from './forkSession';
import {
  buildSessionBrowserRows,
  cleanSessionTopic,
  forkHostForSession,
  formatSessionWhen,
  sessionMachine,
  type BrowsableSession,
  type SessionBrowserSessionRow,
} from './sessionBrowser';

function session(over: Partial<BrowsableSession> & { id: string }): BrowsableSession {
  return {
    shortId: over.id.slice(0, 8),
    agent: 'claude',
    timestamp: '2026-08-03T06:00:00.000Z',
    ...over,
  };
}

const sessionRows = (rows: ReturnType<typeof buildSessionBrowserRows>) =>
  rows.filter((r): r is SessionBrowserSessionRow => r.kind === 'session');

describe('forkHostForSession', () => {
  test('a transcript on this machine forks locally (no --device)', () => {
    expect(forkHostForSession(session({ id: 'local-1', machine: 'zion' }), 'zion')).toBeUndefined();
  });

  test('a transcript on a fleet box forks on that box', () => {
    expect(forkHostForSession(session({ id: 'remote-1', machine: 'yosemite-s0' }), 'zion')).toBe('yosemite-s0');
  });

  test('an untagged row falls back to the browsed device, then this machine', () => {
    expect(forkHostForSession(session({ id: 'old-1' }), 'zion')).toBeUndefined();
    expect(forkHostForSession(session({ id: 'old-1' }), 'zion', 'mac-mini')).toBe('mac-mini');
    expect(sessionMachine(session({ id: 'old-1', machine: '  ' }), 'zion')).toBe('zion');
    expect(sessionMachine(session({ id: 'old-1', machine: '  ' }), 'zion', 'mac-mini')).toBe('mac-mini');
  });
});

describe('buildSessionBrowserRows', () => {
  test('renders one group for the explicitly browsed device', () => {
    const rows = buildSessionBrowserRows(
      [
        session({ id: 'r-1', machine: 'mac-mini' }),
        session({ id: 'old-r-2', machine: undefined }),
      ],
      { localMachine: 'zion', browsedMachine: 'mac-mini' },
    );
    expect(rows.filter(r => r.kind === 'group').map(r => r.machine)).toEqual(['mac-mini']);
    expect(sessionRows(rows).map(r => [r.session.id, r.machine, r.remote])).toEqual([
      ['r-1', 'mac-mini', true],
      ['old-r-2', 'mac-mini', true],
    ]);
  });

  test('marks the browsed machine remote so the launch carries --device', () => {
    const rows = sessionRows(buildSessionBrowserRows(
      [session({ id: 'r-1', machine: 'mac-mini' })],
      { localMachine: 'zion', browsedMachine: 'mac-mini' },
    ));
    expect(rows.map(r => [r.session.id, r.remote])).toEqual([['r-1', true]]);
  });

  test('orders the browsed device newest first', () => {
    const rows = sessionRows(buildSessionBrowserRows(
      [
        session({ id: 'older', machine: 'zion', timestamp: '2026-08-01T00:00:00.000Z' }),
        session({ id: 'newest', machine: 'zion', timestamp: '2026-08-03T00:00:00.000Z' }),
        session({ id: 'middle', machine: 'zion', timestamp: '2026-08-02T00:00:00.000Z' }),
      ],
      { localMachine: 'zion' },
    ));
    expect(rows.map(r => r.session.id)).toEqual(['newest', 'middle', 'older']);
  });

  test('pins the current session to the top of the browsed device list', () => {
    const rows = buildSessionBrowserRows(
      [
        session({ id: 'local-new', machine: 'zion', timestamp: '2026-08-03T08:00:00.000Z' }),
        session({ id: 'current-old', machine: 'zion', timestamp: '2026-07-01T00:00:00.000Z' }),
      ],
      { localMachine: 'zion', currentSessionId: 'current-old' },
    );
    const local = sessionRows(rows);
    expect(local.map(r => r.session.id)).toEqual(['current-old', 'local-new']);
    expect(local[0].current).toBe(true);
    expect(local[0].label.startsWith('$(pinned) ')).toBe(true);
  });

  test('skips rows with no session id rather than emitting an unforkable entry', () => {
    const rows = buildSessionBrowserRows(
      [session({ id: 'good', machine: 'zion' }), { ...session({ id: 'x' }), id: '' }],
      { localMachine: 'zion' },
    );
    expect(sessionRows(rows).map(r => r.session.id)).toEqual(['good']);
  });

  test('renders harness, age, turns and account into the row description', () => {
    const [row] = sessionRows(buildSessionBrowserRows(
      [session({
        id: 'desc-1',
        machine: 'zion',
        version: '2.1.220',
        account: 'me@example.com',
        messageCount: 42,
        topic: 'Add <tool_use>fork</tool_use>  picker',
        project: 'agents-cli',
        cwd: '/src/agents-cli',
        timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
      })],
      { localMachine: 'zion' },
    ));
    expect(row.label).toBe('desc-1  Add fork picker');
    expect(row.description).toBe('claude@2.1.220 · 5 min ago · 42 turns · me@example.com');
    expect(row.detail).toBe('agents-cli  /src/agents-cli');
  });
});

describe('picked row -> launch command', () => {
  // The seam the whole feature turns on: what the browser SHOWS as a device is
  // what the launch RUNS on. Walk a picked row through the real fork request and
  // the real command builder — no mocks in between.
  test('a row on a fleet device launches there, in that box\'s copy of the repo', () => {
    const picked = session({
      id: 'sess-remote',
      agent: 'claude',
      machine: 'yosemite-s1',
      cwd: '/home/muqsit/src/github.com/muqsitnawaz/agents-cli',
    });
    const request = buildForkSessionRequest({
      sessionId: picked.id,
      agentKey: picked.agent,
      host: forkHostForSession(picked, 'zion'),
    });
    if (!request.ok) throw new Error('expected fork request');
    expect(request.local).toBe(false);

    const command = buildAgentLaunchCommand(
      request.agentKey, 'new-id', undefined, undefined, undefined,
      request.strategy, undefined, { host: request.host, local: request.local, remoteCwd: picked.cwd },
    );
    expect(command).toContain("--device 'yosemite-s1'");
    expect(command).toContain("--remote-cwd '/home/muqsit/src/github.com/muqsitnawaz/agents-cli'");
    expect(command).not.toContain(" --cwd ");
    expect(request.prompt).toBe('/continue sess-remote');
  });

  test('a row on this machine launches locally, with no host or remote cwd', () => {
    const picked = session({ id: 'sess-local', agent: 'claude', machine: 'zion', cwd: '/Users/muqsit/src' });
    const request = buildForkSessionRequest({
      sessionId: picked.id,
      agentKey: picked.agent,
      host: forkHostForSession(picked, 'zion'),
    });
    if (!request.ok) throw new Error('expected fork request');
    expect(request.local).toBe(true);

    const command = buildAgentLaunchCommand(
      request.agentKey, 'new-id', undefined, undefined, undefined,
      request.strategy, undefined, { host: request.host, local: request.local },
    );
    expect(command).not.toContain('--device');
    expect(command).not.toContain('--remote-cwd');
  });
});

describe('formatSessionWhen', () => {
  test('reads as a human interval, and stays empty for an unparseable stamp', () => {
    expect(formatSessionWhen(new Date(Date.now() - 30_000).toISOString())).toBe('just now');
    expect(formatSessionWhen(new Date(Date.now() - 90 * 60_000).toISOString())).toBe('1 hour ago');
    expect(formatSessionWhen(new Date(Date.now() - 50 * 60 * 60_000).toISOString())).toBe('2 days ago');
    expect(formatSessionWhen('not-a-date')).toBe('');
  });
});

describe('cleanSessionTopic', () => {
  test('falls back when a topic is missing or was pure markup', () => {
    expect(cleanSessionTopic(undefined)).toBe('(no topic)');
    expect(cleanSessionTopic('<system-reminder>x</system-reminder>')).toBe('x');
    expect(cleanSessionTopic('<a></a>')).toBe('(no topic)');
  });
});
