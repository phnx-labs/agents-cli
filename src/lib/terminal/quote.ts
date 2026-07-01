/**
 * Quoting helpers for building launch commands.
 *
 * `shellQuote` is the single canonical POSIX single-quoter, re-exported from the
 * SSH transport so the local and remote legs quote identically. `appleScriptStr`
 * is the AppleScript string-literal escaper used by the iTerm/Ghostty backends.
 */
import { shellQuote } from '../ssh-exec.js';

export { shellQuote };

/** AppleScript double-quoted string literal (escape backslash, then quote). */
export function appleScriptStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
