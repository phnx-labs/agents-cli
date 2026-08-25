import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as yaml from 'yaml';
import { getUserAgentsDir, readMeta, updateMeta } from '../state.js';
import type { BrowserProfileConfig, Meta } from '../types.js';

export interface ProfileDeclaration {
  device: string;
  config: BrowserProfileConfig;
}

type LegacyBrowserMeta = Meta & { browser?: Record<string, BrowserProfileConfig> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Leftover central `browser:` map from before per-device declarations. Empty when none remain. */
export function centralBrowserProfiles(): Record<string, BrowserProfileConfig> {
  const central = (readMeta() as LegacyBrowserMeta).browser;
  if (!central || Object.keys(central).length === 0) return {};
  return { ...central };
}

export interface CentralClaimResult {
  claimed: string[];
  skipped: string[];
}

/**
 * Fold leftover central `browser:` entries into THIS device's declaration file.
 *
 * Never called implicitly, and that is the point. Every device can read the
 * central map, so an implicit claim races: whichever box happens to read first
 * claims the name, {@link profileKind} then reports it `identity`, and the
 * daemon tunnels to that box — which for a fleet-wide `cdp://localhost:*`
 * profile is a logged-out headless browser wearing a credentialed browser's
 * name. That is the exact bug this module exists to remove, and an implicit
 * migration would write it to disk as a stored fact.
 *
 * The claim is an explicit operator action (`agents browser profiles claim`),
 * run on the machine that actually owns the browser. `canHostHere` is supplied
 * by the command layer so this module stays a leaf — it must not import
 * `isProfileLaunchableHere` (that would cycle through chrome.ts → profiles.ts).
 * Only profiles this machine can host are claimed; the rest stay central,
 * undeclared, and fail loudly on resolve.
 */
export function migrateCentralBrowserProfiles(
  canHostHere: (config: BrowserProfileConfig) => boolean,
  name?: string,
): CentralClaimResult {
  const meta = readMeta() as LegacyBrowserMeta;
  const central = meta.browser;
  if (!central || Object.keys(central).length === 0) {
    if (name) {
      throw new Error(`No leftover central browser profile named "${name}".`);
    }
    return { claimed: [], skipped: [] };
  }

  const local = meta.deviceBrowser ?? {};
  if (name) {
    const config = central[name];
    if (!config) {
      throw new Error(
        local[name]
          ? `Browser profile "${name}" is already declared on this device.`
          : `No leftover central browser profile named "${name}".`,
      );
    }
    if (!canHostHere(config)) {
      throw new Error(
        `Cannot claim browser profile "${name}": this machine cannot host it ` +
          `(its browser/binary isn't installed here). Run this command on the machine that has that browser.`,
      );
    }
  }

  const toClaim: Record<string, BrowserProfileConfig> = {};
  const skipped: string[] = [];
  for (const [profileName, config] of Object.entries(central)) {
    if (name && profileName !== name) continue;
    if (!canHostHere(config)) {
      skipped.push(profileName);
      continue;
    }
    const existing = local[profileName];
    if (existing && !isDeepStrictEqual(existing, config)) {
      throw new Error(
        `Cannot migrate browser profile "${profileName}": central agents.yaml and this device's ` +
          `agents.yaml declare different configurations. Resolve the duplicate before retrying.`,
      );
    }
    toClaim[profileName] = config;
  }

  const claimed = Object.keys(toClaim).sort();
  skipped.sort();
  if (claimed.length === 0) return { claimed, skipped };

  updateMeta((current) => {
    const legacy = current as LegacyBrowserMeta;
    const remaining: Record<string, BrowserProfileConfig> = {};
    for (const [profileName, config] of Object.entries(legacy.browser ?? {})) {
      if (!(profileName in toClaim)) remaining[profileName] = config;
    }
    const { browser: _removed, ...withoutCentralBrowser } = legacy;
    return {
      ...withoutCentralBrowser,
      ...(Object.keys(remaining).length > 0 ? { browser: remaining } : {}),
      deviceBrowser: { ...current.deviceBrowser, ...toClaim },
    } as Meta;
  });
  return { claimed, skipped };
}

/**
 * Every profile any device declares, keyed by name to all declaring devices.
 * Reads every `devices/<name>/agents.yaml`; declarations never overwrite.
 */
export function profileRegistry(): Map<string, ProfileDeclaration[]> {
  const registry = new Map<string, ProfileDeclaration[]>();
  const devicesDir = path.join(getUserAgentsDir(), 'devices');
  if (!fs.existsSync(devicesDir)) return registry;

  const devices = fs
    .readdirSync(devicesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const device of devices) {
    const file = path.join(devicesDir, device, 'agents.yaml');
    if (!fs.existsSync(file)) continue;

    let parsed: unknown;
    try {
      parsed = yaml.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(
        `Cannot read browser declarations from ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (parsed == null) continue;
    if (!isRecord(parsed)) {
      throw new Error(`Cannot read browser declarations from ${file}: document root must be a map.`);
    }

    const browser = parsed.browser;
    if (browser == null) continue;
    if (!isRecord(browser)) {
      throw new Error(`Cannot read browser declarations from ${file}: browser must be a map.`);
    }

    for (const [name, config] of Object.entries(browser)) {
      if (!isRecord(config)) {
        throw new Error(`Cannot read browser declaration "${name}" from ${file}: profile must be a map.`);
      }
      const declarations = registry.get(name) ?? [];
      declarations.push({ device, config: config as unknown as BrowserProfileConfig });
      registry.set(name, declarations);
    }
  }

  return registry;
}

/** Devices declaring `name`, empty when nobody does. */
export function declaringDevices(name: string): string[] {
  return (profileRegistry().get(name) ?? []).map((declaration) => declaration.device);
}

/** Exactly one declaring device is identity-bearing; several are fungible. */
export function profileKind(name: string): 'identity' | 'fungible' | null {
  const count = profileRegistry().get(name)?.length ?? 0;
  if (count === 0) return null;
  return count === 1 ? 'identity' : 'fungible';
}
