import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyTeamSession, filterTeamSessions } from './team-filter.js';
import type { SessionMeta } from './types.js';

function makeSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    shortId: 'aaaabbbb',
    agent: 'claude',
    timestamp: new Date().toISOString(),
    filePath: '/tmp/fake.jsonl',
    ...overrides,
  };
}

describe('classifyTeamSession', () => {
  let tmpDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-team-filter-'));
    savedEnv = process.env.AGENTS_TEAMS_DIR;
    process.env.AGENTS_TEAMS_DIR = tmpDir;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.AGENTS_TEAMS_DIR;
    } else {
      process.env.AGENTS_TEAMS_DIR = savedEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('classifies session as team when meta.json exists with name and mode', () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const agentDir = path.join(tmpDir, sessionId);
    fs.mkdirSync(agentDir);
    fs.writeFileSync(
      path.join(agentDir, 'meta.json'),
      JSON.stringify({ agent_id: sessionId, name: 'frontend', mode: 'plan' }),
    );

    const session = makeSession({ id: sessionId });
    const origin = classifyTeamSession(session);

    expect(origin).not.toBeNull();
    expect(origin!.handle).toBe('frontend');
    expect(origin!.mode).toBe('plan');
  });

  it('uses short UUID as handle when teammate has no name', () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const agentDir = path.join(tmpDir, sessionId);
    fs.mkdirSync(agentDir);
    fs.writeFileSync(
      path.join(agentDir, 'meta.json'),
      JSON.stringify({ agent_id: sessionId, name: null, mode: 'edit' }),
    );

    const session = makeSession({ id: sessionId });
    const origin = classifyTeamSession(session);

    expect(origin).not.toBeNull();
    expect(origin!.handle).toBe('aaaaaaaa');
    expect(origin!.mode).toBe('edit');
  });

  it('classifies orphan session as team when isTeamOrigin flag is set (meta.json missing)', () => {
    const session = makeSession({
      id: 'no-meta-exists-for-this-id',
      isTeamOrigin: true,
      topic: 'Rewrite the --help output for a group of commands',
    });

    const origin = classifyTeamSession(session);
    expect(origin).not.toBeNull();
    expect(origin!.handle).toBe('no-meta-');
  });

  it('does NOT classify normal interactive session as team', () => {
    const session = makeSession({
      id: 'normal-session-id-no-meta',
      isTeamOrigin: false,
      topic: 'Fix the login bug',
    });

    const origin = classifyTeamSession(session);
    expect(origin).toBeNull();
  });

  it('does NOT classify session as team when no meta.json and isTeamOrigin is false', () => {
    const session = makeSession({ id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff' });
    expect(classifyTeamSession(session)).toBeNull();
  });
});

describe('filterTeamSessions', () => {
  let tmpDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-team-filter-'));
    savedEnv = process.env.AGENTS_TEAMS_DIR;
    process.env.AGENTS_TEAMS_DIR = tmpDir;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.AGENTS_TEAMS_DIR;
    } else {
      process.env.AGENTS_TEAMS_DIR = savedEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupTeamSession(sessionId: string, name: string | null, mode: string): void {
    const agentDir = path.join(tmpDir, sessionId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'meta.json'),
      JSON.stringify({ agent_id: sessionId, name, mode }),
    );
  }

  it('default list excludes team sessions and reports hidden count', () => {
    const teamId = 'team-session-id-0001-aaaaaaaaaa';
    setupTeamSession(teamId, 'worker', 'plan');

    const sessions = [
      makeSession({ id: teamId }),
      makeSession({ id: 'normal-id-1111-bbbbbbbbbb', topic: 'Fix the bug' }),
      makeSession({ id: 'normal-id-2222-cccccccccc', topic: 'Write tests' }),
    ];

    const { visible, hiddenCount } = filterTeamSessions(sessions, false);

    expect(hiddenCount).toBe(1);
    expect(visible).toHaveLength(2);
    expect(visible.every(s => s.id !== teamId)).toBe(true);
  });

  it('--teams includes team sessions with teamOrigin populated', () => {
    const teamId = 'team-session-id-0002-aaaaaaaaaa';
    setupTeamSession(teamId, 'backend', 'edit');

    const sessions = [
      makeSession({ id: teamId }),
      makeSession({ id: 'normal-id-3333-dddddddddd', topic: 'Normal work' }),
    ];

    const { visible, hiddenCount } = filterTeamSessions(sessions, true);

    expect(hiddenCount).toBe(0);
    expect(visible).toHaveLength(2);

    const teamSession = visible.find(s => s.id === teamId);
    expect(teamSession?.teamOrigin).toBeDefined();
    expect(teamSession?.teamOrigin?.handle).toBe('backend');
    expect(teamSession?.teamOrigin?.mode).toBe('edit');
  });

  it('hidden count footer shows the right number across multiple team sessions', () => {
    const ids = [
      'team-id-0003-aaaa-bbbbbbbbbbbb',
      'team-id-0004-cccc-dddddddddddd',
      'team-id-0005-eeee-ffffffffffff',
    ];
    for (const id of ids) {
      setupTeamSession(id, null, 'plan');
    }

    const sessions = [
      ...ids.map(id => makeSession({ id })),
      makeSession({ id: 'normal-id-0006-gggggggg', topic: 'Interactive work' }),
    ];

    const { visible, hiddenCount } = filterTeamSessions(sessions, false);

    expect(hiddenCount).toBe(3);
    expect(visible).toHaveLength(1);
    expect(visible[0].topic).toBe('Interactive work');
  });

  it('returns zero hiddenCount and all sessions when none are team-origin', () => {
    const sessions = [
      makeSession({ id: 'normal-a', topic: 'Task A' }),
      makeSession({ id: 'normal-b', topic: 'Task B' }),
    ];

    const { visible, hiddenCount } = filterTeamSessions(sessions, false);

    expect(hiddenCount).toBe(0);
    expect(visible).toHaveLength(2);
  });
});
