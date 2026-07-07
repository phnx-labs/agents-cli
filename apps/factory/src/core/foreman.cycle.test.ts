import { test, expect } from 'bun:test';
import { summarizeCycle } from './foreman.cycle';
import type { UnifiedTask, CycleInfo } from './tasks';

const task = (over: Partial<UnifiedTask> & { id: string }): UnifiedTask => ({
  id: over.id,
  source: 'linear',
  title: over.title ?? `Task ${over.id}`,
  status: over.status ?? 'todo',
  priority: over.priority,
  metadata: { identifier: over.id, ...(over.metadata ?? {}) },
  ...over,
});

test('empty task list with no cycle', () => {
  const r = summarizeCycle([], null);
  expect(r.cycle_name).toBeNull();
  expect(r.cycle_days_left).toBeNull();
  expect(r.total).toBe(0);
  expect(r.top).toHaveLength(0);
});

test('counts split by status and priority', () => {
  const r = summarizeCycle(
    [
      task({ id: 'R-1', status: 'todo', priority: 'urgent' }),
      task({ id: 'R-2', status: 'todo', priority: 'high' }),
      task({ id: 'R-3', status: 'in_progress', priority: 'medium' }),
      task({ id: 'R-4', status: 'done', priority: 'urgent' }),
    ],
    null
  );
  expect(r.total).toBe(4);
  expect(r.todo).toBe(2);
  expect(r.in_progress).toBe(1);
  expect(r.done).toBe(1);
  expect(r.urgent).toBe(2);
  expect(r.high).toBe(1);
});

test('top excludes done and ranks urgent before high', () => {
  const r = summarizeCycle(
    [
      task({ id: 'R-low', status: 'todo', priority: 'low' }),
      task({ id: 'R-urg', status: 'todo', priority: 'urgent' }),
      task({ id: 'R-done', status: 'done', priority: 'urgent' }),
      task({ id: 'R-hi', status: 'todo', priority: 'high' }),
    ],
    null
  );
  expect(r.top.map((t) => t.id)).toEqual(['R-urg', 'R-hi', 'R-low']);
});

test('top prefers in_progress over todo at same priority', () => {
  const r = summarizeCycle(
    [
      task({ id: 'R-td', status: 'todo', priority: 'high' }),
      task({ id: 'R-ip', status: 'in_progress', priority: 'high' }),
    ],
    null
  );
  expect(r.top[0].id).toBe('R-ip');
  expect(r.top[1].id).toBe('R-td');
});

test('top caps at 5 items', () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    task({ id: `R-${i}`, status: 'todo', priority: 'medium' })
  );
  const r = summarizeCycle(many, null);
  expect(r.top).toHaveLength(5);
});

test('cycle days_left rounds up and clamps to zero when past end', () => {
  const now = Date.now();
  const future: CycleInfo = {
    name: 'Q2W4',
    startsAt: new Date(now - 86_400_000).toISOString(),
    endsAt: new Date(now + 2.4 * 86_400_000).toISOString(),
  };
  expect(summarizeCycle([], future).cycle_days_left).toBe(3);

  const past: CycleInfo = {
    name: 'Q1W1',
    startsAt: new Date(now - 10 * 86_400_000).toISOString(),
    endsAt: new Date(now - 86_400_000).toISOString(),
  };
  expect(summarizeCycle([], past).cycle_days_left).toBe(0);
});

test('top entry carries identifier, priority, status, assignee', () => {
  const r = summarizeCycle(
    [
      task({
        id: 'internal-id',
        status: 'in_progress',
        priority: 'urgent',
        title: 'Fix auth',
        metadata: { identifier: 'RUSH-545', assignee: 'Muqsit' },
      }),
    ],
    null
  );
  expect(r.top[0]).toEqual({
    id: 'RUSH-545',
    title: 'Fix auth',
    priority: 'urgent',
    status: 'in_progress',
    assignee: 'Muqsit',
  });
});
