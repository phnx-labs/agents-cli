/** Read-only Arc profile/Space discovery from Arc's native metadata. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ArcSpace {
  /** Stable UUID used for every native operation. */
  id: string;
  /** Display-only title. */
  title: string;
}

export interface ArcProfile {
  /** Arc's profile directory basename: the stable profile identity. */
  profileId: string;
  /** Display-only profile name from Local State. */
  displayName: string;
  spaces: ArcSpace[];
}

export type ArcDiscoveryResult =
  | { ok: true; profiles: ArcProfile[]; userDataDir: string }
  | { ok: false; kind: 'unsupported' | 'not-installed' | 'invalid'; reason: string };

interface SidebarSpace {
  id: string;
  title: string;
  profileId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function arcUserDataDir(): string | undefined {
  const override = process.env.AGENTS_ARC_USER_DATA_DIR;
  if (override) return path.resolve(override);
  if (process.platform !== 'darwin') return undefined;
  return path.join(os.homedir(), 'Library', 'Application Support', 'Arc', 'User Data');
}

export function parseLocalStateProfiles(
  localStatePath: string,
): Map<string, string> | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  } catch (error) {
    return {
      error: error instanceof SyntaxError
        ? 'Arc Local State is not valid JSON'
        : `Cannot read Arc Local State: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(parsed) || !isRecord(parsed.profile) || !isRecord(parsed.profile.info_cache)) {
    return { error: 'Arc Local State has no profile.info_cache map' };
  }

  const profiles = new Map<string, string>();
  for (const [profileId, value] of Object.entries(parsed.profile.info_cache)) {
    if (profileId === '__ARC_SYSTEM_PROFILE') continue;
    if (!isRecord(value) || typeof value.name !== 'string' || value.name.trim() === '') {
      return { error: `Arc Local State profile ${JSON.stringify(profileId)} has no non-empty name` };
    }
    profiles.set(profileId, value.name);
  }
  return profiles;
}

function parseProfileId(value: unknown, spaceId: string): string | { error: string } {
  if (!isRecord(value)) {
    return { error: `Arc Space ${JSON.stringify(spaceId)} has no profile mapping` };
  }
  if (value.default === true && value.custom === undefined) return 'Default';
  if (!isRecord(value.custom)) {
    return { error: `Arc Space ${JSON.stringify(spaceId)} has an unknown profile mapping` };
  }
  const entries = Object.values(value.custom);
  if (entries.length !== 1 || !isRecord(entries[0])) {
    return { error: `Arc Space ${JSON.stringify(spaceId)} has an ambiguous custom profile mapping` };
  }
  const profileId = entries[0].directoryBasename;
  if (typeof profileId !== 'string' || profileId.trim() === '') {
    return { error: `Arc Space ${JSON.stringify(spaceId)} has no custom profile id` };
  }
  return profileId;
}

export function parseSidebarSpaces(
  sidebarPath: string,
): SidebarSpace[] | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(sidebarPath, 'utf8'));
  } catch (error) {
    return {
      error: error instanceof SyntaxError
        ? 'Arc StorableSidebar.json is not valid JSON'
        : `Cannot read Arc StorableSidebar.json: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    const version = isRecord(parsed) ? parsed.version : undefined;
    return { error: `Unsupported StorableSidebar version: ${String(version)}` };
  }
  if (!isRecord(parsed.sidebar) || !Array.isArray(parsed.sidebar.containers)) {
    return { error: 'StorableSidebar.json has no sidebar.containers array' };
  }

  const spaces: SidebarSpace[] = [];
  const ids = new Set<string>();
  for (const container of parsed.sidebar.containers) {
    if (!isRecord(container) || container.spaces === undefined) continue;
    if (!Array.isArray(container.spaces) || container.spaces.length % 2 !== 0) {
      return { error: 'StorableSidebar.json contains a malformed alternating spaces array' };
    }
    for (let i = 0; i < container.spaces.length; i += 2) {
      const encodedId = container.spaces[i];
      const value = container.spaces[i + 1];
      if (typeof encodedId !== 'string' || !isRecord(value)) {
        return { error: `StorableSidebar.json contains a malformed Space at index ${i}` };
      }
      if (typeof value.id !== 'string' || value.id !== encodedId) {
        return { error: `Arc Space key ${JSON.stringify(encodedId)} does not match its stable id` };
      }
      if (typeof value.title !== 'string') {
        return { error: `Arc Space ${JSON.stringify(encodedId)} has no title` };
      }
      if (ids.has(encodedId)) {
        return { error: `Arc Space ${JSON.stringify(encodedId)} appears more than once` };
      }
      const profileId = parseProfileId(value.profile, encodedId);
      if (typeof profileId !== 'string') return profileId;
      ids.add(encodedId);
      spaces.push({ id: encodedId, title: value.title, profileId });
    }
  }
  return spaces;
}

export function discoverArcProfilesAt(userDataDir: string): ArcDiscoveryResult {
  if (!fs.existsSync(userDataDir)) {
    return { ok: false, kind: 'not-installed', reason: `Arc user data directory not found: ${userDataDir}` };
  }
  const profileNames = parseLocalStateProfiles(path.join(userDataDir, 'Local State'));
  if ('error' in profileNames) return { ok: false, kind: 'invalid', reason: profileNames.error };
  if (profileNames.size === 0) {
    return { ok: false, kind: 'invalid', reason: 'No Arc profiles found in Local State' };
  }
  const spaces = parseSidebarSpaces(path.join(userDataDir, 'StorableSidebar.json'));
  if ('error' in spaces) return { ok: false, kind: 'invalid', reason: spaces.error };

  const profiles = new Map<string, ArcProfile>();
  for (const [profileId, displayName] of profileNames) {
    profiles.set(profileId, { profileId, displayName, spaces: [] });
  }
  for (const space of spaces) {
    const profile = profiles.get(space.profileId);
    if (!profile) {
      return {
        ok: false,
        kind: 'invalid',
        reason: `Arc Space ${JSON.stringify(space.id)} maps to unknown profile ${JSON.stringify(space.profileId)}`,
      };
    }
    profile.spaces.push({ id: space.id, title: space.title });
  }
  const selectorOwners = new Map<string, string>();
  for (const profile of profiles.values()) {
    const selector = arcProfileSelector(profile.profileId);
    const existing = selectorOwners.get(selector);
    if (existing && existing !== profile.profileId) {
      return {
        ok: false,
        kind: 'invalid',
        reason: `Arc profile ids ${JSON.stringify(existing)} and ${JSON.stringify(profile.profileId)} map to the same CLI selector ${JSON.stringify(selector)}`,
      };
    }
    selectorOwners.set(selector, profile.profileId);
  }
  return { ok: true, profiles: [...profiles.values()], userDataDir };
}

export function discoverArcProfiles(): ArcDiscoveryResult {
  const userDataDir = arcUserDataDir();
  if (!userDataDir) {
    return { ok: false, kind: 'unsupported', reason: 'Arc is not supported on this platform' };
  }
  return discoverArcProfilesAt(userDataDir);
}

/** Stable CLI selector derived from the authoritative native profile id. */
export function arcProfileSelector(profileId: string): string {
  const slug = profileId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `arc-${slug || 'profile'}`;
}
