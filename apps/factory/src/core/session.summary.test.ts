import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractSessionQuickDetails, extractSessionQuickSummary } from './session.summary';

function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, 'testdata', name), 'utf8');
}

describe('extractSessionQuickSummary', () => {
  test('parses Claude session summary details', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/a.ts' } },
            { type: 'tool_use', name: 'WebSearch', input: { query: 'foo' } },
            { type: 'tool_use', name: 'mcp__Swarm__status', input: {} },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        tool_use_result: {
          type: 'create',
          filePath: '/repo/src/new.ts',
        },
      }),
      JSON.stringify({
        type: 'result',
        usage: {
          server_tool_use: {
            web_search_requests: 2,
            web_fetch_requests: 1,
          },
        },
      }),
    ];

    const summary = extractSessionQuickSummary(lines.join('\n'), 'claude');
    expect(summary.filesEdited).toBe(2);
    expect(summary.filesCreated).toBe(1);
    expect(summary.toolCalls).toBe(3);
    expect(summary.webSearches).toBe(2);
    expect(summary.webFetches).toBe(1);
    expect(summary.mcpCalls).toBe(1);
  });

  test('parses Codex function calls with JSON-string arguments', () => {
    const lines = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'write_file',
          arguments: '{"path":"src/a.ts"}',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'read_file',
          arguments: '{"path":"src/a.ts"}',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'web_search',
          arguments: '{"query":"terminal colors"}',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'mcp__Swarm__status',
          arguments: '{}',
        },
      }),
    ];

    const summary = extractSessionQuickSummary(lines.join('\n'), 'codex');
    expect(summary.filesEdited).toBe(1);
    expect(summary.filesRead).toBe(1);
    expect(summary.toolCalls).toBe(4);
    expect(summary.webSearches).toBe(1);
    expect(summary.mcpCalls).toBe(1);
  });

  test('parses Gemini tool calls', () => {
    const lines = [
      JSON.stringify({
        type: 'tool_use',
        tool_name: 'write_file',
        parameters: { file_path: 'src/b.ts' },
      }),
      JSON.stringify({
        type: 'tool_call',
        tool_name: 'run_shell_command',
        parameters: { command: 'ls -la' },
      }),
      JSON.stringify({
        type: 'tool_use',
        tool_name: 'web_fetch',
        parameters: { url: 'https://example.com' },
      }),
      JSON.stringify({
        type: 'tool_use',
        tool_name: 'mcp__linear__issues',
        parameters: {},
      }),
      JSON.stringify({
        type: 'tool_call',
        tool_name: 'delete_file',
        parameters: { file_path: 'src/old.ts' },
      }),
    ];

    const summary = extractSessionQuickSummary(lines.join('\n'), 'gemini');
    expect(summary.filesEdited).toBe(2);
    expect(summary.filesDeleted).toBe(1);
    expect(summary.toolCalls).toBe(5);
    expect(summary.webFetches).toBe(1);
    expect(summary.mcpCalls).toBe(1);
  });

  test('captures Claude tool calls with inputs and matches results by id', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'ls -la' } },
            { type: 'tool_use', id: 'tool_2', name: 'Read', input: { file_path: '/repo/a.ts' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool_1', content: 'total 8\nfile.txt' },
            { type: 'tool_result', tool_use_id: 'tool_2', content: [{ type: 'text', text: 'export const x = 1' }], is_error: false },
          ],
        },
      }),
    ];

    const details = extractSessionQuickDetails(lines.join('\n'), 'claude');
    expect(details.recentToolCalls.length).toBe(2);
    const read = details.recentToolCalls[0];
    expect(read.name).toBe('Read');
    expect(read.output).toBe('export const x = 1');
    const bash = details.recentToolCalls[1];
    expect(bash.name).toBe('Bash');
    expect(bash.output).toBe('total 8\nfile.txt');
    expect((bash.input as { command: string }).command).toBe('ls -la');
  });

  test('interleaves Claude prose, thinking, and tool calls into recent events', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-13T08:00:00.000Z',
        message: {
          content: [
            { type: 'text', text: 'Reading the sidebar model before changing the renderer.' },
            { type: 'thinking', thinking: 'The timeline needs one event stream, not a second prose panel.' },
            { type: 'tool_use', id: 'tool_read', name: 'Read', input: { file_path: '/repo/Timeline.tsx' } },
          ],
        },
      }),
    ];

    const details = extractSessionQuickDetails(lines.join('\n'), 'claude');
    expect(details.recentToolCalls).toHaveLength(1);
    expect(details.recentEvents.map((event) => event.kind)).toEqual(['tool', 'reasoning', 'message']);
    expect(details.recentEvents[0]).toMatchObject({
      kind: 'tool',
      call: { name: 'Read', input: { file_path: '/repo/Timeline.tsx' } },
      timestamp: '2026-07-13T08:00:00.000Z',
    });
    expect(details.recentEvents[1]).toMatchObject({
      kind: 'reasoning',
      text: 'The timeline needs one event stream, not a second prose panel.',
    });
    expect(details.recentEvents[2]).toMatchObject({
      kind: 'message',
      text: 'Reading the sidebar model before changing the renderer.',
    });
  });

  test('captures Codex tool calls with outputs by call_id', () => {
    const lines = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell',
          arguments: '{"command":"echo hi"}',
          call_id: 'call_abc',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_abc',
          output: 'hi',
        },
      }),
    ];

    const details = extractSessionQuickDetails(lines.join('\n'), 'codex');
    expect(details.recentToolCalls.length).toBe(1);
    expect(details.recentToolCalls[0].name).toBe('shell');
    expect(details.recentToolCalls[0].output).toBe('hi');
  });

  test('interleaves Codex reasoning summaries with function calls', () => {
    const lines = [
      JSON.stringify({
        timestamp: '2026-07-13T08:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Inspecting how the progress data crosses into React.' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-13T08:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'read_file',
          arguments: '{"path":"ui/settings/types/index.ts"}',
          call_id: 'call_read',
        },
      }),
    ];

    const details = extractSessionQuickDetails(lines.join('\n'), 'codex');
    expect(details.recentToolCalls).toHaveLength(1);
    expect(details.recentEvents.map((event) => event.kind)).toEqual(['tool', 'reasoning']);
    expect(details.recentEvents[0]).toMatchObject({
      kind: 'tool',
      call: { name: 'read_file', input: { path: 'ui/settings/types/index.ts' } },
      timestamp: '2026-07-13T08:00:05.000Z',
    });
    expect(details.recentEvents[1]).toMatchObject({
      kind: 'reasoning',
      text: 'Inspecting how the progress data crosses into React.',
      timestamp: '2026-07-13T08:00:00.000Z',
    });
  });

  test('parses Codex custom apply_patch calls into edited files', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '@@',
      '-old',
      '+new',
      '*** Add File: src/new.ts',
      '+export const value = 1;',
      '*** Delete File: src/old.ts',
      '*** End Patch',
    ].join('\n');

    const lines = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: 'call_patch',
          input: patch,
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_patch',
          output: 'patched',
        },
      }),
    ];

    const details = extractSessionQuickDetails(lines.join('\n'), 'codex');
    expect(details.summary.toolCalls).toBe(1);
    expect(details.summary.filesEdited).toBe(3);
    expect(details.summary.filesCreated).toBe(1);
    expect(details.summary.filesDeleted).toBe(1);
    expect(details.recentFiles).toContain('src/a.ts');
    expect(details.recentFiles).toContain('src/new.ts');
    expect(details.recentFiles).toContain('src/old.ts');
    expect(details.recentToolCalls[0].name).toBe('apply_patch');
    expect(details.recentToolCalls[0].output).toBe('patched');
  });

  test('marks tool errors', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool_err', name: 'Bash', input: { command: 'false' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool_err', content: 'exit 1', is_error: true },
          ],
        },
      }),
    ];

    const details = extractSessionQuickDetails(lines.join('\n'), 'claude');
    expect(details.recentToolCalls[0].isError).toBe(true);
    expect(details.recentToolCalls[0].output).toBe('exit 1');
  });

  test('extracts Claude prompt attachments with preview metadata', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-12T10:00:00Z',
        message: {
          content: [
            { type: 'text', text: 'Here is the failing Factory screen.' },
            {
              type: 'image',
              name: 'factory-floor.png',
              source: {
                type: 'file',
                path: '/home/muqsit/.agents/.history/attachments/factory-floor.png',
                media_type: 'image/png',
                sizeBytes: 12345,
              },
            },
          ],
        },
      }),
    ];

    const details = extractSessionQuickDetails(lines.join('\n'), 'claude');
    expect(details.attachments).toEqual([
      {
        path: '/home/muqsit/.agents/.history/attachments/factory-floor.png',
        label: 'factory-floor.png',
        mediaType: 'image/png',
        sizeBytes: 12345,
      },
    ]);
  });

  test('ignores malformed lines', () => {
    const content = [
      'not-json',
      JSON.stringify({ type: 'response_item', payload: { type: 'reasoning' } }),
      '',
    ].join('\n');

    const summary = extractSessionQuickSummary(content, 'codex');
    expect(summary.filesEdited).toBe(0);
    expect(summary.toolCalls).toBe(0);
    expect(summary.webSearches).toBe(0);
    expect(summary.mcpCalls).toBe(0);
  });

  test('returns recent files and tools in recency order', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/a.ts' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/b.ts' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/c.ts' } },
            { type: 'tool_use', name: 'WebSearch', input: { query: 'foo' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/b.ts' } },
          ],
        },
      }),
    ];

    const details = extractSessionQuickDetails(lines.join('\n'), 'claude');
    expect(details.lastFilePath).toBe('/repo/src/b.ts');
    expect(details.recentFiles[0]).toBe('/repo/src/b.ts');
    expect(details.recentFiles[1]).toBe('/repo/src/c.ts');
    expect(details.recentTools[0]).toBe('Edit');
    expect(details.recentTools[1]).toBe('WebSearch');
    expect(details.recentTools[2]).toBe('Read');
  });
});

describe('narrative extraction', () => {
  test('Claude: narrative is the last assistant prose, not the trailing tool/thinking turn', () => {
    const details = extractSessionQuickDetails(fixture('narrative-claude.jsonl'), 'claude');
    expect(details.narrative).toBe('Now updating the config to add the narrative field before the tool call runs.');
  });

  test('Codex: narrative is the last output_text message, not the apply_patch call', () => {
    const details = extractSessionQuickDetails(fixture('narrative-codex.jsonl'), 'codex');
    expect(details.narrative).toBe('Found the off-by-one in the loop bound; patching parser.ts now.');
  });

  test('Gemini: narrative is the last assistant message content, not the tool call', () => {
    const details = extractSessionQuickDetails(fixture('narrative-gemini.jsonl'), 'gemini');
    expect(details.narrative).toBe('Wiring the alias into vite.config.ts so the webview bundle resolves the shared model.');
  });

  test('narrative is empty when the session has no assistant prose', () => {
    const toolOnly = extractSessionQuickDetails(fixture('claude-session.jsonl'), 'claude');
    expect(toolOnly.narrative).toBe('');
    expect(extractSessionQuickDetails('', 'claude').narrative).toBe('');
  });

  test('narrative truncates long prose at a word boundary', () => {
    const long = 'word '.repeat(80).trim();
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: long }] },
    });
    const details = extractSessionQuickDetails(line, 'claude');
    expect(details.narrative.length).toBeLessThanOrEqual(163);
    expect(details.narrative.endsWith('...')).toBe(true);
    expect(details.narrative).not.toContain('wor.');
  });
});
