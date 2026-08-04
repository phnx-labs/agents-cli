import { describe, it, expect } from 'vitest';
import {
  applyClaudeLine,
  finalizeClaudeScan,
  initClaudeParseState,
  serializeClaudeParserState,
  hydrateClaudeParseState,
} from './discover.js';

describe('Claude toolCallCount scan rollup', () => {
  it('counts tool_use blocks and survives serialize/hydrate', () => {
    const state = initClaudeParseState();
    applyClaudeLine(state, {
      type: 'assistant',
      timestamp: '2026-08-01T12:00:00.000Z',
      message: {
        id: 'msg_1',
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/a' } },
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    applyClaudeLine(state, {
      type: 'assistant',
      timestamp: '2026-08-01T12:00:01.000Z',
      message: {
        id: 'msg_2',
        content: [{ type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/tmp/a' } }],
      },
    });
    expect(state.toolCallCount).toBe(3);
    const scan = finalizeClaudeScan(state);
    expect(scan.toolCallCount).toBe(3);

    const snap = serializeClaudeParserState(state, 100);
    expect(snap.toolCallCount).toBe(3);
    const resumed = hydrateClaudeParseState(snap);
    expect(resumed.toolCallCount).toBe(3);
    applyClaudeLine(resumed, {
      type: 'assistant',
      timestamp: '2026-08-01T12:00:02.000Z',
      message: {
        id: 'msg_3',
        content: [{ type: 'tool_use', id: 't4', name: 'Write', input: { file_path: '/tmp/b' } }],
      },
    });
    expect(finalizeClaudeScan(resumed).toolCallCount).toBe(4);
  });
});
