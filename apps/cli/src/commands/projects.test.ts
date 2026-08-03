import { describe, it, expect } from 'vitest';
import { computeProjectListWidths, formatFleetSkippedNote, type ProjectListRow } from './projects.js';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('formatFleetSkippedNote', () => {
  it('says nothing when every peer answered', () => {
    expect(formatFleetSkippedNote([])).toBe('');
  });

  it('names up to four peers, collapsing the rest to +N, with honest reasons', () => {
    expect(stripAnsi(formatFleetSkippedNote(['gpu-box'])))
      .toBe("  · 1 device didn't answer (unreachable, older agents-cli, or timed out): gpu-box\n");
    expect(stripAnsi(formatFleetSkippedNote(['a', 'b', 'c', 'd', 'e', 'f'])))
      .toBe("  · 6 devices didn't answer (unreachable, older agents-cli, or timed out): a, b, c, d +2\n");
  });
});

describe('computeProjectListWidths', () => {
  /** Render a row the way `list` does, so a bleeding column shows up as a shifted gridline. */
  const render = (r: ProjectListRow, w: { name: number; path: number; repo: number }) =>
    `  ${r.name.padEnd(w.name)} ${r.path.padEnd(w.path)} ${r.repo.padEnd(w.repo)} 0 agents`;

  it('sizes every column to the widest row instead of a fixed 32', () => {
    const rows: ProjectListRow[] = [
      { name: 'agents', path: '~/src/github.com/muqsitnawaz/agents', repo: 'muqsitnawaz/agents' },
      { name: 'agents-cli', path: '~/src/github.com/muqsitnawaz/agents-cli', repo: 'muqsitnawaz/agents-cli' },
    ];
    const w = computeProjectListWidths(rows);
    expect(w).toEqual({ name: 10, path: 39, repo: 22 });
    // The repo column starts at the same offset on every row — the bug was a
    // 32-char pad that a ~39-char home-relative path ran straight through.
    const offsets = rows.map((r) => render(r, w).indexOf(r.repo));
    expect(new Set(offsets).size).toBe(1);
  });

  it('caps the path column so one long root cannot widen the whole table', () => {
    const w = computeProjectListWidths([
      { name: 'a', path: '~/' + 'x'.repeat(120), repo: 'o/r' },
      { name: 'b', path: '~/short', repo: 'o/r2' },
    ]);
    expect(w.path).toBe(48);
  });

  it('collapses to zero-width columns when there is nothing to show', () => {
    expect(computeProjectListWidths([])).toEqual({ name: 0, path: 0, repo: 0 });
    expect(computeProjectListWidths([{ name: 'a', path: '', repo: '' }])).toEqual({ name: 1, path: 0, repo: 0 });
  });
});
