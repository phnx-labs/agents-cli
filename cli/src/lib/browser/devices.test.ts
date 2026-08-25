import { describe, it, expect } from 'vitest';
import { parseWindowSize, parseWindowPosition } from './devices.js';

// These back both `profiles create --window/--position` and `profiles edit`.
// They were duplicated inline in commands/browser.ts before the extraction; the
// point of the shared helper is that the two surfaces cannot drift apart.
describe('parseWindowSize', () => {
  it('parses WxH', () => {
    expect(parseWindowSize('1512x982')).toEqual({ width: 1512, height: 982 });
  });

  it('rejects a malformed value rather than guessing', () => {
    for (const bad of ['1512', '1512X982', '1512 x 982', 'x982', '1512x', '-10x20', '']) {
      expect(parseWindowSize(bad)).toBeNull();
    }
  });
});

describe('parseWindowPosition', () => {
  it('parses X,Y', () => {
    expect(parseWindowPosition('80,80')).toEqual({ x: 80, y: 80 });
  });

  it('accepts negatives — a display can sit left of or above the primary one', () => {
    expect(parseWindowPosition('-1512,-200')).toEqual({ x: -1512, y: -200 });
  });

  it('rejects a malformed value', () => {
    for (const bad of ['80', '80;80', '80, 80', ',80', '80,', '']) {
      expect(parseWindowPosition(bad)).toBeNull();
    }
  });
});
