import { describe, it, expect } from 'vitest';
import { resolveListScope } from './sessions.js';

describe('resolveListScope', () => {
  it('non-interactive default: 50-row cap, no time window, cwd-scoped', () => {
    expect(resolveListScope({}, false)).toEqual({ limit: 50, since: undefined, all: false });
  });

  it('interactive default: deep 200-row pool, 30-day window, cwd-scoped', () => {
    expect(resolveListScope({}, true)).toEqual({ limit: 200, since: '30d', all: false });
  });

  it('--all drops the cwd scope but keeps the interactive 30-day window off', () => {
    expect(resolveListScope({ all: true }, true)).toEqual({ limit: 200, since: undefined, all: true });
  });

  it('--fleet unlocks all three: every dir, no window, 10k cap — even non-interactive', () => {
    expect(resolveListScope({ fleet: true }, false)).toEqual({ limit: 10_000, since: undefined, all: true });
  });

  it('--fleet works the same in an interactive terminal', () => {
    expect(resolveListScope({ fleet: true }, true)).toEqual({ limit: 10_000, since: undefined, all: true });
  });

  it('explicit --limit always overrides the fleet default (backward-compatible)', () => {
    expect(resolveListScope({ fleet: true, limit: '25' }, true).limit).toBe(25);
  });

  it('explicit --since always wins, even under --fleet', () => {
    expect(resolveListScope({ fleet: true, since: '2h' }, true).since).toBe('2h');
  });

  it('explicit --since wins over the interactive 30-day default', () => {
    expect(resolveListScope({ since: '7d' }, true).since).toBe('7d');
  });
});
