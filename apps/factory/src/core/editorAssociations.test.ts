import { describe, expect, test } from 'bun:test';
import {
  AGENTS_HTML_READER,
  AGENTS_MARKDOWN_EDITOR,
  MARKDOWN_PATTERN,
  normalizeEditorAssociations,
  withReaderEditorAssociations,
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

describe('withReaderEditorAssociations', () => {
  test('maps md to markdown editor and html/htm to html reader when enabling', () => {
    expect(withReaderEditorAssociations({}, true)).toEqual({
      [MARKDOWN_PATTERN]: AGENTS_MARKDOWN_EDITOR,
      '*.html': AGENTS_HTML_READER,
      '*.htm': AGENTS_HTML_READER,
    });
  });

  test('preserves other associations when enabling', () => {
    expect(
      withReaderEditorAssociations({ '*.pdf': 'pdf.preview' }, true)
    ).toEqual({
      '*.pdf': 'pdf.preview',
      [MARKDOWN_PATTERN]: AGENTS_MARKDOWN_EDITOR,
      '*.html': AGENTS_HTML_READER,
      '*.htm': AGENTS_HTML_READER,
    });
  });

  test('replaces a prior *.md association when enabling', () => {
    expect(
      withReaderEditorAssociations({ [MARKDOWN_PATTERN]: 'default' }, true)
    ).toEqual({
      [MARKDOWN_PATTERN]: AGENTS_MARKDOWN_EDITOR,
      '*.html': AGENTS_HTML_READER,
      '*.htm': AGENTS_HTML_READER,
    });
  });

  test('pins md and html patterns to default when disabling', () => {
    expect(
      withReaderEditorAssociations(
        {
          [MARKDOWN_PATTERN]: AGENTS_MARKDOWN_EDITOR,
          '*.html': AGENTS_HTML_READER,
          '*.htm': AGENTS_HTML_READER,
          '*.pdf': 'pdf.preview',
        },
        false
      )
    ).toEqual({
      [MARKDOWN_PATTERN]: 'default',
      '*.html': 'default',
      '*.htm': 'default',
      '*.pdf': 'pdf.preview',
    });
  });
});
