// detectWaitingForInput — the NEEDS YOU classifier for local terminal tabs.
// The prose trailing-"?" heuristic decays after PROSE_QUESTION_FRESH_MS so a
// finished session that signed off with "anything else?" doesn't sit in NEEDS
// YOU forever (RUSH-1522); the structural AskUserQuestion signal never decays.
import { describe, test, expect } from 'bun:test';
import { detectWaitingForInput, PROSE_QUESTION_FRESH_MS, extractTodoProgress } from './session.activity';

const NOW = Date.parse('2026-06-30T12:00:00.000Z');
const fresh = { lastWriteMs: NOW - 60_000, nowMs: NOW };
const stale = { lastWriteMs: NOW - PROSE_QUESTION_FRESH_MS - 60_000, nowMs: NOW };

function claudeText(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}
function claudeAsk(): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Prod or staging?' }] } }] },
  });
}
function codexMsg(text: string): string {
  return JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text }] } });
}

describe('detectWaitingForInput — prose question freshness decay (RUSH-1522)', () => {
  test('a fresh trailing prose question is waiting', () => {
    expect(detectWaitingForInput(claudeText('Prod or staging?'), 'claude', fresh)).toBe(true);
  });

  test('a stale trailing prose question decays to not-waiting', () => {
    expect(detectWaitingForInput(claudeText('All done. Anything else you need?'), 'claude', stale)).toBe(false);
  });

  test('no freshness context keeps the prose question waiting (caller has no mtime)', () => {
    expect(detectWaitingForInput(claudeText('Prod or staging?'), 'claude')).toBe(true);
  });

  test('a structural AskUserQuestion never decays', () => {
    expect(detectWaitingForInput(claudeAsk(), 'claude', stale)).toBe(true);
  });

  test('a finished session (statement, no question) is never waiting, fresh or stale', () => {
    expect(detectWaitingForInput(claudeText('Done — everything is merged.'), 'claude', fresh)).toBe(false);
    expect(detectWaitingForInput(claudeText('Done — everything is merged.'), 'claude', stale)).toBe(false);
  });

  test('codex prose questions decay the same way', () => {
    expect(detectWaitingForInput(codexMsg('Which option do you prefer?'), 'codex', fresh)).toBe(true);
    expect(detectWaitingForInput(codexMsg('Which option do you prefer?'), 'codex', stale)).toBe(false);
  });

  test('a user reply after the question clears waiting regardless of freshness', () => {
    const content = [claudeText('Prod or staging?'), JSON.stringify({ type: 'user', message: { content: 'prod' } })].join('\n');
    expect(detectWaitingForInput(content, 'claude', fresh)).toBe(false);
  });
});

// extractTodoProgress — the fine-grained plan/progress the live feed rides off the
// per-task detail STREAM (transcript tail), not the floor poll. Claude emits
// TodoWrite tool_use; Codex emits an update_plan function_call. Latest write wins.
function claudeTodo(todos: Array<{ content: string; status?: string; activeForm?: string }>): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos } }] },
  });
}
function codexPlan(plan: Array<{ step: string; status?: string }>): string {
  return JSON.stringify({
    type: 'response_item',
    payload: { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan }) },
  });
}

describe('extractTodoProgress — Claude TodoWrite', () => {
  test('counts pending / in_progress / completed into done/total', () => {
    const p = extractTodoProgress(claudeTodo([
      { content: 'Scaffold', status: 'completed' },
      { content: 'Wire extractor', status: 'completed' },
      { content: 'Write tests', status: 'in_progress' },
      { content: 'Open PR', status: 'pending' },
    ]), 'claude');
    expect(p).not.toBeNull();
    expect(p!.total).toBe(4);
    expect(p!.done).toBe(2);
    expect(p!.todos[2]).toEqual({ content: 'Write tests', status: 'in_progress' });
  });

  test('the LATEST TodoWrite fully supersedes earlier ones', () => {
    const content = [
      claudeText('working on it'),
      claudeTodo([{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }]),
      claudeTodo([{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }, { content: 'c', status: 'pending' }]),
    ].join('\n');
    const p = extractTodoProgress(content, 'claude');
    expect(p!.total).toBe(3);
    expect(p!.done).toBe(2);
  });

  test('carries activeForm when the write includes it', () => {
    const p = extractTodoProgress(claudeTodo([
      { content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
    ]), 'claude');
    expect(p!.todos[0].activeForm).toBe('Running tests');
  });

  test('normalizes unknown/missing status to pending', () => {
    const p = extractTodoProgress(claudeTodo([{ content: 'x', status: 'bogus' }, { content: 'y' }]), 'claude');
    expect(p!.done).toBe(0);
    expect(p!.todos.every(t => t.status === 'pending')).toBe(true);
  });

  test('no TodoWrite in the transcript → null', () => {
    expect(extractTodoProgress(claudeText('just thinking out loud'), 'claude')).toBeNull();
  });

  test('an empty todos array → null (nothing to show)', () => {
    expect(extractTodoProgress(claudeTodo([]), 'claude')).toBeNull();
  });

  test('gemini has no todo tool → null', () => {
    expect(extractTodoProgress(claudeTodo([{ content: 'x', status: 'pending' }]), 'gemini')).toBeNull();
  });
});

describe('extractTodoProgress — Codex update_plan', () => {
  test('parses plan steps + status into the same shape', () => {
    const p = extractTodoProgress(codexPlan([
      { step: 'Read the code', status: 'completed' },
      { step: 'Make the change', status: 'in_progress' },
      { step: 'Verify', status: 'pending' },
    ]), 'codex');
    expect(p!.total).toBe(3);
    expect(p!.done).toBe(1);
    expect(p!.todos[1]).toEqual({ content: 'Make the change', status: 'in_progress' });
  });

  test('the latest update_plan wins', () => {
    const content = [
      codexPlan([{ step: 'a', status: 'pending' }]),
      codexPlan([{ step: 'a', status: 'completed' }, { step: 'b', status: 'in_progress' }]),
    ].join('\n');
    const p = extractTodoProgress(content, 'codex');
    expect(p!.total).toBe(2);
    expect(p!.done).toBe(1);
  });

  test('no update_plan → null', () => {
    const line = JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } });
    expect(extractTodoProgress(line, 'codex')).toBeNull();
  });
});
