import { describe, it, expect } from 'vitest';
import { wrapToWidth, termCols } from './wrap';

describe('wrapToWidth', () => {
  it('wraps on word boundaries at the given width', () => {
    const out = wrapToWidth('the quick brown fox jumps over', 12);
    expect(out).toEqual(['the quick', 'brown fox', 'jumps over']);
    for (const l of out) expect(l.length).toBeLessThanOrEqual(12);
  });

  it('hanging-indents continuation lines under the value, never the first', () => {
    const out = wrapToWidth('alpha beta gamma delta', 12, 4);
    // width shrinks to 12-4=8 for wrapping; first line has no pad, rest padded 4.
    expect(out[0].startsWith(' ')).toBe(false);
    for (const l of out.slice(1)) expect(l.startsWith('    ')).toBe(true);
  });

  it('never splits a single word longer than the width mid-word', () => {
    const out = wrapToWidth('short verylongunbreakabletoken end', 10);
    expect(out).toContain('verylongunbreakabletoken');
  });

  it('preserves existing newlines as paragraph breaks', () => {
    const out = wrapToWidth('one two\nthree four', 20);
    expect(out).toEqual(['one two', 'three four']);
  });

  it('returns [""] for empty input, not []', () => {
    expect(wrapToWidth('', 40)).toEqual(['']);
  });

  it('an indent larger than cols still makes progress (floors at 8, does not crash)', () => {
    const out = wrapToWidth('aaaa bbbb cccc dddd eeee', 10, 40);
    // cols-indent is negative; the floor keeps a small positive width (8), so it
    // wraps into multiple short lines rather than hanging or producing one long line.
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]).toBe('aaaa'); // first line unpadded, wrapped at the 8-col floor
    for (const l of out.slice(1)) expect(l.startsWith(' '.repeat(40))).toBe(true);
  });

  it('respects a legitimately small cols (does not force a 20-wide line)', () => {
    const out = wrapToWidth('the quick brown fox jumps over', 12);
    for (const l of out) expect(l.length).toBeLessThanOrEqual(12);
  });
});

describe('termCols', () => {
  it('falls back to 80 when stdout has no column count (piped / CI)', () => {
    const orig = process.stdout.columns;
    // @ts-expect-error deliberately clear for the test
    process.stdout.columns = 0;
    try {
      expect(termCols()).toBe(80);
      expect(termCols(100)).toBe(100);
    } finally {
      // @ts-expect-error restore
      process.stdout.columns = orig;
    }
  });
});
