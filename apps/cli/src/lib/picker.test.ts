import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { limitPreviewHeight } from './picker.js';

function renderedRows(text: string, width: number): number {
  return text.split('\n').reduce((rows, line) => {
    const visible = stripVTControlCharacters(line).length;
    return rows + Math.max(1, Math.ceil(visible / width));
  }, 0);
}

describe('limitPreviewHeight', () => {
  it('leaves previews unchanged when they fit', () => {
    const preview = ['title', 'body', 'footer'].join('\n');

    expect(limitPreviewHeight(preview, 3, 80)).toBe(preview);
  });

  it('clips multi-line previews to the row budget', () => {
    const preview = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    const clipped = limitPreviewHeight(preview, 4, 80);

    expect(renderedRows(clipped, 80)).toBeLessThanOrEqual(4);
    expect(stripVTControlCharacters(clipped)).toContain('preview truncated');
    expect(stripVTControlCharacters(clipped)).not.toContain('line 10');
  });

  it('accounts for wrapped long lines before adding the truncation marker', () => {
    const preview = 'x'.repeat(200);
    const clipped = limitPreviewHeight(preview, 3, 20);

    expect(renderedRows(clipped, 20)).toBeLessThanOrEqual(3);
    expect(stripVTControlCharacters(clipped)).toContain('truncated');
  });
});
