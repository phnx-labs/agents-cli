/**
 * Ctrl-C-safe spinner factory.
 *
 * `ora` defaults to `discardStdin: true`, which — on a TTY — flips stdin into
 * raw mode for the lifetime of the spinner (via `stdin-discarder`). Raw mode
 * disables the terminal's own ISIG translation, so a Ctrl-C keystroke no longer
 * generates SIGINT; `stdin-discarder` tries to compensate by re-emitting SIGINT
 * when it reads a 0x03 byte, but that read only happens when stdin is in
 * *flowing* mode. At CLI startup a fresh `process.stdin` has `flowing === null`,
 * so `stdin.isPaused()` returns false, the discarder skips its `stdin.resume()`,
 * and its `prependListener('data')` never switches the stream to flowing —
 * because Node's readable only auto-resumes for `on('data')`, not
 * `prependListener('data')`. The net effect: while such a spinner is running,
 * Ctrl-C is swallowed entirely — the terminal won't raise SIGINT and the
 * discarder never sees the byte to re-raise it.
 *
 * That is invisible for a sub-second spinner, but any spinner wrapping a long
 * idle wait — a cross-machine SSH fan-out, a fleet search — traps the user for
 * the full duration (measured: `agents sessions --flat` could not be Ctrl-C'd
 * for the entire ~12s+ sweep and had to be SIGKILLed). The global SIGINT handler
 * in `index.ts` (`process.exit(130)`) is correct; it simply never fires because
 * no SIGINT is ever raised.
 *
 * Setting `discardStdin: false` keeps the terminal in cooked mode, so Ctrl-C
 * raises SIGINT normally (the terminal also SIGINTs the whole foreground process
 * group, reaping the outstanding `ssh` children) and the global handler exits
 * promptly. The only thing lost is cosmetic stray-keystroke discarding during
 * the spin — a worthwhile trade for a spinner the user must be able to abort.
 *
 * Use this for any spinner that wraps a network / fleet / SSH wait. A truly
 * instantaneous local spinner can still use `ora` directly, but preferring this
 * everywhere is harmless.
 */
import ora, { type Options, type Ora } from 'ora';

/**
 * Build an interruptible spinner — a drop-in for `ora(text)` that keeps Ctrl-C
 * working. Returns an unstarted {@link Ora}; call `.start()` as usual.
 */
export function interruptibleSpinner(text?: string, options?: Omit<Options, 'discardStdin'>): Ora {
  return ora({ ...options, ...(text !== undefined ? { text } : {}), discardStdin: false });
}
