import { stripVTControlCharacters } from 'node:util';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from '@homebridge/node-pty-prebuilt-multiarch';
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

describe('multiItemPicker', () => {
  it('renders a supplied preview in its initial terminal frame', async () => {
    const pickerUrl = pathToFileURL(path.resolve('src/lib/picker.ts')).href;
    const program = `
      import { multiItemPicker } from ${JSON.stringify(pickerUrl)};
      await multiItemPicker({
        message: 'Pick:',
        items: [{ id: 'session-1' }],
        filter: () => [{ id: 'session-1' }],
        labelFor: () => 'Session one',
        keyFor: (item) => item.id,
        buildPreview: () => 'PREVIEW_VISIBLE',
      });
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program], {
      cols: 120,
      rows: 40,
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    const output = await new Promise<string>((resolve, reject) => {
      let captured = '';
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`picker preview did not render:\n${stripVTControlCharacters(captured)}`));
      }, 10_000);
      child.onData((data) => {
        captured += data;
        if (!captured.includes('PREVIEW_VISIBLE')) return;
        clearTimeout(timeout);
        child.kill();
        resolve(captured);
      });
    });

    expect(stripVTControlCharacters(output)).toContain('PREVIEW_VISIBLE');
  });
});
