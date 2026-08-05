import { describe, expect, test } from 'bun:test';
import {
  AGENTS_MARKDOWN_EDITOR,
  MARKDOWN_PATTERN,
  normalizeEditorAssociations,
  withMarkdownEditorAssociation,
} from './editorAssociations';

describe('normalizeEditorAssociations', () => {
  test('returns empty for null/undefined/non-objects', () => {
    expect(normalizeEditorAssociations(undefined)).toEqual({});
    expect(normalizeEditorAssociations(null)).toEqual({});
    expect(normalizeEditorAssociations('nope')).toEqual({});
  });

  test('passes through the object map VS Code expects', () => {
    expect(
      normalizeEditorAssociations({
        '*.md': AGENTS_MARKDOWN_EDITOR,
        '*.pdf': 'pdf.preview',
      })
    ).toEqual({
      '*.md': AGENTS_MARKDOWN_EDITOR,
      '*.pdf': 'pdf.preview',
    });
  });

  test('drops non-string values from an object map', () => {
    expect(
      normalizeEditorAssociations({
        '*.md': AGENTS_MARKDOWN_EDITOR,
        '*.bad': 12,
        '*.empty': '',
      })
    ).toEqual({ '*.md': AGENTS_MARKDOWN_EDITOR });
  });

  test('migrates the legacy array shape Factory used to write', () => {
    expect(
      normalizeEditorAssociations([
        { viewType: AGENTS_MARKDOWN_EDITOR, filenamePattern: '*.md' },
        { viewType: 'pdf.preview', filenamePattern: '*.pdf' },
        { viewType: 'broken' },
        null,
      ])
    ).toEqual({
      '*.md': AGENTS_MARKDOWN_EDITOR,
      '*.pdf': 'pdf.preview',
    });
  });
});

describe('withMarkdownEditorAssociation', () => {
  test('sets *.md to the Agents Markdown Editor when enabling', () => {
    expect(withMarkdownEditorAssociation({}, true)).toEqual({
      [MARKDOWN_PATTERN]: AGENTS_MARKDOWN_EDITOR,
    });
  });

  test('preserves other associations when enabling', () => {
    expect(
      withMarkdownEditorAssociation({ '*.pdf': 'pdf.preview' }, true)
    ).toEqual({
      '*.pdf': 'pdf.preview',
      [MARKDOWN_PATTERN]: AGENTS_MARKDOWN_EDITOR,
    });
  });

  test('replaces a prior *.md association when enabling', () => {
    expect(
      withMarkdownEditorAssociation({ [MARKDOWN_PATTERN]: 'default' }, true)
    ).toEqual({
      [MARKDOWN_PATTERN]: AGENTS_MARKDOWN_EDITOR,
    });
  });

  test('pins *.md to default when disabling so the custom editor does not stick', () => {
    expect(
      withMarkdownEditorAssociation(
        { [MARKDOWN_PATTERN]: AGENTS_MARKDOWN_EDITOR, '*.pdf': 'pdf.preview' },
        false
      )
    ).toEqual({
      [MARKDOWN_PATTERN]: 'default',
      '*.pdf': 'pdf.preview',
    });
  });
});
