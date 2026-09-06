/**
 * Arc browser native profile and Space discovery (PHNX-2399).
 *
 * Read-only discovery of the user's installed Arc profiles and Spaces from Arc's
 * local metadata files. Never modifies Arc state, user data, or credentials.
 *
 * ## Data sources
 *
 * 1. `Local State` → `profile.info_cache`: maps profile directory basenames
 *    (e.g. "Default", "Profile 1") to `{ name, ... }`. Excludes
 *    `__ARC_SYSTEM_PROFILE`.
 *
 * 2. `StorableSidebar.json` → `sidebar.containers[].spaces`: alternating
 *    `[spaceUUID, { id, title, profile: { default: true } | { custom: { _0: { directoryBasename, ... } } } }, ...]`.
 *    Joins profile directories to Space IDs.
 *
 * Discovery is bounded: malformed, missing, or unrecognized data yields explicit
 * errors or unknown states, never fabricated profile metadata.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single Arc browser profile discovered from local metadata. */
export interface ArcProfile {
  /** Profile directory basename (e.g. "Default", "Profile 1"). */
  directoryBasename: string;
  /** Human-readable profile name from Arc's info cache. */
  displayName: string;
  /** Spaces that use this profile, by stable UUID. */
  spaces: ArcSpace[];
}

/** A single Arc Space discovered from StorableSidebar.json. */
export interface ArcSpace {
  /** Stable Space UUID from Arc's sidebar data. */
  id: string;
  /** Human-readable Space title. */
  title: string;
}

/** Result of attempting to discover Arc profiles on this machine. */
export type ArcDiscoveryResult =
  | { ok: true; profiles: ArcProfile[]; userDataDir: string }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Platform paths
// ---------------------------------------------------------------------------

/**
 * Resolve Arc's user data directory for the current platform.
 * Returns undefined on unsupported platforms.
 */
export function arcUserDataDir(): string | undefined {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Arc', 'User Data');
  }
  // Arc is macOS-only as of 2026-09. No Linux/Windows path.
  return undefined;
}

// ---------------------------------------------------------------------------
// Local State parsing
// ---------------------------------------------------------------------------

/** Raw shape of a profile entry in Local State → profile.info_cache. */
interface LocalStateProfileInfo {
  name?: string;
  [key: string]: unknown;
}

/**
 * Parse Arc's `Local State` file to extract profile directory → name mappings.
 * Excludes `__ARC_SYSTEM_PROFILE` and any entries with missing names.
 */
export function parseLocalStateProfiles(
  localStatePath: string,
): Map<string, string> | { error: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(localStatePath, 'utf-8');
  } catch (err) {
    return { error: `Cannot read Arc Local State: ${(err as Error).message}` };
  }

  let parsed: { profile?: { info_cache?: Record<string, LocalStateProfileInfo> } };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'Arc Local State is not valid JSON' };
  }

  const infoCache = parsed?.profile?.info_cache;
  if (!infoCache || typeof infoCache !== 'object') {
    return { error: 'Arc Local State has no profile.info_cache' };
  }

  const profiles = new Map<string, string>();
  for (const [dirBasename, info] of Object.entries(infoCache)) {
    if (dirBasename === '__ARC_SYSTEM_PROFILE') continue;
    if (!info || typeof info !== 'object') continue;
    const name = info.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    profiles.set(dirBasename, name);
  }

  return profiles;
}

// ---------------------------------------------------------------------------
// StorableSidebar.json parsing
// ---------------------------------------------------------------------------

/**
 * A single Space entry from StorableSidebar's alternating array encoding.
 * The profile reference is resolved to a directory basename.
 */
interface SidebarSpace {
  id: string;
  title: string;
  /** Profile directory basename, or 'Default' for the default profile. */
  profileDirectory: string;
}

/**
 * Parse Arc's `StorableSidebar.json` to extract Space → profile mappings.
 *
 * The `sidebar.containers` array contains objects; one (or more) will have a
 * `spaces` array encoded as alternating `[uuid, data, uuid, data, ...]`.
 */
export function parseSidebarSpaces(
  sidebarPath: string,
): SidebarSpace[] | { error: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(sidebarPath, 'utf-8');
  } catch (err) {
    return { error: `Cannot read Arc StorableSidebar.json: ${(err as Error).message}` };
  }

  let parsed: { version?: number; sidebar?: { containers?: unknown[] } };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'Arc StorableSidebar.json is not valid JSON' };
  }

  if (parsed.version !== 1) {
    return { error: `Unsupported StorableSidebar version: ${parsed.version}` };
  }

  const containers = parsed?.sidebar?.containers;
  if (!Array.isArray(containers)) {
    return { error: 'StorableSidebar.json has no sidebar.containers array' };
  }

  const spaces: SidebarSpace[] = [];

  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    const spaceArray = (container as Record<string, unknown>).spaces;
    if (!Array.isArray(spaceArray)) continue;

    // Alternating encoding: [uuid, data, uuid, data, ...]
    for (let i = 0; i + 1 < spaceArray.length; i += 2) {
      const uuid = spaceArray[i];
      const data = spaceArray[i + 1];
      if (typeof uuid !== 'string') continue;
      if (!data || typeof data !== 'object') continue;

      const spaceData = data as Record<string, unknown>;
      const id = spaceData.id;
      const title = spaceData.title;
      if (typeof id !== 'string' || typeof title !== 'string') continue;

      // Resolve profile directory from the Space's profile field
      const profileField = spaceData.profile;
      let profileDirectory = 'Default';
      if (profileField && typeof profileField === 'object') {
        const pf = profileField as Record<string, unknown>;
        if (pf.default === true) {
          profileDirectory = 'Default';
        } else if (pf.custom && typeof pf.custom === 'object') {
          const custom = pf.custom as Record<string, unknown>;
          // The custom field uses numbered keys like "_0"
          const firstCustom = custom._0 ?? Object.values(custom)[0];
          if (firstCustom && typeof firstCustom === 'object') {
            const customEntry = firstCustom as Record<string, unknown>;
            if (typeof customEntry.directoryBasename === 'string') {
              profileDirectory = customEntry.directoryBasename;
            }
          }
        }
      }

      spaces.push({ id, title, profileDirectory });
    }
  }

  return spaces;
}

// ---------------------------------------------------------------------------
// Public discovery entry point
// ---------------------------------------------------------------------------

/**
 * Discover Arc browser profiles and their Spaces from local metadata.
 *
 * Read-only: never modifies Arc data, launches Arc, or writes to agents config.
 * Returns a structured result; callers decide what to surface.
 */
export function discoverArcProfiles(): ArcDiscoveryResult {
  const userDataDirPath = arcUserDataDir();
  if (!userDataDirPath) {
    return { ok: false, reason: 'Arc is not supported on this platform' };
  }

  if (!fs.existsSync(userDataDirPath)) {
    return { ok: false, reason: `Arc user data directory not found: ${userDataDirPath}` };
  }

  // Parse Local State for profile names
  const localStatePath = path.join(userDataDirPath, 'Local State');
  const profileNames = parseLocalStateProfiles(localStatePath);
  if ('error' in profileNames) {
    return { ok: false, reason: profileNames.error };
  }

  if (profileNames.size === 0) {
    return { ok: false, reason: 'No Arc profiles found in Local State' };
  }

  // Parse StorableSidebar for Space → profile mappings
  const sidebarPath = path.join(userDataDirPath, 'StorableSidebar.json');
  const sidebarSpaces = parseSidebarSpaces(sidebarPath);
  if ('error' in sidebarSpaces) {
    return { ok: false, reason: sidebarSpaces.error };
  }

  // Build profile → spaces mapping. Only include profiles that appear in both
  // the Local State info_cache AND the sidebar space assignments.
  const profileMap = new Map<string, ArcProfile>();

  for (const [dirBasename, displayName] of profileNames) {
    profileMap.set(dirBasename, {
      directoryBasename: dirBasename,
      displayName,
      spaces: [],
    });
  }

  for (const space of sidebarSpaces) {
    const profile = profileMap.get(space.profileDirectory);
    if (!profile) {
      // Space references a profile directory not in info_cache — skip rather
      // than fabricate. This happens when profiles are deleted but sidebar
      // references linger.
      continue;
    }
    profile.spaces.push({ id: space.id, title: space.title });
  }

  // Include all discovered profiles, even those without spaces (the user may
  // have a profile with no assigned spaces yet — listing should show it).
  const profiles = [...profileMap.values()];

  return { ok: true, profiles, userDataDir: userDataDirPath };
}

/**
 * Generate a CLI-safe profile selector name from an Arc display name.
 * Lowercases, replaces non-alphanumeric with hyphens, collapses runs,
 * trims leading/trailing hyphens, and prepends "arc-".
 */
export function arcProfileSelector(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `arc-${slug || 'profile'}`;
}
