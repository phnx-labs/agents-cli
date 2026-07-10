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

/** Print `msg` in red to stderr and exit the process with `code`. */
export function die(msg: string, code = 1): never {
  console.error(chalk.red(msg));
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

/** True when `--json` was passed or stdout is not a TTY. */
export function isJsonMode(opts: { json?: boolean }): boolean {
  return Boolean(opts.json) || !process.stdout.isTTY;
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
