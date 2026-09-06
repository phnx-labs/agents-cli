import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  parseLocalStateProfiles,
  parseSidebarSpaces,
  arcProfileSelector,
  discoverArcProfilesAt,
} from './arc-discovery.js';

const testdata = path.join(import.meta.dirname, 'testdata', 'arc');

describe('parseLocalStateProfiles', () => {
  it('extracts profiles from a valid Local State', () => {
    const result = parseLocalStateProfiles(path.join(testdata, 'local-state-valid.json'));
    expect(result).toBeInstanceOf(Map);
    const profiles = result as Map<string, string>;
    expect(profiles.size).toBe(3);
    expect(profiles.get('Default')).toBe('Personal');
    expect(profiles.get('Profile 1')).toBe('Work');
    expect(profiles.get('Profile 2')).toBe('Development');
    // System profile excluded
    expect(profiles.has('__ARC_SYSTEM_PROFILE')).toBe(false);
  });

  it('returns error for missing info_cache', () => {
    const result = parseLocalStateProfiles(path.join(testdata, 'local-state-malformed.json'));
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('no profile.info_cache');
  });

  it('returns empty map for empty info_cache', () => {
    const result = parseLocalStateProfiles(path.join(testdata, 'local-state-empty.json'));
    expect(result).toBeInstanceOf(Map);
    expect((result as Map<string, string>).size).toBe(0);
  });

  it('returns error for nonexistent file', () => {
    const result = parseLocalStateProfiles('/nonexistent/path/Local State');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('Cannot read');
  });
});

describe('parseSidebarSpaces', () => {
  it('extracts spaces with profile assignments from a valid sidebar', () => {
    const result = parseSidebarSpaces(path.join(testdata, 'storable-sidebar-valid.json'));
    expect(Array.isArray(result)).toBe(true);
    const spaces = result as Array<{ id: string; title: string; profileId: string }>;
    expect(spaces).toHaveLength(3);

    expect(spaces[0]).toEqual({
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      title: 'Home',
      profileId: 'Default',
    });
    expect(spaces[1]).toEqual({
      id: '11111111-2222-3333-4444-555555555555',
      title: 'Work',
      profileId: 'Profile 1',
    });
    expect(spaces[2]).toEqual({
      id: 'ffffffff-aaaa-bbbb-cccc-dddddddddddd',
      title: 'Reading',
      profileId: 'Default',
    });
  });

  it('rejects unsupported version', () => {
    const result = parseSidebarSpaces(
      path.join(testdata, 'storable-sidebar-wrong-version.json'),
    );
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('Unsupported StorableSidebar version');
  });

  it('returns error for nonexistent file', () => {
    const result = parseSidebarSpaces('/nonexistent/path/StorableSidebar.json');
    expect('error' in result).toBe(true);
  });
});

describe('arcProfileSelector', () => {
  it('generates the selector from the stable profile id, not its mutable display name', () => {
    expect(arcProfileSelector('Default')).toBe('arc-default');
    expect(arcProfileSelector('Profile 1')).toBe('arc-profile-1');
  });

  it('handles special characters', () => {
    expect(arcProfileSelector('Work & Play')).toBe('arc-work-play');
    expect(arcProfileSelector('  spaces  ')).toBe('arc-spaces');
  });

  it('handles empty name', () => {
    expect(arcProfileSelector('')).toBe('arc-profile');
  });
});

describe('discoverArcProfilesAt', () => {
  it('joins Spaces to profiles by stable native ids', () => {
    const result = discoverArcProfilesAt(path.join(testdata, 'valid'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profiles).toEqual([
      {
        profileId: 'Default',
        displayName: 'Personal',
        spaces: [
          { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'Home' },
          { id: 'ffffffff-aaaa-bbbb-cccc-dddddddddddd', title: 'Reading' },
        ],
      },
      {
        profileId: 'Profile 1',
        displayName: 'Work',
        spaces: [{ id: '11111111-2222-3333-4444-555555555555', title: 'Work' }],
      },
      { profileId: 'Profile 2', displayName: 'Development', spaces: [] },
    ]);
  });

  it('fails closed when a Space has an unknown profile mapping', () => {
    const result = discoverArcProfilesAt(path.join(testdata, 'unknown-profile'));
    expect(result).toEqual({
      ok: false,
      kind: 'invalid',
      reason: 'Arc Space "space-unknown" maps to unknown profile "Profile 99"',
    });
  });

  it('fails closed when the profile mapping shape is malformed instead of defaulting it', () => {
    const result = discoverArcProfilesAt(path.join(testdata, 'malformed-profile'));
    expect(result).toEqual({
      ok: false,
      kind: 'invalid',
      reason: 'Arc Space "space-malformed" has an unknown profile mapping',
    });
  });
});
