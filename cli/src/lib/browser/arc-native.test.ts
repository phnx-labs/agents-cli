/**
 * Tests for native Arc integration types and resolve-target guarding (PHNX-2399).
 *
 * These tests exercise the type system additions and the resolve-target fix
 * that prevents native Arc endpoints from being rewritten into SSH tunnels.
 * Real-Mac native integration is opt-in and run by the parent.
 */

import { describe, it, expect } from 'vitest';
import type { BackendKind, ArcNativeTabRef, ArcNativeConnectionMeta } from './types.js';

describe('Arc native types', () => {
  it('BackendKind accepts cdp and arc-native', () => {
    const cdp: BackendKind = 'cdp';
    const arcNative: BackendKind = 'arc-native';
    expect(cdp).toBe('cdp');
    expect(arcNative).toBe('arc-native');
  });

  it('ArcNativeTabRef carries URL-based stable identity', () => {
    const ref: ArcNativeTabRef = {
      tabUrl: 'https://example.com/page',
    };
    expect(ref.tabUrl).toBe('https://example.com/page');
  });

  it('ArcNativeConnectionMeta carries space title and tab refs', () => {
    const meta: ArcNativeConnectionMeta = {
      spaceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      spaceTitle: 'Work',
      profileDirectory: 'Profile 1',
      tabRefs: new Map([
        ['abc', { tabUrl: 'https://example.com' }],
      ]),
    };
    expect(meta.spaceTitle).toBe('Work');
    expect(meta.tabRefs.size).toBe(1);
    expect(meta.tabRefs.get('abc')?.tabUrl).toBe('https://example.com');
  });

  it('ArcNativeConnectionMeta tabRefs keyed by short id', () => {
    const meta: ArcNativeConnectionMeta = {
      tabRefs: new Map([
        ['tab1', { tabUrl: 'https://a.com' }],
        ['tab2', { tabUrl: 'https://b.com' }],
      ]),
    };
    // Verify we can look up by short id and get the stable URL
    expect(meta.tabRefs.get('tab1')?.tabUrl).toBe('https://a.com');
    expect(meta.tabRefs.get('tab2')?.tabUrl).toBe('https://b.com');
    expect(meta.tabRefs.get('nonexistent')).toBeUndefined();
  });
});

describe('sshEndpointForDeclaration native guard', () => {
  it('preserves arc-native: endpoints instead of rewriting to ssh', async () => {
    // Import dynamically to avoid pulling in the full registry (which needs agents state)
    const { sshEndpointForDeclaration } = await import('./resolve-target.js');
    // Build a minimal declaration config with an arc-native endpoint
    const config = {
      browser: 'arc' as const,
      endpoints: { default: { target: 'arc-native://local?spaceTitle=Work' } },
    };
    const result = sshEndpointForDeclaration('zion', config);
    // Must NOT be rewritten to ssh://
    expect(result).toBe('arc-native://local?spaceTitle=Work');
    expect(result.startsWith('ssh://')).toBe(false);
  });

  it('preserves arc-native: endpoints with complex query params', async () => {
    const { sshEndpointForDeclaration } = await import('./resolve-target.js');
    const config = {
      browser: 'arc' as const,
      endpoints: {
        default: {
          target: 'arc-native://local?spaceTitle=My%20Space&profileDir=Profile%201',
        },
      },
    };
    const result = sshEndpointForDeclaration('remote-host', config);
    expect(result).toBe(
      'arc-native://local?spaceTitle=My%20Space&profileDir=Profile%201',
    );
  });
});
