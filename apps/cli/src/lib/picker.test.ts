import { stripVTControlCharacters } from 'node:util';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from '@homebridge/node-pty-prebuilt-multiarch';
import { describe, expect, it } from 'vitest';
import {
  hotkeyToken,
  limitPreviewHeight,
  pickerPageSize,
  PREVIEW_MIN_ROWS,
  PICKER_MIN_LIST_ROWS,
} from './picker.js';

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

/**
 * The row-budget math behind RUSH-2198: PICKER_RECENT_COUNT = 15 list rows on a
 * default 24-row terminal left `availablePreviewRows <= 0`, so `limitPreviewHeight`
 * returned '' and the preview collapsed to nothing. pickerPageSize caps the list so
 * the preview always keeps its PREVIEW_MIN_ROWS floor.
 */
describe('pickerPageSize', () => {
  // Mirror of the itemPicker fixedRows math: header + subtitle + page + separator + help.
  const availablePreview = (page: number, termRows: number, linesAbove = 0): number =>
    termRows - linesAbove - (1 /*header*/ + 1 /*subtitle*/ + page + 1 /*separator*/ + 1 /*help*/);

  it('caps a 15-row list so the preview keeps its floor at the default 24-row height', () => {
    const page = pickerPageSize({
      requestedPageSize: 15,
      terminalRows: 24,
      chromeRows: 3, // header + subtitle + help
      previewOpen: true,
    });
    expect(page).toBeLessThan(15);
    expect(page).toBeGreaterThanOrEqual(PICKER_MIN_LIST_ROWS);
    // The whole point: with the capped page, the preview slot is >= its floor.
    expect(availablePreview(page, 24)).toBeGreaterThanOrEqual(PREVIEW_MIN_ROWS);
  });

  it('reproduces the collapse without the cap and fixes it with it', () => {
    // Uncapped on a common 20-row pane, the raw 15-row page leaves the preview a
    // 1-row budget — limitPreviewHeight then returns only the truncation marker (or
    // '' outright at <= 0), which is the empty pane users reported.
    expect(availablePreview(15, 20)).toBeLessThanOrEqual(1);
    // And it goes fully non-positive (preview === '') once the terminal is a hair shorter.
    expect(availablePreview(15, 19)).toBeLessThanOrEqual(0);
    // Capped: positive, at least the floor, at the same 20-row height.
    const page = pickerPageSize({ requestedPageSize: 15, terminalRows: 20, chromeRows: 3, previewOpen: true });
    expect(availablePreview(page, 20)).toBeGreaterThanOrEqual(PREVIEW_MIN_ROWS);
  });

  it('subtracts lines already printed above the prompt from the budget', () => {
    const withFooter = pickerPageSize({
      requestedPageSize: 15,
      terminalRows: 24,
      chromeRows: 3,
      previewOpen: true,
      linesAbovePrompt: 3,
    });
    const withoutFooter = pickerPageSize({
      requestedPageSize: 15,
      terminalRows: 24,
      chromeRows: 3,
      previewOpen: true,
    });
    expect(withFooter).toBeLessThan(withoutFooter);
    // Even with the footer eating rows, the preview keeps its floor.
    expect(availablePreview(withFooter, 24, 3)).toBeGreaterThanOrEqual(PREVIEW_MIN_ROWS);
  });

  it('never shrinks the list below its floor on a tiny terminal', () => {
    const page = pickerPageSize({ requestedPageSize: 15, terminalRows: 10, chromeRows: 3, previewOpen: true });
    expect(page).toBe(PICKER_MIN_LIST_ROWS);
  });

  it('honours the full requested page when the preview is closed and there is room', () => {
    const page = pickerPageSize({ requestedPageSize: 15, terminalRows: 50, chromeRows: 3, previewOpen: false });
    expect(page).toBe(15);
  });

  it('grows the list back to the request once the terminal is tall enough', () => {
    const page = pickerPageSize({ requestedPageSize: 15, terminalRows: 60, chromeRows: 3, previewOpen: true });
    expect(page).toBe(15);
  });
});

describe('itemPicker preview at default height (RUSH-2198 regression)', () => {
  it('renders the detailed preview for a 15-row list request on a default-height terminal', async () => {
    const pickerUrl = pathToFileURL(path.resolve('src/lib/picker.ts')).href;
    // 20 rows, pageSize 15 (PICKER_RECENT_COUNT), preview open by default, plus
    // lines printed above the prompt — the exact shape that used to collapse.
    const program = `
      import { itemPicker } from ${JSON.stringify(pickerUrl)};
      const items = Array.from({ length: 20 }, (_, i) => ({ id: 's' + i }));
      await itemPicker({
        message: 'Search sessions:',
        subtitle: 'Tip: type to filter',
        items,
        filter: () => items,
        labelFor: (it) => 'session row ' + it.id,
        buildPreview: () => 'PREVIEW_VISIBLE\\nprompt: do the thing\\nfiles: a.ts\\nlast: done',
        pageSize: 15,
        linesAbovePrompt: 3,
      });
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program], {
      cols: 120,
      rows: 24,
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

    const clean = stripVTControlCharacters(output);
    expect(clean).toContain('PREVIEW_VISIBLE');
    // The list still shows and the separator still divides it from the preview.
    expect(clean).toContain('session row s0');
    expect(clean).toContain('─');
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

describe('dynamicPicker submit keys', () => {
  it('submits the highlighted row with a typed action before the same key can change a filter', async () => {
    const pickerUrl = pathToFileURL(path.resolve('src/lib/picker.ts')).href;
    const program = `
      import { dynamicPicker } from ${JSON.stringify(pickerUrl)};
      const result = await dynamicPicker({
        message: 'Sessions',
        initialFilter: { legacyFilter: false },
        load: async () => [{ id: 'session-1' }],
        keyFor: (item) => item.id,
        labelFor: () => 'Session one',
        matches: () => true,
        submitKeys: { f: 'focus' },
        keyBindings: { f: (filter) => ({ ...filter, legacyFilter: true }) },
      });
      process.stdout.write('RESULT ' + JSON.stringify(result));
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program], {
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    const output = await new Promise<string>((resolve, reject) => {
      let captured = '';
      let sent = false;
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`dynamic picker did not submit:\n${stripVTControlCharacters(captured)}`));
      }, 10_000);
      child.onData((data) => {
        captured += data;
        if (!sent && captured.includes('Session one')) {
          sent = true;
          child.write('f');
        }
        if (!captured.includes('RESULT ')) return;
        clearTimeout(timeout);
        resolve(captured);
      });
    });

    const clean = stripVTControlCharacters(output);
    const result = JSON.parse(clean.slice(clean.lastIndexOf('RESULT ') + 'RESULT '.length));
    expect(result).toEqual({
      item: { id: 'session-1' },
      filter: { legacyFilter: false },
      action: 'focus',
    });
  });

  it('treats the submit-key letter as query text while search mode is active', async () => {
    const pickerUrl = pathToFileURL(path.resolve('src/lib/picker.ts')).href;
    const program = `
      import { dynamicPicker } from ${JSON.stringify(pickerUrl)};
      const result = await dynamicPicker({
        message: 'Sessions',
        initialFilter: { legacyFilter: false },
        load: async () => [{ id: 'focus-result' }],
        keyFor: (item) => item.id,
        labelFor: () => 'Focus result',
        matches: (item, query) => item.id.includes(query),
        submitKeys: { f: 'focus' },
      });
      process.stdout.write('RESULT ' + JSON.stringify(result));
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program], {
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    const output = await new Promise<string>((resolve, reject) => {
      let captured = '';
      let stage = 0;
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`dynamic picker did not preserve search-mode input:\n${stripVTControlCharacters(captured)}`));
      }, 10_000);
      child.onData((data) => {
        captured += data;
        const clean = stripVTControlCharacters(captured);
        if (stage === 0 && clean.includes('Focus result')) {
          stage = 1;
          child.write('s');
        } else if (stage === 1 && clean.includes('/ (type to filter)')) {
          stage = 2;
          child.write('f');
        } else if (stage === 2 && clean.includes('/f')) {
          stage = 3;
          child.write('\r');
        }
        if (!clean.includes('RESULT ')) return;
        clearTimeout(timeout);
        resolve(captured);
      });
    });

    const clean = stripVTControlCharacters(output);
    const result = JSON.parse(clean.slice(clean.lastIndexOf('RESULT ') + 'RESULT '.length));
    expect(result).toEqual({
      item: { id: 'focus-result' },
      filter: { legacyFilter: false },
    });
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
    for (const c of ['r', 'c', 'a', 'b', 'd', 't', 'p', 'w', 'y', 's', 'f']) {
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
