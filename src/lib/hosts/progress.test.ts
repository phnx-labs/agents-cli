import { describe, it, expect } from 'vitest';
import { exitMarker, splitProgressOutput, mirrorAliasesSource } from './progress.js';

describe('exitMarker', () => {
  it('embeds the task id so it cannot collide with generic output', () => {
    expect(exitMarker('a1b2c3d4')).toBe('\n@@AGENTS_HOST_EXIT_a1b2c3d4@@\n');
  });
});

describe('splitProgressOutput', () => {
  const id = 'a1b2c3d4';
  const M = exitMarker(id);

  it('splits log bytes from the exit code in a single combined fetch', () => {
    const out = `hello world${M}0`;
    expect(splitProgressOutput(out, id)).toEqual({ logChunk: 'hello world', exit: '0' });
  });

  it('returns an empty exit while the job is still running', () => {
    const out = `some streamed output${M}`;
    expect(splitProgressOutput(out, id)).toEqual({ logChunk: 'some streamed output', exit: '' });
  });

  it('reports an empty log chunk when there is no new output', () => {
    const out = `${M}`;
    expect(splitProgressOutput(out, id)).toEqual({ logChunk: '', exit: '' });
  });

  it('returns null when the marker is absent (transient fetch miss)', () => {
    expect(splitProgressOutput('partial ssh output', id)).toBeNull();
    expect(splitProgressOutput('', id)).toBeNull();
  });

  it('splits on the LAST marker so a token echoed in the log cannot spoof the boundary', () => {
    // The agent's own output literally contained the sentinel; the real
    // trailing marker must still win, keeping the echoed copy inside the log.
    const echoed = `agent printed ${M} in its output`;
    const out = `${echoed}${M}137`;
    const r = splitProgressOutput(out, id);
    expect(r).not.toBeNull();
    expect(r!.exit).toBe('137');
    expect(r!.logChunk).toBe(echoed);
  });

  it('is scoped per task id — another run’s marker is not treated as ours', () => {
    const other = exitMarker('ffffffff');
    const out = `log body${other}0`;
    expect(splitProgressOutput(out, id)).toBeNull();
  });

  it('the printf-emitted sentinel round-trips through the parser (no desync)', () => {
    // fetchProgress builds the remote printf format by escaping exitMarker's
    // newlines; when the shell interprets those escapes it must reproduce the
    // exact marker the parser splits on. Simulate that here.
    const printfArg = exitMarker(id).replace(/\n/g, '\\n');
    const emitted = printfArg.replace(/\\n/g, '\n'); // what `printf` writes out
    expect(emitted).toBe(exitMarker(id));
    const r = splitProgressOutput(`body${emitted}0`, id);
    expect(r).toEqual({ logChunk: 'body', exit: '0' });
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
