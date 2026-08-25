import { describe, it, expect } from 'vitest';
import { pickRemoteSessionId } from './remote-session-id.js';

// The demux correlation for interactive non-Claude host runs: the launcher
// forwards AGENT_LAUNCH_ID, the remote hook writes the agent's REAL session id
// under that key, and after the stream the launcher reads the remote hook records
// and resolves the id by launch id. These fixtures are the exact on-disk shape the
// SessionStart hook writes (packages/session-tracker/src/hook.sh), one JSON object
// per line — no real agent, no SSH.

// A codex run recorded by the remote hook under our forwarded launch id.
const codexRecord = JSON.stringify({
  session_id: 'codex-sess-9f2a',
  agent: 'codex',
  cwd: '/home/me/proj',
  pid: 4242,
  ts: 1_700,
  method: 'hook-stdin',
  launch_id: 'LID-forwarded',
});

// An unrelated grok run in the same dir under a DIFFERENT launch id.
const grokRecord = JSON.stringify({
  session_id: 'grok-sess-1111',
  agent: 'grok',
  cwd: '/home/me/other',
  pid: 5555,
  ts: 1_900,
  method: 'hook-env',
  launch_id: 'LID-other',
});

describe('pickRemoteSessionId', () => {
  it('resolves the real session id for the forwarded launch id', () => {
    const dump = [grokRecord, codexRecord].join('\n');
    expect(pickRemoteSessionId(dump, 'LID-forwarded')).toBe('codex-sess-9f2a');
  });

  it('ignores records under a different launch id (no cross-run leak)', () => {
    // Only the grok record is present; asking for the codex launch id must miss,
    // not return the co-located grok session.
    expect(pickRemoteSessionId(grokRecord, 'LID-forwarded')).toBeUndefined();
  });

  it('resolves each launch id to its OWN session in a multi-run dir', () => {
    const dump = [codexRecord, grokRecord].join('\n');
    expect(pickRemoteSessionId(dump, 'LID-forwarded')).toBe('codex-sess-9f2a');
    expect(pickRemoteSessionId(dump, 'LID-other')).toBe('grok-sess-1111');
  });

  it('returns undefined for an empty launch id (never a blind first-match)', () => {
    const dump = [codexRecord].join('\n');
    expect(pickRemoteSessionId(dump, '')).toBeUndefined();
  });

  it('returns undefined when the hook record has not landed yet', () => {
    expect(pickRemoteSessionId('', 'LID-forwarded')).toBeUndefined();
  });

  it('keeps the NEWEST record (by ts) when a launch id collides — pid reuse / stale file', () => {
    const stale = JSON.stringify({ session_id: 'codex-STALE', pid: 1, ts: 100, launch_id: 'LID-dup' });
    const fresh = JSON.stringify({ session_id: 'codex-FRESH', pid: 2, ts: 2_000, launch_id: 'LID-dup' });
    // Order-independent: the higher ts wins whichever way the records are listed.
    expect(pickRemoteSessionId([stale, fresh].join('\n'), 'LID-dup')).toBe('codex-FRESH');
    expect(pickRemoteSessionId([fresh, stale].join('\n'), 'LID-dup')).toBe('codex-FRESH');
  });

  it('skips a record with an empty/absent session_id (nothing to key on)', () => {
    const empty = JSON.stringify({ session_id: '', pid: 3, ts: 3_000, launch_id: 'LID-forwarded' });
    // The empty-id record must not shadow the real one under the same launch id.
    expect(pickRemoteSessionId([empty, codexRecord].join('\n'), 'LID-forwarded')).toBe('codex-sess-9f2a');
    // And on its own it resolves to undefined, not '' .
    expect(pickRemoteSessionId(empty, 'LID-forwarded')).toBeUndefined();
  });

  it('tolerates a garbled line (partial write / raced read) without throwing', () => {
    const dump = ['{not json', codexRecord].join('\n');
    expect(pickRemoteSessionId(dump, 'LID-forwarded')).toBe('codex-sess-9f2a');
  });

  it('parses records run together on one line (cat without newline separators)', () => {
    // A `}{` boundary is normalised by the SSH wrapper before this pure parser
    // sees it; assert the parser handles the already-split shape it is handed.
    const joined = `${grokRecord}\n${codexRecord}`;
    expect(pickRemoteSessionId(joined, 'LID-forwarded')).toBe('codex-sess-9f2a');
  });
});
