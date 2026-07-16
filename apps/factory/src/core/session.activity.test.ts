import { describe, test, expect } from 'bun:test';
import { todoProgressFromCli } from './session.activity';

// todoProgressFromCli maps the CLI's computed checklist (`agents sessions <id>
// --json` → `session.todos`, shape { items: [{content,status,activeForm}], done,
// total }) into the panel's TodoProgress. The extension no longer re-parses the
// transcript for todos (RUSH-1503) — the CLI state engine is the one source.
function cliTodos(
  items: Array<{ content?: string; status?: string; activeForm?: string }>,
  done = 0,
  total = items.length,
): unknown {
  return { items, done, total };
}

describe('todoProgressFromCli', () => {
  test('maps items and recomputes done/total from statuses', () => {
    const p = todoProgressFromCli(cliTodos([
      { content: 'Scaffold', status: 'completed' },
      { content: 'Wire mapper', status: 'completed' },
      { content: 'Write tests', status: 'in_progress' },
      { content: 'Open PR', status: 'pending' },
    ], /* stale tally */ 99, 99));
    expect(p).not.toBeNull();
    expect(p!.total).toBe(4);
    expect(p!.done).toBe(2); // recomputed from items, not the bogus 99 tally
    expect(p!.todos[2]).toEqual({ content: 'Write tests', status: 'in_progress' });
  });

  test('carries activeForm when the CLI item includes it', () => {
    const p = todoProgressFromCli(cliTodos([
      { content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
    ]));
    expect(p!.todos[0].activeForm).toBe('Running tests');
  });

  test('normalizes unknown/missing status to pending', () => {
    const p = todoProgressFromCli(cliTodos([
      { content: 'x', status: 'bogus' },
      { content: 'y' },
    ]));
    expect(p!.done).toBe(0);
    expect(p!.todos.every(t => t.status === 'pending')).toBe(true);
  });

  test('drops contentless items', () => {
    const p = todoProgressFromCli(cliTodos([
      { status: 'completed' },
      { content: '  ', status: 'pending' },
      { content: 'Real', status: 'pending' },
    ]));
    expect(p!.total).toBe(1);
    expect(p!.todos[0].content).toBe('Real');
  });

  test('returns null for an empty list, no items, or a non-object payload', () => {
    expect(todoProgressFromCli(cliTodos([]))).toBeNull();
    expect(todoProgressFromCli({ done: 0, total: 0 })).toBeNull();
    expect(todoProgressFromCli(undefined)).toBeNull();
    expect(todoProgressFromCli(null)).toBeNull();
    expect(todoProgressFromCli('nope')).toBeNull();
  });
});
