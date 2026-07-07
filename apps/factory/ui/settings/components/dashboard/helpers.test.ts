import { expect, test } from 'bun:test'
import { deriveApprovalStatusFromTask, formatMixFromTask, getTerminalPrompt } from './helpers'
import { TaskSummary } from '../../types'

function makeTask(overrides?: Partial<TaskSummary>): TaskSummary {
  return {
    task_name: 'task-1',
    agent_count: 2,
    status_counts: { running: 0, completed: 0, failed: 0, stopped: 0 },
    latest_activity: '2026-01-01T00:00:00.000Z',
    agents: [
      {
        agent_id: 'a1',
        agent_type: 'codex',
        status: 'running',
        duration: null,
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: null,
        prompt: 'Fix issue',
        cwd: null,
        files_created: [],
        files_modified: [],
        files_deleted: [],
        bash_commands: [],
        last_messages: [],
      },
      {
        agent_id: 'a2',
        agent_type: 'claude',
        status: 'running',
        duration: null,
        started_at: '2026-01-01T00:00:01.000Z',
        completed_at: null,
        prompt: 'Plan work',
        cwd: null,
        files_created: [],
        files_modified: [],
        files_deleted: [],
        bash_commands: [],
        last_messages: [],
      },
    ],
    ...overrides,
  }
}

test('getTerminalPrompt prefers first user message', () => {
  expect(getTerminalPrompt({
    id: 't1',
    agentType: 'claude',
    label: 'label',
    autoLabel: 'auto',
    createdAt: Date.now(),
    index: 1,
    sessionId: null,
    firstUserMessage: 'first',
    lastUserMessage: 'last',
  })).toBe('first')
})

test('getTerminalPrompt falls back through available fields', () => {
  expect(getTerminalPrompt({
    id: 't1',
    agentType: 'claude',
    label: null,
    autoLabel: 'auto',
    createdAt: Date.now(),
    index: 1,
    sessionId: null,
    lastUserMessage: 'last',
  })).toBe('last')
})

test('getTerminalPrompt returns waiting message when all are empty', () => {
  expect(getTerminalPrompt({
    id: 't1',
    agentType: 'claude',
    label: '',
    autoLabel: '',
    createdAt: Date.now(),
    index: 1,
    sessionId: null,
  })).toBe('Waiting for first message...')
})

test('deriveApprovalStatusFromTask uses explicit approval status first', () => {
  const task = makeTask({ approval_status: 'approved' })
  expect(deriveApprovalStatusFromTask(task)).toBe('approved')
})

test('deriveApprovalStatusFromTask maps running to running', () => {
  const task = makeTask({ status_counts: { running: 1, completed: 0, failed: 0, stopped: 0 } })
  expect(deriveApprovalStatusFromTask(task)).toBe('running')
})

test('formatMixFromTask returns explicit mix when present', () => {
  const task = makeTask({ mix: '70% Claude, 30% Codex' })
  expect(formatMixFromTask(task)).toBe('70% Claude, 30% Codex')
})

test('formatMixFromTask computes distribution when mix missing', () => {
  const task = makeTask({
    agent_count: 2,
    agents: [
      { ...makeTask().agents[0], agent_id: 'c1', agent_type: 'codex' },
      { ...makeTask().agents[1], agent_id: 'c2', agent_type: 'codex' },
    ],
  })
  expect(formatMixFromTask(task)).toBe('100% Codex')
})

