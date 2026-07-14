import { describe, test, expect } from 'bun:test';
import { extractTodoProgress } from './session.activity';

function claudeText(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}
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

  test('a latest empty TodoWrite clears an older checklist', () => {
    const content = [
      claudeTodo([{ content: 'old task', status: 'completed' }]),
      claudeTodo([]),
    ].join('\n');
    expect(extractTodoProgress(content, 'claude')).toBeNull();
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

  test('a latest empty update_plan clears an older checklist', () => {
    const content = [
      codexPlan([{ step: 'old task', status: 'completed' }]),
      codexPlan([]),
    ].join('\n');
    expect(extractTodoProgress(content, 'codex')).toBeNull();
  });

  test('no update_plan → null', () => {
    const line = JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } });
    expect(extractTodoProgress(line, 'codex')).toBeNull();
  });
});
