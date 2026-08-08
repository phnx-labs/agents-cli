import { describe, expect, test } from 'bun:test';
import { canonicalSessionId } from './canonicalSessionId';
import { needsSessionIdHydrate } from './sessionIdHydrate';
import {
  hydrateRemoteTabTick,
  planActiveMapHydration,
  type RemoteAutoLabelHooks,
  type RemoteAutoLabelTab,
} from './remoteAutoLabel';

const deps = {
  needsHydrate: needsSessionIdHydrate,
  canonical: (raw: string) => canonicalSessionId(raw) ?? '',
};

const UUID = '11111111-2222-3333-4444-555555555555';
const UUID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const UUID_C = '99999999-8888-7777-6666-555555555555';

describe('planActiveMapHydration', () => {
  test('empty active map plans nothing (post-launch indexing race)', () => {
    const tabs: RemoteAutoLabelTab[] = [{ id: 'CX1', host: 'yosemite-m1', sessionId: undefined }];
    expect(planActiveMapHydration(new Map(), tabs, deps)).toEqual([]);
  });

  test('resolves an idless tab to its canonical UUID once the map maps it', () => {
    const tabs: RemoteAutoLabelTab[] = [{ id: 'CX1', host: 'yosemite-m1', sessionId: undefined }];
    const map = new Map([['CX1', UUID]]);
    expect(planActiveMapHydration(map, tabs, deps)).toEqual([{ id: 'CX1', canonicalId: UUID }]);
  });

  test('every sibling on the host is planned from the one fetch', () => {
    const tabs: RemoteAutoLabelTab[] = [
      { id: 'CX1', host: 'yosemite-m1', sessionId: undefined },
      { id: 'CX2', host: 'yosemite-m1', sessionId: undefined },
      { id: 'CX3', host: 'yosemite-m1', sessionId: undefined },
    ];
    const map = new Map([['CX1', UUID], ['CX2', UUID_B], ['CX3', UUID_C]]);
    expect(planActiveMapHydration(map, tabs, deps)).toEqual([
      { id: 'CX1', canonicalId: UUID },
      { id: 'CX2', canonicalId: UUID_B },
      { id: 'CX3', canonicalId: UUID_C },
    ]);
  });

  test('a tab that already holds its canonical id is left alone (local Codex/Claude)', () => {
    const tabs: RemoteAutoLabelTab[] = [{ id: 'CX1', host: 'yosemite-m1', sessionId: UUID }];
    // Even if the map still lists it, needsHydrate is false so it is not re-planned.
    expect(planActiveMapHydration(new Map([['CX1', UUID]]), tabs, deps)).toEqual([]);
  });

  test('a clean but stale UUID is replaced by the terminal-id map', () => {
    const tabs: RemoteAutoLabelTab[] = [{ id: 'CX1', host: 'yosemite-m1', sessionId: UUID }];
    expect(planActiveMapHydration(new Map([['CX1', UUID_B]]), tabs, deps)).toEqual([
      { id: 'CX1', canonicalId: UUID_B },
    ]);
  });

  test('a dirty Codex rollout stem is canonicalized to its UUID', () => {
    const stem = `rollout-2026-08-07T10-00-00-${UUID}.jsonl`;
    const tabs: RemoteAutoLabelTab[] = [{ id: 'CX1', host: 'yosemite-m1', sessionId: stem }];
    const map = new Map([['CX1', stem]]);
    expect(planActiveMapHydration(map, tabs, deps)).toEqual([{ id: 'CX1', canonicalId: UUID }]);
  });

  test('a map entry that canonicalizes to nothing is skipped, never stamped wrong', () => {
    const tabs: RemoteAutoLabelTab[] = [{ id: 'CX1', host: 'yosemite-m1', sessionId: undefined }];
    expect(planActiveMapHydration(new Map([['CX1', '   ']]), tabs, deps)).toEqual([]);
  });
});

/** A tiny in-memory tab store to observe stamp/arm/label side-effects. */
function makeHooks(
  fetchMapSeq: Array<Map<string, string>>,
  initial: RemoteAutoLabelTab[],
): {
  hooks: RemoteAutoLabelHooks;
  armed: string[];
  labelCalls: string[];
  tabs: Map<string, RemoteAutoLabelTab>;
} {
  const tabs = new Map(initial.map((t) => [t.id, { ...t }]));
  const armed: string[] = [];
  const labelCalls: string[] = [];
  let fetchIdx = 0;
  const hooks: RemoteAutoLabelHooks = {
    fetchMap: async () => fetchMapSeq[Math.min(fetchIdx++, fetchMapSeq.length - 1)] ?? new Map(),
    needsHydrate: needsSessionIdHydrate,
    canonical: (raw) => canonicalSessionId(raw) ?? '',
    siblings: () => Array.from(tabs.values()).map((t) => ({ ...t })),
    onHydrated: (tabId, canonicalId) => {
      const t = tabs.get(tabId);
      if (t) t.sessionId = canonicalId; // stamp (mirrors terminals.setSessionId + applyHydratedSessionId)
      armed.push(tabId); // arm labeling (mirrors startAutoLabelPollerForTerminal)
    },
    currentSessionId: (tabId) => tabs.get(tabId)?.sessionId,
    fetchLabel: async (tabId) => {
      labelCalls.push(tabId);
      return 'RUSH-2411 auto-label picked-host Codex';
    },
  };
  return { hooks, armed, labelCalls, tabs };
}

describe('hydrateRemoteTabTick', () => {
  test('idless picked-host Codex: empty map first tick, then UUID -> label without a focus change', async () => {
    const { hooks, armed, labelCalls, tabs } = makeHooks(
      [new Map(), new Map([['CX1', UUID]])],
      [{ id: 'CX1', host: 'yosemite-m1', sessionId: undefined }],
    );

    // Tick 1: the remote session is not indexed yet -> no id, no label, no arm.
    const first = await hydrateRemoteTabTick('CX1', 'yosemite-m1', hooks);
    expect(first.hydratedIds).toEqual([]);
    expect(first.label).toBeUndefined();
    expect(armed).toEqual([]);
    expect(labelCalls).toEqual([]);
    expect(tabs.get('CX1')?.sessionId).toBeUndefined();

    // Tick 2: the shared active map now resolves the terminal id to the UUID.
    const second = await hydrateRemoteTabTick('CX1', 'yosemite-m1', hooks);
    expect(second.hydratedIds).toEqual(['CX1']);
    expect(tabs.get('CX1')?.sessionId).toBe(UUID); // canonical UUID stamped
    expect(armed).toEqual(['CX1']); // labeling armed on the id transition
    expect(labelCalls).toEqual(['CX1']); // label path ran, same tick, no refocus
    expect(second.label).toBe('RUSH-2411 auto-label picked-host Codex');
  });

  test('multiple tabs on one host share the fetch and each arm labeling', async () => {
    const { hooks, armed, labelCalls, tabs } = makeHooks(
      [new Map([['CX1', UUID], ['CX2', UUID_B], ['CX3', UUID_C]])],
      [
        { id: 'CX1', host: 'yosemite-m1', sessionId: undefined },
        { id: 'CX2', host: 'yosemite-m1', sessionId: undefined },
        { id: 'CX3', host: 'yosemite-m1', sessionId: undefined },
      ],
    );

    const res = await hydrateRemoteTabTick('CX1', 'yosemite-m1', hooks);
    // One fetch stamped + armed all three tabs sharing the host map.
    expect(res.hydratedIds.sort()).toEqual(['CX1', 'CX2', 'CX3']);
    expect(armed.sort()).toEqual(['CX1', 'CX2', 'CX3']);
    expect(tabs.get('CX1')?.sessionId).toBe(UUID);
    expect(tabs.get('CX2')?.sessionId).toBe(UUID_B);
    expect(tabs.get('CX3')?.sessionId).toBe(UUID_C);
    // Only the polled tab fetches its label this tick; siblings label from their
    // own armed pollers.
    expect(labelCalls).toEqual(['CX1']);
  });

  test('siblings on a different host are not touched by this host fetch', async () => {
    const { hooks, armed, tabs } = makeHooks(
      [new Map([['CX1', UUID], ['CX9', UUID_C]])],
      [
        { id: 'CX1', host: 'yosemite-m1', sessionId: undefined },
        { id: 'CX9', host: 'yosemite-m2', sessionId: undefined },
      ],
    );

    await hydrateRemoteTabTick('CX1', 'yosemite-m1', hooks);
    expect(armed).toEqual(['CX1']);
    expect(tabs.get('CX9')?.sessionId).toBeUndefined(); // other host untouched
  });

  test('local/already-identified tab is not re-hydrated (regression guard)', async () => {
    const { hooks, armed, labelCalls } = makeHooks(
      [new Map([['CX1', UUID]])],
      [{ id: 'CX1', host: 'yosemite-m1', sessionId: UUID }],
    );

    const res = await hydrateRemoteTabTick('CX1', 'yosemite-m1', hooks);
    // Already canonical -> nothing re-armed; label path still runs since it has an id.
    expect(res.hydratedIds).toEqual([]);
    expect(armed).toEqual([]);
    expect(labelCalls).toEqual(['CX1']);
  });
});
