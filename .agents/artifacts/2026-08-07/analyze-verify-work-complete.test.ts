import { describe, expect, test } from 'bun:test';
import {
  analyzeSession,
  buildAudit,
  gateType,
  isGenuineFeedback,
  normalizeTranscript,
  parseDuration,
  type TimelineEvent,
} from './analyze-verify-work-complete';

const meta = {
  id: 'session-1',
  shortId: 'session1',
  agent: 'claude',
  version: '2.1.207',
  machine: 'test-host',
  project: 'agents-cli',
  filePath: '/unused',
};

function event(overrides: Partial<TimelineEvent>): TimelineEvent {
  return {
    index: 0,
    timestamp: '2026-08-07T12:00:00.000Z',
    kind: 'message',
    ...overrides,
  };
}

const deliveryFeedback = `Stop hook feedback:
[~/.claude/hooks/00-agent-verify-work-complete.sh]: STOP GATE (delivery): This stop looks like the end of a delivery, but the loop is not closed.

User-facing change detected, but missing docs and CHANGELOG update(s) in the PR.`;

describe('verify-work-complete audit', () => {
  test('parses duration values and rejects ambiguous input', () => {
    expect(parseDuration('7d')).toBe(7 * 86_400_000);
    expect(parseDuration('48h')).toBe(48 * 3_600_000);
    expect(() => parseDuration('last week')).toThrow();
  });

  test('recognizes genuine feedback but not a source-code quotation', () => {
    expect(isGenuineFeedback(event({ role: 'user', text: deliveryFeedback, synthetic: true }))).toBe(true);
    expect(isGenuineFeedback(event({ role: 'assistant', text: 'The file contains STOP GATE (delivery).' }))).toBe(false);
    expect(gateType(deliveryFeedback)).toBe('delivery');
  });

  test('normalizes Claude assistant, tool, and synthetic hook-feedback records', () => {
    const raw = [
      JSON.stringify({ timestamp: '2026-08-07T12:00:00Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }, { type: 'tool_use', name: 'Bash', input: { command: 'echo ok' } }] } }),
      JSON.stringify({ timestamp: '2026-08-07T12:00:01Z', type: 'user', isMeta: true, message: { role: 'user', content: deliveryFeedback } }),
    ].join('\n');
    const events = normalizeTranscript(raw, 'claude');
    expect(events.map((item) => item.kind)).toEqual(['message', 'tool', 'message']);
    expect(events.at(-1)?.synthetic).toBe(true);
    expect(isGenuineFeedback(events.at(-1)!)).toBe(true);
  });

  test('deduplicates paired hook versions within five seconds', () => {
    const events = [
      event({ index: 0, role: 'user', text: 'Build the feature.', synthetic: false }),
      event({ index: 1, role: 'assistant', text: 'Done.', timestamp: '2026-08-07T12:00:01Z' }),
      event({ index: 2, role: 'user', text: deliveryFeedback, synthetic: true, timestamp: '2026-08-07T12:00:02Z' }),
      event({ index: 3, role: 'user', text: deliveryFeedback.replace('~/.claude', '~/.agents/history/claude'), synthetic: true, timestamp: '2026-08-07T12:00:05Z' }),
      event({ index: 4, role: 'assistant', text: 'The gate does not apply; screenshot: https://example.test/proof', timestamp: '2026-08-07T12:00:06Z' }),
    ];
    const result = analyzeSession(meta, events, Date.parse('2026-08-07T00:00:00Z'), Date.parse('2026-08-08T00:00:00Z'));
    expect(result.raw).toBe(2);
    expect(result.interventions).toHaveLength(1);
    expect(result.interventions[0].rawDuplicateCount).toBe(1);
  });

  test('flags the browser-only delivery mismatch and evidence-backed pushback', () => {
    const events = [
      event({ index: 0, role: 'user', text: 'Submit this into the browser app.', synthetic: false }),
      event({ index: 1, kind: 'tool', tool: 'Bash', command: 'agents browser screenshot', timestamp: '2026-08-07T12:00:01Z' }),
      event({ index: 2, role: 'assistant', text: 'Done — the browser app is building.', timestamp: '2026-08-07T12:00:02Z' }),
      event({ index: 3, role: 'user', text: deliveryFeedback, synthetic: true, timestamp: '2026-08-07T12:00:03Z' }),
      event({ index: 4, role: 'assistant', text: "The gate doesn't apply. There is no repo or PR. Evidence: screenshot and https://example.test/app", timestamp: '2026-08-07T12:00:04Z' }),
    ];
    const result = analyzeSession(meta, events, Date.parse('2026-08-07T00:00:00Z'), Date.parse('2026-08-08T00:00:00Z'));
    expect(result.interventions[0].deliveryContextMismatchCandidate).toBe(true);
    expect(result.interventions[0].reaction).toBe('substantiated-pushback');
  });

  test('resets logical attempt numbering at a genuine user turn', () => {
    const events = [
      event({ index: 0, role: 'user', text: 'First task', synthetic: false }),
      event({ index: 1, role: 'assistant', text: 'Done.', timestamp: '2026-08-07T12:00:01Z' }),
      event({ index: 2, role: 'user', text: deliveryFeedback, synthetic: true, timestamp: '2026-08-07T12:00:02Z' }),
      event({ index: 3, role: 'assistant', text: 'Already done with evidence: 5 tests passed.', timestamp: '2026-08-07T12:00:03Z' }),
      event({ index: 4, role: 'user', text: 'Second task', synthetic: false, timestamp: '2026-08-07T12:10:00Z' }),
      event({ index: 5, role: 'assistant', text: 'Done.', timestamp: '2026-08-07T12:10:01Z' }),
      event({ index: 6, role: 'user', text: deliveryFeedback, synthetic: true, timestamp: '2026-08-07T12:10:02Z' }),
      event({ index: 7, role: 'assistant', text: 'Already done with evidence: 6 tests passed.', timestamp: '2026-08-07T12:10:03Z' }),
    ];
    const result = analyzeSession(meta, events, Date.parse('2026-08-07T00:00:00Z'), Date.parse('2026-08-08T00:00:00Z'));
    expect(result.interventions.map((item) => item.logicalAttempt)).toEqual([1, 1]);
  });

  test('reports a Codex observability gap instead of claiming zero executions', () => {
    const audit = buildAudit([], '7d', new Date('2026-08-08T00:00:00Z'));
    expect(audit.coverage.instrumentationCaveat).toContain('zero observable interventions is not evidence');
  });
});
