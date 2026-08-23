import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildTrajectory } from './trajectory.js';
import { parseSession } from './parse.js';
import type { SessionEvent, SessionMeta } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

describe('buildTrajectory — durations by callId pairing', () => {
  it('measures a paired tool_use→tool_result span, not estimated', () => {
    const events: SessionEvent[] = [
      { type: 'message', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', role: 'user', content: 'go' },
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:02Z', tool: 'Bash', callId: 'c1', command: 'bun test' },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:08:06Z', tool: 'Bash', callId: 'c1', outcome: 'error', exitCode: 1, output: '2 failing' },
    ];
    const t = buildTrajectory(events, meta());
    const step = t.steps.find((s) => s.tool === 'Bash')!;
    expect(step.durationMs).toBe(8 * 60_000 + 4_000); // 08:06 − 00:02 = 8m04s
    expect(step.durationEstimated).toBe(false);
    expect(step.outcome).toBe('error');
    expect(step.startMs).toBe(2_000); // 2s after the first event
  });

  it('falls back to next-event delta with durationEstimated when no result is paired', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Read', callId: 'r1', args: { file_path: 'a.ts' } },
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:05Z', tool: 'Edit', callId: 'e1', args: { file_path: 'a.ts' } },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:06Z', tool: 'Edit', callId: 'e1', outcome: 'ok' },
    ];
    const read = t(events).steps.find((s) => s.tool === 'Read')!;
    expect(read.durationEstimated).toBe(true);
    expect(read.durationMs).toBe(5_000); // delta to the next event
    const edit = t(events).steps.find((s) => s.tool === 'Edit')!;
    expect(edit.durationEstimated).toBe(false);
    expect(edit.durationMs).toBe(1_000);
  });

  it('never pairs concurrent same-tool calls by arrival order (callId only)', () => {
    // Two Bash calls fire back-to-back; only the SECOND id has a result.
    const events: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'a', command: 'sleep 1' },
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'b', command: 'sleep 2' },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:30Z', tool: 'Bash', callId: 'b', outcome: 'ok' },
    ];
    const steps = t(events).steps;
    const a = steps[0];
    const b = steps[1];
    // 'a' has no result → estimated (never grabs b's result by order).
    expect(a.durationEstimated).toBe(true);
    // 'b' is measured against its own result.
    expect(b.durationEstimated).toBe(false);
    expect(b.durationMs).toBe(30_000);
  });

  it('callId-less harness: every step estimated by next-event delta, never mispaired', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', agent: 'gemini', timestamp: '2026-08-01T00:00:00Z', tool: 'Read', args: { file_path: 'x' } },
      { type: 'tool_use', agent: 'gemini', timestamp: '2026-08-01T00:00:03Z', tool: 'Read', args: { file_path: 'y' } },
      { type: 'tool_result', agent: 'gemini', timestamp: '2026-08-01T00:00:04Z', tool: 'Read' },
    ];
    const steps = buildTrajectory(events, meta({ agent: 'gemini' })).steps;
    expect(steps.every((s) => s.durationEstimated)).toBe(true);
  });
});

describe('buildTrajectory — gaps, tokens, delegation, shares', () => {
  it('records an idle gap longer than the threshold with the preceding step', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'c1', command: 'ls' },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:01Z', tool: 'Bash', callId: 'c1', outcome: 'ok' },
      // 3m10s of nothing — a stall.
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:03:11Z', tool: 'Read', callId: 'r1', args: { file_path: 'a' } },
    ];
    const traj = buildTrajectory(events, meta(), { idleThresholdMs: 120_000 });
    expect(traj.gaps).toHaveLength(1);
    expect(traj.gaps[0].durationMs).toBe(3 * 60_000 + 10_000);
    expect(traj.gaps[0].afterOrdinal).toBe(1); // after the Bash step
  });

  it('does not record a gap under the threshold', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'c1', command: 'ls' },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:30Z', tool: 'Bash', callId: 'c1', outcome: 'ok' },
    ];
    expect(buildTrajectory(events, meta(), { idleThresholdMs: 120_000 }).gaps).toHaveLength(0);
  });

  it('a long tool execution (tool_use→its own result) is NOT an idle gap', () => {
    // A single 8m04s `bun test`: the span between the tool_use and its result is
    // the tool running, not the agent stalling — it must not be a gap.
    const events: SessionEvent[] = [
      { type: 'message', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', role: 'user', content: 'go' },
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:02Z', tool: 'Bash', callId: 'c1', command: 'bun test' },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:08:06Z', tool: 'Bash', callId: 'c1', outcome: 'ok' },
    ];
    const traj = buildTrajectory(events, meta(), { idleThresholdMs: 120_000 });
    expect(traj.gaps).toHaveLength(0);
    // The duration still lands on the step itself.
    expect(traj.steps.find((s) => s.tool === 'Bash')!.durationMs).toBe(8 * 60_000 + 4_000);
  });

  it('attributes output tokens from the nearest following usage event', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'c1', command: 'ls' },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:01Z', tool: 'Bash', callId: 'c1', outcome: 'ok' },
      { type: 'usage', agent: 'claude', timestamp: '2026-08-01T00:00:02Z', outputTokens: 18_400 },
    ];
    const step = buildTrajectory(events, meta()).steps.find((s) => s.tool === 'Bash')!;
    expect(step.outputTokens).toBe(18_400);
  });

  it('tags an inline Task tool_use as delegation and computes tool time share', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'c1', command: 'x' },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:30Z', tool: 'Bash', callId: 'c1', outcome: 'ok' },
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:30Z', tool: 'Task', callId: 't1', args: { subagent_type: 'code-reviewer', description: 'review' } },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:40Z', tool: 'Task', callId: 't1', outcome: 'ok' },
    ];
    const traj = buildTrajectory(events, meta());
    const task = traj.steps.find((s) => s.tool === 'Task')!;
    expect(task.delegation).toBe('inline-task');
    expect(task.label).toContain('code-reviewer');
    // Bash 30s, Task 10s → shares 0.75 / 0.25.
    expect(traj.toolTimeShare.Bash).toBeCloseTo(0.75, 5);
    expect(traj.toolTimeShare.Task).toBeCloseTo(0.25, 5);
  });
});

describe('buildTrajectory — redaction and safety', () => {
  it('redacts a secret in a derived label by default, and passes it through with redact:false', () => {
    const secret = 'sk-supersecrettoken1234567890';
    const events: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'c1', command: `curl -H "authorization: Bearer ${secret}" https://x` },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:01Z', tool: 'Bash', callId: 'c1', outcome: 'ok' },
    ];
    const redacted = buildTrajectory(events, meta(), { redact: true, knownSecrets: [secret] });
    expect(redacted.steps[0].label).not.toContain(secret);
    expect(redacted.redacted).toBe(true);
    const raw = buildTrajectory(events, meta(), { redact: false, knownSecrets: [secret] });
    expect(raw.steps[0].label).toContain(secret);
    expect(raw.redacted).toBe(false);
  });

  it('empty events (unparseable harness like OpenClaw) yields an empty trajectory, not a crash', () => {
    const traj = buildTrajectory([], meta({ agent: 'openclaw' }));
    expect(traj.steps).toHaveLength(0);
    expect(traj.gaps).toHaveLength(0);
    expect(traj.spanMs).toBe(0);
    expect(traj.toolTimeShare).toEqual({});
  });

  it('caps drawn steps and counts the dropped tail (no silent truncation)', () => {
    const events: SessionEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push({ type: 'tool_use', agent: 'claude', timestamp: `2026-08-01T00:00:0${i}Z`, tool: 'Bash', callId: `c${i}`, command: 'x' });
    }
    const traj = buildTrajectory(events, meta(), { maxSteps: 4 });
    expect(traj.steps).toHaveLength(4);
    expect(traj.truncatedSteps).toBe(6);
  });
});

describe('buildTrajectory — real parsed transcript (no crash, coherent order)', () => {
  it('builds a trajectory from a real Claude fixture', () => {
    const filePath = path.join(HERE, 'testdata', 'checklist-claude.jsonl');
    const events = parseSession(filePath, 'claude');
    const traj = buildTrajectory(events, meta({ filePath }));
    expect(traj.steps.length).toBeGreaterThan(0);
    // Every tool step carries a non-empty label and an ordinal.
    for (const step of traj.steps) {
      expect(step.ordinal).toBeGreaterThan(0);
      expect(step.label.length).toBeGreaterThan(0);
    }
    // Ordinals are contiguous 1..N in draw order.
    expect(traj.steps.map((s) => s.ordinal)).toEqual(traj.steps.map((_, i) => i + 1));
  });
});

/** Terse helper — build a trajectory with default meta. */
function t(events: SessionEvent[]) {
  return buildTrajectory(events, meta());
}
