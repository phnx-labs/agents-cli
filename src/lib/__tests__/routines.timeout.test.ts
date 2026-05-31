import { describe, it, expect } from 'vitest';
import { parseTimeout } from '../routines.js';

describe('parseTimeout', () => {
  it('parses 10m as 600000ms', () => {
    expect(parseTimeout('10m')).toBe(600000);
  });

  it('parses 1h as 3600000ms', () => {
    expect(parseTimeout('1h')).toBe(3600000);
  });

  it('parses 1h30m as 5400000ms', () => {
    expect(parseTimeout('1h30m')).toBe(5400000);
  });

  it('parses 3d as 259200000ms', () => {
    expect(parseTimeout('3d')).toBe(259200000);
  });

  it('parses 1w as 604800000ms', () => {
    expect(parseTimeout('1w')).toBe(604800000);
  });

  it('returns null for 2w (over cap)', () => {
    expect(parseTimeout('2w')).toBeNull();
  });

  it('returns null for 8d (over cap)', () => {
    expect(parseTimeout('8d')).toBeNull();
  });

  it('returns null for 0m (zero duration)', () => {
    expect(parseTimeout('0m')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseTimeout('')).toBeNull();
  });

  it('returns null for "30 minutes" (unrecognized format)', () => {
    expect(parseTimeout('30 minutes')).toBeNull();
  });
});
