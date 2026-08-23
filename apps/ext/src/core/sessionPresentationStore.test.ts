import { describe, expect, test } from 'bun:test';
import { SessionPresentationStore } from './sessionPresentationStore';

describe('SessionPresentationStore', () => {
  test('joins projected attention by session id and removes it on resolution', () => {
    const store = new SessionPresentationStore();
    const attention = { key: 'a1', sessionId: 's1', state: 'open', fingerprint: 'fp' };
    store.apply({ v: 1, type: 'reset', streamId: 's', sequence: 1, capturedAt: 1, scope: 'local', agents: [{ rowKey: 'r1', sessionId: 's1' }], attention: [attention] });
    expect(store.sessions()).toEqual([{ rowKey: 'r1', sessionId: 's1', attention }]);
    store.apply({ v: 1, type: 'attention.remove', streamId: 's', sequence: 2, capturedAt: 2, scope: 'local', rowKey: 'a1', resolution: { key: 'a1', state: 'answered' } });
    expect(store.sessions()).toEqual([{ rowKey: 'r1', sessionId: 's1', attention: { ...attention, state: 'answered' } }]);
    expect(store.activityEvents()).toEqual([{
      type: 'attention.receipt', key: 'a1', sessionId: 's1', question: undefined,
      source: undefined, fingerprint: 'fp', state: 'answered', resolvedAt: 2,
      resolution: { key: 'a1', state: 'answered' },
    }]);
  });
  test('projects reset/upsert/remove without deriving lifecycle state', () => {
    const store = new SessionPresentationStore();
    store.apply({ v: 1, type: 'reset', streamId: 's', sequence: 1, capturedAt: 1, scope: 'zion', agents: [{ rowKey: 'a', sourceDevice: 'zion', status: 'active' }], attention: [] });
    store.apply({ v: 1, type: 'agent.upsert', streamId: 's', sequence: 2, capturedAt: 2, scope: 'zion', rowKey: 'b', agent: { rowKey: 'b', sourceDevice: 'zion', status: 'orphaned' } });
    expect(store.sessions()).toEqual([
      { rowKey: 'a', sourceDevice: 'zion', status: 'active' },
      { rowKey: 'b', sourceDevice: 'zion', status: 'orphaned' },
    ]);
  });

  // RUSH-2670: a detached session's row has host 'tmux' (the terminal APP — the
  // bare tmux server is its only terminal) and carries its device identity in
  // sourceDevice. Mapping host into the machine slot presented the session as
  // living on a machine called "tmux", so Attach's host === local filter never
  // matched and "Agents: Attach" always reported no backgrounded agents.
  test('presents a detached local row (host: tmux) under the local label, not "tmux"', () => {
    const store = new SessionPresentationStore();
    store.apply({
      v: 1, type: 'reset', streamId: 's', sequence: 1, capturedAt: 1, scope: 'zion', attention: [],
      agents: [{
        rowKey: 'bg', sessionId: '2d29e6ac-7d5b-4bcc-91d1-8efc0818dbb3', kind: 'claude',
        host: 'tmux', sourceDevice: 'zion', status: 'closed', presence: 'background', context: 'terminal',
      }],
    });
    const presented = store.presentedSessions('zion', 'this-mac');
    expect(presented).toHaveLength(1);
    expect(presented[0]?.host).toBe('this-mac');
    expect(presented[0]?.presence).toBe('background');
  });

  test('presents an offloaded row under its machine, not its terminal app', () => {
    const store = new SessionPresentationStore();
    store.apply({
      v: 1, type: 'reset', streamId: 's', sequence: 1, capturedAt: 1, scope: 'zion', attention: [],
      agents: [{
        rowKey: 'r', sessionId: 'abcd1234-0000-0000-0000-000000000000', kind: 'claude',
        host: 'tmux', machine: 'yosemite-s1', sourceDevice: 'zion', status: 'running', context: 'terminal',
      }],
    });
    expect(store.presentedSessions('zion', 'this-mac')[0]?.host).toBe('yosemite-s1');
  });

  test('orders each stream independently and resets only its scope', () => {
    const store = new SessionPresentationStore();
    store.apply({ v: 1, type: 'reset', streamId: 'a', sequence: 5, capturedAt: 1, scope: 'zion', agents: [{ rowKey: 'z', sourceDevice: 'zion' }], attention: [] });
    store.apply({ v: 1, type: 'reset', streamId: 'b', sequence: 1, capturedAt: 1, scope: 'yosemite-s1', agents: [{ rowKey: 'y', sourceDevice: 'yosemite-s1' }], attention: [] });
    expect(store.apply({ v: 1, type: 'attention.remove', streamId: 'a', sequence: 4, capturedAt: 2, scope: 'zion', rowKey: 'z' })).toBe(false);
    expect(store.sessions()).toEqual([{ rowKey: 'z', sourceDevice: 'zion' }, { rowKey: 'y', sourceDevice: 'yosemite-s1' }]);
  });

  test('a reset retains projected attention owned by another scope', () => {
    const store = new SessionPresentationStore();
    const remoteAttention = { key: 'remote-attention', sessionId: 'remote-session', state: 'open' };
    store.apply({ v: 1, type: 'reset', streamId: 'remote', sequence: 1, capturedAt: 1, scope: 'remote', agents: [{ rowKey: 'remote-row', sessionId: 'remote-session', sourceDevice: 'remote' }], attention: [remoteAttention] });
    store.apply({ v: 1, type: 'reset', streamId: 'local', sequence: 1, capturedAt: 2, scope: 'local', agents: [{ rowKey: 'local-row', sessionId: 'local-session', sourceDevice: 'local' }], attention: [] });
    expect(store.sessions()).toContainEqual({ rowKey: 'remote-row', sessionId: 'remote-session', sourceDevice: 'remote', attention: remoteAttention });
  });

  test('liveSession returns machine + topic for a --device auto tab that never recorded its host', () => {
    const store = new SessionPresentationStore();
    store.apply({
      v: 1, type: 'reset', streamId: 's', sequence: 1, capturedAt: 1, scope: 'yosemite-s1', attention: [],
      agents: [{
        rowKey: 'r',
        sessionId: '022fe0a8-7674-402a-a5e0-248195894663',
        kind: 'claude',
        host: 'tmux',
        machine: 'yosemite-s1',
        topic: 'Compact the PageHeader across every page',
        label: '',
        cwd: '/home/muqsit/src/github.com/muqsitnawaz/svatlas',
        sourceDevice: 'yosemite-s1',
        status: 'running',
        context: 'terminal',
      }],
    });
    expect(store.liveSession('022fe0a8-7674-402a-a5e0-248195894663')).toEqual({
      machine: 'yosemite-s1',
      topic: 'Compact the PageHeader across every page',
      label: '',
      cwd: '/home/muqsit/src/github.com/muqsitnawaz/svatlas',
    });
    expect(store.liveSession('missing')).toBeUndefined();
  });
});
