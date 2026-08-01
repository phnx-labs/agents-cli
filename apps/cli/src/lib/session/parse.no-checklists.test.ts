import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { parseGemini } from './parse.js';
import { extractTodoProgressFromEvents } from './state.js';

const TESTDATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata');

describe('harnesses without an observed checklist tool', () => {
  it('Gemini preserves generic tools without inventing TodoProgress', () => {
    const events = parseGemini(path.join(TESTDATA, 'checklist-none-gemini.json'));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_use', tool: 'run_shell_command' }));
    expect(extractTodoProgressFromEvents(events)).toBeUndefined();
  });
});
