/**
 * Render an HTML file to a 1200×630 PNG — the Open Graph cover for a shared plan.
 *
 * When `agents share plan.html` runs, we screenshot the plan's own hero and use it
 * as the `og:image`, so the link unfurls into a card in Slack / iMessage / Twitter /
 * Discord. No AI, no central render service: it's a headless screenshot on the
 * publisher's machine, so it works identically for us and for any user, and costs
 * nothing.
 *
 * Browser resolution reuses the repo's own detector (`findFirstInstalledBrowser`,
 * the same auto-pick behind `agents browser`), then falls back to a managed
 * Chromium in the Playwright/Puppeteer caches (present on machines that have done
 * browser automation), then `PUPPETEER_EXECUTABLE_PATH`. If nothing headless-capable
 * is found, `captureCover` returns null and publishing proceeds without a cover —
 * the link still works, it just won't have a preview image.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findFirstInstalledBrowser } from '../browser/chrome.js';

/** OG standard card size; captured at OG_SCALE× for retina crispness. */
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
/** Device scale factor for the capture — the served PNG is OG_WIDTH*OG_SCALE × OG_HEIGHT*OG_SCALE. */
export const OG_SCALE = 2;

// Installed browsers that are poor `--headless` hosts (they hang instead of
// capturing). We still let a managed Chromium or an explicit override handle those
// machines; we just don't burn a timeout probing these. (Only members of the
// browser detector's `BrowserType` are meaningful here; Comet is the real case.)
const BAD_HEADLESS_TYPES = new Set(['comet']);

/** Ordered list of candidate Chromium-family binaries to try for headless capture. */
export function candidateBrowsers(): string[] {
  const out: string[] = [];
  const push = (p: string | undefined) => {
    if (p && fs.existsSync(p) && !out.includes(p)) out.push(p);
  };

  // 1) An explicit override always wins.
  push(process.env.PUPPETEER_EXECUTABLE_PATH || process.env.AGENTS_SHARE_BROWSER);

  // 2) Managed Chromium in the Playwright / Puppeteer caches — purpose-built for
  //    headless, so it's the most reliable capture host when present.
  for (const bin of scanCaches()) push(bin);

  // 3) The repo's own auto-pick (Chrome → Brave → Edge → Chromium by platform),
  //    skipping browsers known to be poor headless hosts so we don't eat a timeout.
  try {
    const pick = findFirstInstalledBrowser();
    if (pick && !BAD_HEADLESS_TYPES.has(pick.browserType)) push(pick.binary);
  } catch {
    // detector is best-effort
  }

  return out;
}

/** Newest-first Chromium binaries under the Playwright / Puppeteer download caches. */
function scanCaches(): string[] {
  const home = os.homedir();
  const roots =
    os.platform() === 'darwin'
      ? [
          path.join(home, 'Library/Caches/ms-playwright'),
          path.join(home, '.cache/ms-playwright'),
          path.join(home, '.cache/puppeteer/chrome'),
        ]
      : [path.join(home, '.cache/ms-playwright'), path.join(home, '.cache/puppeteer/chrome')];
  const rel =
    os.platform() === 'darwin'
      ? [
          'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
          'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        ]
      : ['chrome-linux/chrome', 'chrome-linux64/chrome'];
  const found: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root).sort().reverse(); // newest version dir first
    } catch {
      continue;
    }
    for (const e of entries) {
      for (const r of rel) {
        const p = path.join(root, e, r);
        if (fs.existsSync(p)) found.push(p);
      }
    }
  }
  return found;
}

/**
 * Screenshot `htmlPath`'s top 1200×630 (its hero) to a PNG buffer, or null if no
 * headless-capable browser is available or every candidate fails. Never throws —
 * a cover is a nice-to-have, never a reason to fail a publish.
 */
export async function captureCover(htmlPath: string, timeoutMs = 15_000): Promise<Buffer | null> {
  const abs = path.resolve(htmlPath);
  if (!fs.existsSync(abs)) return null;
  const fileUrl = `file://${abs.split('/').map(encodeURIComponent).join('/')}`;

  for (const bin of candidateBrowsers()) {
    const outPng = path.join(os.tmpdir(), `agents-share-cover-${process.pid}-${Date.now()}.png`);
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-share-chrome-'));
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          bin,
          [
            '--headless=new',
            '--disable-gpu',
            '--hide-scrollbars',
            '--no-first-run',
            '--no-default-browser-check',
            `--force-device-scale-factor=${OG_SCALE}`,
            // Bound page JS (count-up animations etc.) so the shot fires promptly
            // instead of waiting on long-running timers.
            '--virtual-time-budget=8000',
            `--window-size=${OG_WIDTH},${OG_HEIGHT}`,
            `--user-data-dir=${userDir}`,
            `--screenshot=${outPng}`,
            fileUrl,
          ],
          { timeout: timeoutMs },
          (err) => (err ? reject(err) : resolve()),
        );
      });
      if (fs.existsSync(outPng)) {
        const buf = fs.readFileSync(outPng);
        // A valid PNG starts with the 8-byte signature; guard against 0-byte writes.
        if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return buf;
      }
    } catch {
      // try the next candidate
    } finally {
      fs.rmSync(outPng, { force: true });
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  }
  return null;
}
