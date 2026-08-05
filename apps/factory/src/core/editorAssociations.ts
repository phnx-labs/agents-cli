/**
 * VS Code's `workbench.editorAssociations` is an object map:
 *   { "*.md": "agents.markdownEditor", "*.html": "agents.htmlReader" }
 *
 * Older Factory builds wrote a legacy array of `{ viewType, filenamePattern }`
 * entries. That shape is ignored by the editor resolver, so the Reader toggle
 * appeared to save but never changed which editor opened files.
 */

export type EditorAssociations = Record<string, string>;

/** TipTap / Notion-style markdown reader-editor. */
export const AGENTS_MARKDOWN_EDITOR = 'agents.markdownEditor';

/** Sandboxed HTML preview for artifacts-cli (and other) HTML docs. */
export const AGENTS_HTML_READER = 'agents.htmlReader';

export const READER_PATTERNS = ['*.md', '*.html', '*.htm'] as const;

export type ReaderPattern = (typeof READER_PATTERNS)[number];

/** @deprecated Use READER_PATTERNS; kept for call-site clarity in markdown-only paths. */
export const MARKDOWN_PATTERN = '*.md';

/**
 * Normalize whatever is stored for `workbench.editorAssociations` into the
 * object map VS Code actually consumes. Accepts the current object shape and
 * the legacy array shape Factory used to write.
 */
export function normalizeEditorAssociations(value: unknown): EditorAssociations {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out: EditorAssociations = {};
    for (const [pattern, viewType] of Object.entries(value as Record<string, unknown>)) {
      if (typeof pattern === 'string' && typeof viewType === 'string' && viewType.length > 0) {
        out[pattern] = viewType;
      }
    }
    return out;
  }

  if (Array.isArray(value)) {
    const out: EditorAssociations = {};
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const pattern = (entry as { filenamePattern?: unknown }).filenamePattern;
      const viewType = (entry as { viewType?: unknown }).viewType;
      if (typeof pattern === 'string' && typeof viewType === 'string' && viewType.length > 0) {
        out[pattern] = viewType;
      }
    }
    return out;
  }

  return {};
}

/**
 * View type the Agents Reader uses for a given filename pattern.
 */
export function readerViewTypeForPattern(pattern: string): string {
  if (pattern === '*.html' || pattern === '*.htm') return AGENTS_HTML_READER;
  return AGENTS_MARKDOWN_EDITOR;
}

/**
 * Compute the next associations map when enabling/disabling the Agents Reader.
 * Covers markdown (TipTap editor) and HTML (artifact preview).
 */
export function withReaderEditorAssociations(
  current: EditorAssociations,
  enabled: boolean
): EditorAssociations {
  const next: EditorAssociations = { ...current };
  for (const pattern of READER_PATTERNS) {
    if (enabled) {
      next[pattern] = readerViewTypeForPattern(pattern);
    } else {
      // Pin to the default text editor so a prior enable does not stick.
      next[pattern] = 'default';
    }
  }
  return next;
}

/**
 * @deprecated Prefer withReaderEditorAssociations — same behavior, name kept for
 * older call sites during the rename.
 */
export function withMarkdownEditorAssociation(
  current: EditorAssociations,
  enabled: boolean
): EditorAssociations {
  return withReaderEditorAssociations(current, enabled);
}
