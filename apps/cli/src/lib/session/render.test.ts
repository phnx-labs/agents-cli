import { describe, it, expect } from 'vitest';
import { renderJson } from './render.js';
import type { SessionEvent, SessionMeta } from './types.js';

describe('renderJson single-session output shape', () => {
  const events: SessionEvent[] = [
    { type: 'message', agent: 'claude', timestamp: '2026-06-24T00:00:00Z', role: 'user', content: 'plan it' },
    { type: 'tool_use', agent: 'claude', timestamp: '2026-06-24T00:00:01Z', tool: 'ExitPlanMode', args: { plan: '# Plan\n\n1. Step one' } },
  ];

  it('with no meta: emits a bare SessionEvent array (legacy shape)', () => {
    const out = JSON.parse(renderJson(events));
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(2);
    expect(out[0].content).toBe('plan it');
  });

  it('with meta: emits { session, events } and surfaces meta.plan at top level', () => {
    const meta: SessionMeta = {
      id: 'abc-123',
      shortId: 'abc-1234',
      agent: 'claude',
      timestamp: '2026-06-24T00:00:00Z',
      filePath: '/tmp/session.jsonl',
      plan: '# Plan\n\n1. Step one',
    };
    const parsed = JSON.parse(renderJson(events, meta));
    expect(parsed).toHaveProperty('session');
    expect(parsed).toHaveProperty('events');
    expect(parsed.session.plan).toBe('# Plan\n\n1. Step one');
    expect(parsed.session.id).toBe('abc-123');
    expect(Array.isArray(parsed.events)).toBe(true);
    expect(parsed.events).toHaveLength(2);
  });

  it('surfaces meta.todos (checklist progress) at session top level (RUSH-1503)', () => {
    const meta: SessionMeta = {
      id: 'abc-123',
      shortId: 'abc-1234',
      agent: 'claude',
      timestamp: '2026-06-24T00:00:00Z',
      filePath: '/tmp/session.jsonl',
      todos: {
        items: [
          { content: 'Step one', status: 'completed' },
          { content: 'Step two', status: 'in_progress', activeForm: 'Doing step two' },
        ],
        done: 1,
        total: 2,
        activeForm: 'Doing step two',
      },
    };
    const parsed = JSON.parse(renderJson(events, meta));
    expect(parsed.session.todos.done).toBe(1);
    expect(parsed.session.todos.total).toBe(2);
    expect(parsed.session.todos.items).toHaveLength(2);
    expect(parsed.session.todos.items[1].content).toBe('Step two');
  });

  it('strips internal bookkeeping fields (_matchedTerms/_bm25Score/_remote) from session', () => {
    const meta: SessionMeta = {
      id: 'abc-123',
      shortId: 'abc-1234',
      agent: 'claude',
      timestamp: '2026-06-24T00:00:00Z',
      filePath: '/tmp/session.jsonl',
      _matchedTerms: ['plan'],
      _bm25Score: 1.5,
      _remote: true,
    } as SessionMeta;
    const parsed = JSON.parse(renderJson(events, meta));
    expect(parsed.session._matchedTerms).toBeUndefined();
    expect(parsed.session._bm25Score).toBeUndefined();
    expect(parsed.session._remote).toBeUndefined();
  });
});
