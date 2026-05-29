import { afterEach, describe, it, expect, vi } from 'vitest';
import { rmSync } from 'fs';
import * as path from 'path';
import {
  BrowserDaemonNotRunningError,
  formatBrowserDaemonNotRunningError,
  getSocketPath,
  sendIPCRequest,
} from './ipc.js';
import { getHelpersDir } from '../state.js';

const paths = vi.hoisted(() => ({
  helperDir: `/tmp/agents-cli-browser-ipc-${process.pid}`,
}));

vi.mock('../state.js', () => ({
  getHelpersDir: vi.fn(() => paths.helperDir),
}));

const daemon = vi.hoisted(() => ({
  startDaemon: vi.fn(),
}));

vi.mock('../daemon.js', () => ({
  startDaemon: daemon.startDaemon,
}));

afterEach(() => {
  rmSync(paths.helperDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('getSocketPath', () => {
  it('places the browser IPC socket in its own helper subdirectory', () => {
    expect(getSocketPath()).toBe(path.join(getHelpersDir(), 'browser', 'browser.sock'));
  });
});

describe('sendIPCRequest', () => {
  it('reports daemon-not-running without starting the daemon when autoStartDaemon is false', async () => {
    await expect(
      sendIPCRequest({ action: 'status' }, { autoStartDaemon: false })
    ).rejects.toThrow(BrowserDaemonNotRunningError);
    await expect(
      sendIPCRequest({ action: 'status' }, { autoStartDaemon: false })
    ).rejects.toThrow(formatBrowserDaemonNotRunningError());
    expect(daemon.startDaemon).not.toHaveBeenCalled();
  });
});
