import type { ActiveSession } from '../session/active.js';
import { mailboxIdForActiveSession } from '../mailbox-target.js';
import type { OpenBlock } from '../feed.js';
import type { AgentStatusDetail, TaskInfo } from '../teams/api.js';

export type HqRoomKind = 'team' | 'machine' | 'lobby';
export type HqAgentMood = 'working' | 'waiting' | 'blocked' | 'celebrating' | 'idle';
export type HqAmbientKind = 'needs_input' | 'error' | 'pr' | 'team_active' | 'idle_scene';

export interface HqAction {
  id: string;
  label: string;
  command: string[];
  target: {
    kind: 'agent' | 'room' | 'floor';
    id: string;
  };
  destructive?: boolean;
  input?: Array<{
    name: string;
    label: string;
    placeholder?: string;
    required?: boolean;
  }>;
}

export interface HqRoom {
  id: string;
  kind: HqRoomKind;
  name: string;
  machine?: string;
  team?: string;
  counts: {
    agents: number;
    needsInput: number;
    running: number;
    failed: number;
  };
  actions: HqAction[];
}

export interface HqAgent {
  id: string;
  label: string;
  agent: string;
  roomId: string;
  mood: HqAgentMood;
  status: string;
  activity?: string;
  preview?: string;
  machine?: string;
  team?: string;
  teammate?: string;
  sessionId?: string;
  mailboxId?: string;
  pid?: number;
  prUrl?: string;
  ticketId?: string;
  actions: HqAction[];
}

export interface HqAmbientEvent {
  id: string;
  kind: HqAmbientKind;
  roomId: string;
  agentId?: string;
  label: string;
  intensity: 'low' | 'medium' | 'high';
}

export interface HqFloorSnapshot {
  version: 1;
  generatedAt: string;
  counters: {
    rooms: number;
    agents: number;
    teams: number;
    needsInput: number;
    failed: number;
    prs: number;
  };
  rooms: HqRoom[];
  agents: HqAgent[];
  ambientEvents: HqAmbientEvent[];
  actions: HqAction[];
}

export interface BuildHqFloorInput {
  generatedAt?: Date;
  sessions: ActiveSession[];
  teams: TaskInfo[];
  teammatesByTeam: Map<string, AgentStatusDetail[]>;
  blocks: OpenBlock[];
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

function roomIdForTeam(team: string): string {
  return `team:${slug(team)}`;
}

function roomIdForMachine(machine: string): string {
  return `machine:${slug(machine)}`;
}

function agentDisplayName(session: ActiveSession): string {
  return session.name || session.label || session.agentId || session.sessionId?.slice(0, 8) || session.kind;
}

function sessionMachine(session: ActiveSession): string {
  return session.machine || session.provenance?.host || session.host || 'local';
}

function teamForSession(session: ActiveSession, teammatesById: Map<string, AgentStatusDetail & { team: string }>): string | undefined {
  if (session.teamName) return session.teamName;
  if (session.agentId && teammatesById.has(session.agentId)) return teammatesById.get(session.agentId)!.team;
  return undefined;
}

function teammateName(session: ActiveSession, teammatesById: Map<string, AgentStatusDetail & { team: string }>): string | undefined {
  if (session.agentId && teammatesById.has(session.agentId)) {
    return teammatesById.get(session.agentId)!.name || session.agentId.slice(0, 8);
  }
  return session.agentId;
}

function moodForSession(session: ActiveSession, hasOpenBlock: boolean): HqAgentMood {
  if (session.status === 'input_required' || session.activity === 'waiting_input' || hasOpenBlock) return 'waiting';
  if (session.rateLimited) return 'blocked';
  if (session.pr) return 'celebrating';
  if (session.status === 'running' || session.activity === 'working') return 'working';
  return 'idle';
}

function action(id: string, label: string, command: string[], target: HqAction['target'], extra: Omit<HqAction, 'id' | 'label' | 'command' | 'target'> = {}): HqAction {
  return { id, label, command, target, ...extra };
}

function agentActions(agentId: string, session: ActiveSession, mailboxId: string | undefined, team: string | undefined, teammate: string | undefined): HqAction[] {
  const actions: HqAction[] = [];
  if (mailboxId) {
    actions.push(action(
      `agent:${agentId}:message`,
      'Message',
      ['message', mailboxId, '{message}', '--surface', 'hq'],
      { kind: 'agent', id: agentId },
      { input: [{ name: 'message', label: 'Message', placeholder: 'What should this agent do next?', required: true }] },
    ));
    actions.push(action(
      `agent:${agentId}:stop`,
      'Stop',
      ['feed', '--kill', mailboxId],
      { kind: 'agent', id: agentId },
      { destructive: true },
    ));
  }
  if (team && teammate) {
    actions.push(action(
      `agent:${agentId}:team-stop`,
      'Stop teammate',
      ['teams', 'stop', team, teammate],
      { kind: 'agent', id: agentId },
      { destructive: true },
    ));
  }
  if (session.sessionId) {
    actions.push(action(
      `agent:${agentId}:transcript`,
      'Transcript',
      ['sessions', session.sessionId, '--markdown'],
      { kind: 'agent', id: agentId },
    ));
  }
  return actions;
}

function spawnActionForRoom(roomId: string, team: string | undefined): HqAction {
  if (team) {
    return action(
      `room:${roomId}:spawn-teammate`,
      'Spawn teammate',
      ['teams', 'add', team, '{agent}', '{task}', '--name', '{name}', '--mode', 'edit'],
      { kind: 'room', id: roomId },
      {
        input: [
          { name: 'agent', label: 'Agent', placeholder: 'claude', required: true },
          { name: 'name', label: 'Name', placeholder: 'frontend', required: true },
          { name: 'task', label: 'Task', placeholder: 'Implement the next scoped task', required: true },
        ],
      },
    );
  }
  return action(
    `room:${roomId}:spawn-run`,
    'Run agent',
    ['run', '{agent}', '{task}', '--name', '{name}'],
    { kind: 'room', id: roomId },
    {
      input: [
        { name: 'agent', label: 'Agent', placeholder: 'claude', required: true },
        { name: 'name', label: 'Name', placeholder: 'investigate', required: true },
        { name: 'task', label: 'Task', placeholder: 'Investigate this room', required: true },
      ],
    },
  );
}

export function buildHqFloor(input: BuildHqFloorInput): HqFloorSnapshot {
  const generatedAt = (input.generatedAt ?? new Date()).toISOString();
  const teammatesById = new Map<string, AgentStatusDetail & { team: string }>();
  for (const [team, teammates] of input.teammatesByTeam) {
    for (const teammate of teammates) teammatesById.set(teammate.agent_id, { ...teammate, team });
  }

  const openBlocksByMailbox = new Map<string, OpenBlock[]>();
  for (const block of input.blocks) {
    const blocks = openBlocksByMailbox.get(block.mailboxId) || [];
    blocks.push(block);
    openBlocksByMailbox.set(block.mailboxId, blocks);
  }

  const rooms = new Map<string, HqRoom>();
  const ensureRoom = (room: Omit<HqRoom, 'counts' | 'actions'>): HqRoom => {
    const existing = rooms.get(room.id);
    if (existing) return existing;
    const created: HqRoom = {
      ...room,
      counts: { agents: 0, needsInput: 0, running: 0, failed: 0 },
      actions: [spawnActionForRoom(room.id, room.team)],
    };
    rooms.set(room.id, created);
    return created;
  };

  for (const team of input.teams) {
    ensureRoom({ id: roomIdForTeam(team.task_name), kind: 'team', name: team.task_name, team: team.task_name });
  }

  const agents: HqAgent[] = [];
  for (const session of input.sessions) {
    const team = teamForSession(session, teammatesById);
    const machine = sessionMachine(session);
    const room = team
      ? ensureRoom({ id: roomIdForTeam(team), kind: 'team', name: team, team })
      : ensureRoom({ id: roomIdForMachine(machine), kind: 'machine', name: machine, machine });
    const mailboxId = mailboxIdForActiveSession(session);
    const blocks = mailboxId ? openBlocksByMailbox.get(mailboxId) || [] : [];
    const id = session.agentId || session.sessionId || `${session.kind}:${agents.length + 1}`;
    const mood = moodForSession(session, blocks.length > 0);
    const teammate = teammateName(session, teammatesById);
    room.counts.agents++;
    if (mood === 'waiting') room.counts.needsInput++;
    if (session.status === 'running') room.counts.running++;
    if (mood === 'blocked') room.counts.failed++;
    agents.push({
      id,
      label: agentDisplayName(session),
      agent: session.kind,
      roomId: room.id,
      mood,
      status: session.status,
      activity: session.activity,
      preview: session.preview || session.question?.text,
      machine,
      team,
      teammate,
      sessionId: session.sessionId,
      mailboxId,
      pid: session.pid,
      prUrl: session.pr?.url,
      ticketId: session.ticket?.id,
      actions: agentActions(id, session, mailboxId, team, teammate),
    });
  }

  const ambientEvents: HqAmbientEvent[] = [];
  for (const agent of agents) {
    if (agent.mood === 'waiting') {
      ambientEvents.push({
        id: `needs-input:${agent.id}`,
        kind: 'needs_input',
        roomId: agent.roomId,
        agentId: agent.id,
        label: `${agent.label} needs input`,
        intensity: 'high',
      });
    } else if (agent.mood === 'blocked') {
      ambientEvents.push({
        id: `blocked:${agent.id}`,
        kind: 'error',
        roomId: agent.roomId,
        agentId: agent.id,
        label: `${agent.label} is blocked`,
        intensity: 'high',
      });
    } else if (agent.mood === 'celebrating' && agent.prUrl) {
      ambientEvents.push({
        id: `pr:${agent.id}`,
        kind: 'pr',
        roomId: agent.roomId,
        agentId: agent.id,
        label: `${agent.label} opened a PR`,
        intensity: 'medium',
      });
    }
  }
  for (const room of rooms.values()) {
    if (room.kind === 'team' && room.counts.running > 0) {
      ambientEvents.push({
        id: `team-active:${room.id}`,
        kind: 'team_active',
        roomId: room.id,
        label: `${room.name} has ${room.counts.running} active teammate${room.counts.running === 1 ? '' : 's'}`,
        intensity: 'low',
      });
    }
    if (room.counts.agents > 0 && room.counts.running === 0 && room.counts.needsInput === 0) {
      ambientEvents.push({
        id: `idle:${room.id}`,
        kind: 'idle_scene',
        roomId: room.id,
        label: `${room.name} is calm`,
        intensity: 'low',
      });
    }
  }

  const floorActions = [
    action(
      'floor:create-team',
      'Create team room',
      ['teams', 'create', '{team}', '--description', '{description}'],
      { kind: 'floor', id: 'floor' },
      {
        input: [
          { name: 'team', label: 'Team', placeholder: 'release-squad', required: true },
          { name: 'description', label: 'Description', placeholder: 'What this room owns' },
        ],
      },
    ),
  ];

  const roomList = [...rooms.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'team' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    version: 1,
    generatedAt,
    counters: {
      rooms: roomList.length,
      agents: agents.length,
      teams: input.teams.length,
      needsInput: agents.filter((agent) => agent.mood === 'waiting').length,
      failed: agents.filter((agent) => agent.mood === 'blocked').length,
      prs: agents.filter((agent) => agent.prUrl).length,
    },
    rooms: roomList,
    agents,
    ambientEvents,
    actions: floorActions,
  };
}
