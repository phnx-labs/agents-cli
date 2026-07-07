import { describe, expect, it } from 'vitest';
import { rpcMethodFor, toRpcParams, makeVerbDispatcher } from './dispatch.js';
import type { ComputerClient, RPCResponse } from '../computer-rpc.js';

// The verb -> RPC translation in dispatch.ts is the load-bearing seam behind
// `computer run`: a single wrong param key silently breaks every gated macOS
// action, with no cross-platform CI guard. These tests pin the exact renames.
//
// rpcMethodFor / toRpcParams are pure — exercised directly, no daemon, no
// mocking of the code under test. For the target-resolution skip logic we drive
// the real makeVerbDispatcher against a recording ComputerClient; the client is
// the daemon transport boundary (a legitimate stand-in), not code under test.

describe('rpcMethodFor', () => {
  it('renames CLI verbs to their daemon RPC method names', () => {
    // Exact target method names quoted from dispatch.ts:15-24 (RPC_METHOD).
    expect(rpcMethodFor('apps')).toBe('list_apps');
    expect(rpcMethodFor('get-text')).toBe('get_text');
    expect(rpcMethodFor('type-text')).toBe('type_text');
    expect(rpcMethodFor('ax-action')).toBe('ax_action');
    expect(rpcMethodFor('right-click')).toBe('right_click');
    expect(rpcMethodFor('launch')).toBe('launch_app');
    expect(rpcMethodFor('focus')).toBe('set_focus');
    expect(rpcMethodFor('raise')).toBe('focus_window');
  });

  it('passes through verbs that share their RPC method name', () => {
    expect(rpcMethodFor('describe')).toBe('describe');
    expect(rpcMethodFor('click')).toBe('click');
    expect(rpcMethodFor('type')).toBe('type');
    // An unknown verb passes through unchanged (RPC_METHOD[verb] ?? verb).
    expect(rpcMethodFor('screenshot')).toBe('screenshot');
    expect(rpcMethodFor('key')).toBe('key');
  });
});

describe('toRpcParams', () => {
  it('injects pid only when supplied', () => {
    expect(toRpcParams('describe', {}, 42)).toEqual({ pid: 42 });
    expect(toRpcParams('describe', {})).toEqual({});
  });

  it('remaps describe depth -> max_depth', () => {
    expect(toRpcParams('describe', { depth: 3 }, 7)).toEqual({ pid: 7, max_depth: 3 });
  });

  it('remaps get-text id -> element_id and maxChars -> max_chars', () => {
    expect(toRpcParams('get-text', { id: 'e5', maxChars: 200 }, 7)).toEqual({
      pid: 7,
      element_id: 'e5',
      max_chars: 200,
    });
  });

  it('remaps click id -> element_id and passes coords/count through', () => {
    expect(toRpcParams('click', { id: 'e1', x: 10, y: 20, count: 2 }, 7)).toEqual({
      pid: 7,
      element_id: 'e1',
      x: 10,
      y: 20,
      count: 2,
    });
  });

  it('remaps launch bundle -> bundle_id, path/name pass through', () => {
    expect(toRpcParams('launch', { bundle: 'com.apple.Finder', name: 'Finder' })).toEqual({
      bundle_id: 'com.apple.Finder',
      name: 'Finder',
    });
  });

  it('remaps ax-action id -> element_id and passes action through', () => {
    expect(toRpcParams('ax-action', { id: 'e9', action: 'AXPress' }, 7)).toEqual({
      pid: 7,
      element_id: 'e9',
      action: 'AXPress',
    });
  });

  it('remaps focus id -> element_id', () => {
    expect(toRpcParams('focus', { id: 'e3' }, 7)).toEqual({ pid: 7, element_id: 'e3' });
  });

  describe('wait', () => {
    it('remaps duration -> duration_ms', () => {
      expect(toRpcParams('wait', { duration: 500 })).toEqual({ duration_ms: 500 });
    });

    it('builds a locator object from role/label/identifier', () => {
      expect(
        toRpcParams('wait', { until: 'exists', role: 'AXButton', label: 'OK', identifier: 'ok-btn' }, 7),
      ).toEqual({
        pid: 7,
        until: 'exists',
        locator: { role: 'AXButton', label: 'OK', identifier: 'ok-btn' },
      });
    });

    it('omits the locator entirely when no locator key is present', () => {
      const params = toRpcParams('wait', { until: 'exists' }, 7);
      expect(params).toEqual({ pid: 7, until: 'exists' });
      expect('locator' in params).toBe(false);
    });

    it('includes only the locator keys that are set', () => {
      expect(toRpcParams('wait', { role: 'AXButton' })).toEqual({
        locator: { role: 'AXButton' },
      });
    });
  });

  it('drops keys whose input value is null/undefined', () => {
    // copyIf only copies when input[from] != null.
    expect(toRpcParams('get-text', { id: undefined, maxChars: null }, 7)).toEqual({ pid: 7 });
  });
});

// A recording ComputerClient: captures every method invocation so we can assert
// whether the target-resolution roundtrip (`list_apps`) ran. `apps` returns a
// one-app list so resolveTargetPidDecision could pick a target if it were called.
function recordingClient(): { client: ComputerClient; calls: Array<{ method: string; params?: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const client: ComputerClient = {
    async call(method: string, params?: Record<string, unknown>): Promise<RPCResponse> {
      calls.push({ method, params });
      if (method === 'list_apps') {
        return { id: 1, result: { apps: [{ pid: 999, name: 'Finder', bundle_id: 'com.apple.Finder', active: true }] } };
      }
      return { id: 1, result: {} };
    },
  };
  return { client, calls };
}

describe('makeVerbDispatcher target resolution', () => {
  it('skips resolution for NO_TARGET verb apps (single list_apps call, no pid)', async () => {
    const { client, calls } = recordingClient();
    const dispatch = makeVerbDispatcher(client);
    const res = await dispatch({ name: 'apps', input: {} });
    expect(res.ok).toBe(true);
    // `apps` own RPC method IS list_apps; if resolution had also run we'd see a
    // SECOND list_apps call. Exactly one, with no injected pid, proves the skip.
    expect(calls).toEqual([{ method: 'list_apps', params: {} }]);
  });

  it('skips resolution for NO_TARGET verb launch (no list_apps, no pid)', async () => {
    const { client, calls } = recordingClient();
    const dispatch = makeVerbDispatcher(client);
    const res = await dispatch({ name: 'launch', input: { bundle: 'com.apple.Finder' } });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([{ method: 'launch_app', params: { bundle_id: 'com.apple.Finder' } }]);
    expect(calls.some((c) => c.method === 'list_apps')).toBe(false);
  });

  it('skips resolution for wait with a duration (no list_apps, no pid)', async () => {
    const { client, calls } = recordingClient();
    const dispatch = makeVerbDispatcher(client);
    const res = await dispatch({ name: 'wait', input: { duration: 250 } });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([{ method: 'wait', params: { duration_ms: 250 } }]);
    expect(calls.some((c) => c.method === 'list_apps')).toBe(false);
  });

  it('DOES resolve the target (list_apps first) for a non-NO_TARGET verb without a pid', async () => {
    const { client, calls } = recordingClient();
    const dispatch = makeVerbDispatcher(client);
    const res = await dispatch({ name: 'describe', input: { depth: 2 } });
    expect(res.ok).toBe(true);
    // Contrast case: resolution runs first, then the verb call carries the pid.
    expect(calls).toEqual([
      { method: 'list_apps', params: undefined },
      { method: 'describe', params: { pid: 999, max_depth: 2 } },
    ]);
  });

  it('a directly-supplied pid short-circuits resolution (no list_apps)', async () => {
    const { client, calls } = recordingClient();
    const dispatch = makeVerbDispatcher(client);
    const res = await dispatch({ name: 'describe', input: { pid: 321, depth: 1 } });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([{ method: 'describe', params: { pid: 321, max_depth: 1 } }]);
  });
});
