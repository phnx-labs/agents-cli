// detectWaitingForInput — the NEEDS YOU classifier for local terminal tabs.
// The prose trailing-"?" heuristic decays after PROSE_QUESTION_FRESH_MS so a
// finished session that signed off with "anything else?" doesn't sit in NEEDS
// YOU forever (RUSH-1522); the structural AskUserQuestion signal never decays.
import { describe, test, expect } from 'bun:test';
import { detectWaitingForInput, PROSE_QUESTION_FRESH_MS } from './session.activity';

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
