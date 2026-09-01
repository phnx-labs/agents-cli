import { describe, expect, it } from 'vitest';
import {
  MANAGED_DEFAULT_VISIBILITY,
  BYO_DEFAULT_VISIBILITY,
  defaultVisibilityForBackend,
  explicitVisibility,
  resolveVisibility,
  publishVisibility,
  PUBLISH_VISIBILITY_LEVELS,
  EDITABLE_VISIBILITY_LEVELS,
} from './visibility.js';

describe('visibility model — the one product default', () => {
  it('private (me) is the managed default; public is the BYO default', () => {
    expect(MANAGED_DEFAULT_VISIBILITY).toBe('me');
    expect(BYO_DEFAULT_VISIBILITY).toBe('public');
    expect(defaultVisibilityForBackend('managed')).toBe('me');
    expect(defaultVisibilityForBackend('byo')).toBe('public');
  });

  it('level sets match the Worker vocabulary; private is publish-only', () => {
    expect([...PUBLISH_VISIBILITY_LEVELS]).toEqual(['public', 'unlisted', 'private', 'me', 'org']);
    expect([...EDITABLE_VISIBILITY_LEVELS]).toEqual(['public', 'unlisted', 'me', 'org']);
    expect(EDITABLE_VISIBILITY_LEVELS).not.toContain('private');
  });
});

describe('explicitVisibility — distinguishes a real choice from "no preference"', () => {
  it('returns undefined when nothing was asked', () => {
    expect(explicitVisibility({})).toBeUndefined();
    expect(explicitVisibility({ visibility: undefined })).toBeUndefined();
  });

  it('--protected wins over --unlisted, which wins over --visibility', () => {
    expect(explicitVisibility({ protected: true, unlisted: true, visibility: 'public' })).toBe('private');
    expect(explicitVisibility({ unlisted: true, visibility: 'public' })).toBe('unlisted');
  });

  it('passes an explicit --visibility through, including public', () => {
    for (const level of PUBLISH_VISIBILITY_LEVELS) {
      expect(explicitVisibility({ visibility: level })).toBe(level);
    }
  });
});

describe('publishVisibility — explicit-or-backend-default (the surface entry point)', () => {
  it('signed in, no flags → me (private by default)', () => {
    expect(publishVisibility({}, 'managed')).toBe('me');
  });

  it('BYO, no flags → public (me/org need a Phoenix owner)', () => {
    expect(publishVisibility({}, 'byo')).toBe('public');
  });

  it('an explicit level always wins over the backend default', () => {
    expect(publishVisibility({ visibility: 'public' }, 'managed')).toBe('public');
    expect(publishVisibility({ visibility: 'org' }, 'byo')).toBe('org');
    expect(publishVisibility({ unlisted: true }, 'managed')).toBe('unlisted');
    expect(publishVisibility({ protected: true }, 'managed')).toBe('private');
  });
});

describe('resolveVisibility — library fallback stays public (no silent flip)', () => {
  it('defaults to public so a lib caller is never surprised', () => {
    expect(resolveVisibility({})).toBe('public');
    // --public expressed as "not unlisted" (sessions share) keeps public.
    expect(resolveVisibility({ unlisted: false })).toBe('public');
  });

  it('honors an explicit fallback when the surface supplies one', () => {
    expect(resolveVisibility({}, 'me')).toBe('me');
  });
});
