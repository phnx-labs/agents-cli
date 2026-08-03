import { describe, expect, it } from 'vitest';
import {
  buildSample,
  deterministicSessionSample,
  exactSampleTargetArgs,
  loadEnvelope,
  mergeSampleEnvelopes,
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
    expect(new Set(deterministicSessionSample(sessions, 2).map((item) => item.machine)))
      .toEqual(new Set(['box-1', 'box-2']));
    const skewed = [
      ...Array.from({ length: 100 }, (_, index) => session(`local-${index}`, 'box-1')),
      session('only-peer', 'box-2'),
    ];
    expect(deterministicSessionSample(skewed, 10).some((item) => item.machine === 'box-2')).toBe(true);
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
    expect(exactSampleTargetArgs('yosemite-s1', 'yosemite-s1')).toEqual(['--local']);
    expect(exactSampleTargetArgs('YOSEMITE-S1', 'yosemite-s1')).toEqual(['--local']);
    expect(exactSampleTargetArgs('yosemite-m3', 'yosemite-s1')).toEqual(['--device', 'yosemite-m3']);
  });

  it('bulk-queries each source and marks coverage partial when one fails', () => {
    const calls: string[][] = [];
    const envelope = loadEnvelope(
      { sessions: 50, since: '7d', devices: ['yosemite-s1', 'peer-one'], passes: 1 },
      (args) => {
        calls.push(args);
        if (args.includes('peer-one')) throw new Error('peer failed');
        if (!args.includes('--query')) {
          return JSON.stringify({
            schemaVersion: 1,
            generatedAt: '2026-08-03T00:00:00Z',
            query: { clauses: [] },
            coverage: { indexedFiles: 0, indexedCalls: 0, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
            sessions: [session('local-session', 'yosemite-s1')],
          });
        }
        return JSON.stringify({
          schemaVersion: 1,
          generatedAt: '2026-08-03T00:00:00Z',
          query: { clauses: [] },
          coverage: { indexedFiles: 1, indexedCalls: 1, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
          sessions: [session('local-session', 'yosemite-s1')],
        });
      },
      'yosemite-s1',
    );
    expect(calls).toHaveLength(6);
    expect(calls[0]).toContain('--local');
    expect(calls[4]).toContain('peer-one');
    expect(calls.every((args) => args.includes('--include'))).toBe(true);
    expect(calls.filter((args) => args.includes('--query'))).toHaveLength(5);
    expect(envelope.sessions).toHaveLength(1);
    expect(envelope.coverage).toMatchObject({ skippedFiles: 0, complete: false });
    expect(envelope).toMatchObject({ failedSources: 1 });
  });

  it('does not repeat a terminal partial result with no remaining backfill', () => {
    let queryCalls = 0;
    const envelope = loadEnvelope(
      { sessions: 50, since: '7d', devices: ['peer-one'], passes: 4 },
      (args) => {
        queryCalls++;
        return JSON.stringify({
          schemaVersion: 1,
          generatedAt: '2026-08-03T00:00:00Z',
          query: { clauses: [] },
          coverage: { indexedFiles: 1, indexedCalls: 1, skippedFiles: 0, limitedFiles: 1, remainingFiles: 0, complete: false },
          sessions: [session('limited-session', 'peer-one')],
        });
      },
      'yosemite-s1',
    );
    expect(queryCalls).toBe(5);
    expect(envelope.sessions).toHaveLength(1);
  });

  it('deduplicates bulk results from normalized machine names', () => {
    const first: ToolSearchEnvelope = {
      schemaVersion: 1, generatedAt: '2026-08-03T00:00:00Z', query: { clauses: [] },
      coverage: { indexedFiles: 1, indexedCalls: 1, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
      sessions: [session('same', 'YOSEMITE-S1')],
    };
    const second: ToolSearchEnvelope = {
      ...first,
      sessions: [session('same', 'yosemite-s1')],
    };
    expect(mergeSampleEnvelopes([first, second]).sessions).toHaveLength(1);
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
