import * as net from 'net';

import { CDPClient, discoverBrowserWsUrl, verifyBrowserIdentity } from '../cdp.js';
import { launchBrowser, getPortOccupant } from '../chrome.js';
import { parseEndpointUrl } from '../profiles.js';
import type { BrowserProfile } from '../types.js';

/**
 * Cheap TCP-level "is something bound here?" probe. Used as a fallback when
 * `getPortOccupant()` (lsof-based) misses the process — Comet and other
 * Electron apps sometimes hold a TCP socket that lsof's `-sTCP:LISTEN` filter
 * doesn't report. If anything ACKs the connection, we treat the port as taken
 * and surface a friendly error instead of silently auto-launching a fresh
 * browser that would then conflict.
 */
async function probeTcpBound(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host });
    const cleanup = () => {
      sock.removeAllListeners();
      sock.destroy();
    };
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); cleanup(); resolve(true); });
    sock.once('error', () => { clearTimeout(timer); cleanup(); resolve(false); });
  });
}

export interface LocalConnection {
  cdp: CDPClient;
  port: number;
  pid: number;
}

/**
 * Local-port listeners we refuse to attach through. These forward CDP traffic
 * to a remote host — silently using them would let a `cdp://127.0.0.1:N`
 * profile drive a browser on a different machine without the caller realizing.
 */
const TUNNEL_PROCESS_NAMES = new Set(['ssh', 'autossh', 'mosh-client', 'socat']);

function isTunnelProcess(command: string): boolean {
  return TUNNEL_PROCESS_NAMES.has(command.toLowerCase());
}

export async function connectLocal(
  endpoint: string,
  profile: BrowserProfile
): Promise<LocalConnection> {
  const url = new URL(endpoint);

  if (url.protocol !== 'cdp:') {
    throw new Error(`Invalid local endpoint: ${endpoint}`);
  }

  // Share the parser with the SSH driver and the collision-detection code
  // path so `cdp://host:N` and `cdp://host?port=N` behave identically.
  const parsed = parseEndpointUrl(endpoint);
  const port = parsed?.port ?? 9222;

  // Refuse to attach through an SSH tunnel before we even try to speak CDP.
  // `verifyBrowserIdentity` only inspects what comes back over the wire — it
  // can't tell whether the browser actually lives on this machine or on the
  // far end of an `ssh -L` tunnel. A stale tunnel from a prior session
  // (common when an SSH-driven profile is deleted before the daemon exits)
  // will silently hijack any "local" profile bound to the same port.
  const preOccupant = getPortOccupant(port);
  if (preOccupant && isTunnelProcess(preOccupant.command)) {
    throw new Error(
      `Port ${port} is held by ${preOccupant.command} (pid ${preOccupant.pid}), an SSH ` +
        `tunnel forwarding to a remote host. Profile "${profile.name}" is configured as ` +
        `local (${endpoint}) but traffic would round-trip to another machine. Either kill ` +
        `the tunnel (\`kill ${preOccupant.pid}\`) and retry, or switch the profile to an ` +
        `ssh:// endpoint to drive the remote browser explicitly.`
    );
  }

  try {
    const { wsUrl, browser } = await discoverBrowserWsUrl(port, 'localhost', profile.name);
    verifyBrowserIdentity(browser, profile.browser, port);
    const cdp = new CDPClient();
    await cdp.connect(wsUrl);

    return { cdp, port, pid: 0 };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Browser identity mismatch')) {
      throw err;
    }

    // Distinguish "nothing listening on this port" (fine to launch fresh) from
    // "something is listening but it's not a debuggable browser" (bail loudly —
    // silently launching on a different port leads to confusing `pid 0` and
    // `CDP connection not open` errors downstream).
    const occupant = getPortOccupant(port);
    if (occupant) {
      throw new Error(
        `Port ${port} is occupied by ${occupant.command} (pid ${occupant.pid}) but is ` +
          `not serving the Chrome DevTools Protocol. Either stop that process ` +
          `(\`kill ${occupant.pid}\`) or restart it with \`--remote-debugging-port=${port}\` ` +
          `so profile "${profile.name}" can attach.`
      );
    }

    // lsof-based detection misses some Electron-family processes (Comet, custom
    // chrome wrappers). Cheap TCP probe as a safety net: if something ACKs a
    // connect, the port is bound — bail loudly with the profile name + endpoint
    // rather than silently launching a duplicate browser.
    if (await probeTcpBound(port)) {
      throw new Error(
        `Profile "${profile.name}" is configured for cdp://127.0.0.1:${port}, ` +
          `but something is already bound to that port without serving the Chrome ` +
          `DevTools Protocol. If that's your browser running without remote debugging, ` +
          `quit it and relaunch with \`--remote-debugging-port=${port}\`. Otherwise, ` +
          `update the profile to a free port (\`agents browser profiles list\`).`
      );
    }

    const newPort = port;
    const chromeOpts = { ...profile.chrome, viewport: profile.viewport };
    let launched;
    try {
      launched = await launchBrowser(
        profile.name,
        profile.browser,
        newPort,
        chromeOpts,
        profile.secrets,
        profile.binary,
        profile.electron === true
      );
    } catch (launchErr) {
      const reason = launchErr instanceof Error ? launchErr.message : String(launchErr);
      throw new Error(
        `Could not start ${profile.browser} for profile "${profile.name}" on port ${newPort}: ${reason}. ` +
          `Check that the browser binary is installed (\`agents browser profiles list\`) and ` +
          `that no other process is holding the port.`
      );
    }
    const cdp = new CDPClient();
    await cdp.connect(launched.wsUrl);

    return { cdp, port: newPort, pid: launched.pid };
  }
}
