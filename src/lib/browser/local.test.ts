import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('./cdp.js', () => ({
  CDPClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
  })),
  discoverBrowserWsUrl: vi.fn(),
  verifyBrowserIdentity: vi.fn(),
}));

vi.mock('./chrome.js', () => ({
  launchBrowser: vi.fn(),
  getPortOccupant: vi.fn(),
}));

import { connectLocal } from './drivers/local.js';
import { discoverBrowserWsUrl, verifyBrowserIdentity } from './cdp.js';
import { launchBrowser, getPortOccupant } from './chrome.js';
import type { BrowserProfile } from './types.js';

function makeProfile(overrides: Partial<BrowserProfile> = {}): BrowserProfile {
  return {
    name: 'test-profile',
    browser: 'chrome',
    endpoints: ['cdp://127.0.0.1:9335'],
    ...overrides,
  };
}

describe('connectLocal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('launch uses the endpoint port, not a random allocatePort()', async () => {
    const profile = makeProfile({ browser: 'chrome', endpoints: ['cdp://127.0.0.1:9335'] });

    // Nothing listening on 9335 → discoverBrowserWsUrl throws
    vi.mocked(discoverBrowserWsUrl).mockRejectedValue(new Error('connection refused'));
    // No occupant (port is free)
    vi.mocked(getPortOccupant).mockReturnValue(null);
    // Browser launches successfully
    vi.mocked(launchBrowser).mockResolvedValue({ pid: 1234, port: 9335, wsUrl: 'ws://localhost:9335/devtools/browser/abc' });

    await connectLocal('cdp://127.0.0.1:9335', profile);

    expect(launchBrowser).toHaveBeenCalledWith(
      'test-profile',
      'chrome',
      9335, // must be the endpoint port, not any other port
      expect.anything(),
      undefined,
      undefined,
      false // isElectron defaults to false for chrome
    );
  });

  it('reuse path: returns pid 0 when browser is already running on endpoint port', async () => {
    const profile = makeProfile({ browser: 'chrome', endpoints: ['cdp://127.0.0.1:9335'] });

    vi.mocked(discoverBrowserWsUrl).mockResolvedValue({
      wsUrl: 'ws://localhost:9335/devtools/browser/abc',
      browser: 'chrome',
    });
    vi.mocked(verifyBrowserIdentity).mockReturnValue(undefined);

    const result = await connectLocal('cdp://127.0.0.1:9335', profile);

    expect(result.pid).toBe(0);
    expect(result.port).toBe(9335);
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it('throws Browser identity mismatch when reported browser does not match profile', async () => {
    const profile = makeProfile({ browser: 'chrome', endpoints: ['cdp://127.0.0.1:9335'] });

    vi.mocked(discoverBrowserWsUrl).mockResolvedValue({
      wsUrl: 'ws://localhost:9335/devtools/browser/abc',
      browser: 'firefox',
    });
    vi.mocked(verifyBrowserIdentity).mockImplementation(() => {
      throw new Error('Browser identity mismatch: profile expects "chrome" but port 9335 is serving "firefox".');
    });

    await expect(connectLocal('cdp://127.0.0.1:9335', profile)).rejects.toThrow(
      'Browser identity mismatch'
    );
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it('throws with kill hint when a non-CDP process occupies the port', async () => {
    const profile = makeProfile({ browser: 'chrome', endpoints: ['cdp://127.0.0.1:9335'] });

    vi.mocked(discoverBrowserWsUrl).mockRejectedValue(new Error('connection refused'));
    vi.mocked(getPortOccupant).mockReturnValue({ pid: 1234, command: 'node' });

    await expect(connectLocal('cdp://127.0.0.1:9335', profile)).rejects.toThrow(
      /kill 1234/
    );
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  // Regression: a `cdp://127.0.0.1:N` profile must not silently drive the
  // remote browser sitting on the far end of an SSH tunnel. Verified before
  // CDP connect — `verifyBrowserIdentity` only checks what comes back over
  // the wire, so it happily accepts the remote browser's identity.
  it('refuses to attach when an SSH tunnel holds the local port', async () => {
    const profile = makeProfile({ browser: 'comet', endpoints: ['cdp://127.0.0.1:9200'] });

    vi.mocked(getPortOccupant).mockReturnValue({ pid: 40117, command: 'ssh' });
    // discoverBrowserWsUrl WOULD succeed (mac-mini's Comet/Chrome responds
    // through the tunnel) — make sure we bail before we even ask.
    vi.mocked(discoverBrowserWsUrl).mockResolvedValue({
      wsUrl: 'ws://localhost:9200/devtools/browser/abc',
      browser: 'chrome',
    });

    await expect(connectLocal('cdp://127.0.0.1:9200', profile)).rejects.toThrow(
      /forwarding to a remote host/
    );
    await expect(connectLocal('cdp://127.0.0.1:9200', profile)).rejects.toThrow(
      /kill 40117/
    );
    expect(discoverBrowserWsUrl).not.toHaveBeenCalled();
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it('detects autossh and socat as tunnel processes too', async () => {
    const profile = makeProfile({ endpoints: ['cdp://127.0.0.1:9200'] });

    vi.mocked(getPortOccupant).mockReturnValue({ pid: 12, command: 'autossh' });
    await expect(connectLocal('cdp://127.0.0.1:9200', profile)).rejects.toThrow(
      /autossh.*forwarding to a remote host/s
    );

    vi.mocked(getPortOccupant).mockReturnValue({ pid: 34, command: 'socat' });
    await expect(connectLocal('cdp://127.0.0.1:9200', profile)).rejects.toThrow(
      /socat.*forwarding to a remote host/s
    );
  });

  it('tunnel-process check is case-insensitive', async () => {
    const profile = makeProfile({ endpoints: ['cdp://127.0.0.1:9200'] });

    // Different platforms (or wrapped binaries) sometimes return "SSH" in
    // upper-case from lsof. The guard must still catch it.
    vi.mocked(getPortOccupant).mockReturnValue({ pid: 99, command: 'SSH' });
    await expect(connectLocal('cdp://127.0.0.1:9200', profile)).rejects.toThrow(
      /forwarding to a remote host/
    );
  });
});
