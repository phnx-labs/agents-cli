import { describe, it, expect } from 'vitest';
import { exitMarker, splitProgressBytes, mirrorAliasesSource } from './progress.js';

describe('exitMarker', () => {
  it('embeds the task id so it cannot collide with generic output', () => {
    expect(exitMarker('a1b2c3d4')).toBe('\n@@AGENTS_HOST_EXIT_a1b2c3d4@@\n');
  });
});

describe('splitProgressBytes', () => {
  const id = 'a1b2c3d4';
  const M = exitMarker(id);
  const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

  it('splits log bytes from the exit code in a single combined fetch', () => {
    const r = splitProgressBytes(buf(`hello world${M}0`), id)!;
    expect(r.logChunk.toString('utf8')).toBe('hello world');
    expect(r.exit.toString('utf8')).toBe('0');
    expect(r.consumed).toBe(11); // 'hello world'
  });

  it('returns an empty exit while the job is still running', () => {
    const r = splitProgressBytes(buf(`some streamed output${M}`), id)!;
    expect(r.logChunk.toString('utf8')).toBe('some streamed output');
    expect(r.exit.toString('utf8')).toBe('');
  });

  it('reports an empty log chunk when there is no new output', () => {
    const r = splitProgressBytes(buf(`${M}`), id)!;
    expect(r.logChunk.length).toBe(0);
    expect(r.consumed).toBe(0);
    expect(r.exit.toString('utf8')).toBe('');
  });

  it('returns null when the marker is absent (transient fetch miss)', () => {
    expect(splitProgressBytes(buf('partial ssh output'), id)).toBeNull();
    expect(splitProgressBytes(buf(''), id)).toBeNull();
  });

  it('splits on the LAST marker so a token echoed in the log cannot spoof the boundary', () => {
    const echoed = `agent printed ${M} in its output`;
    const r = splitProgressBytes(buf(`${echoed}${M}137`), id)!;
    expect(r.exit.toString('utf8')).toBe('137');
    expect(r.logChunk.toString('utf8')).toBe(echoed);
  });

  it('is scoped per task id — another run’s marker is not treated as ours', () => {
    const other = exitMarker('ffffffff');
    expect(splitProgressBytes(buf(`log body${other}0`), id)).toBeNull();
  });

  // The load-bearing cases: byte-exact counting across a multibyte character.
  it('counts exact wire bytes when a multibyte char precedes the marker', () => {
    // 'héllo' is 6 UTF-8 bytes (é = 2); a string split would report 5 chars.
    const r = splitProgressBytes(buf(`héllo${M}0`), id)!;
    expect(r.consumed).toBe(6);
    expect(r.logChunk.length).toBe(6);
    expect(r.logChunk.toString('utf8')).toBe('héllo');
  });

  it('counts a multibyte char truncated at the buffer end by its raw bytes', () => {
    // 'café' = 5 bytes; drop the last byte so 'é' is split mid-character. The
    // next poll must resume exactly 4 bytes on — not skip/re-read — so consumed
    // MUST be 4, which a re-encoded U+FFFD (3 bytes) string count would get wrong.
    const half = buf('café').subarray(0, 4);
    const combined = Buffer.concat([half, Buffer.from(M, 'utf8')]);
    const r = splitProgressBytes(combined, id)!;
    expect(r.consumed).toBe(4);
    expect(r.logChunk.length).toBe(4);
  });
});

describe('mirrorAliasesSource', () => {
  it('flags aliasing when local and remote are the same file (localhost host)', () => {
    // Same dev:ino → the mirror IS the tailed file → skip the append.
    expect(mirrorAliasesSource('66306:1234567', '66306:1234567')).toBe(true);
  });

  it('does not flag distinct files (a genuine remote host)', () => {
    expect(mirrorAliasesSource('66306:1234567', '2049:9999999')).toBe(false);
  });

  it('does not flag when either identity is unknown', () => {
    // Missing local (mirror not created yet) or unstattable remote → keep mirroring.
    expect(mirrorAliasesSource(null, '2049:9999999')).toBe(false);
    expect(mirrorAliasesSource('66306:1234567', null)).toBe(false);
    expect(mirrorAliasesSource(null, null)).toBe(false);
  });
});
