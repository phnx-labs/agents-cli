import * as path from 'path';
import {
  getBrowserRuntimeDir as getBrowserRuntimeDirRoot,
  readMeta,
  writeMeta,
} from '../state.js';
import type { BrowserProfileConfig } from '../types.js';
import type { BrowserProfile } from './types.js';
import { findBrowserPath, findFirstInstalledBrowser, isPortInUse } from './chrome.js';
import { DEFAULT_VIEWPORT } from './devices.js';

export type { BrowserProfile } from './types.js';

export const DEFAULT_BROWSER_PROFILE_NAME = 'default';

/**
 * The device-local configured default profile name (set via
 * `agents browser profiles set-default`), or undefined when unset. When set, it
 * is the profile `agents browser start` resolves to for BOTH the no-`--profile`
 * path and an explicit `--profile default`. Stored per-machine — see
 * `Meta.defaultBrowserProfile`.
 */
export function getConfiguredDefaultProfileName(): string | undefined {
  return readMeta().defaultBrowserProfile || undefined;
}

export function getBrowserRuntimeDir(): string {
  return getBrowserRuntimeDirRoot();
}

export function getProfileRuntimeDir(name: string): string {
  return path.join(getBrowserRuntimeDir(), name);
}

function configToProfile(name: string, config: BrowserProfileConfig): BrowserProfile {
  validateRemoteBrowserBinaries(config);
  return {
    name,
    description: config.description,
    browser: config.browser,
    binary: config.binary,
    electron: config.electron,
    targetFilter: config.targetFilter,
    endpoints: config.endpoints,
    defaultEndpoint: config.defaultEndpoint,
    chrome: config.chrome,
    secrets: config.secrets,
    viewport: config.viewport,
    logDir: config.logDir,
    logHost: config.logHost,
  };
}

function profileToConfig(profile: BrowserProfile): BrowserProfileConfig {
  validateRemoteBrowserBinaries(profile);
  const config: BrowserProfileConfig = {
    browser: profile.browser,
    endpoints: profile.endpoints,
  };
  if (profile.description) config.description = profile.description;
  if (profile.binary) config.binary = profile.binary;
  if (profile.electron) config.electron = profile.electron;
  if (profile.targetFilter) config.targetFilter = profile.targetFilter;
  if (profile.defaultEndpoint) config.defaultEndpoint = profile.defaultEndpoint;
  if (profile.chrome) config.chrome = profile.chrome;
  if (profile.secrets) config.secrets = profile.secrets;
  if (profile.viewport) config.viewport = profile.viewport;
  if (profile.logDir) config.logDir = profile.logDir;
  if (profile.logHost) config.logHost = profile.logHost;
  return config;
}

export async function listProfiles(): Promise<BrowserProfile[]> {
  const meta = readMeta();
  if (!meta.browser) return [];

  return Object.entries(meta.browser).map(([name, config]) =>
    configToProfile(name, config)
  );
}

export async function getProfile(name: string): Promise<BrowserProfile | null> {
  const meta = readMeta();
  const config = meta.browser?.[name];
  if (!config) return null;
  return configToProfile(name, config);
}

/**
 * Resolve the profile `agents browser start` uses when no `--profile` is given.
 *
 * Order: (1) the device-local configured default (`agents browser profiles
 * set-default <name>`) when it names an existing profile; (2) an existing
 * `default` profile as-is; (3) auto-pick the first installed Chromium-family
 * browser per the platform priority list in chrome.ts (macOS: chrome > brave >
 * edge > chromium > comet; Linux: chrome > chromium > brave > edge; Windows:
 * edge > chrome > brave > comet) and pin a new `default` profile to it. Throws an
 * actionable error if none of those binaries are installed. A configured default
 * that no longer exists warns and falls through to (2)/(3) — never a hard fail.
 */
export async function ensureDefaultBrowserProfile(): Promise<BrowserProfile> {
  const configured = getConfiguredDefaultProfileName();
  if (configured) {
    const chosen = await getProfile(configured);
    if (chosen) return chosen;
    console.warn(
      `warning: configured default browser profile "${configured}" no longer exists; ` +
      `falling back to auto-detect. Fix with: agents browser profiles set-default <name>  (or --unset)`
    );
  }

  const existing = await getProfile(DEFAULT_BROWSER_PROFILE_NAME);
  if (existing) return existing;

  const detected = findFirstInstalledBrowser();
  if (!detected) {
    throw new Error(
      'No supported browser found. Install one of: Chrome, Brave, Edge, Chromium, or Comet, ' +
      'then re-run `agents browser start`. Or create a profile explicitly with ' +
      '`agents browser profiles create <name> --browser <chrome|comet|chromium|brave|edge|custom>`. ' +
      'Note: Safari and Firefox are not supported — agents browser drives over the ' +
      'Chrome DevTools Protocol, which they don\'t implement.'
    );
  }

  const freePort = await findFreeProfilePort();
  const profile: BrowserProfile = {
    name: DEFAULT_BROWSER_PROFILE_NAME,
    description: `Auto-detected ${detected.browserType} profile`,
    browser: detected.browserType,
    binary: detected.binary,
    endpoints: [`cdp://127.0.0.1:${freePort}`],
    viewport: {
      width: DEFAULT_VIEWPORT.width,
      height: DEFAULT_VIEWPORT.height,
    },
  };
  await createProfile(profile);
  return profile;
}

/**
 * Compute the LOCAL port a profile will occupy at runtime:
 *   - `cdp://127.0.0.1:N` → N (we listen on N directly)
 *   - `ssh://host?port=N` → N (the SSH tunnel binds local N → remote N now)
 *   - `ws[s]://`, `http[s]://` → undefined (we don't claim a local port)
 *
 * This is what callers should compare to detect collisions; the (host,
 * port) tuple is no longer enough because SSH profiles do compete with
 * cdp:// profiles for local ports under the new tunnel scheme.
 */
export function effectiveLocalPort(profile: BrowserProfile): number | undefined {
  const presets = getEndpointPresets(profile);
  const firstName = profile.defaultEndpoint && presets[profile.defaultEndpoint]
    ? profile.defaultEndpoint
    : Object.keys(presets)[0];
  if (!firstName) return undefined;
  const target = presets[firstName].target;
  let url: URL;
  try { url = new URL(target); } catch { return undefined; }
  if (url.protocol !== 'cdp:' && url.protocol !== 'ssh:') return undefined;
  return parseEndpointUrl(target)?.port;
}

/**
 * Find a port in 9222–9399 that is not already claimed by ANY existing
 * profile (cdp:// or ssh://) and is not in use by any OS process. The
 * SSH change to bind locally on `?port=N` means we no longer get to
 * skip remote profiles in this scan.
 */
export async function findFreeProfilePort(): Promise<number> {
  const profiles = await listProfiles();
  const usedByProfile = new Set<number>();
  for (const p of profiles) {
    const port = effectiveLocalPort(p);
    if (port !== undefined) usedByProfile.add(port);
  }

  for (let port = 9222; port <= 9399; port++) {
    if (usedByProfile.has(port)) continue;
    // Platform-aware bound-port probe (lsof on POSIX, netstat on Windows).
    // The old inline lsof call threw ENOENT on Windows — where lsof doesn't
    // exist — so EVERY port scanned as "free", including one an already-
    // running browser was listening on (typically 9222), and the new profile
    // would silently attach to that browser instead of launching its own.
    if (!isPortInUse(port)) return port;
  }

  throw new Error('No available ports in range 9222-9399');
}

function validateRemoteBrowserBinaries(
  profile: Pick<BrowserProfileConfig, 'binary' | 'endpoints'>
): void {
  if (!hasSshEndpoint(profile.endpoints)) return;
  validateRemoteBrowserBinary(profile.binary);
  if (!Array.isArray(profile.endpoints)) {
    for (const preset of Object.values(profile.endpoints)) {
      validateRemoteBrowserBinary(preset.binary);
    }
  }
}

function validateRemoteBrowserBinary(binary: string | undefined): void {
  if (!binary) return;
  if (/[\0\r\n;&|`$<>]/.test(binary)) {
    throw new Error(
      `Remote browser binary contains shell metacharacters: ${binary}`
    );
  }
}

function hasSshEndpoint(endpoints: BrowserProfileConfig['endpoints']): boolean {
  const targets = Array.isArray(endpoints)
    ? endpoints
    : Object.values(endpoints).map((preset) => preset.target);
  return targets.some((target) => {
    try {
      return new URL(target).protocol === 'ssh:';
    } catch {
      return false;
    }
  });
}

/**
 * True when any endpoint is an `ssh://…?os=windows` target — i.e. the browser
 * lives on a remote Windows host. Such a profile's binary (`msedge.exe`) will
 * never exist on this Mac, so create-time local-binary validation must be
 * skipped; the binary is resolved on the remote at connect time instead.
 */
function hasRemoteWindowsEndpoint(endpoints: BrowserProfileConfig['endpoints']): boolean {
  const targets = Array.isArray(endpoints)
    ? endpoints
    : Object.values(endpoints).map((preset) => preset.target);
  return targets.some((target) => {
    try {
      const url = new URL(target);
      return (
        url.protocol === 'ssh:' &&
        (url.searchParams.get('os') || '').toLowerCase() === 'windows'
      );
    } catch {
      return false;
    }
  });
}

export async function createProfile(profile: BrowserProfile): Promise<void> {
  const meta = readMeta();
  if (meta.browser?.[profile.name]) {
    throw new Error(`Profile "${profile.name}" already exists`);
  }

  // Collision check. Every CDP/SSH profile ends up listening on (or
  // tunneling to) the same LOCAL port number as the one configured in the
  // endpoint URL — SSH profiles now reuse `?port=N` locally so we no
  // longer need to scope by host. Two profiles that would need the same
  // local port can't both run at the same time.
  const newLocal = effectiveLocalPort(profile);
  if (newLocal !== undefined && meta.browser) {
    for (const [existingName, existingConfig] of Object.entries(meta.browser)) {
      const existingProfile = configToProfile(existingName, existingConfig);
      const existingLocal = effectiveLocalPort(existingProfile);
      if (existingLocal === newLocal) {
        throw new Error(
          `Local port ${newLocal} is already used by profile "${existingName}". ` +
            `Each profile must own a unique local port (SSH tunnels now bind ` +
            `to their configured port locally too). Pick a different port.`
        );
      }
    }
  }

  // Resolve the browser binary at create time. Fails fast with an actionable
  // error ("Comet not installed at /Applications/Comet.app") rather than
  // deferring the failure to the first task. `findBrowserPath` short-circuits
  // for browser=custom without a binary by throwing — same outcome.
  //
  // Skip for remote-Windows profiles: the browser is `msedge.exe` on the
  // remote box, never on this Mac, so a local lookup would always (wrongly)
  // fail. The remote launcher resolves it at connect time via App Paths.
  if (!hasRemoteWindowsEndpoint(profile.endpoints)) {
    findBrowserPath(profile.browser, profile.binary);
  }

  meta.browser = meta.browser ?? {};
  meta.browser[profile.name] = profileToConfig(profile);
  writeMeta(meta);
}

export async function updateProfile(profile: BrowserProfile): Promise<void> {
  const meta = readMeta();
  if (!meta.browser?.[profile.name]) {
    throw new Error(`Profile "${profile.name}" does not exist`);
  }

  meta.browser[profile.name] = profileToConfig(profile);
  writeMeta(meta);
}

export async function deleteProfile(name: string): Promise<void> {
  const meta = readMeta();
  if (!meta.browser?.[name]) {
    throw new Error(`Profile "${name}" does not exist`);
  }

  delete meta.browser[name];
  writeMeta(meta);
}

/**
 * Resolve a profile's endpoint presets into a normalized map regardless of
 * whether the YAML uses the legacy `string[]` shape or the new map shape.
 * The legacy entries get auto-named `endpoint-0`, `endpoint-1`, ... .
 */
export function getEndpointPresets(
  profile: BrowserProfile
): Record<string, import('./types.js').EndpointPreset> {
  if (Array.isArray(profile.endpoints)) {
    const out: Record<string, import('./types.js').EndpointPreset> = {};
    profile.endpoints.forEach((target, i) => {
      out[`endpoint-${i}`] = { target };
    });
    return out;
  }
  return profile.endpoints;
}

/**
 * Pick the endpoint preset to use. Order:
 *   1. Explicit name passed in (errors if unknown)
 *   2. `profile.defaultEndpoint` if set
 *   3. First entry (preserves legacy string[] behavior)
 *
 * Returns the resolved name + the preset (with per-endpoint overrides
 * already applied to binary / targetFilter), so callers don't have to
 * remember the precedence rules.
 */
export function resolveEndpoint(
  profile: BrowserProfile,
  endpointName?: string
): { name: string; target: string; binary?: string; targetFilter?: string } {
  const presets = getEndpointPresets(profile);
  const names = Object.keys(presets);
  if (names.length === 0) {
    throw new Error(`Profile "${profile.name}" has no endpoints configured`);
  }

  let chosenName: string;
  if (endpointName) {
    if (!presets[endpointName]) {
      throw new Error(
        `Endpoint "${endpointName}" not found on profile "${profile.name}". ` +
          `Available: ${names.join(', ')}`
      );
    }
    chosenName = endpointName;
  } else if (profile.defaultEndpoint && presets[profile.defaultEndpoint]) {
    chosenName = profile.defaultEndpoint;
  } else {
    chosenName = names[0];
  }

  const preset = presets[chosenName];
  return {
    name: chosenName,
    target: preset.target,
    binary: preset.binary ?? profile.binary,
    targetFilter: preset.targetFilter ?? profile.targetFilter,
  };
}

/**
 * Extract the (host, port) pair intended by the profile's default endpoint.
 * Returns undefined for endpoint shapes that don't carry a port (e.g. ws:// without one).
 *
 * Ports are scoped by host: a `cdp://127.0.0.1:9222` profile (local Chrome on
 * this machine) and an `ssh://remote-host:9222` profile (Comet on a remote
 * host) point at different physical ports — the host disambiguates them.
 *
 * Accepts both `scheme://host:port` and `scheme://host?port=N` shapes (the
 * latter is the documented form in `types.ts` for `ssh://`). Without this,
 * `ssh://remote-host?port=18805` would silently fall back to 9222 and every
 * `?port=`-style SSH profile would collide on creation.
 */
export function extractConfiguredEndpoint(
  profile: BrowserProfile
): { host: string; port: number } | undefined {
  const presets = getEndpointPresets(profile);
  const firstName = profile.defaultEndpoint && presets[profile.defaultEndpoint]
    ? profile.defaultEndpoint
    : Object.keys(presets)[0];
  if (!firstName) return undefined;
  return parseEndpointUrl(presets[firstName].target);
}

/**
 * Shared endpoint parser used by both the collision-detection code path and
 * the connection drivers. Returning a single normalized `(host, port)` here
 * keeps `extractConfiguredEndpoint` and the SSH driver from drifting on URL
 * conventions (which is how `?port=N` ended up being silently ignored).
 */
export function parseEndpointUrl(
  endpoint: string
): { host: string; port: number } | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  const host = normalizeHost(url.hostname, url.protocol);
  if (!host) return undefined;
  const port = extractPortFromUrl(url);
  if (port !== undefined) return { host, port };
  // SSH endpoints tunnel to a remote port AND bind that same port locally,
  // so they do "own" a local port — the host-scoped collision check used
  // to disagree, but we want the local-port-scoped semantics now.
  if (url.protocol === 'cdp:' || url.protocol === 'ssh:') return { host, port: 9222 };
  return undefined;
}

function extractPortFromUrl(url: URL): number | undefined {
  if (url.port) {
    const n = parseInt(url.port, 10);
    if (Number.isFinite(n)) return n;
  }
  // `scheme://host?port=N` — the form documented for SSH endpoints in
  // `types.ts`. WHATWG URL parsing surfaces it via searchParams only.
  const qp = url.searchParams.get('port');
  if (qp) {
    const n = parseInt(qp, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Extract the port intended by the profile's default endpoint.
 * Returns undefined for endpoint shapes that don't carry a port (e.g. ws:// without one).
 *
 * Note: this loses the host dimension — for collision detection use
 * `extractConfiguredEndpoint` instead, which returns the (host, port) pair.
 */
export function extractConfiguredPort(profile: BrowserProfile): number | undefined {
  return extractConfiguredEndpoint(profile)?.port;
}

function normalizeHost(hostname: string, protocol: string): string | undefined {
  if (!hostname) {
    // cdp:// and ssh:// without an explicit host imply localhost.
    if (protocol === 'cdp:' || protocol === 'ssh:') return '127.0.0.1';
    return undefined;
  }
  if (hostname === 'localhost') return '127.0.0.1';
  return hostname;
}

export function isLocalHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
