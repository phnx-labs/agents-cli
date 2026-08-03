import { describe, expect, it } from 'vitest';
import { buildHqFloor } from './floor.js';
import type { ActiveSession } from '../session/active.js';
import type { OpenBlock } from '../feed.js';
import type { AgentStatusDetail, TaskInfo } from '../teams/api.js';

describe('buildHqFloor', () => {
  it('groups live agents into team rooms and exposes clickable management commands', () => {
    const teams: TaskInfo[] = [{
      task_name: 'release-squad',
      agent_count: 1,
      pending: 0,
      running: 1,
      completed: 0,
      failed: 0,
      stopped: 0,
      workspace_dir: '/repo',
      created_at: '2026-07-21T17:00:00.000Z',
      modified_at: '2026-07-21T17:01:00.000Z',
    }];
    const teammate: AgentStatusDetail = {
      agent_id: 'agent-123456',
      agent_type: 'codex',
      status: 'running',
      prompt: 'Ship the release',
      started_at: '2026-07-21T17:00:00.000Z',
      completed_at: null,
      duration: null,
      files_created: [],
      files_modified: [],
      files_read: [],
      files_deleted: [],
      bash_commands: [],
      recent_tool_calls: [],
      last_messages: [],
      tool_count: 0,
      has_errors: false,
      cursor: '2026-07-21T17:01:00.000Z',
      name: 'shipper',
      host: 'yosemite-s0',
    };
    const sessions: ActiveSession[] = [{
      context: 'teams',
      kind: 'codex',
      status: 'input_required',
      activity: 'waiting_input',
      sessionId: 'session-abc',
      agentId: 'agent-123456',
      teamName: 'release-squad',
      machine: 'yosemite-s0',
      preview: 'Waiting for approval',
      question: { text: 'Merge this PR?', reason: 'question', options: [] },
    }];
    const blocks: OpenBlock[] = [{
      blockId: 'block-1',
      sessionId: 'session-abc',
      mailboxId: 'agent-123456',
      host: 'yosemite-s0',
      runtime: 'codex',
      ts: '2026-07-21T17:02:00.000Z',
      kind: 'question',
      questions: [{ text: 'Merge this PR?', options: [] }],
    } as OpenBlock];

    const snapshot = buildHqFloor({
      generatedAt: new Date('2026-07-21T17:03:00.000Z'),
      sessions,
      teams,
      teammatesByTeam: new Map([['release-squad', [teammate]]]),
      blocks,
    });

    expect(snapshot.generatedAt).toBe('2026-07-21T17:03:00.000Z');
    expect(snapshot.rooms).toHaveLength(1);
    expect(snapshot.rooms[0]).toMatchObject({
      id: 'team:release-squad',
      kind: 'team',
      name: 'release-squad',
      counts: { agents: 1, needsInput: 1, running: 0, failed: 0 },
    });
    expect(snapshot.agents[0]).toMatchObject({
      id: 'agent-123456',
      label: 'agent-123456',
      roomId: 'team:release-squad',
      mood: 'waiting',
      team: 'release-squad',
      teammate: 'shipper',
      mailboxId: 'agent-123456',
    });
    expect(snapshot.agents[0].actions.map((a) => a.id)).toEqual([
      'agent:agent-123456:message',
      'agent:agent-123456:stop',
      'agent:agent-123456:team-stop',
      'agent:agent-123456:transcript',
    ]);
    expect(snapshot.agents[0].actions.find((a) => a.label === 'Message')?.command).toEqual([
      'message',
      'agent-123456',
      '{message}',
      '--surface',
      'hq',
    ]);
    expect(snapshot.rooms[0].actions[0].command).toEqual([
      'teams',
      'add',
      'release-squad',
      '{agent}',
      '{task}',
      '--name',
      '{name}',
      '--mode',
      'edit',
    ]);
    expect(snapshot.ambientEvents.some((event) => event.kind === 'needs_input' && event.agentId === 'agent-123456')).toBe(true);
  });

  it('does not render closed or abandoned sessions as idle on the floor', () => {
    const sessions: ActiveSession[] = [
      {
        context: 'terminal',
        kind: 'codex',
        status: 'closed',
        activity: 'working',
        sessionId: 'closed-session',
        machine: 'yosemite-s0',
      },
      {
        context: 'terminal',
        kind: 'claude',
        status: 'abandoned',
        activity: 'idle',
        sessionId: 'abandoned-session',
        machine: 'yosemite-s0',
      },
    ];

    const snapshot = buildHqFloor({
      generatedAt: new Date('2026-07-21T17:03:00.000Z'),
      sessions,
      teams: [],
      teammatesByTeam: new Map(),
      blocks: [],
    });

    expect(snapshot.agents.map((agent) => [agent.id, agent.mood])).toEqual([
      ['closed-session', 'done'],
      ['abandoned-session', 'blocked'],
    ]);
    expect(snapshot.rooms[0].counts).toEqual({ agents: 2, needsInput: 0, running: 0, failed: 1 });
    expect(snapshot.counters.failed).toBe(1);
    expect(snapshot.ambientEvents.some((event) => event.kind === 'error' && event.agentId === 'abandoned-session')).toBe(true);
    expect(snapshot.ambientEvents.some((event) => event.kind === 'idle_scene')).toBe(false);
  });

  // A session whose host died keeps whatever `activity` its last parsed turn
  // left behind — usually `working`. Without its own arm that falls through to
  // the activity check and the Floor shows a cheerfully working agent for a
  // process that is gone.
  it('does not render a crashed or orphaned session as working on the floor', () => {
    const sessions: ActiveSession[] = [
      {
        context: 'terminal',
        kind: 'claude',
        status: 'crashed',
        activity: 'working',
        sessionId: 'crashed-session',
        machine: 'yosemite-s0',
      },
      {
        context: 'terminal',
        kind: 'claude',
        status: 'orphaned',
        activity: 'idle',
        sessionId: 'orphaned-session',
        machine: 'yosemite-s0',
      },
    ];

    const snapshot = buildHqFloor({
      generatedAt: new Date('2026-07-21T17:03:00.000Z'),
      sessions,
      teams: [],
      teammatesByTeam: new Map(),
      blocks: [],
    });

    expect(snapshot.agents.map((agent) => [agent.id, agent.mood])).toEqual([
      ['crashed-session', 'blocked'],
      ['orphaned-session', 'waiting'],
    ]);
  });
});
