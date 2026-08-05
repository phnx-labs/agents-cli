import { describe, it, expect } from 'vitest';
import { stringWidth, stripAnsi, truncateToWidth, padToWidth, terminalWidth } from './width.js';

describe('stringWidth', () => {
  it('counts ASCII as one cell each', () => {
    expect(stringWidth('hello')).toBe(5);
  });

  it('ignores ANSI colour escapes', () => {
    // chalk.green('ok') style input must measure as the visible text only.
    const colored = '\x1b[32mok\x1b[39m';
    expect(stringWidth(colored)).toBe(2);
    expect(stripAnsi(colored)).toBe('ok');
  });

  it('counts CJK as two cells', () => {
    expect(stringWidth('日本語')).toBe(6);
  });

  it('counts emoji as two cells', () => {
    expect(stringWidth('🔧')).toBe(2);
  });

  it('treats combining marks as zero-width', () => {
    // 'e' + combining acute accent renders in one cell.
    expect(stringWidth('é')).toBe(1);
  });
});

describe('OSC-8 hyperlinks (RUSH-2205)', () => {
  // osc8() form: ESC ]8;;<url> ESC \ <label> ESC ]8;; ESC \  — the URL is not
  // visible, so a clickable RUSH-2205 badge must measure as its 9-char label and
  // never be sliced mid-escape by truncateToWidth.
  const link = '\x1b]8;;https://linear.app/x/issue/RUSH-2205\x1b\\RUSH-2205\x1b]8;;\x1b\\';

  it('measures only the visible label, not the URL', () => {
    expect(stringWidth(link)).toBe(9);
    expect(stripAnsi(link)).toBe('RUSH-2205');
  });

  it('handles the BEL-terminated variant', () => {
    const bel = '\x1b]8;;https://x\x07label\x1b]8;;\x07';
    expect(stringWidth(bel)).toBe(5);
    expect(stripAnsi(bel)).toBe('label');
  });

  it('truncates without leaving a corrupted (unterminated) escape', () => {
    // A badge + trailing text truncated to below the label: the result must carry
    // no partial OSC-8 opener (the corruption bug this fixes).
    const out = truncateToWidth(link + ' idle 3h', 6);
    expect(stringWidth(out)).toBeLessThanOrEqual(6);
    // stripAnsi removes complete escapes; any residual ESC means a cut mid-sequence.
    expect(stripAnsi(out)).not.toContain('\x1b');
  });
});

describe('truncateToWidth', () => {
  it('leaves short strings untouched', () => {
    expect(truncateToWidth('short', 10)).toBe('short');
  });

  it('truncates ASCII with an ellipsis at the target width', () => {
    const out = truncateToWidth('abcdefghij', 5);
    expect(stringWidth(out)).toBeLessThanOrEqual(5);
    expect(out.endsWith('…')).toBe(true);
  });

  it('never splits a wide glyph across the boundary', () => {
    // Two CJK chars = 4 cells; truncate to 3 must keep one char + ellipsis (2+1=3).
    const out = truncateToWidth('日本', 3);
    expect(stringWidth(out)).toBeLessThanOrEqual(3);
    expect(out).toBe('日…');
  });

  it('measures the coloured input by visible width, not escape length', () => {
    const colored = '\x1b[32mhello world\x1b[39m';
    const out = truncateToWidth(colored, 5);
    expect(stringWidth(out)).toBeLessThanOrEqual(5);
  });
});

describe('padToWidth', () => {
  it('pads to the visible target width', () => {
    expect(padToWidth('ab', 5)).toBe('ab   ');
  });
  it('pads accounting for wide chars', () => {
    // '日' is 2 cells, so pad to 5 adds 3 spaces.
    expect(padToWidth('日', 5)).toBe('日   ');
  });
  it('does not truncate when already wider', () => {
    expect(padToWidth('abcdef', 3)).toBe('abcdef');
  });
});

describe('terminalWidth', () => {
  it('prefers $COLUMNS and clamps to the sane band', () => {
    const prev = process.env.COLUMNS;
    process.env.COLUMNS = '120';
    expect(terminalWidth()).toBe(120);
    process.env.COLUMNS = '5000';
    expect(terminalWidth()).toBe(200);
    process.env.COLUMNS = '10';
    expect(terminalWidth()).toBe(60);
    if (prev === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = prev;
  });
});
