import { describe, it, expect } from 'vitest';
import {
  computeProjectListWidths,
  formatFleetSkippedNote,
  formatMilestoneDue,
  formatNextMilestone,
  type ProjectListRow,
} from './projects.js';

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

describe('formatMilestoneDue', () => {
  /** Local noon on 2026-08-03, so a timezone slip shows up as a whole-day error. */
  const now = new Date(2026, 7, 3, 12, 0, 0).getTime();

  it('speaks in days a person would use', () => {
    expect(formatMilestoneDue('2026-08-03', now)).toBe('due today');
    expect(formatMilestoneDue('2026-08-04', now)).toBe('due tomorrow');
    expect(formatMilestoneDue('2026-08-09', now)).toBe('due in 6 days');
    expect(formatMilestoneDue('2026-08-02', now)).toBe('overdue by a day');
    expect(formatMilestoneDue('2026-07-27', now)).toBe('overdue by 7 days');
  });

  it('switches to a calendar date once the countdown stops being useful', () => {
    expect(formatMilestoneDue('2026-08-21', now)).toBe('due Aug 21');
    // A different year has to say which one.
    expect(formatMilestoneDue('2027-01-15', now)).toBe('due Jan 15, 2027');
  });

  it('reads the date at LOCAL midnight, not UTC', () => {
    // `new Date('2026-08-03')` is UTC midnight — west of Greenwich that is
    // Aug 2 locally, and this would read "overdue by a day" instead of "today".
    expect(formatMilestoneDue('2026-08-03', new Date(2026, 7, 3, 23, 59).getTime())).toBe('due today');
    expect(formatMilestoneDue('2026-08-03', new Date(2026, 7, 3, 0, 1).getTime())).toBe('due today');
  });

  it('returns nothing for a value that is not a calendar date', () => {
    expect(formatMilestoneDue('', now)).toBeUndefined();
    expect(formatMilestoneDue('someday', now)).toBeUndefined();
    expect(formatMilestoneDue('2026-08-03T00:00:00Z', now)).toBeUndefined();
  });
});

describe('formatNextMilestone', () => {
  const now = new Date(2026, 7, 3, 12, 0, 0).getTime();

  it('reads name, progress, then when it is due', () => {
    expect(stripAnsi(formatNextMilestone({ name: 'Beta cut', targetDate: '2026-08-09', done: 3, total: 8 }, now)))
      .toBe('Beta cut  ·  3/8  ·  due in 6 days');
  });

  it('omits the date entirely when the milestone has none', () => {
    expect(stripAnsi(formatNextMilestone({ name: 'Someday', done: 0, total: 4 }, now)))
      .toBe('Someday  ·  0/4');
  });

  it('omits the fraction when nothing is filed under the milestone yet', () => {
    // 0/0 is noise. This is the real shape of every milestone in this repo's
    // own Linear project.
    expect(stripAnsi(formatNextMilestone({ name: 'Factory onboarding', targetDate: '2026-09-15', done: 0, total: 0 }, now)))
      .toBe('Factory onboarding  ·  due Sep 15');
  });

  it('does not print a raw date when the stored value is unparseable', () => {
    expect(stripAnsi(formatNextMilestone({ name: 'Odd', targetDate: 'not-a-date', done: 1, total: 2 }, now)))
      .toBe('Odd  ·  1/2');
  });
});
