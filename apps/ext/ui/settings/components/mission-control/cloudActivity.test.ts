import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseCloudSummary,
  parseCloudSummaryIncremental,
  emptyCloudParseCache,
  toolHeadline,
  simpleDiff,
  type CloudEvent,
  type ToolUseEvent,
} from './cloudActivity';

const FIXTURE_DIR = path.join(__dirname, 'testdata');
const REAL_SUMMARY = fs.readFileSync(
  path.join(FIXTURE_DIR, 'cloud-summary-zavknykt.txt'),
  'utf-8',
);

describe('parseCloudSummary', () => {
  test('returns [] for null / empty', () => {
    expect(parseCloudSummary(null)).toEqual([]);
    expect(parseCloudSummary('')).toEqual([]);
    expect(parseCloudSummary('   \n  \n')).toEqual([]);
  });

  test('real cloud summary yields preamble then JSONL events (no crash on truncated tail)', () => {
    const events = parseCloudSummary(REAL_SUMMARY);
    expect(events.length).toBeGreaterThan(5);

    const firstPreamble = events.find((e): e is Extract<CloudEvent, { kind: 'preamble' }> =>
      e.kind === 'preamble');
    expect(firstPreamble).toBeDefined();
    expect(firstPreamble!.tSec).toBe(0);
    expect(firstPreamble!.text).toContain('entered wrapper');

    const init = events.find((e) => e.kind === 'system' && e.subtype === 'init');
    expect(init).toBeDefined();
    expect((init as { summary: string }).summary).toContain('claude-sonnet-4-6');
    expect((init as { summary: string }).summary).toContain('tools');

    const hookStarted = events.find((e) => e.kind === 'system' && e.subtype === 'hook_started');
    expect(hookStarted).toBeDefined();
  });

  test('parses preamble [t+Xs] prefix into tSec', () => {
    const events = parseCloudSummary('[t+17s] fetch done\n[t+28s] reset done\nhello world');
    expect(events).toEqual([
      { kind: 'preamble', text: 'fetch done', tSec: 17 },
      { kind: 'preamble', text: 'reset done', tSec: 28 },
      { kind: 'preamble', text: 'hello world' },
    ]);
  });

  test('parses a synthetic tool_use / tool_result pair', () => {
    const use = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/workspace/src/a.ts' } },
        ],
      },
    };
    const result = {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents here', is_error: false },
        ],
      },
    };
    const events = parseCloudSummary(JSON.stringify(use) + '\n' + JSON.stringify(result));
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      kind: 'tool-use',
      id: 'toolu_1',
      name: 'Read',
      input: { file_path: '/workspace/src/a.ts' },
    });
    expect(events[1]).toEqual({
      kind: 'tool-result',
      id: 'toolu_1',
      content: 'file contents here',
      isError: false,
    });
  });

  test('flattens array tool_result content', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_x',
            content: [
              { type: 'text', text: 'line one' },
              { type: 'text', text: 'line two' },
            ],
            is_error: true,
          },
        ],
      },
    });
    const events = parseCloudSummary(line);
    expect(events).toEqual([
      { kind: 'tool-result', id: 'toolu_x', content: 'line one\nline two', isError: true },
    ]);
  });

  test('skips unparseable trailing line (streaming / truncation)', () => {
    const good = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    });
    const truncated = '{"type":"assistant","message":{"content":[{"type":"tex';
    const events = parseCloudSummary(good + '\n' + truncated);
    expect(events).toEqual([{ kind: 'assistant', text: 'hello' }]);
  });

  test('splits assistant blocks: thinking + text + tool_use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'Let me think.' },
          { type: 'text', text: 'Here we go.' },
          { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'ls -la' } },
        ],
      },
    });
    const events = parseCloudSummary(line);
    expect(events.map((e) => e.kind)).toEqual(['thinking', 'assistant', 'tool-use']);
  });

  test('captures result event with duration + cost', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      duration_ms: 12345,
      num_turns: 7,
      total_cost_usd: 0.42,
    });
    const events = parseCloudSummary(line);
    expect(events).toEqual([
      { kind: 'result', subtype: 'success', durationMs: 12345, numTurns: 7, totalCostUsd: 0.42 },
    ]);
  });
});

describe('parseCloudSummaryIncremental', () => {
  test('matches a full reparse at every step of a growing append-only stream', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', tools: ['Read'], cwd: '/w' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking into it.' }] } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/w/a.ts' } }] },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'contents', is_error: false }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 100, num_turns: 1, total_cost_usd: 0.01 }),
    ];
    const cache = emptyCloudParseCache();
    let summary = '';
    for (const line of lines) {
      summary += line + '\n';
      const incremental = parseCloudSummaryIncremental(summary, cache);
      expect(incremental).toEqual(parseCloudSummary(summary));
    }
  });

  test('returns a fresh array identity on every call so React memoization sees new events', () => {
    // Regression for RUSH-1558: the feed rendered off `useMemo(() => groupEvents(events), [events])`
    // in CloudActivityFeed. If this function ever hands back the live cache.events reference
    // on the common (no-tail) path, that reference's identity stops changing across calls even
    // though its length keeps growing via push() -- React's dependency check sees the "same"
    // array and freezes the rendered feed on whatever it first committed.
    const cache = emptyCloudParseCache();
    const line1 = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] } });
    const line2 = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'two' }] } });

    const first = parseCloudSummaryIncremental(line1 + '\n', cache);
    expect(first).toHaveLength(1);

    const second = parseCloudSummaryIncremental(line1 + '\n' + line2 + '\n', cache);
    expect(second).toHaveLength(2);
    expect(second).not.toBe(first);
  });

  test('resets and reparses when the buffer is truncated/replaced (not append-only)', () => {
    const cache = emptyCloudParseCache();
    const line1 = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] } });
    parseCloudSummaryIncremental(line1 + '\n', cache);

    const replaced = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'other' }] } });
    const result = parseCloudSummaryIncremental(replaced + '\n', cache);
    expect(result).toEqual(parseCloudSummary(replaced + '\n'));
  });
});

describe('toolHeadline', () => {
  const make = (name: string, input: Record<string, unknown>): ToolUseEvent => ({
    kind: 'tool-use',
    id: 't',
    name,
    input,
  });

  test('formats each known tool distinctly', () => {
    expect(toolHeadline(make('Read', { file_path: '/w/s/a.ts' }))).toBe('Read /w/s/a.ts');
    expect(toolHeadline(make('Glob', { pattern: '**/*.tsx' }))).toBe('Glob **/*.tsx');
    expect(toolHeadline(make('Grep', { pattern: 'foo', glob: '*.ts' }))).toBe('Grep foo in *.ts');
    expect(toolHeadline(make('Edit', { file_path: '/w/s/a.ts' }))).toBe('Edit /w/s/a.ts');
    expect(toolHeadline(make('Write', { file_path: '/w/s/n.ts' }))).toBe('Write /w/s/n.ts');
    expect(toolHeadline(make('Bash', { command: 'bun test' }))).toBe('$ bun test');
    expect(toolHeadline(make('Task', { description: 'explore X' }))).toBe('Spawn agent: explore X');
    expect(toolHeadline(make('WebSearch', { query: 'hydration' }))).toBe('Search "hydration"');
    expect(toolHeadline(make('TodoWrite', { todos: [{}, {}, {}] }))).toBe('Update todos (3)');
  });

  test('falls back to tool name when fields missing', () => {
    expect(toolHeadline(make('Read', {}))).toBe('Read');
    expect(toolHeadline(make('UnknownTool', { foo: 'bar' }))).toBe('UnknownTool');
  });

  test('shortens long paths', () => {
    const h = toolHeadline(make('Read', { file_path: '/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s.ts' }));
    expect(h.length).toBeLessThanOrEqual('Read '.length + 64);
    expect(h).toContain('s.ts');
  });

  test('collapses multiline bash commands to one line', () => {
    expect(toolHeadline(make('Bash', { command: 'echo hi\nls\npwd' }))).toBe('$ echo hi ls pwd');
  });
});

describe('simpleDiff', () => {
  test('shared prefix is context; divergent suffix splits into del + add', () => {
    const rows = simpleDiff('a\nb\nc', 'a\nB\nC');
    expect(rows).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'del', text: 'c' },
      { kind: 'add', text: 'B' },
      { kind: 'add', text: 'C' },
    ]);
  });

  test('pure insert has no del rows', () => {
    const rows = simpleDiff('a\nb', 'a\nb\nc\nd');
    expect(rows).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'ctx', text: 'b' },
      { kind: 'add', text: 'c' },
      { kind: 'add', text: 'd' },
    ]);
  });

  test('pure delete has no add rows', () => {
    const rows = simpleDiff('a\nb\nc', 'a');
    expect(rows).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'del', text: 'c' },
    ]);
  });
});
