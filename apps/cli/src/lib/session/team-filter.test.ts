import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _resetTeamOriginIndex, classifyTeamSession, enrichTeamOrigins, filterTeamSessions } from './team-filter.js';
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
    _resetTeamOriginIndex();
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

  it('carries the team name and spawning session off meta.json', () => {
    // task_name / parent_session_id have always been on disk; before this they
    // were parsed and discarded, so a teammate row could never name its team or
    // point back at the orchestrator that created it.
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const agentDir = path.join(tmpDir, sessionId);
    fs.mkdirSync(agentDir);
    fs.writeFileSync(
      path.join(agentDir, 'meta.json'),
      JSON.stringify({
        agent_id: sessionId,
        name: 'resume-picker',
        mode: 'edit',
        task_name: 'redesign',
        parent_session_id: '21805f5f-1111-2222-3333-444444444444',
      }),
    );

    const origin = classifyTeamSession(makeSession({ id: sessionId }));

    expect(origin!.team).toBe('redesign');
    expect(origin!.parentSessionId).toBe('21805f5f-1111-2222-3333-444444444444');
    expect(origin!.handle).toBe('resume-picker');
  });

  it('leaves team and parentSessionId undefined for a record that lacks them', () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const agentDir = path.join(tmpDir, sessionId);
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, 'meta.json'), JSON.stringify({ agent_id: sessionId, name: 'solo' }));

    const origin = classifyTeamSession(makeSession({ id: sessionId }));

    expect(origin!.handle).toBe('solo');
    expect(origin!.team).toBeUndefined();
    expect(origin!.parentSessionId).toBeUndefined();
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
    _resetTeamOriginIndex();
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

describe('enrichTeamOrigins', () => {
  let tmpDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-team-enrich-'));
    savedEnv = process.env.AGENTS_TEAMS_DIR;
    process.env.AGENTS_TEAMS_DIR = tmpDir;
    _resetTeamOriginIndex();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AGENTS_TEAMS_DIR;
    else process.env.AGENTS_TEAMS_DIR = savedEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTeammate(sessionId: string, meta: Record<string, unknown>): void {
    const dir = path.join(tmpDir, sessionId);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ agent_id: sessionId, ...meta }));
  }

  it('attaches teamOrigin to teammate rows and leaves ordinary rows untouched', () => {
    writeTeammate('team-1', { name: 'auth', mode: 'edit', task_name: 'redesign', parent_session_id: 'orch-1' });

    const [teammate, ordinary] = enrichTeamOrigins([
      makeSession({ id: 'team-1' }),
      makeSession({ id: 'ordinary-1' }),
    ]);

    expect(teammate.teamOrigin?.team).toBe('redesign');
    expect(teammate.teamOrigin?.parentSessionId).toBe('orch-1');
    expect(ordinary.teamOrigin).toBeUndefined();
  });

  it('resolves a teammate whose transcript id is not its agent-dir name', () => {
    // The directory is named for the AGENT id; the harness mints its own session
    // id, recorded separately as remote_session_id. Keying only on the directory
    // name missed most teammates — on a live box, 14 of 16 records were reachable
    // only this way — so their rows could not name their team at all.
    writeTeammate('agent-dir-id', {
      name: 'core',
      mode: 'edit',
      task_name: 'checklists',
      parent_session_id: 'orch-1',
      remote_session_id: 'transcript-id-42',
    });

    const [row] = enrichTeamOrigins([makeSession({ id: 'transcript-id-42' })]);

    expect(row.teamOrigin?.team).toBe('checklists');
    expect(row.teamOrigin?.handle).toBe('core');
    expect(row.teamOrigin?.parentSessionId).toBe('orch-1');
  });

  it('still resolves a teammate under its agent-dir name', () => {
    writeTeammate('same-id', { name: 'ui', task_name: 'redesign', remote_session_id: 'other-id' });
    const [byDir] = enrichTeamOrigins([makeSession({ id: 'same-id' })]);
    const [byRemote] = enrichTeamOrigins([makeSession({ id: 'other-id' })]);
    expect(byDir.teamOrigin?.team).toBe('redesign');
    expect(byRemote.teamOrigin?.team).toBe('redesign');
  });

  it('preserves a teamOrigin the peer already resolved', () => {
    // A remote row was classified on the machine that owns its meta.json. We have
    // no record for it locally, so re-deriving would downgrade a named teammate
    // to a bare id — the browser folds peers in, so this is the common case.
    const remote = makeSession({
      id: 'peer-1',
      isTeamOrigin: true,
      teamOrigin: { handle: 'ui', team: 'redesign', parentSessionId: 'orch-9' },
    });

    const [out] = enrichTeamOrigins([remote]);

    expect(out.teamOrigin?.handle).toBe('ui');
    expect(out.teamOrigin?.team).toBe('redesign');
  });

  it('falls back to a bare handle for a team row with no meta record', () => {
    const [out] = enrichTeamOrigins([makeSession({ id: 'legacy-team-row', isTeamOrigin: true })]);
    expect(out.teamOrigin?.handle).toBe('legacy-t');
    expect(out.teamOrigin?.team).toBeUndefined();
  });
});
