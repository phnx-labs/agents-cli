import { describe, it, expect } from 'vitest';
import { SYNC_AGENTS } from './agents.js';

function spec(id: string) {
  const s = SYNC_AGENTS.find(a => a.id === id);
  if (!s) throw new Error(`missing SYNC_AGENTS entry: ${id}`);
  return s;
}

describe('SYNC_AGENTS expanded beyond claude+codex', () => {
  it('includes the four agents from RUSH-1467', () => {
    const ids = SYNC_AGENTS.map(s => s.id);
    expect(ids).toContain('droid');
    expect(ids).toContain('grok');
    expect(ids).toContain('kimi');
    expect(ids).toContain('opencode');
    expect(ids).not.toContain('gemini');
  });

  it('claude keeps the default .jsonl extension', () => {
    expect(spec('claude').ext).toBeUndefined();
  });

  it('kimi uses .json for state.json metadata files', () => {
    expect(spec('kimi').ext).toBe('.json');
  });
});

describe('sessionIdFromRelKey', () => {
  it('claude: basename without .jsonl', () => {
    expect(spec('claude').sessionIdFromRelKey('my-project/abc123.jsonl')).toBe('abc123');
  });

  it('codex: extracts UUID from rollout filename', () => {
    expect(
      spec('codex').sessionIdFromRelKey('2026-07-15/rollout-1721011200-019f5a97-33ec-7001-8aad-4c42ae1d30d9.jsonl'),
    ).toBe('019f5a97-33ec-7001-8aad-4c42ae1d30d9');
  });

  it('droid: basename without .jsonl', () => {
    expect(
      spec('droid').sessionIdFromRelKey('-home-muqsit/2bd0daa3-8336-464a-bf51-42b1ea22cd30.jsonl'),
    ).toBe('2bd0daa3-8336-464a-bf51-42b1ea22cd30');
  });

  it('grok: parent directory name (UUID)', () => {
    expect(
      spec('grok').sessionIdFromRelKey('%2Fhome%2Fmuqsit/019f5a97-33ec-7001-8aad-4c42ae1d30d9/events.jsonl'),
    ).toBe('019f5a97-33ec-7001-8aad-4c42ae1d30d9');
  });

  it('kimi: extracts session_<uuid> from path', () => {
    expect(
      spec('kimi').sessionIdFromRelKey('wd_agents-cli_24557025c9f4/session_cabd8c14-9169-4aaa-845a-a40e944ab37a/state.json'),
    ).toBe('session_cabd8c14-9169-4aaa-845a-a40e944ab37a');
  });

  it('kimi: falls back to relKey when no session_ segment', () => {
    expect(spec('kimi').sessionIdFromRelKey('odd/path/file.json')).toBe('odd/path/file.json');
  });

  it('opencode: basename (placeholder until SQLite export lands)', () => {
    expect(spec('opencode').sessionIdFromRelKey('sessions/ses_abc123.jsonl')).toBe('ses_abc123.jsonl');
  });
});
