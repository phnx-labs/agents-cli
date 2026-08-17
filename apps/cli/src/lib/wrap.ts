/**
 * Terminal text wrapping — one shared helper for the whole CLI.
 *
 * The session preview (and anywhere else that renders variable-length text into
 * a fixed-width terminal) must wrap through THIS, never a per-field truncate or
 * ad-hoc slice. It wraps on word boundaries, respects existing newlines, and
 * hanging-indents continuation lines so they align under the value, not the label.
 */

/** Columns of the attached terminal, or 80 when not a TTY (piped / CI). */
export function termCols(fallback = 80): number {
  const c = process.stdout?.columns;
  return typeof c === 'number' && c > 0 ? c : fallback;
}

/**
 * Hard-wrap `text` to `cols` columns.
 *
 * - Splits on existing newlines first (each paragraph wraps independently).
 * - Wraps on whitespace; a single word longer than the available width is
 *   emitted on its own line rather than split mid-word.
 * - `hangingIndent` pads every line AFTER the first with that many spaces, so a
 *   labelled value ("Latest  <text>") keeps its continuation lines aligned under
 *   the value. The available width is `cols - indent`, floored at a small
 *   minimum (8) so a pathologically large indent still makes forward progress —
 *   the floor guards the indent, it does NOT override a legitimately small cols.
 *
 * Returns the wrapped lines (never mutates input). An empty string yields [''].
 */
export function wrapToWidth(text: string, cols: number, hangingIndent = 0): string[] {
  const indent = Math.max(0, Math.trunc(hangingIndent));
  const width = Math.max(8, cols - indent);
  const pad = ' '.repeat(indent);
  const out: string[] = [];

  for (const para of String(text).split('\n')) {
    const words = para.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      if (line.length === 0) {
        line = word;
      } else if (line.length + 1 + word.length > width) {
        out.push(line);
        line = word;
      } else {
        line = `${line} ${word}`;
      }
    }
    if (line.length > 0) out.push(line);
  }
  if (out.length === 0) out.push('');
  return out.map((l, i) => (i === 0 ? l : pad + l));
}
