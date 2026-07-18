import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanCaches } from './capture.js';

const tmpdirs: string[] = [];

function mkhome() {
  const dir = mkdtempSync(join(tmpdir(), 'share-capture-'));
  tmpdirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpdirs.length) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

function touch(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
}

describe('scanCaches', () => {
  it('finds Playwright chromium_headless_shell packages on darwin (raw binary, not .app)', () => {
    const home = mkhome();
    const bin = join(
      home,
      'Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    );
    touch(bin);
    expect(scanCaches(home, 'darwin')).toContain(bin);
  });

  it('still finds the classic Chromium.app and Chrome for Testing layouts on darwin', () => {
    const home = mkhome();
    const chromium = join(home, 'Library/Caches/ms-playwright/chromium-1200/chrome-mac/Chromium.app/Contents/MacOS/Chromium');
    const cft = join(
      home,
      '.cache/puppeteer/chrome/mac-131/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    );
    touch(chromium);
    touch(cft);
    const found = scanCaches(home, 'darwin');
    expect(found).toContain(chromium);
    expect(found).toContain(cft);
  });

  it('finds the headless-shell layout on linux', () => {
    const home = mkhome();
    const bin = join(home, '.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell');
    touch(bin);
    expect(scanCaches(home, 'linux')).toContain(bin);
  });

  it('returns newest version dirs first', () => {
    const home = mkhome();
    const older = join(home, '.cache/ms-playwright/chromium_headless_shell-1169/chrome-headless-shell-linux64/chrome-headless-shell');
    const newer = join(home, '.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell');
    touch(older);
    touch(newer);
    const found = scanCaches(home, 'linux');
    expect(found.indexOf(newer)).toBeLessThan(found.indexOf(older));
  });
});
