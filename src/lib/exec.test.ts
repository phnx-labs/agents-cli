import { describe, it, expect } from 'vitest';
import { shouldTapStdout, resolveInteractive } from './exec.js';

describe('shouldTapStdout (budget live-watcher attach gating, #346 FIX 3)', () => {
  // The regression FIX 3 fixes: a headless run AT A TERMINAL (piped=false) with
  // caps active used to leave stdout 'inherit', so child.stdout was null and the
  // live hard-cap kill never engaged. The watcher must now attach there too.
  it('TAPS a non-interactive run at a TTY when caps are active (the FIX 3 case)', () => {
    expect(shouldTapStdout(/*interactive*/ false, /*piped*/ false, /*capsActive*/ true)).toBe(true);
  });

  it('does NOT tap a non-interactive run at a TTY when no caps are configured', () => {
    // Zero-overhead for budget non-users: no watcher, no pipe, stdout stays inherit.
    expect(shouldTapStdout(false, false, false)).toBe(false);
  });

  it('still taps a piped non-interactive run regardless of caps (preserve compose path)', () => {
    expect(shouldTapStdout(false, true, false)).toBe(true);
    expect(shouldTapStdout(false, true, true)).toBe(true);
  });

  it('NEVER taps an interactive session even with caps active (human owns the TTY)', () => {
    expect(shouldTapStdout(true, false, true)).toBe(false);
    expect(shouldTapStdout(true, true, true)).toBe(false);
  });
});

describe('resolveInteractive (sanity for the gating inputs above)', () => {
  it('a prompt-bearing run is non-interactive (headless), so it is eligible to tap', () => {
    expect(resolveInteractive({ prompt: 'hi' })).toBe(false);
  });
  it('a prompt-less run is interactive (never tapped)', () => {
    expect(resolveInteractive({ prompt: undefined })).toBe(true);
  });
  it('--headless forces non-interactive even without a prompt', () => {
    expect(resolveInteractive({ headless: true, prompt: undefined })).toBe(false);
  });
});
