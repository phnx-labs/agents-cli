import { describe, it, expect } from 'vitest';
import * as net from 'net';

import { connectLocal } from './local.js';
import type { BrowserProfile } from '../types.js';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Failed to allocate free port')));
      }
    });
  });
}

function listenOn(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => {
      // Hold the connection open briefly so the probe's ACK lands cleanly.
      sock.on('data', () => {});
    });
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

describe('connectLocal — TCP probe fallback for #43', () => {
  it('refuses to auto-launch when the configured port is held by a non-CDP TCP listener', async () => {
    const port = await freePort();
    const blocker = await listenOn(port);

    const profile: BrowserProfile = {
      name: 'comet-like',
      browser: 'chrome',
      endpoints: [`cdp://127.0.0.1:${port}`],
    };

    try {
      // Either branch (lsof-based occupant detection or the TCP-probe fallback)
      // is fine — the contract is: surface an actionable error that names the
      // port + the profile, no Node stacktrace. Issue #43 is about UX, not
      // about which detection path catches it first.
      await expect(connectLocal(`cdp://127.0.0.1:${port}`, profile)).rejects.toThrow(
        new RegExp(`${port}`),
      );
      await expect(connectLocal(`cdp://127.0.0.1:${port}`, profile)).rejects.toThrow(
        /comet-like/,
      );
    } finally {
      blocker.close();
    }
  });
});
