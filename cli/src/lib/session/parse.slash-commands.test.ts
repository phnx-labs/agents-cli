/**
 * SessionEvent.slashCommand (#12) — captured two ways in a Claude transcript:
 *   1. The USER typing a slash command: Claude injects a `<command-name>`
 *      wrapper as the `role=user` message content.
 *   2. The MODEL invoking one programmatically via the `SlashCommand` tool.
 *
 * Verified against the real fixtures named in the task: the docs example
 * events.json (which carries a genuine `<command-name>/recap</command-name>`
 * wrapper from a real Claude transcript) and the team-session fixture
 * (which carries neither form, pinning the negative case).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { parseClaude, parseClaudeContent } from './parse.js';
import { extractSlashCommandName, extractSlashCommandFromToolInput } from './prompt.js';

const SESSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCS_EVENTS_JSON = path.join(SESSION_DIR, '..', '..', '..', 'docs', 'examples', 'sessions', 'claude', 'events.json');
const TEAM_FIXTURE = path.join(SESSION_DIR, '..', '..', '..', 'tests', 'fixtures', 'teams', 'claude-session.jsonl');

describe('extractSlashCommandName — against the real docs/examples/sessions/claude/events.json fixture', () => {
  it('extracts /recap from the genuine <command-name> wrapper recorded there', () => {
    // The checked-in file is a captured terminal render of `agents sessions
    // ... --json` (banner lines + one large JSON array), and isn't guaranteed
    // strict JSON end-to-end (embedded transcript content elsewhere in the
    // 3700+ line file can carry characters that break a naive JSON.parse of
    // the WHOLE document). Pull just the one field this test cares about —
    // the raw `"content": "..."` string literal that contains the wrapper —
    // via the same JSON string-literal grammar, not a full-document parse.
    const raw = fs.readFileSync(DOCS_EVENTS_JSON, 'utf-8');
    const m = raw.match(/"content":\s*"((?:[^"\\]|\\.)*<command-name>(?:[^"\\]|\\.)*)"/);
    expect(m).toBeTruthy();
    const wrappedContent = JSON.parse(`"${m![1]}"`) as string;
    expect(wrappedContent).toContain('<command-message>recap</command-message>');

    expect(extractSlashCommandName(wrappedContent)).toBe('/recap');
  });
});

describe('extractSlashCommandName — unit cases', () => {
  it('returns undefined for plain user text with no wrapper', () => {
    expect(extractSlashCommandName('Refactor the auth module')).toBeUndefined();
    expect(extractSlashCommandName(undefined)).toBeUndefined();
    expect(extractSlashCommandName('')).toBeUndefined();
  });

  it('normalizes a leading slash onto a bare (pre-slash-era) command name', () => {
    // Real transcripts predating the slash-prefixed wrapper carried the bare
    // name (see the isSyntheticUserMessage test fixture in prompt.test.ts).
    expect(extractSlashCommandName('<command-name>continue</command-name>')).toBe('/continue');
  });

  it('handles a namespaced plugin command (e.g. code:commit)', () => {
    expect(extractSlashCommandName('<command-message>commit</command-message>\n<command-name>/code:commit</command-name>')).toBe('/code:commit');
  });
});

describe('extractSlashCommandFromToolInput — the SlashCommand tool-call', () => {
  it('takes only the leading command token, dropping trailing args', () => {
    expect(extractSlashCommandFromToolInput({ command: '/code:commit fix the flaky test' })).toBe('/code:commit');
  });

  it('handles a bare command with no args', () => {
    expect(extractSlashCommandFromToolInput({ command: '/recap' })).toBe('/recap');
  });

  it('returns undefined for a non-string or missing command field', () => {
    expect(extractSlashCommandFromToolInput({})).toBeUndefined();
    expect(extractSlashCommandFromToolInput(undefined)).toBeUndefined();
    expect(extractSlashCommandFromToolInput({ command: 42 })).toBeUndefined();
  });
});

describe('parseClaudeContent populates SessionEvent.slashCommand end-to-end', () => {
  it('the USER-typed <command-name> wrapper (real content pulled from the docs fixture)', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-04-20T02:06:00.222Z',
      message: {
        role: 'user',
        content: '<command-message>recap</command-message>\n<command-name>/recap</command-name>',
      },
    });
    const events = parseClaudeContent(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'message', role: 'user', slashCommand: '/recap' });
  });

  it('the MODEL-invoked SlashCommand tool call', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-04-20T02:06:00.222Z',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'SlashCommand', input: { command: '/code:commit fix the bug' } }],
      },
    });
    const events = parseClaudeContent(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'tool_use', tool: 'SlashCommand', slashCommand: '/code:commit' });
  });

  it('an ordinary user message and an ordinary tool call carry no slashCommand', () => {
    const lines = [
      JSON.stringify({ type: 'user', timestamp: '2026-04-20T02:00:00.000Z', message: { role: 'user', content: 'fix the bug in auth.ts' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-04-20T02:00:01.000Z', message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/repo/auth.ts' } }] } }),
    ];
    const events = parseClaudeContent(lines.join('\n'));
    expect(events).toHaveLength(2);
    for (const e of events) expect(e.slashCommand).toBeUndefined();
  });
});

describe('parseClaude — real team-session fixture (no slash-command occurrence, pinning the negative case)', () => {
  it('parses cleanly and stamps slashCommand on nothing (this fixture has neither form)', () => {
    const events = parseClaude(TEAM_FIXTURE);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.slashCommand !== undefined)).toBe(false);
  });
});
