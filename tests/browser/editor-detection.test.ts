import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import type { Browser, Page, CDPSession } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getRefs } from '../../src/lib/browser/refs.js';
import { typeEditorText } from '../../src/lib/browser/editor.js';
import type { CDPClient } from '../../src/lib/browser/cdp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = join(__dirname, 'editor-fixtures');

function makeCDPAdapter(session: CDPSession): CDPClient {
  return {
    send: async <T = unknown>(method: string, params?: Record<string, unknown>, _sessionId?: string): Promise<T> => {
      return session.send(method as any, params as any) as Promise<T>;
    },
    on: () => {},
    off: () => {},
    close: () => {},
    connected: true,
    isOpen: true,
  } as unknown as CDPClient;
}

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser.close();
});

async function withFixture(
  fixture: string,
  fn: (page: Page, cdp: CDPClient) => Promise<void>
): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.goto(`file://${join(FIXTURES_DIR, fixture)}`, { waitUntil: 'domcontentloaded' });
    const session = await page.context().newCDPSession(page);
    await fn(page, makeCDPAdapter(session));
  } finally {
    await page.close();
  }
}

const FRAMEWORKS = [
  { fixture: 'lexical.html', editor: 'lexical' },
  { fixture: 'prosemirror.html', editor: 'prosemirror' },
  { fixture: 'slate.html', editor: 'slate' },
  { fixture: 'quill.html', editor: 'quill' },
  { fixture: 'ckeditor5.html', editor: 'ckeditor5' },
] as const;

describe('editor framework detection', () => {
  for (const { fixture, editor } of FRAMEWORKS) {
    it(`detects ${editor} via refs`, async () => {
      await withFixture(fixture, async (_page, cdp) => {
        const { nodeMap } = await getRefs(cdp, '', { interactive: false, limit: 100 });
        const nodes = Array.from(nodeMap.values());
        const editorNode = nodes.find(n => n.role === 'textbox');
        expect(editorNode, `expected a textbox ref in ${fixture}`).toBeDefined();
        expect(editorNode!.editor).toBe(editor);
      });
    }, 30_000);
  }
});

describe('type into editor frameworks', () => {
  for (const { fixture, editor } of FRAMEWORKS) {
    it(`inserts text into ${editor} via beforeinput dispatch`, async () => {
      await withFixture(fixture, async (page, cdp) => {
        const { nodeMap } = await getRefs(cdp, '', { interactive: false, limit: 100 });
        const nodes = Array.from(nodeMap.values());
        const editorNode = nodes.find(n => n.role === 'textbox');
        expect(editorNode!.editor).toBe(editor);

        await typeEditorText(cdp, '', editorNode!, 'hello world');

        const content = await page.$eval('#editor', (el: Element) => el.textContent ?? '');
        expect(content).toContain('hello world');
      });
    }, 30_000);
  }
});
