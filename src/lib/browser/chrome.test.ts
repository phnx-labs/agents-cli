import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const presentPaths = new Set<string>();

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: actual,
    existsSync: (p: string) => presentPaths.has(p),
  };
});

import { findFirstInstalledBrowser, resolveBrowserBinary, isLauncherScript, isPortInUse } from './chrome.js';

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

  it('auto-detects a per-user (Store) Edge install under LOCALAPPDATA', () => {
    // Per-user / Microsoft Store Edge installs land in %LOCALAPPDATA%, not
    // Program Files. Edge is the win32 default, so missing this candidate meant
    // auto-detect silently failed on machines with only a per-user Edge.
    const localAppData = process.env.LOCALAPPDATA || `${os.homedir()}\\AppData\\Local`;
    presentPaths.add(`${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`);

    const result = findFirstInstalledBrowser('win32');

    expect(result).toEqual({
      browserType: 'edge',
      binary: `${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`,
    });
  });

  it('auto-detects Comet on Windows when no other Chromium-family browser is installed', () => {
    // Comet ships Windows builds under Perplexity\Comet (issue: profile create
    // refused with "comet is macOS-only" on a machine running Comet).
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    presentPaths.add(`${programFiles}\\Perplexity\\Comet\\Application\\comet.exe`);

    const result = findFirstInstalledBrowser('win32');

    expect(result).toEqual({
      browserType: 'comet',
      binary: `${programFiles}\\Perplexity\\Comet\\Application\\comet.exe`,
    });
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

// resolveBrowserBinary only does work on Linux, where distro launchers are
// shell wrappers around the real ELF. The `head -c2` read, realpath, and
// readFileSync below all hit the actual filesystem (existsSync is the only
// mocked fs call), so these are gated to Linux hosts.
describe.skipIf(os.platform() !== 'linux')('resolveBrowserBinary', () => {
  // The upstream Chromium wrapper, verbatim down to the launch line — this is
  // exactly what Debian/Ubuntu ship at /usr/bin/{brave-browser,google-chrome}.
  const WRAPPER = [
    '#!/bin/bash',
    'export CHROME_WRAPPER="`readlink -f "$0"`"',
    'HERE="`dirname "$CHROME_WRAPPER"`"',
    'exec < /dev/null',
    'exec > >(exec cat)',
    'exec 2> >(exec cat >&2)',
    '"$HERE/brave" "$@" || true',
    '',
  ].join('\n');
  // ELF magic so the byte-sniff classifies it as a real binary, not a script.
  const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);

  let dir: string;

  beforeEach(() => {
    presentPaths.clear();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-resolve-'));
  });

  function realFsPaths(...names: string[]) {
    // existsSync is mocked to consult presentPaths, so register the real ELF
    // for the resolver's final fs.existsSync(realBinary) guard.
    for (const n of names) presentPaths.add(path.join(dir, n));
  }

  it('follows a Chromium wrapper script to the real ELF next to it', () => {
    fs.writeFileSync(path.join(dir, 'brave-browser'), WRAPPER);
    fs.writeFileSync(path.join(dir, 'brave'), ELF);
    realFsPaths('brave');

    expect(resolveBrowserBinary(path.join(dir, 'brave-browser'))).toBe(
      path.join(dir, 'brave')
    );
  });

  it('also handles the `exec -a "$0" "$HERE/chrome"` wrapper variant', () => {
    const variant = WRAPPER.replace('"$HERE/brave" "$@" || true', 'exec -a "$0" "$HERE/chrome" "$@"');
    fs.writeFileSync(path.join(dir, 'google-chrome'), variant);
    fs.writeFileSync(path.join(dir, 'chrome'), ELF);
    realFsPaths('chrome');

    expect(resolveBrowserBinary(path.join(dir, 'google-chrome'))).toBe(
      path.join(dir, 'chrome')
    );
  });

  it('leaves a real ELF binary untouched', () => {
    const elfPath = path.join(dir, 'brave');
    fs.writeFileSync(elfPath, ELF);

    expect(resolveBrowserBinary(elfPath)).toBe(elfPath);
  });

  it('returns the original path when the wrapped binary is missing', () => {
    const wrapperPath = path.join(dir, 'brave-browser');
    fs.writeFileSync(wrapperPath, WRAPPER);
    // Note: no `brave` ELF written and none registered in presentPaths.

    expect(resolveBrowserBinary(wrapperPath)).toBe(wrapperPath);
  });

  it('returns the original path for a script with no recognizable launch line', () => {
    const scriptPath = path.join(dir, 'weird-launcher');
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho hello\n');

    expect(resolveBrowserBinary(scriptPath)).toBe(scriptPath);
  });
});

describe.skipIf(os.platform() === 'win32')('isLauncherScript', () => {
  let dir: string;

  beforeEach(() => {
    presentPaths.clear();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-launcher-'));
  });

  it('reports true for a shebang wrapper script', () => {
    const p = path.join(dir, 'brave-browser');
    fs.writeFileSync(p, '#!/bin/bash\n"$HERE/brave" "$@"\n');
    expect(isLauncherScript(p)).toBe(true);
  });

  it('reports false for a real ELF binary', () => {
    const p = path.join(dir, 'brave');
    fs.writeFileSync(p, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));
    expect(isLauncherScript(p)).toBe(false);
  });

  it('reports false for a missing path', () => {
    expect(isLauncherScript(path.join(dir, 'nope'))).toBe(false);
  });
});

describe('isPortInUse', () => {
  // Real socket, real probe (lsof on POSIX, netstat on Windows) — no mocks.
  // Guards the Windows regression where the port scan shelled out to lsof
  // (absent there), every port scanned as "free", and findFreeProfilePort
  // handed out a port an already-running browser was listening on.
  it('detects a genuinely bound TCP port and its release', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as net.AddressInfo;

    try {
      expect(isPortInUse(port)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(isPortInUse(port)).toBe(false);
  });
});
