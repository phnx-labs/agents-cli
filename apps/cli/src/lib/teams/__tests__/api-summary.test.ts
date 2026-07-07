/**
 * Pins the compact summary contract that the default `agents teams status`
 * relies on. If this test breaks, double-check that orchestrators don't
 * depend on field names being present.
 */
import { describe, expect, it } from 'vitest';
import {
  toAgentStatusSummary,
  toTaskStatusSummary,
  type AgentStatusDetail,
  type TaskStatusResult,
} from '../api.js';

const longPrompt = 'PROMPT '.repeat(500); // ~3.5 KB synthetic brief

const fakeDetail = (overrides: Partial<AgentStatusDetail> = {}): AgentStatusDetail => ({
  agent_id: '11111111-2222-3333-4444-555555555555',
  agent_type: 'claude',
  status: 'running',
  prompt: longPrompt,
  started_at: '2026-06-08T00:00:00.000Z',
  completed_at: null,
  duration: '5 minutes',
  files_created: [
    '/Users/me/repo/src/foo/a.ts',
    '/Users/me/repo/src/bar/b.ts',
  ],
  files_modified: [
    '/Users/me/repo/src/x/m1.ts',
    '/Users/me/repo/src/x/m2.ts',
    '/Users/me/repo/src/y/m3.ts',
    '/Users/me/repo/src/y/m4.ts',
    '/Users/me/repo/src/z/m5.ts',
    '/Users/me/repo/src/z/m6.ts',
    '/Users/me/repo/src/z/m7.ts',     // 7th — beyond the cap
  ],
  files_read: Array.from({ length: 47 }, (_, i) => `/Users/me/repo/src/r${i}.ts`),
  files_deleted: [],
  bash_commands: ['ls', 'pwd', 'git status'],
  recent_tool_calls: [],
  last_messages: [
    'msg1 short',
    'msg2 short',
    'msg3 short',
    'msg4 short',
    'msg5: ' + 'X'.repeat(800),       // beyond per-msg cap
  ],
  tool_count: 42,
  has_errors: false,
  cursor: '2026-06-08T00:05:00.000Z',
  mode: 'edit',
  pr_url: 'https://github.com/example/repo/pull/1',
  name: 'alice',
  after: [],
  ...overrides,
});

describe('toAgentStatusSummary', () => {
  it('drops the prompt entirely', () => {
    const summary = toAgentStatusSummary(fakeDetail());
    expect(summary).not.toHaveProperty('prompt');
    // Cheap upper-bound size check — if we accidentally re-attach the brief,
    // this assertion blows the budget.
    expect(JSON.stringify(summary).length).toBeLessThan(2000);
  });

  it('folds file lists to basenames with exact counts', () => {
    const summary = toAgentStatusSummary(fakeDetail());
    expect(summary.files.modified.count).toBe(7);
    expect(summary.files.modified.names).toEqual([
      'm1.ts', 'm2.ts', 'm3.ts', 'm4.ts', 'm5.ts', 'm6.ts',
    ]);
    expect(summary.files.created.count).toBe(2);
    expect(summary.files.created.names).toEqual(['a.ts', 'b.ts']);
  });

  it('reports files_read as a count only', () => {
    const summary = toAgentStatusSummary(fakeDetail());
    expect(summary.files.read).toEqual({ count: 47 });
    // Field shape must not leak names — orchestrators rely on this for budget.
    expect(summary.files.read).not.toHaveProperty('names');
  });

  it('keeps the last 3 messages and trims each body', () => {
    const summary = toAgentStatusSummary(fakeDetail());
    expect(summary.last_messages).toHaveLength(3);
    expect(summary.last_messages[0]).toBe('msg3 short');
    expect(summary.last_messages[1]).toBe('msg4 short');
    // 5th original msg was 'msg5: ' + 800 Xs → trimmed to 400 chars with ellipsis.
    expect(summary.last_messages[2].length).toBeLessThanOrEqual(400);
    expect(summary.last_messages[2].endsWith('…')).toBe(true);
  });

  it('passes through identity, status, duration, tool_count, has_errors, pr_url', () => {
    const summary = toAgentStatusSummary(fakeDetail());
    expect(summary.agent_id).toBe('11111111-2222-3333-4444-555555555555');
    expect(summary.name).toBe('alice');
    expect(summary.agent_type).toBe('claude');
    expect(summary.status).toBe('running');
    expect(summary.duration).toBe('5 minutes');
    expect(summary.tool_count).toBe(42);
    expect(summary.has_errors).toBe(false);
    expect(summary.pr_url).toBe('https://github.com/example/repo/pull/1');
  });

  it('cuts at least 5x compared to the verbose detail it was projected from', () => {
    const detail = fakeDetail();
    const summary = toAgentStatusSummary(detail);
    const detailBytes = JSON.stringify(detail).length;
    const summaryBytes = JSON.stringify(summary).length;
    // Real-world prompts run 5-20 KB; this fixture's 3.5 KB prompt yields
    // roughly 7x. The 5x floor is a regression guard, not a goal.
    expect(summaryBytes * 5).toBeLessThan(detailBytes);
  });
});

describe('toTaskStatusSummary', () => {
  it('maps every agent through toAgentStatusSummary and preserves the envelope', () => {
    const result: TaskStatusResult = {
      task_name: 'caps-driven-sync',
      agents: [fakeDetail({ name: 'alice' }), fakeDetail({ name: 'bob' })],
      summary: { pending: 0, running: 1, completed: 1, failed: 0, stopped: 0 },
      cursor: '2026-06-08T00:10:00.000Z',
    };
    const compact = toTaskStatusSummary(result);
    expect(compact.task_name).toBe('caps-driven-sync');
    expect(compact.summary).toEqual(result.summary);
    expect(compact.cursor).toBe(result.cursor);
    expect(compact.agents).toHaveLength(2);
    expect(compact.agents.map((a) => a.name)).toEqual(['alice', 'bob']);
    // Total envelope must stay small even with several teammates.
    expect(JSON.stringify(compact).length).toBeLessThan(5000);
  });

  it('preserves order from the verbose result', () => {
    const result: TaskStatusResult = {
      task_name: 't',
      agents: [
        fakeDetail({ name: 'a' }),
        fakeDetail({ name: 'b' }),
        fakeDetail({ name: 'c' }),
      ],
      summary: { pending: 0, running: 0, completed: 3, failed: 0, stopped: 0 },
      cursor: 'x',
    };
    expect(toTaskStatusSummary(result).agents.map((a) => a.name)).toEqual(['a', 'b', 'c']);
  });
});
