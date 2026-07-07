/**
 * Interactive-login-shell wrappers shared by every backend.
 *
 * `-i` is load-bearing, not cosmetic: the version-pinned shims (e.g.
 * `claude@2.1.187`) live in `~/.agents/.cache/shims`, which `.zshrc` puts on
 * PATH for *interactive* shells only. A plain `zsh -lc` (login, non-interactive)
 * skips `.zshrc`, so the shim isn't found and the surface dies with "command not
 * found". Every backend wraps its command in `zsh -ilc` for this reason — do not
 * drop the `-i`.
 */
import { shellQuote } from './quote.js';

/** `cd <cwd> && exec <command>` — for backends that don't set cwd natively. */
export function loginExec(cwd: string, command: string[]): string {
  return `cd ${shellQuote(cwd)} && exec ${command.join(' ')}`;
}

/** `exec <command>` — for backends that set the working directory natively. */
export function execOnly(command: string[]): string {
  return `exec ${command.join(' ')}`;
}

/** Wrap an inner shell script in an interactive login zsh: `zsh -ilc '<inner>'`. */
export function iLoginShell(inner: string): string {
  return `zsh -ilc ${shellQuote(inner)}`;
}
