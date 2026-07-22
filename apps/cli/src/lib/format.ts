/**
 * Shared terminal-formatting helpers.
 *
 * These small utilities were previously copy-pasted across ~20 command and lib
 * files, and had drifted into behavior differences (truncation ellipsis `...`
 * vs `…` vs `.`; `relTime` long "5 minutes ago" vs short "5m ago"; a
 * `visibleWidth` regex missing its `\x1b` escape). This module is the single
 * canonical home — every consumer imports from here.
 */
import chalk from 'chalk';
import { readSync } from 'node:fs';

/** Options for {@link die} — opt into machine-readable failure output. */
export interface DieOptions {
  /**
   * Emit a machine-readable `{"error", "hint"?}` object to **stdout** instead of
   * red text on stderr. Pass `isJsonMode(options)` from a `--json` command so an
   * agent parsing stdout gets a structured reason instead of an empty stream and
   * a bare nonzero exit (RUSH-1830).
   */
  json?: boolean;
  /** Optional recovery hint — the command to run instead. Included in both modes. */
  hint?: string;
}

/**
 * Render a fatal error to the right stream. Pure — no I/O, no `process.exit` — so
 * the human-vs-agent split is unit-testable. A `--json` caller gets
 * `{"error","hint"?}` on **stdout** (where a JSON consumer reads); a human gets
 * red text (plus a gray hint line) on **stderr**.
 */
export function formatDie(
  msg: string,
  opts: DieOptions = {},
): { stream: 'stdout' | 'stderr'; text: string } {
  if (opts.json) {
    const payload: { error: string; hint?: string } = { error: msg };
    if (opts.hint) payload.hint = opts.hint;
    return { stream: 'stdout', text: JSON.stringify(payload) };
  }
  const lines = [chalk.red(msg)];
  if (opts.hint) lines.push(chalk.gray(opts.hint));
  return { stream: 'stderr', text: lines.join('\n') };
}

/**
 * Print `msg` and exit the process with `code`. Humans get red text on stderr;
 * a `--json` caller (pass `{ json: true }`) gets `{"error","hint"?}` on stdout so
 * an agent has a parseable reason. Backward-compatible: `die(msg)` / `die(msg, code)`
 * keep the original red-stderr behavior.
 */
export function die(msg: string, code = 1, opts: DieOptions = {}): never {
  const { stream, text } = formatDie(msg, opts);
  // Keep console.* (not process.std*.write): the suite spies on console.error /
  // console.log to capture command output, and fd-level writes bypass those spies.
  if (stream === 'stdout') console.log(text);
  else console.error(text);
  process.exit(code);
}

/**
 * Truncate `s` to at most `max` characters, appending a single-char ellipsis
 * (`…`) when shortened. Character-count based (not ANSI/width aware — use
 * `truncateToWidth` from `session/width.ts` for colored strings).
 */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * Format an ISO timestamp as a compact relative age: "just now", "5m ago",
 * "3h ago", "2d ago". The canonical short form — the long "5 minutes ago"
 * variant that once lived in `cloud.ts` is deliberately dropped. (For the
 * session-list long form with calendar fallback, see
 * `formatRelativeTime` in `session/relative-time.ts`.)
 */
export function relTime(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/** Format a millisecond duration as "45s", "3m", "2h 5m", "1d 3h". */
export function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm ? `${h}h ${mm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d}d ${hh}h` : `${d}d`;
}

/**
 * Visible column width of `s`, ignoring ANSI SGR color codes (e.g. chalk
 * wrappers). Matches the full CSI sequence including the `\x1b` escape.
 */
export function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Pad `s` with trailing spaces to a target character width. */
export function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/** Pad `s` with trailing spaces to a target *visible* width (ANSI-aware). */
export function padVisible(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

/** True when `--json` was passed. Piped stdout stays human-readable unless requested. */
export function isJsonMode(opts: { json?: boolean }): boolean {
  return Boolean(opts.json);
}

/** Read all of stdin synchronously and return it UTF-8 decoded and trimmed. */
export function readStdinSync(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  while (true) {
    let bytesRead: number;
    try {
      bytesRead = readSync(0, buf, 0, buf.length, null);
    } catch {
      break;
    }
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

/**
 * Wrap `text` in an OSC 8 hyperlink to `filePath` (as a `file://` URL) when
 * stdout is a TTY; otherwise return `text` unchanged.
 */
export function termLink(text: string, filePath: string): string {
  if (!filePath || !process.stdout.isTTY) return text;
  const url = `file://${filePath}`;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
