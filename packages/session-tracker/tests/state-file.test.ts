import { describe, it, expect } from 'vitest';
import { parseState } from '../src/state-file.js';

describe('parseState', () => {
  it('parses the canonical schema written by hook.sh', () => {
    const raw = JSON.stringify({
      session_id: 'aaaa-bbbb',
      agent: 'claude',
      cwd: '/x',
      pid: 123,
      ts: 1780000000000,
      method: 'hook-stdin',
      terminal_id: 'cl-1',
    });
    const s = parseState(raw);
    expect(s).not.toBeNull();
    expect(s!.session_id).toBe('aaaa-bbbb');
    expect(s!.agent).toBe('claude');
    expect(s!.terminal_id).toBe('cl-1');
  });

  it('parses the legacy 04-capture hook schema (no agent, no method)', () => {
    // This is the literal shape ~/.agents/.system/hooks/04-capture-session-start-metadata.sh
    // writes — kept around for backward compat with already-installed agent versions.
    const raw = '{"session_id": "df106759-aaaa", "cwd": "/x", "pid": 35013, "ts": 1780964717}';
    const s = parseState(raw);
    expect(s).not.toBeNull();
    expect(s!.session_id).toBe('df106759-aaaa');
    expect(s!.agent).toBe('unknown');
    expect(s!.method).toBe('hook-stdin');
  });

  it('rejects missing session_id', () => {
    const raw = '{"cwd": "/x", "pid": 1, "ts": 1}';
    expect(parseState(raw)).toBeNull();
  });

  it('rejects malformed JSON', () => {
    expect(parseState('{not json')).toBeNull();
  });
});
