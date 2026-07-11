import { describe, it, expect } from 'vitest';
import {
  truncate,
  relTime,
  humanDuration,
  visibleWidth,
  padRight,
  padVisible,
  isJsonMode,
  termLink,
} from './format.js';

describe('truncate', () => {
  it('returns the string unchanged when within max', () => {
    expect(truncate('hello', 5)).toBe('hello');
    expect(truncate('hi', 10)).toBe('hi');
  });
  it('shortens with a single-char ellipsis when over max', () => {
    expect(truncate('hello world', 5)).toBe('hell…');
    // The ellipsis occupies exactly one visible column, so a 5-char budget
    // keeps 4 chars + `…`.
    expect(truncate('hello world', 5)).toHaveLength(5);
  });
});

describe('relTime', () => {
  const iso = (secsAgo: number) => new Date(Date.now() - secsAgo * 1000).toISOString();
  it('uses the short canonical form', () => {
    expect(relTime(iso(3))).toBe('just now');
    expect(relTime(iso(30))).toBe('30s ago');
    expect(relTime(iso(300))).toBe('5m ago');
    expect(relTime(iso(3 * 3600))).toBe('3h ago');
    expect(relTime(iso(2 * 86400))).toBe('2d ago');
  });
});

describe('humanDuration', () => {
  it('formats sub-minute, minute, hour, and day spans', () => {
    expect(humanDuration(45_000)).toBe('45s');
    expect(humanDuration(3 * 60_000)).toBe('3m');
    expect(humanDuration(2 * 3_600_000)).toBe('2h');
    expect(humanDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2h 5m');
    expect(humanDuration(86_400_000)).toBe('1d');
    expect(humanDuration(86_400_000 + 3 * 3_600_000)).toBe('1d 3h');
  });
});

describe('visibleWidth', () => {
  it('ignores ANSI SGR sequences including the escape byte', () => {
    // The previously-buggy regex omitted the leading \x1b, so it left the ESC
    // byte in the string and under/over-counted. The canonical version strips
    // the whole CSI sequence.
    const colored = '\x1b[31mred\x1b[0m';
    expect(visibleWidth(colored)).toBe(3);
    expect(visibleWidth('plain')).toBe(5);
  });
});

describe('padRight / padVisible', () => {
  it('padRight pads by raw length', () => {
    expect(padRight('ab', 5)).toBe('ab   ');
    expect(padRight('abcdef', 3)).toBe('abcdef');
  });
  it('padVisible pads by visible width, ignoring color codes', () => {
    const colored = '\x1b[31mab\x1b[0m';
    expect(visibleWidth(padVisible(colored, 5))).toBe(5);
    expect(padVisible(colored, 5)).toBe(colored + '   ');
  });
});

describe('isJsonMode', () => {
  it('is true when json flag is set', () => {
    expect(isJsonMode({ json: true })).toBe(true);
  });
});

describe('termLink', () => {
  it('returns plain text when not a TTY', () => {
    // In the test runner stdout is not a TTY, so no OSC 8 wrapping.
    expect(termLink('label', '/tmp/x')).toBe('label');
  });
  it('returns plain text when filePath is empty', () => {
    expect(termLink('label', '')).toBe('label');
  });
});
