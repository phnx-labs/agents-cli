import { describe, expect, it } from 'vitest';
import { computeInsights, normalizeErrorKey } from './insights.js';
import type { SyncRow, ToolCallRow } from './sync.js';

function makeRow(id: string, timestamp: string): SyncRow {
  return {
    id, short_id: id.slice(0, 8), agent: 'claude', origin: 'cli', routine_name: null,
    routine_run_id: null, version: null, account: null, account_key: null,
    account_org: null, mode: 'auto', timestamp, last_activity: null, project: 'agents-cli',
    cwd: '/redacted/agents-cli', git_branch: null, topic: null, label: null,
    message_count: null, token_count: null, output_tokens: null, input_tokens: null,
    cache_read_tokens: null, cache_write_tokens: null, cost_usd: null, cost_usd_nocache: null,
    duration_ms: null, model: 'claude-opus-4-8', tool_call_count: null,
    file_path: `/tmp/${id}.jsonl`, file_mtime_ms: 0, file_size: 0, machine: 'test-device',
  };
}

function makeCall(
  sessionId: string,
  ordinal: number,
  timestamp: string,
  tool: string,
  outcome: 'ok' | 'error',
  opts: Partial<Pick<ToolCallRow, 'exit_code' | 'status_code' | 'error_code' | 'error' | 'parse_error'>> = {},
): ToolCallRow {
  return {
    session_id: sessionId, ordinal, timestamp, tool, outcome,
    exit_code: opts.exit_code ?? null, status_code: opts.status_code ?? null,
    error_code: opts.error_code ?? null, error: opts.error ?? null, parse_error: opts.parse_error ?? null,
  };
}

const T0 = '2026-08-27T00:00:00.000Z';
const iso = (offsetMs: number): string => new Date(Date.parse(T0) + offsetMs).toISOString();

describe('normalizeErrorKey', () => {
  it('folds volatile per-instance tokens so repeat failures hash identically', () => {
    const a = normalizeErrorKey('rate limit', 'API rate limit exceeded for user 111 (try again in 30s)');
    const b = normalizeErrorKey('rate limit', 'API rate limit exceeded for user 222 (try again in 47s)');
    expect(a).toBe(b);
    expect(a).toBe('api rate limit exceeded for user _ (try again in _s)');
  });
});

describe('computeInsights', () => {
  it('folds near-identical rate-limit errors into one pattern and sums wasted time exactly', () => {
    const rows = [makeRow('sess-rate', T0)];
    const calls: ToolCallRow[] = [
      makeCall('sess-rate', 1, iso(0), 'Bash', 'error', {
        error: 'API rate limit exceeded for user 111 (try again in 30s)',
      }),
      // Same signature after normalization, 2 minutes later — a retry loop.
      makeCall('sess-rate', 2, iso(120_000), 'Bash', 'error', {
        error: 'API rate limit exceeded for user 222 (try again in 47s)',
      }),
      // Recovers, but only after a 3-minute stall following the second failure.
      makeCall('sess-rate', 3, iso(120_000 + 180_000), 'Bash', 'ok'),
    ];

    const result = computeInsights(rows, calls, null);
    expect(result.failurePatterns).toHaveLength(1);
    const pattern = result.failurePatterns[0];
    expect(pattern.signature).toEqual({
      tool: 'Bash',
      cause: 'real',
      key: 'api rate limit exceeded for user _ (try again in _s)',
    });
    expect(pattern.occurrences).toBe(2);
    expect(pattern.sessions).toBe(1);
    expect(pattern.label).toBe('Bash: rate limit back-off loop');
    // 120s (retry-loop gap) + 180s (stall after the second failure) = 300s.
    expect(pattern.wastedMs).toBe(300_000);
    expect(result.wastedMsTotal).toBe(300_000);
  });

  it('ranks by wasted-time impact, not occurrence count — a rare long loop outranks a frequent short one', () => {
    const rows = [makeRow('sess-big', T0), ...Array.from({ length: 50 }, (_, i) => makeRow(`sess-freq-${i}`, T0))];
    const calls: ToolCallRow[] = [
      // One session, one failure, an 8-hour stall before the session ends.
      makeCall('sess-big', 1, iso(0), 'Bash', 'error', { error: 'connection refused' }),
      makeCall('sess-big', 2, iso(8 * 60 * 60 * 1000), 'Bash', 'ok'),
      // 50 sessions, one quick failure each, no follow-up call — zero wasted time.
      ...Array.from({ length: 50 }, (_, i) =>
        makeCall(`sess-freq-${i}`, 1, iso(0), 'Read', 'error', { error: 'permission denied' }),
      ),
    ];

    const result = computeInsights(rows, calls, null);
    const big = result.failurePatterns.find((p) => p.signature.tool === 'Bash');
    const frequent = result.failurePatterns.find((p) => p.signature.tool === 'Read');
    expect(big?.occurrences).toBe(1);
    expect(big?.wastedMs).toBe(8 * 60 * 60 * 1000);
    expect(frequent?.occurrences).toBe(50);
    expect(frequent?.wastedMs).toBe(0);
    expect(result.failurePatterns.indexOf(big!)).toBeLessThan(result.failurePatterns.indexOf(frequent!));
  });

  it('bounds the shard to the top-K patterns regardless of corpus size', () => {
    const rows = Array.from({ length: 40 }, (_, i) => makeRow(`sess-${i}`, T0));
    const calls = rows.map((row, i) =>
      makeCall(row.id, 1, iso(0), `Tool${i}`, 'error', { error: `distinct failure ${i}` }),
    );
    const result = computeInsights(rows, calls, null);
    expect(result.failurePatterns.length).toBeLessThanOrEqual(25);
  });

  it('does not attribute an ordinary gap between unrelated successful calls as wasted time', () => {
    const rows = [makeRow('sess-clean', T0)];
    const calls: ToolCallRow[] = [
      makeCall('sess-clean', 1, iso(0), 'Read', 'ok'),
      makeCall('sess-clean', 2, iso(30_000), 'Edit', 'ok'),
    ];
    const result = computeInsights(rows, calls, null);
    expect(result.failurePatterns).toHaveLength(0);
    expect(result.wastedMsTotal).toBe(0);
  });

  it('computes time-to-first-tool latency from the first call offset per session', () => {
    const rows = [makeRow('sess-a', T0), makeRow('sess-b', T0)];
    const calls: ToolCallRow[] = [
      makeCall('sess-a', 1, iso(5_000), 'Read', 'ok'),
      makeCall('sess-b', 1, iso(15_000), 'Read', 'ok'),
    ];
    const result = computeInsights(rows, calls, null);
    expect(result.latency.firstToolMs.p50).toBeGreaterThanOrEqual(5_000);
    expect(result.latency.firstToolMs.max).toBe(15_000);
  });

  it('marks drift up/down/flat against the previous shard by pattern id', () => {
    const rows = [makeRow('sess-drift', T0)];
    const calls: ToolCallRow[] = [
      makeCall('sess-drift', 1, iso(0), 'Bash', 'error', { error: 'network timeout' }),
    ];
    const first = computeInsights(rows, calls, null);
    expect(first.failurePatterns[0].drift).toBe('up');

    const prevShard = { failurePatterns: first.failurePatterns } as never;
    const same = computeInsights(rows, calls, prevShard);
    expect(same.failurePatterns[0].drift).toBe('flat');

    const moreCalls = [...calls, makeCall('sess-drift', 2, iso(1), 'Bash', 'error', { error: 'network timeout' })];
    const grew = computeInsights(rows, moreCalls, prevShard);
    expect(grew.failurePatterns[0].drift).toBe('up');
  });
});
