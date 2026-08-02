import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { readCursorMeta } from '../discover.js';
import { detectAgent, parseCursor, parseSession } from '../parse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'testdata', 'cursor-session.jsonl');
const SESSION_ID = '123e4567-e89b-12d3-a456-426614174000';

describe('Cursor session parsing and discovery metadata', () => {
  let root: string;
  let transcriptPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-cursor-'));
    transcriptPath = path.join(
      root, '.cursor', 'projects', 'tmp-public-project', 'agent-transcripts',
      SESSION_ID, `${SESSION_ID}.jsonl`,
    );
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.copyFileSync(FIXTURE, transcriptPath);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('maps text and tool-use blocks and ignores turn_ended', () => {
    const events = parseCursor(transcriptPath);
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ agent: 'cursor', type: 'message', role: 'user' });
    expect(events[1]).toMatchObject({
      agent: 'cursor', type: 'message', role: 'assistant',
      content: 'I will inspect the session documentation.',
    });
    expect(events[2]).toMatchObject({
      agent: 'cursor', type: 'tool_use', tool: 'Read',
      path: '/tmp/public-project/docs/sessions.md',
    });
    expect(events[3]).toMatchObject({
      agent: 'cursor', type: 'message', role: 'assistant',
      content: 'The sessions command discovers and renders local transcripts.',
    });
  });

  test('joins authoritative cwd, title, and timestamps from chats meta.json', () => {
    const metaPath = path.join(root, '.cursor', 'chats', 'workspace-hash', SESSION_ID, 'meta.json');
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify({
      schemaVersion: 1,
      createdAtMs: 1785654071336,
      hasConversation: true,
      title: 'Session command audit',
      updatedAtMs: 1785668144486,
      cwd: '/tmp/public-project',
    }));

    const result = readCursorMeta(transcriptPath, '2026.07.23-e383d2b');
    expect(result).not.toBeNull();
    expect(result!.meta).toMatchObject({
      id: SESSION_ID,
      shortId: '123e4567',
      agent: 'cursor',
      timestamp: '2026-08-02T07:01:11.336Z',
      lastActivity: '2026-08-02T10:55:44.486Z',
      cwd: '/tmp/public-project',
      project: 'public-project',
      label: 'Session command audit',
      topic: 'Inspect the public CLI documentation and summarize the session commands.',
      messageCount: 3,
    });
    expect(result!.content).toBe('Inspect the public CLI documentation and summarize the session commands.');
  });

  test('indexes transcript-only archives without inventing cwd or title', () => {
    const result = readCursorMeta(transcriptPath);
    expect(result).not.toBeNull();
    expect(result!.meta.cwd).toBe('');
    expect(result!.meta.project).toBeUndefined();
    expect(result!.meta.label).toBeUndefined();
    expect(result!.meta.messageCount).toBe(3);
  });

  test('detectAgent and parseSession route Cursor transcript paths', () => {
    expect(detectAgent(transcriptPath)).toBe('cursor');
    expect(parseSession(transcriptPath)).toEqual(parseCursor(transcriptPath));
  });

  test('skips malformed JSONL lines without dropping valid events', () => {
    fs.appendFileSync(transcriptPath, '{not json}\n');
    expect(parseCursor(transcriptPath)).toHaveLength(4);
  });
});
