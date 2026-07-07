import { describe, it, expect } from 'vitest';
import { ipcEndpoint } from './ipc.js';

describe('ipcEndpoint', () => {
  it('returns the socket path unchanged on POSIX', () => {
    expect(ipcEndpoint('/home/u/.agents/.cache/helpers/browser/browser.sock', 'linux'))
      .toBe('/home/u/.agents/.cache/helpers/browser/browser.sock');
    expect(ipcEndpoint('/x/y.sock', 'darwin')).toBe('/x/y.sock');
  });

  it('returns a \\\\.\\pipe\\ named pipe on win32 — never a filesystem path', () => {
    const ep = ipcEndpoint('C:\\Users\\u\\.agents\\.cache\\helpers\\browser\\browser.sock', 'win32');
    expect(ep).toMatch(/^\\\\\.\\pipe\\agents-[0-9a-f]{16}$/);
    expect(ep.includes('browser.sock')).toBe(false);
  });

  it('is stable per socket path and unique across paths', () => {
    const a1 = ipcEndpoint('C:\\a\\browser.sock', 'win32');
    const a2 = ipcEndpoint('C:\\a\\browser.sock', 'win32');
    const b = ipcEndpoint('C:\\b\\browser.sock', 'win32');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });
});
