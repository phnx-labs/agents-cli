import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import type { Browser, Page, CDPSession } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { focusNode, typeText } from '../../src/lib/browser/input.js';
import type { CDPClient } from '../../src/lib/browser/cdp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = join(__dirname, 'input-fixtures');

function makeCDPAdapter(session: CDPSession): CDPClient {
  return {
    send: async <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
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
  fn: (page: Page, cdp: CDPClient, session: CDPSession) => Promise<void>
): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.goto(`file://${join(FIXTURES_DIR, fixture)}`, { waitUntil: 'domcontentloaded' });
    const session = await page.context().newCDPSession(page);
    await fn(page, makeCDPAdapter(session), session);
  } finally {
    await page.close();
  }
}

async function backendNodeIdFor(session: CDPSession, selector: string): Promise<number> {
  const { root } = (await session.send('DOM.getDocument', { depth: -1, pierce: true })) as {
    root: { nodeId: number };
  };
  const { nodeId } = (await session.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector,
  })) as { nodeId: number };
  if (!nodeId) throw new Error(`selector not found: ${selector}`);
  const { node } = (await session.send('DOM.describeNode', { nodeId })) as {
    node: { backendNodeId: number };
  };
  return node.backendNodeId;
}

describe('focusNode', () => {
  it('focuses a native input directly', async () => {
    await withFixture('wrapper-input.html', async (page, cdp, session) => {
      const id = await backendNodeIdFor(session, '#real');
      await focusNode(cdp, '', id);
      const focused = await page.evaluate(() => document.activeElement?.id);
      expect(focused).toBe('real');
    });
  }, 30_000);

  it('falls back to focusable descendant when ref is a wrapper', async () => {
    await withFixture('wrapper-input.html', async (page, cdp, session) => {
      const id = await backendNodeIdFor(session, '#wrapper');
      await focusNode(cdp, '', id);
      const focused = await page.evaluate(() => document.activeElement?.id);
      expect(focused).toBe('real');
    });
  }, 30_000);

  it('throws when neither the node nor any descendant is focusable', async () => {
    await withFixture('wrapper-input.html', async (_page, cdp, session) => {
      // <body> has no focusable descendants except inputs we already covered —
      // a fresh <p> with no children is a clean no-focusable case.
      await session.send('Runtime.evaluate', {
        expression: 'document.body.insertAdjacentHTML("beforeend", "<p id=\\"empty\\">x</p>")',
      });
      const id = await backendNodeIdFor(session, '#empty');
      await expect(focusNode(cdp, '', id)).rejects.toThrow();
    });
  }, 30_000);
});

describe('typeText', () => {
  it('fires beforeinput and input events on a focused input', async () => {
    await withFixture('wrapper-input.html', async (page, cdp, session) => {
      const id = await backendNodeIdFor(session, '#real');
      await focusNode(cdp, '', id);
      await typeText(cdp, '', 'hi');
      const events = await page.evaluate(() => (window as any).__realEvents);
      expect(events.some((e: { type: string }) => e.type === 'input')).toBe(true);
      const value = await page.$eval('#real', (el) => (el as HTMLInputElement).value);
      expect(value).toBe('hi');
    });
  }, 30_000);

  it('propagates through a controlled input via the input event', async () => {
    await withFixture('wrapper-input.html', async (page, cdp, session) => {
      const id = await backendNodeIdFor(session, '#controlled');
      await focusNode(cdp, '', id);
      await typeText(cdp, '', 'rush');
      const mirror = await page.$eval('#controlled-mirror', (el) => el.textContent ?? '');
      expect(mirror).toBe('rush');
    });
  }, 30_000);
});
