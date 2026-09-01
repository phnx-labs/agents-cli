import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { rmSync } from 'fs';
import { execFileSync } from 'child_process';
import * as path from 'path';

import { execFileBounded } from '../exec-bounded.js';

const HELPER_DIR = `/tmp/agents-cli-eventloop-${process.pid}`;

// Isolate ONLY the browser IPC socket path into a per-pid temp dir; everything
// else in state.js stays real (BrowserService reaches version.ts through it).
// Mirrors browser/ipc.test.ts.
vi.mock('../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state.js')>()),
  getHelpersDir: vi.fn(() => HELPER_DIR),
}));

afterEach(() => {
  rmSync(HELPER_DIR, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('the daemon event loop is not starved by a running child (PHNX-3695)', () => {
  it('a SYNCHRONOUS exec freezes the loop — the wedge this fix removes', async () => {
    // A timer set to fire immediately cannot run while execFileSync holds the
    // single thread. This is exactly why a sync spawn on a service tick made the
    // browser `version` probe "accept but never reply" (browser/ipc.ts:233).
    const scheduled = Date.now();
    let fireDelay = -1;
    setTimeout(() => { fireDelay = Date.now() - scheduled; }, 0);
    execFileSync('node', ['-e', 'const e=Date.now()+400;while(Date.now()<e){}'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 10)); // let the (now overdue) 0ms timer flush
    // The 0ms timer could not run until the 400ms sync exec released the thread.
    expect(fireDelay).toBeGreaterThanOrEqual(300);
  });

  it('a bounded ASYNC exec leaves the browser version probe responsive while it runs', async () => {
    const { BrowserIPCServer } = await import('../browser/ipc.js');
    const { BrowserService } = await import('../browser/service.js');
    const { isBrowserServiceResponsive, getSocketPath } = await import('../browser/ipc.js');
    const { ipcEndpoint } = await import('../platform/index.js');

    const server = new BrowserIPCServer(new BrowserService());
    await server.start();
    const endpoint = ipcEndpoint(getSocketPath());
    try {
      // Baseline: a healthy server answers the trivial version probe.
      expect(await isBrowserServiceResponsive(endpoint, 2)).toBe(true);

      // Start a SLOW child (~1.2s) via the bounded helper and DO NOT await it.
      // With a synchronous spawn the loop would be frozen for its whole life and
      // the probe below would time out; with execFileBounded the loop stays live.
      const slow = execFileBounded('node', ['-e', 'setTimeout(()=>{}, 1200)'], { timeoutMs: 10_000 });

      const started = Date.now();
      const responsive = await isBrowserServiceResponsive(endpoint, 2);
      const elapsed = Date.now() - started;

      expect(responsive).toBe(true);
      // The reply came back promptly — far inside the child's 1.2s lifetime —
      // proving the child never blocked the event loop.
      expect(elapsed).toBeLessThan(1_000);

      const res = await slow;
      expect(res.code).toBe(0);
    } finally {
      await server.stop();
    }
  }, 20_000);
});
