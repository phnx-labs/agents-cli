import { describe, it, expect } from 'vitest';
import { buildTrajectory } from './trajectory.js';
import { diffTrajectories } from './trajectory-compare.js';
import type { SessionEvent, SessionMeta } from './types.js';

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'sess-0001',
    shortId: 'sess0001',
    agent: 'claude',
    timestamp: '2026-08-01T00:00:00Z',
    filePath: '/tmp/sess.jsonl',
    ...overrides,
  };
}

function toolEvent(tool: string, ts: string, callId: string, outcome: 'ok' | 'error' = 'ok'): SessionEvent[] {
  return [
    { type: 'tool_use', agent: 'claude', timestamp: ts, tool, callId, args: {} },
    { type: 'tool_result', agent: 'claude', timestamp: ts, tool, callId, outcome },
  ];
}

describe('diffTrajectories', () => {
  it('reports no divergence for two identical tool sequences', () => {
    const events: SessionEvent[] = [
      ...toolEvent('Bash', '2026-08-01T00:00:00Z', 'a1'),
      ...toolEvent('Read', '2026-08-01T00:00:05Z', 'a2'),
      ...toolEvent('Edit', '2026-08-01T00:00:10Z', 'a3'),
    ];
    const a = buildTrajectory(events, meta({ id: 'a' }));
    const b = buildTrajectory(events, meta({ id: 'b' }));
    const cmp = diffTrajectories(a, b);
    expect(cmp.divergence).toBeUndefined();
    expect(cmp.added).toHaveLength(0);
    expect(cmp.removed).toHaveLength(0);
  });

  it('finds the first divergence point where the tool sequences split', () => {
    // Claude: Bash, Read, Edit. Codex: Bash, Bash, Bash (retries), Edit.
    const eventsA: SessionEvent[] = [
      ...toolEvent('Bash', '2026-08-01T00:00:00Z', 'a1'),
      ...toolEvent('Read', '2026-08-01T00:00:05Z', 'a2'),
      ...toolEvent('Edit', '2026-08-01T00:00:10Z', 'a3'),
    ];
    const eventsB: SessionEvent[] = [
      ...toolEvent('Bash', '2026-08-01T00:00:00Z', 'b1'),
      ...toolEvent('Bash', '2026-08-01T00:00:05Z', 'b2', 'error'),
      ...toolEvent('Bash', '2026-08-01T00:00:10Z', 'b3', 'error'),
      ...toolEvent('Edit', '2026-08-01T00:00:15Z', 'b4'),
    ];
    const a = buildTrajectory(eventsA, meta({ id: 'a' }));
    const b = buildTrajectory(eventsB, meta({ id: 'b' }));
    const cmp = diffTrajectories(a, b);

    expect(cmp.divergence).toBeDefined();
    // Both agree on step 1 (Bash), so divergence starts after ordinal 1 on each side.
    expect(cmp.divergence!.afterOrdinalA).toBe(1);
    expect(cmp.divergence!.afterOrdinalB).toBe(1);
    // 'a' has Read with no counterpart in 'b' -> removed.
    expect(cmp.removed.some((s) => s.tool === 'Read')).toBe(true);
    // 'b' has two extra Bash retries with no counterpart in 'a' -> added.
    const addedBash = cmp.added.filter((s) => s.tool === 'Bash');
    expect(addedBash.length).toBe(2);
  });

  it('treats every step as added when the first session has no tool steps', () => {
    const a = buildTrajectory([], meta({ id: 'a' }));
    const eventsB: SessionEvent[] = [...toolEvent('Bash', '2026-08-01T00:00:00Z', 'b1')];
    const b = buildTrajectory(eventsB, meta({ id: 'b' }));
    const cmp = diffTrajectories(a, b);
    expect(cmp.removed).toHaveLength(0);
    expect(cmp.added).toHaveLength(1);
    expect(cmp.divergence!.afterOrdinalA).toBe(0);
    expect(cmp.divergence!.afterOrdinalB).toBe(0);
  });

  it('computes per-session summaries independent of the diff', () => {
    const eventsA: SessionEvent[] = [
      ...toolEvent('Bash', '2026-08-01T00:00:00Z', 'a1'),
      ...toolEvent('Bash', '2026-08-01T00:00:05Z', 'a2', 'error'),
    ];
    const eventsB: SessionEvent[] = [...toolEvent('Read', '2026-08-01T00:00:00Z', 'b1')];
    const a = buildTrajectory(eventsA, meta({ id: 'a' }));
    const b = buildTrajectory(eventsB, meta({ id: 'b' }));
    const cmp = diffTrajectories(a, b);
    expect(cmp.summaryA.toolCount).toBe(2);
    expect(cmp.summaryA.errorCount).toBe(1);
    expect(cmp.summaryB.toolCount).toBe(1);
    expect(cmp.summaryB.errorCount).toBe(0);
    expect(cmp.summaryA.session.id).toBe('a');
    expect(cmp.summaryB.session.id).toBe('b');
  });

  it('caps the diff computation with maxDiffSteps and reports truncation, never a crash', () => {
    const manyEvents: SessionEvent[] = [];
    for (let i = 0; i < 20; i++) {
      manyEvents.push(...toolEvent('Bash', `2026-08-01T00:00:${String(i).padStart(2, '0')}Z`, `c${i}`));
    }
    const a = buildTrajectory(manyEvents, meta({ id: 'a' }));
    const b = buildTrajectory(manyEvents, meta({ id: 'b' }));
    const cmp = diffTrajectories(a, b, { maxDiffSteps: 5 });
    expect(cmp.truncatedA).toBe(15);
    expect(cmp.truncatedB).toBe(15);
    expect(cmp.divergence).toBeUndefined();
  });
});
