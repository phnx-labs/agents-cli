import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import {
  chooseFormat,
  buildTraceEnvelope,
  buildCompareTraceEnvelope,
  registerSessionsTraceCommand,
  registerTraceCommand,
  SESSIONS_TRACE_SCHEMA_VERSION,
} from './sessions-trace.js';
import { buildTrajectory } from '../lib/session/trajectory.js';
import { diffTrajectories } from '../lib/session/trajectory-compare.js';
import type { SessionEvent, SessionMeta } from '../lib/session/types.js';

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return { id: 'sess-0001', shortId: 'sess0001', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', filePath: '/tmp/s.jsonl', ...overrides };
}

describe('chooseFormat — audience auto-selection', () => {
  it('explicit flags always win', () => {
    expect(chooseFormat({ json: true }, true)).toBe('json');
    expect(chooseFormat({ html: true }, false)).toBe('html');
    expect(chooseFormat({ text: true }, true)).toBe('text');
  });
  it('defaults to HTML on a TTY (a person) and text when piped (an agent)', () => {
    expect(chooseFormat({}, true)).toBe('html');
    expect(chooseFormat({}, false)).toBe('text');
  });
});

describe('buildTraceEnvelope — the --json contract', () => {
  it('emits the versioned single-layout envelope', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'c1', command: 'ls' },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:01Z', tool: 'Bash', callId: 'c1', outcome: 'ok' },
    ];
    const envelope = buildTraceEnvelope([buildTrajectory(events, meta())]);
    expect(envelope.schemaVersion).toBe(SESSIONS_TRACE_SCHEMA_VERSION);
    expect(envelope.kind).toBe('sessions-trace');
    expect(envelope.layout).toBe('single');
    expect(envelope.sessions).toHaveLength(1);
    const model = envelope.sessions[0];
    expect(model.session.id).toBe('sess-0001');
    expect(model.steps[0].tool).toBe('Bash');
    expect(model).toHaveProperty('gaps');
    expect(model).toHaveProperty('toolTimeShare');
    expect(model).toHaveProperty('stats');
  });
});

describe('buildCompareTraceEnvelope — the --json compare contract', () => {
  it('emits the versioned compare-layout envelope with both trajectories and the diff', () => {
    const eventsA: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'a1', command: 'ls' },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:01Z', tool: 'Bash', callId: 'a1', outcome: 'ok' },
    ];
    const eventsB: SessionEvent[] = [
      { type: 'tool_use', agent: 'codex', timestamp: '2026-08-01T00:00:00Z', tool: 'Grep', callId: 'b1', args: { pattern: 'x' } },
      { type: 'tool_result', agent: 'codex', timestamp: '2026-08-01T00:00:01Z', tool: 'Grep', callId: 'b1', outcome: 'ok' },
    ];
    const a = buildTrajectory(eventsA, meta({ id: 'a', agent: 'claude' }));
    const b = buildTrajectory(eventsB, meta({ id: 'b', agent: 'codex' }));
    const envelope = buildCompareTraceEnvelope(diffTrajectories(a, b));
    expect(envelope.schemaVersion).toBe(SESSIONS_TRACE_SCHEMA_VERSION);
    expect(envelope.kind).toBe('sessions-trace');
    expect(envelope.layout).toBe('compare');
    expect(envelope.sessions).toHaveLength(2);
    expect(envelope.sessions[0].session.id).toBe('a');
    expect(envelope.sessions[1].session.id).toBe('b');
    expect(envelope.diff).toBeDefined();
    expect(envelope.diff!.divergence).toBeDefined();
    expect(envelope.diff!.summaryA.session.id).toBe('a');
    expect(envelope.diff!.summaryB.session.id).toBe('b');
  });
});

describe('command registration', () => {
  function optionNames(cmd: Command): string[] {
    return cmd.options.map((o) => o.long ?? o.short ?? '');
  }

  it('registers the canonical `sessions trace` with the audience/rendering flags', () => {
    const sessions = new Command('sessions');
    registerSessionsTraceCommand(sessions);
    const trace = sessions.commands.find((c) => c.name() === 'trace');
    expect(trace).toBeTruthy();
    const opts = optionNames(trace!);
    for (const flag of ['--html', '--text', '--json', '--output', '--no-open', '--errors-only', '--no-redact', '--compare', '--tree']) {
      expect(opts).toContain(flag);
    }
  });

  it('registers the top-level `agents trace` alias with the same shape', () => {
    const program = new Command('agents');
    registerTraceCommand(program);
    const trace = program.commands.find((c) => c.name() === 'trace');
    expect(trace).toBeTruthy();
    expect(optionNames(trace!)).toContain('--json');
  });
});
