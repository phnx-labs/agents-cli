import { describe, it, expect } from 'vitest';
import { parseWin32ProcessCsv, foldSubordinateAgents, type AgentCandidate } from '../active.js';

describe('parseWin32ProcessCsv', () => {
  const csv = [
    '"ProcessId","ParentProcessId","Name"',
    '"0","0","System Idle Process"',
    '"38080","21480","claude.exe"',
    '"27808","38080","claude.exe"',
    '"5220","30844","node.exe"',
    '"9912","4180","codex.exe"',
    '"7212","1234","CLAUDE.EXE"',
    '',
  ].join('\r\n');

  it('parses pid/ppid/comm rows and skips the header', () => {
    const rows = parseWin32ProcessCsv(csv);
    expect(rows.map(r => r.pid)).toEqual([0, 38080, 27808, 5220, 9912, 7212]);
    expect(rows[1]).toEqual({ pid: 38080, ppid: 21480, comm: 'claude.exe', kind: 'claude' });
  });

  it('strips the .exe suffix case-insensitively when resolving agent kind', () => {
    const rows = parseWin32ProcessCsv(csv);
    const byPid = new Map(rows.map(r => [r.pid, r]));
    expect(byPid.get(38080)?.kind).toBe('claude');
    expect(byPid.get(9912)?.kind).toBe('codex');
    expect(byPid.get(7212)?.kind).toBe('claude');
    expect(byPid.get(5220)?.kind).toBeUndefined();
  });

  it('unescapes doubled quotes in image names', () => {
    const rows = parseWin32ProcessCsv('"10","1","we""ird.exe"');
    expect(rows[0].comm).toBe('we"ird.exe');
  });
});

describe('foldSubordinateAgents', () => {
  const noRegistry = () => false;

  it('folds same-kind descendants onto the topmost root, transitively', () => {
    // 100 -> 200 -> 300, plus an unrelated 900. Intermediate non-agent pids
    // (shims, shells) sit between 200 and 300 to exercise chain walking.
    const candidates: AgentCandidate[] = [
      { pid: 100, kind: 'claude' },
      { pid: 200, kind: 'claude' },
      { pid: 300, kind: 'claude' },
      { pid: 900, kind: 'claude' },
    ];
    const ppid = new Map([[100, 1], [200, 100], [250, 200], [300, 250], [900, 7]]);
    const { kept, foldedByRoot } = foldSubordinateAgents(candidates, ppid, noRegistry);
    expect(kept.map(c => c.pid)).toEqual([100, 900]);
    expect(foldedByRoot.get(100)).toBe(2);
  });

  it('keeps a descendant with its own registry session and folds its children to it', () => {
    const candidates: AgentCandidate[] = [
      { pid: 100, kind: 'claude' },
      { pid: 200, kind: 'claude' },
      { pid: 300, kind: 'claude' },
    ];
    const ppid = new Map([[100, 1], [200, 100], [300, 200]]);
    const { kept, foldedByRoot } = foldSubordinateAgents(candidates, ppid, p => p === 200);
    expect(kept.map(c => c.pid)).toEqual([100, 200]);
    expect(foldedByRoot.get(200)).toBe(1);
    expect(foldedByRoot.has(100)).toBe(false);
  });

  it('does not fold across agent kinds', () => {
    const candidates: AgentCandidate[] = [
      { pid: 100, kind: 'claude' },
      { pid: 200, kind: 'codex' },
    ];
    const ppid = new Map([[100, 1], [200, 100]]);
    const { kept, foldedByRoot } = foldSubordinateAgents(candidates, ppid, noRegistry);
    expect(kept.map(c => c.pid)).toEqual([100, 200]);
    expect(foldedByRoot.size).toBe(0);
  });

  it('survives a ppid cycle without dropping rows', () => {
    const candidates: AgentCandidate[] = [
      { pid: 100, kind: 'claude' },
      { pid: 200, kind: 'claude' },
    ];
    // 100 and 200 point at each other (pid reuse can fabricate this).
    const ppid = new Map([[100, 200], [200, 100]]);
    const { kept, foldedByRoot } = foldSubordinateAgents(candidates, ppid, noRegistry);
    // Neither is a valid root, so both survive as their own rows.
    expect(kept.map(c => c.pid).sort()).toEqual([100, 200]);
    expect(foldedByRoot.size).toBe(0);
  });
});
