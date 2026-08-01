import { describe, it, expect, afterEach } from 'vitest';
import { writePidSessionEntry, readPidSessionEntry, listPidSessionEntries, prunePidSessionRegistry, extractSessionIdArg } from './pid-registry.js';

// A pid far above any real process on this box, so the test never clobbers a
// live `ag run` entry and never collides with a real process's registry file.
const FAKE_PID = 999_000_001;

// Clean up only our own entry — a prune predicate that reports every OTHER pid
// as alive, so real entries written by concurrent `ag run` invocations survive.
afterEach(() => {
  prunePidSessionRegistry((pid) => pid !== FAKE_PID);
});

describe('pid session registry', () => {
  it('round-trips a written entry with its exact session id and join keys', () => {
    writePidSessionEntry({
      pid: FAKE_PID,
      agent: 'claude',
      sessionId: 'abc-123-uuid',
      cwd: '/home/x/repo',
      launchId: 'launch-abc',
      terminalId: 'CL-1700000000000-1',
      tmuxPane: '%18',
      startedAtMs: 1_700_000_000_000,
    });
    const got = readPidSessionEntry(FAKE_PID);
    expect(got?.sessionId).toBe('abc-123-uuid');
    expect(got?.agent).toBe('claude');
    expect(got?.cwd).toBe('/home/x/repo');
    // The join keys must survive the round-trip — active.ts reconciles the hook's
    // authoritative id to this entry via launchId (and terminalId).
    expect(got?.launchId).toBe('launch-abc');
    expect(got?.terminalId).toBe('CL-1700000000000-1');
    expect(got?.tmuxPane).toBe('%18');
  });

  it('returns undefined for a pid with no entry', () => {
    expect(readPidSessionEntry(FAKE_PID + 7)).toBeUndefined();
  });

  it('ignores a pid < 1 (never writes a bogus file)', () => {
    writePidSessionEntry({ pid: 0, agent: 'claude', startedAtMs: 1 });
    expect(readPidSessionEntry(0)).toBeUndefined();
  });

  it('prune removes entries whose pid is dead, keeps live ones', () => {
    writePidSessionEntry({ pid: FAKE_PID, agent: 'claude', sessionId: 's', startedAtMs: 1 });
    expect(readPidSessionEntry(FAKE_PID)).toBeDefined();
    // Everything dead → our entry is removed.
    prunePidSessionRegistry(() => false);
    expect(readPidSessionEntry(FAKE_PID)).toBeUndefined();
  });

  it('stores an entry without a session id (non-Claude agents that take none)', () => {
    writePidSessionEntry({ pid: FAKE_PID, agent: 'grok', cwd: '/repo', startedAtMs: 2 });
    const got = readPidSessionEntry(FAKE_PID);
    expect(got?.agent).toBe('grok');
    expect(got?.sessionId).toBeUndefined();
  });

  it('listPidSessionEntries surfaces a written entry (the tmux source indexes these by pane)', () => {
    writePidSessionEntry({ pid: FAKE_PID, agent: 'gemini', cwd: '/repo', tmuxPane: '%42', launchId: 'lz', startedAtMs: 9 });
    const mine = listPidSessionEntries().filter(e => e.pid === FAKE_PID);
    expect(mine).toHaveLength(1);
    expect(mine[0].tmuxPane).toBe('%42');
    expect(mine[0].agent).toBe('gemini');
    expect(mine[0].launchId).toBe('lz');
  });
});

describe('extractSessionIdArg', () => {
  const UUID = 'e6666574-191b-4afd-ad21-e7a09fd7b026';

  it('finds --session-id <uuid> and --session-id=<uuid>', () => {
    expect(extractSessionIdArg(['--permission-mode', 'x', '--session-id', UUID])).toBe(UUID);
    expect(extractSessionIdArg([`--session-id=${UUID}`])).toBe(UUID);
  });

  it('rejects non-uuid values so a flag typo never fabricates an identity', () => {
    expect(extractSessionIdArg(['--session-id', 'not-a-uuid'])).toBeUndefined();
    expect(extractSessionIdArg(['--session-id'])).toBeUndefined();
    expect(extractSessionIdArg([])).toBeUndefined();
  });

  it('does not match the flag as a prompt substring (only whole args)', () => {
    expect(extractSessionIdArg(['-p', `run with --session-id ${UUID} please`])).toBeUndefined();
  });
});
