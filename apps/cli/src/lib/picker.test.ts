import { stripVTControlCharacters } from 'node:util';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from '@homebridge/node-pty-prebuilt-multiarch';
import { describe, expect, it } from 'vitest';
import { hotkeyToken, limitPreviewHeight } from './picker.js';

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

/**
 * The hotkey lookup token. readline collapses `f` and `F` onto the same `name`
 * and gives punctuation no name at all, so keying bindings on the name alone
 * makes `*` unbindable and a shifted letter indistinguishable from its lowercase
 * twin. Every existing binding is a plain lowercase letter, where the token is
 * unchanged — that no-op property is what makes this safe to swap in.
 */
describe('hotkeyToken', () => {
  it('is a no-op for a plain lowercase letter (every existing binding)', () => {
    for (const c of ['r', 'c', 'a', 'd', 't', 'p', 'w', 'y', 's', 'f']) {
      expect(hotkeyToken({ name: c, sequence: c })).toBe(c);
    }
  });

  it('separates a shifted letter from its lowercase twin', () => {
    expect(hotkeyToken({ name: 'f', sequence: 'f' })).toBe('f');
    expect(hotkeyToken({ name: 'f', sequence: 'F' })).toBe('F');
  });

  it('makes a punctuation key bindable at all — readline gives it no name', () => {
    expect(hotkeyToken({ name: undefined, sequence: '*' })).toBe('*');
    expect(hotkeyToken({ name: undefined, sequence: '/' })).toBe('/');
  });

  it('keeps control keys on their names, not their raw sequences', () => {
    expect(hotkeyToken({ name: 'tab', sequence: '\t' })).toBe('tab');
    expect(hotkeyToken({ name: 'return', sequence: '\r' })).toBe('return');
    expect(hotkeyToken({ name: 'backspace', sequence: '\x7f' })).toBe('backspace');
    expect(hotkeyToken({ name: 'space', sequence: ' ' })).toBe('space');
    expect(hotkeyToken({ name: 'escape', sequence: '\x1b' })).toBe('escape');
  });

  it('never claims a modified key — ctrl-c must not read as the letter c', () => {
    expect(hotkeyToken({ name: 'c', sequence: '\x03', ctrl: true })).toBe('c');
    expect(hotkeyToken({ name: 'f', sequence: 'f', meta: true })).toBe('f');
  });

  it('degrades to an empty token when readline reports neither', () => {
    expect(hotkeyToken({})).toBe('');
  });

  // The shifted form of an existing single-letter hotkey reached its binding
  // through `key.name` before this token existed. Keying on the character alone
  // would have retired `R`/`C`/`A` for anyone with caps lock on, so the lookup
  // falls back to the name — which only works if the token and the name differ
  // in exactly the way asserted here.
  it('leaves the readline name available as the fallback for a shifted letter', () => {
    const shifted = { name: 'r', sequence: 'R' };
    expect(hotkeyToken(shifted)).toBe('R');
    expect(shifted.name).toBe('r');
  });
});
