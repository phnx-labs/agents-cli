import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  parseLocalStateProfiles,
  parseSidebarSpaces,
  arcProfileSelector,
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
    const spaces = result as Array<{ id: string; title: string; profileDirectory: string }>;
    expect(spaces).toHaveLength(3);

    expect(spaces[0]).toEqual({
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      title: 'Home',
      profileDirectory: 'Default',
    });
    expect(spaces[1]).toEqual({
      id: '11111111-2222-3333-4444-555555555555',
      title: 'Work',
      profileDirectory: 'Profile 1',
    });
    expect(spaces[2]).toEqual({
      id: 'ffffffff-aaaa-bbbb-cccc-dddddddddddd',
      title: 'Reading',
      profileDirectory: 'Default',
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
  it('generates a slug from a display name', () => {
    expect(arcProfileSelector('Work')).toBe('arc-work');
    expect(arcProfileSelector('Personal')).toBe('arc-personal');
    expect(arcProfileSelector('My Dev Profile')).toBe('arc-my-dev-profile');
  });

  it('handles special characters', () => {
    expect(arcProfileSelector('Work & Play')).toBe('arc-work-play');
    expect(arcProfileSelector('  spaces  ')).toBe('arc-spaces');
  });

  it('handles empty name', () => {
    expect(arcProfileSelector('')).toBe('arc-profile');
  });
});
