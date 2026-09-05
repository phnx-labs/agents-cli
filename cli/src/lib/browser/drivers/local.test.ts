import { describe, it, expect } from 'vitest';
import * as net from 'net';

import { connectLocal, arcAttachRequiredError, attachOnlyRequiredError, foreignInstanceError } from './local.js';
import type { BrowserProfile, ConnectionKey } from '../types.js';

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

// A real listener that answers the CDP /json/version probe immediately with a
// non-CDP 404 (a plausible "some other web server squats the port" case), so
// discoverBrowserWsUrl rejects fast on !response.ok instead of waiting out its
// 3s timeout. Used where the test only needs the "non-CDP occupant → never
// launches" outcome, not the hang-until-timeout path.
function respondNotFound(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => {
      sock.on('data', () => {
        sock.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      });
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

describe('connectLocal — Arc attaches to a running instance, never launches a duplicate (PHNX-2399)', () => {
  const key = 'my-arc@endpoint-0' as ConnectionKey;

  it('fails loud with the relaunch instruction when the Arc port serves no CDP endpoint', async () => {
    // Nothing is listening on this port. For a Chromium-family browser this is
    // the "fine to launch fresh" case — but Arc is single-instance and cannot be
    // spawned as an isolated debug instance, so it must fail loud rather than
    // spawn the stray window PHNX-2399 exists to end.
    const port = await freePort();
    const profile: BrowserProfile = {
      name: 'my-arc',
      browser: 'arc',
      endpoints: [`cdp://127.0.0.1:${port}`],
    };

    // One real connect attempt; the single loud message must name the profile,
    // the port, and the single-instance reason — and never reach launchBrowser.
    const err = await connectLocal(`cdp://127.0.0.1:${port}`, profile, key).then(
      () => {
        throw new Error('expected connectLocal to reject, not launch');
      },
      (e: unknown) => e as Error,
    );
    expect(err.message).toMatch(/my-arc/);
    expect(err.message).toMatch(new RegExp(`--remote-debugging-port=${port}`));
    expect(err.message).toMatch(/single-instance/);
  });

  it('still fails loud (never launches) when the Arc port is held by a non-CDP listener', async () => {
    const port = await freePort();
    const blocker = await listenOn(port);
    const profile: BrowserProfile = {
      name: 'held-arc',
      browser: 'arc',
      endpoints: [`cdp://127.0.0.1:${port}`],
    };
    try {
      await expect(connectLocal(`cdp://127.0.0.1:${port}`, profile, key)).rejects.toThrow(
        /held-arc/,
      );
    } finally {
      blocker.close();
    }
  });
});

describe('arcAttachRequiredError', () => {
  it('names the profile, the port, and the exact relaunch', () => {
    const msg = arcAttachRequiredError('work', 9222).message;
    expect(msg).toContain('work');
    expect(msg).toContain('open -a Arc --args --remote-debugging-port=9222');
    expect(msg).toContain('single-instance');
  });
});

describe('connectLocal — an attach-only Comet never spawns a second instance (PHNX-3967)', () => {
  const key = 'agents-comet@endpoint-0' as ConnectionKey;

  it('fails loud with the durable-dir relaunch when nothing serves CDP on the port', async () => {
    // Free port, attach-only Comet: this is the "fine to launch fresh" case for a
    // launch-policy Chromium profile — but an attach-only profile must NEVER reach
    // launchBrowser, or it spawns the second, logged-out dock tile the ticket ends.
    const port = await freePort();
    const profile: BrowserProfile = {
      name: 'agents-comet',
      browser: 'comet',
      launchPolicy: 'attach-only',
      userDataDir: '/tmp/agents-comet-durable',
      endpoints: [`cdp://127.0.0.1:${port}`],
    };

    // One real connect attempt; the single loud message must name the profile,
    // the durable-dir relaunch, and the attach-only reason — never launchBrowser.
    const err = await connectLocal(`cdp://127.0.0.1:${port}`, profile, key).then(
      () => {
        throw new Error('expected connectLocal to reject, not launch');
      },
      (e: unknown) => e as Error,
    );
    expect(err.message).toMatch(/agents-comet/);
    expect(err.message).toMatch(
      new RegExp(`open -a Comet --args --remote-debugging-port=${port} --user-data-dir=/tmp/agents-comet-durable`),
    );
    expect(err.message).toMatch(/attach-only/);
  });

  it('still fails loud (never launches) when the port is held by a non-CDP listener', async () => {
    const port = await freePort();
    // A real listener that answers the CDP probe FAST with a non-CDP 404, rather
    // than the silent hold in listenOn(): discoverBrowserWsUrl rejects on the
    // !response.ok branch in ms instead of waiting out its 3s timeout, so this
    // attach-only branch is covered without adding a real 3s wait to the suite.
    // The timeout-hold path stays covered by the Arc sibling above and the #43
    // probe test.
    const blocker = await respondNotFound(port);
    const profile: BrowserProfile = {
      name: 'agents-comet',
      browser: 'comet',
      launchPolicy: 'attach-only',
      endpoints: [`cdp://127.0.0.1:${port}`],
    };
    try {
      await expect(connectLocal(`cdp://127.0.0.1:${port}`, profile, key)).rejects.toThrow(/agents-comet/);
    } finally {
      blocker.close();
    }
  });
});

describe('attachOnlyRequiredError (PHNX-3967)', () => {
  it('routes an arc profile to the Arc-specific message', () => {
    const msg = attachOnlyRequiredError({ name: 'work', browser: 'arc' }, 9222).message;
    expect(msg).toContain('open -a Arc --args --remote-debugging-port=9222');
    expect(msg).toContain('single-instance');
  });

  it('names the browser, port, and durable data dir for a Comet profile', () => {
    const msg = attachOnlyRequiredError(
      { name: 'agents-comet', browser: 'comet', userDataDir: '/data/comet' },
      9333,
    ).message;
    expect(msg).toContain('agents-comet');
    expect(msg).toContain('open -a Comet --args --remote-debugging-port=9333 --user-data-dir=/data/comet');
    expect(msg).toContain('never launches a second one');
  });
});

describe('foreignInstanceError — port-squat rejection (PHNX-3967)', () => {
  it('names both dirs, the pid, and the ownership-rejection prefix so the driver re-throws it', () => {
    const err = foreignInstanceError(
      { name: 'agents-comet', browser: 'comet', userDataDir: '/data/comet' },
      9333,
      '/tmp/rush-mockup-comet.abc',
      45995,
    );
    expect(err.message.startsWith('Attach-only ownership check failed')).toBe(true);
    expect(err.message).toContain('/tmp/rush-mockup-comet.abc');
    expect(err.message).toContain('/data/comet');
    expect(err.message).toContain('kill 45995');
  });
});
