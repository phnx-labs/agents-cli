/**
 * Verifies parseKimi normalizes Kimi's internal wire.jsonl session log into the
 * shared SessionEvent shape, and detectAgent routes Kimi session paths correctly.
 */

import { describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseKimi, detectAgent, parseSession } from '../parse.js';

function makeKimiSession(wireContent: string): string {
  const base = path.join(os.tmpdir(), `.kimi-code`, 'sessions', `kimi-parse-${Date.now()}-${Math.random()}`);
  const sessionDir = path.join(base, 'session_test-123e4567-e89b-12d3-a456-426614174000');
  const agentsDir = path.join(sessionDir, 'agents', 'main');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    title: 'Test session',
    createdAt: '2026-06-24T00:00:00.000Z',
  }));
  fs.writeFileSync(path.join(agentsDir, 'wire.jsonl'), wireContent);
  return path.join(sessionDir, 'state.json');
}

describe('parseKimi', () => {
  test('maps user append_message to message event', () => {
    const statePath = makeKimiSession(JSON.stringify({
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Hello Kimi' }],
      },
      time: 1750723200000,
    }));

    const events = parseKimi(statePath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'message',
      agent: 'kimi',
      role: 'user',
      content: 'Hello Kimi',
    });
  });

  test('maps assistant append_message to message event', () => {
    const statePath = makeKimiSession(JSON.stringify({
      type: 'context.append_message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there' }],
      },
      time: 1750723200000,
    }));

    const events = parseKimi(statePath);
    expect(events[0]).toMatchObject({
      type: 'message',
      agent: 'kimi',
      role: 'assistant',
      content: 'Hi there',
    });
  });

  test('maps content.part text to assistant message', () => {
    const statePath = makeKimiSession(JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        part: { type: 'text', text: 'Done.' },
      },
      time: 1750723200000,
    }));

    const events = parseKimi(statePath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'message',
      agent: 'kimi',
      role: 'assistant',
      content: 'Done.',
    });
  });

  test('maps content.part think to thinking event', () => {
    const statePath = makeKimiSession(JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        part: { type: 'think', think: 'Let me check...' },
      },
      time: 1750723200000,
    }));

    const events = parseKimi(statePath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'thinking',
      agent: 'kimi',
      content: 'Let me check...',
    });
  });

  test('maps Bash tool.call to tool_use with command', () => {
    const statePath = makeKimiSession(JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        toolCallId: 'tool_1',
        name: 'Bash',
        function: {
          name: 'Bash',
          arguments: JSON.stringify({ command: 'ls -la' }),
        },
      },
      time: 1750723200000,
    }));

    const events = parseKimi(statePath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_use',
      agent: 'kimi',
      tool: 'Bash',
      command: 'ls -la',
      args: { command: 'ls -la' },
    });
  });

  test('maps Read tool.call to tool_use with path', () => {
    const statePath = makeKimiSession(JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        toolCallId: 'tool_2',
        name: 'Read',
        function: {
          name: 'Read',
          arguments: JSON.stringify({ path: '/tmp/file.txt' }),
        },
      },
      time: 1750723200000,
    }));

    const events = parseKimi(statePath);
    expect(events[0]).toMatchObject({
      type: 'tool_use',
      agent: 'kimi',
      tool: 'Read',
      path: '/tmp/file.txt',
    });
  });

  test('maps tool.result to tool_result and correlates tool name', () => {
    const jsonl = [
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          toolCallId: 'tool_3',
          name: 'Bash',
          function: {
            name: 'Bash',
            arguments: JSON.stringify({ command: 'echo hi' }),
          },
        },
        time: 1750723200000,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          toolCallId: 'tool_3',
          result: { output: 'hi' },
        },
        time: 1750723200001,
      },
    ].map(o => JSON.stringify(o)).join('\n');

    const statePath = makeKimiSession(jsonl);
    const events = parseKimi(statePath);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'tool_result',
      agent: 'kimi',
      tool: 'Bash',
      success: true,
      output: 'hi',
    });
  });

  test('maps failed tool.result to error event', () => {
    const jsonl = [
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          toolCallId: 'tool_4',
          name: 'Bash',
          function: {
            name: 'Bash',
            arguments: JSON.stringify({ command: 'false' }),
          },
        },
        time: 1750723200000,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          toolCallId: 'tool_4',
          result: { output: 'Error: command failed', isError: true },
        },
        time: 1750723200001,
      },
    ].map(o => JSON.stringify(o)).join('\n');

    const statePath = makeKimiSession(jsonl);
    const events = parseKimi(statePath);
    expect(events[1]).toMatchObject({
      type: 'error',
      agent: 'kimi',
      tool: 'Bash',
      success: false,
    });
  });

  // Tests for the event.args shape (real Kimi wire format as of 2026-06)
  test('maps Bash tool.call with event.args shape to tool_use with command', () => {
    const statePath = makeKimiSession(JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        uuid: 'tool_bash_001',
        toolCallId: 'tool_bash_001',
        name: 'Bash',
        args: { command: 'ls -la /tmp', cwd: '/tmp' },
      },
      time: 1750723200000,
    }));

    const events = parseKimi(statePath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_use',
      agent: 'kimi',
      tool: 'Bash',
      command: 'ls -la /tmp',
      args: { command: 'ls -la /tmp', cwd: '/tmp' },
    });
  });

  test('maps Read tool.call with event.args shape to tool_use with path', () => {
    const statePath = makeKimiSession(JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        uuid: 'tool_read_002',
        toolCallId: 'tool_read_002',
        name: 'Read',
        args: { path: '/tmp/testfile.txt' },
      },
      time: 1750723200001,
    }));

    const events = parseKimi(statePath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_use',
      agent: 'kimi',
      tool: 'Read',
      path: '/tmp/testfile.txt',
      args: { path: '/tmp/testfile.txt' },
    });
    expect((events[0] as any).command).toBeUndefined();
  });

  test('parses kimi-tool-args.jsonl fixture via event.args shape', () => {
    const fixturePath = path.join(__dirname, '..', 'testdata', 'kimi-tool-args.jsonl');
    const wireContent = fs.readFileSync(fixturePath, 'utf-8');
    const statePath = makeKimiSession(wireContent);

    const events = parseKimi(statePath);
    const toolEvents = events.filter(e => e.type === 'tool_use') as any[];
    expect(toolEvents.length).toBeGreaterThanOrEqual(3);

    const bash = toolEvents.find(e => e.tool === 'Bash');
    expect(bash).toBeDefined();
    expect(bash.command).toBe('ls -la /tmp');
    expect(bash.args.cwd).toBe('/tmp');

    const read = toolEvents.find(e => e.tool === 'Read');
    expect(read).toBeDefined();
    expect(read.path).toBe('/tmp/testfile.txt');
  });

  test('maps usage.record to usage event', () => {
    const statePath = makeKimiSession(JSON.stringify({
      type: 'usage.record',
      usage: {
        inputOther: 100,
        output: 50,
      },
      model: 'kimi-code/kimi-for-coding',
      time: 1750723200000,
    }));

    const events = parseKimi(statePath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'usage',
      agent: 'kimi',
      model: 'kimi-code/kimi-for-coding',
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  test('returns empty array when wire.jsonl is missing', () => {
    const base = path.join(os.tmpdir(), `kimi-parse-missing-${Date.now()}`);
    const sessionDir = path.join(base, 'session_test-123e4567-e89b-12d3-a456-426614174000');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({}));

    const events = parseKimi(path.join(sessionDir, 'state.json'));
    expect(events).toEqual([]);
  });
});

describe('detectAgent routes kimi paths', () => {
  test('local ~/.kimi-code/ state.json path', () => {
    expect(detectAgent('/home/me/.kimi-code/sessions/wd_foo/session_abc/state.json')).toBe('kimi');
  });

  test('parseSession dispatches through detectAgent for kimi', () => {
    const statePath = makeKimiSession(JSON.stringify({
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'hi from kimi' }],
      },
      time: 1750723200000,
    }));

    const events = parseSession(statePath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agent: 'kimi',
      type: 'message',
      role: 'user',
      content: 'hi from kimi',
    });
  });
});
