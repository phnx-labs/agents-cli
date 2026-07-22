import { describe, expect, it } from 'vitest';
import { makeStreamRenderer } from './stream-render.js';

describe('makeStreamRenderer', () => {
  it('renders Claude messages, tool uses, and elided tool results as compact lines', () => {
    const render = makeStreamRenderer('claude', '/repo');

    const msg = render(JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-22T14:32:07.000',
      message: { content: [{ type: 'text', text: 'Let me check the follow paths...' }] },
    }));
    expect(msg).toContain('14:32:07');
    expect(msg).toContain('· claude');
    expect(msg).toContain('Let me check the follow paths...');

    const use = render(JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-22T14:32:08.000',
      message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'rg -n "follow" src/' } }] },
    }));
    expect(use).toContain('14:32:08');
    expect(use).toContain('→');
    expect(use).toContain('Bash');
    expect(use).toContain('rg -n "follow" src/');

    const result = render(JSON.stringify({
      type: 'user',
      timestamp: '2026-07-22T14:32:14.000',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'one\ntwo\nthree' }] },
    }));
    expect(result).toContain('14:32:14');
    expect(result).toContain('✓');
    expect(result).toContain('Bash');
    expect(result).toContain('(result elided — 3 lines)');
    expect(result).not.toContain('one');
    expect(result).not.toContain('two');
  });

  it('renders Codex tool calls and hides reasoning/init events', () => {
    const render = makeStreamRenderer('codex', '/repo');

    expect(render(JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-07-22T14:32:00.000',
      payload: { cli_version: '0.134.0', cwd: '/repo' },
    }))).toBeNull();

    expect(render(JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-22T14:32:01.000',
      payload: { type: 'reasoning', summary: [{ text: 'private chain' }] },
    }))).toBeNull();

    const use = render(JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-22T14:32:09.000',
      payload: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'call_1',
        input: '*** Begin Patch\n*** Update File: apps/cli/src/commands/sessions-tail.ts\n@@\n-old\n+new\n*** End Patch',
      },
    }));
    expect(use).toContain('14:32:09');
    expect(use).toContain('→');
    expect(use).toContain('Edit');
    expect(use).toContain('apps/cli/src/commands/sessions-tail.ts');

    const result = render(JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-22T14:32:15.000',
      payload: { type: 'custom_tool_call_output', call_id: 'call_1', output: 'patched\nwith details' },
    }));
    expect(result).toContain('14:32:15');
    expect(result).toContain('✓');
    expect(result).toContain('Edit');
    expect(result).toContain('(result elided — 2 lines)');
    expect(result).not.toContain('patched');
  });

  it('renders user messages distinctly and hides usage/result events', () => {
    const render = makeStreamRenderer('claude');

    const user = render(JSON.stringify({
      type: 'user',
      timestamp: '2026-07-22T14:32:06.000',
      message: { content: 'Please inspect the live tail path.' },
    }));
    expect(user).toContain('14:32:06');
    expect(user).toContain('» you');
    expect(user).toContain('Please inspect the live tail path.');

    expect(render(JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-22T14:32:07.000',
      message: {
        content: [],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    }))).toBeNull();

    expect(render(JSON.stringify({
      type: 'result',
      timestamp: '2026-07-22T14:32:08.000',
      subtype: 'success',
    }))).toBeNull();
  });
});
