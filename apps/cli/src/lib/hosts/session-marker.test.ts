import { describe, it, expect } from 'vitest';
import { sessionIdMarkerLine, parseSessionIdMarker } from './session-marker.js';

describe('sessionIdMarkerLine', () => {
  it('frames the id on its own line so it lands cleanly after any agent output', () => {
    const line = sessionIdMarkerLine('abc-123');
    expect(line).toBe('\n@@AGENTS_SESSION_ID abc-123@@\n');
  });

  it('round-trips through the parser', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(parseSessionIdMarker(sessionIdMarkerLine(id))).toBe(id);
  });
});

describe('parseSessionIdMarker', () => {
  it('extracts the id from a chunk of surrounding log output', () => {
    const log =
      'booting codex...\nrunning tools\n' +
      sessionIdMarkerLine('01JABCDXYZ_session-9') +
      'done\n';
    expect(parseSessionIdMarker(log)).toBe('01JABCDXYZ_session-9');
  });

  it('returns null when no marker is present', () => {
    expect(parseSessionIdMarker('plain output with no marker\n')).toBeNull();
  });

  it('takes the LAST marker so an id echoed earlier cannot mask the real trailing one', () => {
    // An agent that literally echoes the sentinel token in its own output must
    // never fool the parser — the real id the run prints comes last.
    const log =
      '@@AGENTS_SESSION_ID echoed-fake@@ (agent quoted this)\n' +
      sessionIdMarkerLine('real-final-id');
    expect(parseSessionIdMarker(log)).toBe('real-final-id');
  });

  it('rejects a malformed frame rather than returning a bogus id', () => {
    // A space in the token can't be a session id — better null than a fabricated id.
    expect(parseSessionIdMarker('@@AGENTS_SESSION_ID not a real id@@\n')).toBeNull();
    // Missing suffix → incomplete frame.
    expect(parseSessionIdMarker('@@AGENTS_SESSION_ID dangling\n')).toBeNull();
  });
});
