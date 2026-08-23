import { describe, expect, it } from 'vitest';
import type { ActiveSession } from '../session/active.js';
import { SessionWatchState } from '../session/watch.js';
import { FeedWatchState, projectSessionEnvelope } from './watch.js';

function session(id: string, extra: Partial<ActiveSession> = {}): ActiveSession {
  return { context: 'headless', kind: 'kimi', host: 'worker-a', sessionId: id, status: 'running', ...extra } as ActiveSession;
}

describe('feed watch operator projection', () => {
  it('retains peer rows while unavailable and replaces the scope on reconnect', async () => {
    const sessions = new SessionWatchState('peer-stream');
    const feed = new FeedWatchState('coordinator-stream');
    const first = await projectSessionEnvelope(sessions.reset('worker-a', [session('s1')]), feed);
    const unavailable = await projectSessionEnvelope(sessions.scope('worker-a', 'unavailable', 'ssh exited 255'), feed);
    const reconnect = await projectSessionEnvelope(sessions.reset('worker-a', [session('s1'), session('s2')]), feed);
    expect(first[0]).toMatchObject({ type: 'reset', scope: 'worker-a', agents: [{ sessionId: 's1' }] });
    expect(unavailable).toEqual([expect.objectContaining({ type: 'scope', status: 'unavailable' })]);
    expect(unavailable.some((event) => event.type === 'attention.remove')).toBe(false);
    expect(reconnect[0]).toMatchObject({ type: 'reset', agents: [{ sessionId: 's1' }, { sessionId: 's2' }] });
    expect([first[0].sequence, unavailable[0].sequence, reconnect[0].sequence]).toEqual([1, 2, 3]);
  });

  it('emits one coordinator order for agent and attention changes', async () => {
    const sessions = new SessionWatchState('peer-stream');
    sessions.reset('worker-a', []);
    const [upsert] = sessions.update('worker-a', [session('ask', {
      activity: 'waiting_input', awaitingReason: 'plan_review',
      question: { text: 'Approve the plan?', reason: 'plan_review' }, lastActivityMs: 42,
    })]);
    const projected = await projectSessionEnvelope(upsert, new FeedWatchState('coordinator'));
    expect(projected.map((event) => event.type)).toEqual(['agent.upsert', 'attention.upsert']);
    expect(projected.map((event) => event.sequence)).toEqual([1, 2]);
    expect(projected[1]).toMatchObject({ attention: { kind: 'plan_review', source: 'lifecycle' } });
  });
});
