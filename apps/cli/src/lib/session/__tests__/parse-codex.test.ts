/**
 * Verifies parseCodex recovers the two event kinds that were silently dropped
 * before: apply_patch edits (response_item / custom_tool_call, NOT function_call)
 * and web searches (event_msg / web_search_end). Also checks the update_plan and
 * apply_patch summaries render cleanly. Fixtures are synthetic — no user data.
 */

import { describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseCodex, parseCodexContent, summarizeToolUse, applyPatchTargetPaths } from '../parse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '..', 'testdata', 'codex-custom-tools.jsonl');

describe('parseCodex apply_patch (custom_tool_call)', () => {
  test('recovers apply_patch as an Edit tool_use with the patched path', () => {
    const events = parseCodex(fixture);
    const edits = events.filter((e) => e.type === 'tool_use' && e.tool === 'Edit');
    // One Update File + one Add File apply_patch in the fixture.
    expect(edits).toHaveLength(2);
    expect(edits[0]).toMatchObject({ tool: 'Edit', path: '/tmp/proj/src/foo.ts' });
    expect(edits[0].args?.file_path).toBe('/tmp/proj/src/foo.ts');
    expect(edits[1]).toMatchObject({ tool: 'Edit', path: '/tmp/proj/src/bar.ts' });
  });

  test('pairs custom_tool_call_output into a tool_result carrying the Edit tool name', () => {
    const events = parseCodex(fixture);
    const results = events.filter((e) => e.type === 'tool_result' && e.tool === 'Edit');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ success: true });
    expect(results[0].output).toContain('Updated the following files');
  });

  // RUSH-1410: a single apply_patch body may touch many files — each must surface.
  test('multi-file apply_patch emits one Edit tool_use per file path', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: /tmp/proj/a.ts',
      '@@',
      '-a',
      '+A',
      '*** Add File: /tmp/proj/b.ts',
      '+export const b = 1;',
      '*** Delete File: /tmp/proj/c.ts',
      '*** End Patch',
    ].join('\n');
    expect(applyPatchTargetPaths(patch)).toEqual([
      '/tmp/proj/a.ts',
      '/tmp/proj/b.ts',
      '/tmp/proj/c.ts',
    ]);

    const content = JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-01T00:00:00Z',
      payload: {
        type: 'custom_tool_call',
        id: 'ctc_multi',
        call_id: 'call_multi',
        name: 'apply_patch',
        input: patch,
      },
    });
    const events = parseCodexContent(content);
    const edits = events.filter((e) => e.type === 'tool_use' && e.tool === 'Edit');
    expect(edits).toHaveLength(3);
    expect(edits.map((e) => e.path)).toEqual([
      '/tmp/proj/a.ts',
      '/tmp/proj/b.ts',
      '/tmp/proj/c.ts',
    ]);
  });
});

describe('parseCodex web search (event_msg / web_search_end)', () => {
  test('recovers exactly one WebSearch per search, carrying the query', () => {
    const events = parseCodex(fixture);
    const searches = events.filter((e) => e.type === 'tool_use' && e.tool === 'WebSearch');
    // web_search_call is ignored; only web_search_end emits (one per search).
    expect(searches).toHaveLength(1);
    expect(searches[0].args?.query).toBe('how to parse codex sessions 2026');
  });
});

describe('summarizeToolUse Codex additions', () => {
  test('apply_patch renders through the Edit summarizer with its path', () => {
    const events = parseCodex(fixture);
    const edit = events.find((e) => e.type === 'tool_use' && e.tool === 'Edit')!;
    expect(summarizeToolUse('Edit', edit.args)).toBe('Edit /tmp/proj/src/foo.ts');
  });

  test('update_plan summarizes as step count', () => {
    expect(summarizeToolUse('update_plan', { plan: [{ step: 'a' }, { step: 'b' }, { step: 'c' }] })).toBe(
      'Plan: 3 steps',
    );
    expect(summarizeToolUse('update_plan', { plan: [{ step: 'only' }] })).toBe('Plan: 1 step');
  });

  test('WebSearch summarizes with its query', () => {
    expect(summarizeToolUse('WebSearch', { query: 'codex sessions' })).toBe('WebSearch: codex sessions');
  });

  test('TodoWrite summarizes as progress + the current step (RUSH-1380)', () => {
    expect(
      summarizeToolUse('TodoWrite', {
        todos: [
          { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
          { content: 'Ship it', status: 'in_progress', activeForm: 'Shipping it' },
          { content: 'Verify', status: 'pending' },
        ],
      }),
    ).toBe('Plan 1/3: Shipping it');
    // No in-progress item ⇒ bare progress fraction.
    expect(
      summarizeToolUse('TodoWrite', {
        todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'completed' },
        ],
      }),
    ).toBe('Plan: 2/2 done');
    expect(summarizeToolUse('TodoWrite', { todos: [] })).toBe('Plan: 0 steps');
  });
});

describe('parseCodexContent update_plan (function_call)', () => {
  test('emits a tool_use for the plan tool', () => {
    const content = JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-01T00:00:00Z',
      payload: {
        type: 'function_call',
        name: 'update_plan',
        call_id: 'c1',
        arguments: '{"plan":[{"step":"one","status":"pending"}]}',
      },
    });
    const events = parseCodexContent(content);
    const plans = events.filter((e) => e.type === 'tool_use' && e.tool === 'update_plan');
    expect(plans).toHaveLength(1);
    expect(plans[0].args?.plan).toHaveLength(1);
  });
});
