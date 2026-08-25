import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { parseClaude, parseCodex, parseDroid, parseGrok } from './parse.js';
import { extractTodoProgressFromEvents } from './state.js';

const TESTDATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata');

describe('harness checklist transcript fixtures', () => {
  const cases = [
    ['claude', parseClaude, 'checklist-claude.jsonl', 'Building'],
    ['codex', parseCodex, 'checklist-codex.jsonl', 'Build'],
    ['grok', parseGrok, 'chat_history.jsonl', 'Build'],
    ['droid', parseDroid, 'checklist-droid.jsonl', 'Building'],
  ] as const;

  for (const [harness, parse, fixture, activeForm] of cases) {
    it(`${harness} produces shared TodoProgress`, () => {
      const progress = extractTodoProgressFromEvents(parse(path.join(TESTDATA, fixture)));
      expect(progress).toMatchObject({ done: 1, total: 2, activeForm });
    });
  }
});
