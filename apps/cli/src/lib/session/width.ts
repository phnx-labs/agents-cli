/**
 * Terminal display-width helpers.
 *
 * `String.length` is the wrong ruler for a terminal: it over-counts ANSI colour
 * escapes (chalk output) and under-counts wide glyphs (CJK, emoji) which occupy
 * two cells. The result is the drifting, wrapping session-table line users see
 * under tmux and over `--host` SSH. Every renderer that sizes a session-table
 * cell measures and truncates through this module so alignment is computed once,
 * correctly, from the same source of truth.
 */

/** SGR colour sequences emitted by chalk (e.g. `\x1b[32m`). */
const SGR_REGEX = /\x1b\[[0-9;]*m/g;

/** Strip SGR colour escapes so width is measured on visible characters only. */
export function stripAnsi(s: string): string {
  return s.replace(SGR_REGEX, '');
}

/**
 * Display cells for one code point: 0 for zero-width combining/ZWJ/variation
 * selectors, 2 for East-Asian-wide and emoji ranges, 1 otherwise. Compact and
 * dependency-free — covers the glyphs that actually show up in prompts/titles.
 */
function charWidth(cp: number): number {
  if (cp === 0) return 0;
  // Zero-width: combining marks, zero-width joiner, variation selectors.
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    cp === 0x200b || cp === 0x200d ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  ) return 0;
  // Wide (2 cells): CJK, Hangul, fullwidth forms, emoji & pictographs.
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||   // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) ||   // CJK radicals … Yi
    (cp >= 0xac00 && cp <= 0xd7a3) ||   // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) ||   // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) ||   // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||   // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji & symbols
    (cp >= 0x20000 && cp <= 0x3fffd)    // CJK Ext-B and beyond
  ) return 2;
  return 1;
}

/** Visible display width of a string, ANSI-aware and wide-char-aware. */
export function stringWidth(s: string): number {
  const plain = stripAnsi(s);
  let w = 0;
  for (const ch of plain) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/**
 * Truncate to a target display width, appending '…' when shortened. Operates on
 * the visible (ANSI-stripped) string; callers colour the result afterwards so
 * the ellipsis is never inserted mid-escape.
 */
export function truncateToWidth(s: string, max: number): string {
  if (max <= 0) return '';
  const plain = stripAnsi(s);
  if (stringWidth(plain) <= max) return plain;
  let w = 0;
  let out = '';
  for (const ch of plain) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > max - 1) break; // reserve one cell for the ellipsis
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** Right-pad with spaces to a target display width. Never truncates. */
export function padToWidth(s: string, width: number): string {
  const pad = width - stringWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

/**
 * Effective terminal width. Reads `$COLUMNS` first so it survives tmux and
 * `--host` SSH (where `process.stdout.columns` is unset or wrong), falls back to
 * the TTY's reported width, then to `fallback`. Clamped to a sane band so a
 * bogus value can't produce a 0-wide or absurdly long table.
 */
export function terminalWidth(fallback = 100): number {
  const env = Number.parseInt(process.env.COLUMNS ?? '', 10);
  const raw = Number.isFinite(env) && env > 0
    ? env
    : (process.stdout.columns || fallback);
  return Math.max(60, Math.min(200, raw));
}
