/**
 * VS Code's `workbench.editorAssociations` is an object map:
 *   { "*.md": "agents.markdownEditor" }
 *
 * Older Factory builds wrote a legacy array of `{ viewType, filenamePattern }`
 * entries. That shape is ignored by the editor resolver, so the Markdown Viewer
 * toggle appeared to save but never changed which editor opened .md files.
 */

export type EditorAssociations = Record<string, string>;

export const AGENTS_MARKDOWN_EDITOR = 'agents.markdownEditor';
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
 * Compute the next associations map when enabling/disabling the Agents Markdown Editor.
 */
export function withMarkdownEditorAssociation(
  current: EditorAssociations,
  enabled: boolean
): EditorAssociations {
  const next: EditorAssociations = { ...current };
  if (enabled) {
    next[MARKDOWN_PATTERN] = AGENTS_MARKDOWN_EDITOR;
  } else {
    // Pin *.md to the default text editor so the custom editor does not stick
    // via a leftover association from a prior enable.
    next[MARKDOWN_PATTERN] = 'default';
  }
  return next;
}
