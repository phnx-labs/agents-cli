import { describe, it, expect } from 'vitest';
import { buildTrajectory } from './trajectory.js';
import { diffTrajectories } from './trajectory-compare.js';
import { renderTrajectoryCompareText } from './trajectory-text.js';
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

const eventsA: SessionEvent[] = [
  { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'a1', command: 'git fetch' },
  { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:02Z', tool: 'Bash', callId: 'a1', outcome: 'ok' },
  { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:03Z', tool: 'Read', callId: 'a2', args: { file_path: 'exec.ts' } },
  { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:04Z', tool: 'Read', callId: 'a2', outcome: 'ok' },
];

const eventsB: SessionEvent[] = [
  { type: 'tool_use', agent: 'codex', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'b1', command: 'git fetch' },
  { type: 'tool_result', agent: 'codex', timestamp: '2026-08-01T00:00:02Z', tool: 'Bash', callId: 'b1', outcome: 'ok' },
  { type: 'tool_use', agent: 'codex', timestamp: '2026-08-01T00:00:03Z', tool: 'Grep', callId: 'b2', args: { pattern: 'foo' } },
  { type: 'tool_result', agent: 'codex', timestamp: '2026-08-01T00:00:05Z', tool: 'Grep', callId: 'b2', outcome: 'error' },
];

describe('renderTrajectoryCompareText', () => {
  it('renders both session headers, the divergence line, and the step diff', () => {
    const a = buildTrajectory(eventsA, meta({ id: 'a', agent: 'claude' }));
    const b = buildTrajectory(eventsB, meta({ id: 'b', agent: 'codex' }));
    const text = renderTrajectoryCompareText(diffTrajectories(a, b));
    expect(text).toContain('compare: claude sess0001 vs codex sess0001');
    expect(text).toContain('diverge after step 1/1');
    expect(text).toContain('only in claude sess0001 (1):');
    expect(text).toContain('only in codex sess0001 (1):');
    expect(text).toContain('Read');
    expect(text).toContain('Grep');
    // No ANSI escapes, no box-drawing.
    expect(text).not.toMatch(/\x1b\[/);
  });

  it('states no divergence for identical tool sequences', () => {
    const a = buildTrajectory(eventsA, meta({ id: 'a' }));
    const b = buildTrajectory(eventsA, meta({ id: 'b' }));
    const text = renderTrajectoryCompareText(diffTrajectories(a, b));
    expect(text).toContain('no divergence — tool sequences match');
    expect(text).toContain('only in claude sess0001 (0): none');
  });

  it('caps the diff lines with maxDiffLines and counts the rest', () => {
    const manyEvents: SessionEvent[] = [];
    for (let i = 0; i < 20; i++) {
      manyEvents.push(
        { type: 'tool_use', agent: 'claude', timestamp: `2026-08-01T00:00:${String(i).padStart(2, '0')}Z`, tool: 'Bash', callId: `c${i}`, command: `echo ${i}` },
        { type: 'tool_result', agent: 'claude', timestamp: `2026-08-01T00:00:${String(i).padStart(2, '0')}Z`, tool: 'Bash', callId: `c${i}`, outcome: 'ok' },
      );
    }
    const a = buildTrajectory([], meta({ id: 'a' }));
    const b = buildTrajectory(manyEvents, meta({ id: 'b' }));
    const text = renderTrajectoryCompareText(diffTrajectories(a, b), { maxDiffLines: 3 });
    expect(text).toContain('… 17 more');
  });
});
