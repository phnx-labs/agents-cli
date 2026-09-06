import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaudeContent, parseCodexItemsContent, parseGrok, parseKimi, readGrokSignals } from './parse.js';

const TESTDATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata');

/**
 * Every harness writes a human label per tool call, and several write their own
 * outcome and file ledger. The parser dropped all of it, so the timeline had
 * nothing to render a now-line from and had to re-derive what the harness
 * already knew (PHNX-3939).
 */
describe('Claude: the label, the denial, and the file ledger', () => {
  const record = (obj: unknown): string => `${JSON.stringify(obj)}\n`;

  it('keeps the description Claude writes on a Bash call', () => {
    const events = parseClaudeContent(record({
      type: 'assistant', timestamp: '2026-09-06T00:00:00.000Z',
      message: { role: 'assistant', content: [{
        type: 'tool_use', id: 'tu1', name: 'Bash',
        input: { command: 'ls -la /repo', description: 'Locate the prior session transcript on disk' },
      }] },
    }));
    expect(events[0]).toMatchObject({
      type: 'tool_use', tool: 'Bash',
      label: 'Locate the prior session transcript on disk',
      command: 'ls -la /repo',
    });
  });

  it('leaves label unset when the harness wrote none', () => {
    const events = parseClaudeContent(record({
      type: 'assistant', timestamp: '2026-09-06T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/repo/a.ts' } }] },
    }));
    expect(events[0].label).toBeUndefined();
  });

  it('marks a permission-denied result blocked, and an ordinary error not', () => {
    const denied = parseClaudeContent(record({
      type: 'user', timestamp: '2026-09-06T00:00:01.000Z', toolDenialKind: 'permission-rule',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'Permission to use Bash has been denied.' }] },
    }));
    expect(denied[0]).toMatchObject({ type: 'error', blocked: true });

    const errored = parseClaudeContent(record({
      type: 'user', timestamp: '2026-09-06T00:00:01.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'exit 2' }] },
    }));
    expect(errored[0].blocked).toBeUndefined();
  });

  it('emits the file ledger ONLY when asked, so the published stream is unchanged', () => {
    const line = record({ type: 'file-history-delta', timestamp: '2026-09-06T00:00:02.000Z', trackingPath: 'src/index.ts' });
    expect(parseClaudeContent(line)).toEqual([]);
    expect(parseClaudeContent(line, { includeFileHistory: true })).toEqual([{
      type: 'file_change', agent: 'claude', timestamp: '2026-09-06T00:00:02.000Z',
      changes: [{ path: 'src/index.ts', op: 'modified' }],
    }]);
  });
});

describe('Codex: the typed item stream', () => {
  const CODEX_ITEMS = path.join(TESTDATA, 'timeline-codex-items.jsonl');
  const item = (it: unknown, timestamp = '2026-09-06T00:00:00.000Z'): string =>
    `${JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'item_completed', item: it } })}\n`;

  it('reads commentary, the parsed command class, the exit code and the file ledger', () => {
    const events = parseCodexItemsContent(
      item({ type: 'AgentMessage', id: 'm1', phase: 'commentary', content: [{ type: 'Text', text: 'Auditing the deck files.' }] })
      + item({ type: 'CommandExecution', id: 'c1', command: ['/bin/zsh', '-lc', 'rg TODO src'], parsed_cmd: [{ type: 'search' }], status: 'completed', exit_code: 0 })
      + item({ type: 'FileChange', id: 'f1', changes: { '/repo/plan.md': { type: 'add' }, '/repo/src/a.ts': { type: 'update' }, '/repo/old.ts': { type: 'delete' } } }),
    );
    expect(events[0]).toMatchObject({ type: 'message', role: 'assistant', phase: 'commentary', content: 'Auditing the deck files.' });
    expect(events[1]).toMatchObject({ type: 'tool_use', tool: 'Bash', verbClass: 'read', command: 'rg TODO src', label: 'rg TODO src' });
    expect(events[2]).toMatchObject({ type: 'tool_result', outcome: 'ok', exitCode: 0 });
    expect(events[3]).toMatchObject({ type: 'file_change', changes: [
      { path: '/repo/plan.md', op: 'created' },
      { path: '/repo/src/a.ts', op: 'modified' },
      { path: '/repo/old.ts', op: 'deleted' },
    ] });
  });

  it('separates a real command failure from a search that matched nothing', () => {
    const real = parseCodexItemsContent(item({ type: 'CommandExecution', id: 'c1', command: 'bun run build', exit_code: 2, status: 'completed' }));
    expect(real.find((e) => e.type === 'error')).toBeDefined();
    const empty = parseCodexItemsContent(item({ type: 'CommandExecution', id: 'c2', command: 'rg nothing src', exit_code: 1, status: 'completed' }));
    expect(empty.find((e) => e.type === 'error')).toBeUndefined();
  });

  it('reads web search, sub-agent starts, image views and compaction', () => {
    const events = parseCodexItemsContent(
      item({ type: 'Extension', id: 'e1', kind: 'web.search', query: 'codex credential storage' })
      + item({ type: 'SubAgentActivity', id: 's1', kind: 'started', agent_path: '/root/account_security_review' })
      + item({ type: 'SubAgentActivity', id: 's2', kind: 'completed', agent_path: '/root/account_security_review' })
      + item({ type: 'ImageView', id: 'i1', path: 'file:///repo/shot.png' })
      + item({ type: 'ContextCompaction', id: 'x1' }),
    );
    expect(events.map((e) => [e.type, e.verbClass ?? e.hookName])).toEqual([
      ['tool_use', 'browser'],
      ['tool_use', 'agent'],
      ['tool_use', 'read'],
      ['hook', 'ContextCompaction'],
    ]);
    expect(events[1].label).toContain('root/account_security_review');
  });

  it('folds an unknown item type to a counted `other` call instead of throwing', () => {
    const events = parseCodexItemsContent(item({ type: 'SomeFutureItem', id: 'z1', payload: { anything: true } }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'tool_use', tool: 'SomeFutureItem', verbClass: 'other' });
  });

  it('reads an aborted turn as an interruption', () => {
    const events = parseCodexItemsContent(`${JSON.stringify({ type: 'event_msg', timestamp: '2026-09-06T00:00:00.000Z', payload: { type: 'turn_aborted' } })}\n`);
    expect(events[0]).toMatchObject({ type: 'interrupt', content: 'Turn interrupted by user' });
  });

  it('reads a real rollout without emitting the response_item stream twice', () => {
    // The fixture is the item stream ONLY. `parseCodexContent` reads
    // `response_item` records, which describe the same turn — parsing a rollout
    // with both readers and concatenating would double every tool call, which is
    // exactly why this reader is separate.
    const events = parseCodexItemsContent(fs.readFileSync(CODEX_ITEMS, 'utf8'));
    expect(events.length).toBeGreaterThan(50);
    expect(events.filter((e) => e.type === 'tool_use').every((e) => Boolean(e.label))).toBe(true);
    expect(events.some((e) => e.type === 'message' && e.phase === 'commentary')).toBe(true);
    expect(events.some((e) => e.type === 'file_change')).toBe(true);
  });
});

describe('Kimi and OpenCode: the per-call description', () => {
  it('keeps the description Kimi writes on the wire event', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-kimi-label-'));
    const wire = path.join(dir, 'agents', 'main');
    fs.mkdirSync(wire, { recursive: true });
    fs.writeFileSync(path.join(wire, 'wire.jsonl'), `${JSON.stringify({
      type: 'context.append_loop_event', time: Date.UTC(2026, 8, 6),
      event: { type: 'tool.call', name: 'Bash', toolCallId: 'k1', description: 'List the worktrees', args: { command: 'git worktree list' } },
    })}\n`);
    try {
      const events = parseKimi(path.join(dir, 'state.json'));
      expect(events[0]).toMatchObject({ type: 'tool_use', tool: 'Bash', label: 'List the worktrees' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Grok: the counters it keeps beside the transcript', () => {
  it('reads signals.json for the milestones the event stream cannot report', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-grok-signals-'));
    try {
      const history = path.join(dir, 'chat_history.jsonl');
      fs.writeFileSync(history, '');
      fs.writeFileSync(path.join(dir, 'signals.json'), JSON.stringify({
        gitCommitCount: 2, prCreatedCount: 1, prMergedCount: 0, toolFailureCount: 3, toolCallCount: 51,
      }));
      expect(readGrokSignals(history)).toEqual({
        gitCommitCount: 2, prCreatedCount: 1, prMergedCount: 0, toolFailureCount: 3,
      });
      // The transcript still parses on its own; signals are a separate read.
      expect(parseGrok(history)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined rather than zeros when the file is absent', () => {
    expect(readGrokSignals(path.join(os.tmpdir(), 'no-such-grok-session', 'chat_history.jsonl'))).toBeUndefined();
  });
});
