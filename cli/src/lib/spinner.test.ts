/**
 * The guarantee under test is one line with an outsized blast radius: the
 * spinner must be built with `discardStdin: false`. With ora's default
 * (`discardStdin: true`) a TTY spinner raw-modes stdin and swallows Ctrl-C for
 * its whole lifetime — so a spinner wrapping a multi-second fleet sweep traps
 * the user until it finishes (see the module doc for the mechanism). A silent
 * flip back to the default would restore that trap with no other visible
 * symptom, which is exactly the kind of regression a test should catch.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const oraSpy = vi.fn(() => ({ start: () => ({}) }));
vi.mock('ora', () => ({ default: (opts: unknown) => oraSpy(opts) }));

const { interruptibleSpinner } = await import('./spinner.js');

describe('interruptibleSpinner', () => {
  beforeEach(() => oraSpy.mockClear());

  it('always disables discardStdin so Ctrl-C keeps raising SIGINT', () => {
    interruptibleSpinner('Reaching other machines...');
    expect(oraSpy).toHaveBeenCalledTimes(1);
    const opts = oraSpy.mock.calls[0][0] as { discardStdin?: boolean; text?: string };
    expect(opts.discardStdin).toBe(false);
    expect(opts.text).toBe('Reaching other machines...');
  });

  it('forwards caller options but never lets them re-enable discarding', () => {
    // The type omits discardStdin, but a stray cast at a call site must not win.
    interruptibleSpinner('x', { color: 'cyan', discardStdin: true } as never);
    const opts = oraSpy.mock.calls[0][0] as { discardStdin?: boolean; color?: string };
    expect(opts.color).toBe('cyan');
    expect(opts.discardStdin).toBe(false);
  });

  it('omits text when none is given rather than forcing an empty label', () => {
    interruptibleSpinner();
    const opts = oraSpy.mock.calls[0][0] as { text?: string; discardStdin?: boolean };
    expect('text' in opts).toBe(false);
    expect(opts.discardStdin).toBe(false);
  });
});
