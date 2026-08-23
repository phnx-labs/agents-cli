import { afterEach, describe, expect, test } from 'bun:test';
import { activeMapCacheKey, fetchTerminalIdSessionMap, needsSessionIdHydrate, resolveSessionIdForTerminal } from './sessionIdHydrate';
import { sessionPresentationStore } from './sessionPresentationStore';

afterEach(() => sessionPresentationStore.clear());

describe('session id hydration from the canonical CLI stream', () => {
  test('maps terminal ids without launching another agents sessions query', async () => {
    sessionPresentationStore.apply({
      v: 1,
      type: 'reset',
      streamId: 'stream-a', sequence: 1, capturedAt: 1, scope: 'box-a',
      agents: [{ rowKey: 'one', sourceDevice: 'box-a', sessionId: 'session-1', terminalId: 'CX-1', machine: 'box-a' }], attention: [],
    });
    expect(await fetchTerminalIdSessionMap('box-a')).toEqual(new Map([['CX-1', 'session-1']]));
    expect(await resolveSessionIdForTerminal('CX-1', 'box-a')).toBe('session-1');
  });

  test('scopes remote rows by host', async () => {
    sessionPresentationStore.apply({
      v: 1,
      type: 'reset',
      streamId: 'stream-b', sequence: 1, capturedAt: 1, scope: 'fleet',
      agents: [
        { rowKey: 'one', sourceDevice: 'box-a', sessionId: 'one', terminalId: 'T-1', machine: 'box-a' },
        { rowKey: 'two', sourceDevice: 'box-b', sessionId: 'two', terminalId: 'T-2', machine: 'box-b' },
      ], attention: [],
    });
    expect(await fetchTerminalIdSessionMap('box-a')).toEqual(new Map([['T-1', 'one']]));
  });
});

describe('session id hydration helpers', () => {
  test('same-machine placement collapses to the local key', () => {
    expect(activeMapCacheKey('zion.tailnet', 'zion', 'zion')).toBe('__local__');
  });
  test('dirty or absent ids still need hydration', () => {
    expect(needsSessionIdHydrate(undefined)).toBe(true);
    expect(needsSessionIdHydrate('rollout-2026-session')).toBe(true);
  });
});
