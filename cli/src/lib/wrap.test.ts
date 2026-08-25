import { describe, it, expect } from 'vitest';
import { wrapToWidth } from './wrap';
import { stringWidth } from './session/width';

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

  it('measures VISIBLE width, not raw .length — ANSI-coloured text is not over-counted', () => {
    // Two green words: visible "hello world" is 11 cells, but the raw string is
    // 31 chars (each `\x1b[32m…\x1b[39m` adds 10 invisible bytes). At cols=11 the
    // coloured text must stay on ONE line — a raw-.length wrap would split it.
    const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
    const coloured = `${green('hello')} ${green('world')}`;
    expect(coloured.length).toBeGreaterThan(11); // sanity: raw length exceeds cols
    const out = wrapToWidth(coloured, 11);
    expect(out).toEqual([coloured]); // single line, untouched
    for (const l of out) expect(stringWidth(l)).toBeLessThanOrEqual(11);
  });

  it('respects a legitimately small cols with no indent (floor is 1, not 8)', () => {
    const out = wrapToWidth('ab cd ef gh', 3);
    expect(out).toEqual(['ab', 'cd', 'ef', 'gh']);
    for (const l of out) expect(l.length).toBeLessThanOrEqual(3);
  });

  it('an indent larger than cols still makes progress (floors at 8, does not crash)', () => {
    const out = wrapToWidth('aaaa bbbb cccc dddd eeee', 10, 40);
    // cols-indent is negative; the indent floor keeps a small positive width (8),
    // so it wraps into multiple short lines rather than hanging.
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]).toBe('aaaa'); // first line unpadded
    for (const l of out.slice(1)) expect(l.startsWith(' '.repeat(40))).toBe(true);
  });

  it('degrades a non-finite cols to the floor instead of joining everything on one line', () => {
    const out = wrapToWidth('a b c', Number.NaN);
    // With NaN cols the old raw `> NaN` comparison was always false and dumped the
    // whole paragraph onto one line. The finite-guard floors width at 1 instead.
    expect(out).toEqual(['a', 'b', 'c']);
  });
});
