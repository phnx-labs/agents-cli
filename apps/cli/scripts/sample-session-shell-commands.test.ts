import { describe, expect, it } from 'vitest';
import {
  buildSample,
  deterministicSessionSample,
  loadEnvelope,
  parseSampleOptions,
  partitionSampleDevices,
  SAMPLE_MAX_SERIALIZED_BYTES,
} from './sample-session-shell-commands.js';
import type { ToolSearchEnvelope, ToolSessionEvidence } from '../src/lib/session/tool-index.js';

function session(id: string, machine: string): ToolSessionEvidence {
  return {
    id, shortId: id, machine, agent: 'codex', timestamp: '2026-08-03T00:00:00Z',
    filePath: `/${machine}/${id}.jsonl`, calls: [{
      id: `${id}-call`, ordinal: 0, timestamp: '2026-08-03T00:00:01Z',
      tool: 'exec_command', programs: ['git'], input: 'git status', outcome: 'unknown',
    }],
  };
}

describe('session shell-command sampler', () => {
  it('validates the requested 50-100 session range and repeatable devices', () => {
    expect(parseSampleOptions(['--sessions', '75', '--since', '5d', '--device', 'a', '--device', 'b']))
      .toMatchObject({ sessions: 75, since: '5d', devices: ['a', 'b'] });
    expect(parseSampleOptions(['--output', '/tmp/sample.json'])).toMatchObject({ output: '/tmp/sample.json' });
    expect(() => parseSampleOptions(['--sessions', '49'])).toThrow('50 to 100');
    expect(() => parseSampleOptions(['--sessions', '101'])).toThrow('50 to 100');
  });

  it('selects a stable cross-device sample and keeps bounded command origins', () => {
    const sessions = [session('a', 'box-1'), session('b', 'box-2'), session('c', 'box-1')];
    expect(deterministicSessionSample(sessions, 2).map((item) => item.id))
      .toEqual(deterministicSessionSample([...sessions].reverse(), 2).map((item) => item.id));
    const envelope: ToolSearchEnvelope = {
      schemaVersion: 1, generatedAt: '2026-08-03T00:00:00Z', query: { clauses: [] },
      coverage: { indexedFiles: 0, indexedCalls: 0, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
      sessions,
    };
    const sample = buildSample(envelope, 2);
    expect(sample.sampledSessions).toBe(2);
    expect(sample.sessions.every((item) => item.commands[0].input === 'git status')).toBe(true);
  });

  it('reads the current device locally and sends only peers through device fan-out', () => {
    expect(partitionSampleDevices(['yosemite-s1', 'yosemite-m3'], 'yosemite-s1', false)).toEqual({
      includeLocal: true,
      remoteDevices: ['yosemite-m3'],
    });
    expect(partitionSampleDevices(['yosemite-m3'], 'yosemite-s1', true)).toEqual({
      includeLocal: false,
      remoteDevices: ['yosemite-m3'],
    });
    expect(partitionSampleDevices(['YOSEMITE-S1'], 'yosemite-s1', true)).toEqual({
      includeLocal: true,
      remoteDevices: [],
    });
  });

  it('marks coverage partial when an exact session query fails', () => {
    const envelope = loadEnvelope(
      { sessions: 50, since: '7d', devices: ['peer-one'], passes: 1 },
      (args) => {
        if (args.includes('--include')) throw new Error('peer failed');
        return JSON.stringify([{
          id: 'failed-session', shortId: 'failed-s', agent: 'codex', machine: 'peer-one',
          timestamp: '2026-08-03T00:00:00Z',
        }]);
      },
    );
    expect(envelope.sessions).toEqual([]);
    expect(envelope.coverage).toMatchObject({ skippedFiles: 1, complete: false });
  });

  it('caps the serialized artifact even when every sampled session carries maximum-size inputs', () => {
    const sessions = Array.from({ length: 50 }, (_, sessionIndex) => {
      const item = session(`large-${sessionIndex}`, `box-${sessionIndex % 2}`);
      item.calls = Array.from({ length: 24 }, (_, callIndex) => ({
        ...item.calls[0],
        id: `${item.id}-call-${callIndex}`,
        ordinal: callIndex,
        input: `${sessionIndex}:${callIndex}:` + 'x'.repeat(16 * 1024),
      }));
      return item;
    });
    const envelope: ToolSearchEnvelope = {
      schemaVersion: 1,
      generatedAt: '2026-08-03T00:00:00Z',
      query: { clauses: [] },
      coverage: { indexedFiles: 50, indexedCalls: 1_200, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
      sessions,
    };

    const sample = buildSample(envelope, 50);
    const bytes = Buffer.byteLength(JSON.stringify(sample, null, 2) + '\n');
    expect(bytes).toBeLessThanOrEqual(SAMPLE_MAX_SERIALIZED_BYTES);
    expect(sample.sampledSessions).toBeLessThan(50);
    expect(sample.coverage.complete).toBe(false);
    expect(sample.truncation).toEqual({ reason: 'sample_byte_limit', maxBytes: SAMPLE_MAX_SERIALIZED_BYTES });
  });
});
