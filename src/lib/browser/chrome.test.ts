import { describe, it, expect, vi, beforeEach } from 'vitest';

const presentPaths = new Set<string>();

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: actual,
    existsSync: (p: string) => presentPaths.has(p),
  };
});

import { findFirstInstalledBrowser } from './chrome.js';

describe('findFirstInstalledBrowser', () => {
  beforeEach(() => {
    presentPaths.clear();
  });

  it('returns the first installed browser in macOS priority order (chrome > brave > edge > chromium > comet)', () => {
    presentPaths.add('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
    presentPaths.add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');

    const result = findFirstInstalledBrowser('darwin');

    expect(result).toEqual({
      browserType: 'brave',
      binary: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    });
  });

  it('prefers Chrome on macOS when both Chrome and Brave are installed', () => {
    presentPaths.add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    presentPaths.add('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');

    const result = findFirstInstalledBrowser('darwin');

    expect(result?.browserType).toBe('chrome');
  });

  it('prefers Edge on Windows since it ships preinstalled', () => {
    presentPaths.add('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    presentPaths.add('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');

    const result = findFirstInstalledBrowser('win32');

    expect(result?.browserType).toBe('edge');
  });

  it('walks the Linux priority list (chrome > chromium > brave > edge)', () => {
    presentPaths.add('/usr/bin/chromium');
    presentPaths.add('/usr/bin/brave-browser');

    const result = findFirstInstalledBrowser('linux');

    expect(result).toEqual({
      browserType: 'chromium',
      binary: '/usr/bin/chromium',
    });
  });

  it('returns null when no priority-list browser is installed', () => {
    expect(findFirstInstalledBrowser('darwin')).toBeNull();
    expect(findFirstInstalledBrowser('linux')).toBeNull();
    expect(findFirstInstalledBrowser('win32')).toBeNull();
  });

  it('returns null on unsupported platforms', () => {
    expect(findFirstInstalledBrowser('aix')).toBeNull();
    expect(findFirstInstalledBrowser('freebsd')).toBeNull();
  });
});
