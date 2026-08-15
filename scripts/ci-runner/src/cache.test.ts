import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForkSafeCache } from './cache';
import { ciLayout } from './paths';

describe('ForkSafeCache', () => {
  test('trusted populate is content-addressed and restore-only forks cannot write', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-cache-'));
    try {
      const layout = ciLayout(root);
      const digest = 'deadbeef'.repeat(4);
      const trusted = new ForkSafeCache({ layout, lockfileDigest: digest, mode: 'read-write' });
      const dest = trusted.populate({ 'node_modules/.stamp': 'installed' });
      expect(dest).toContain(digest);
      expect(trusted.readReadyMarker()).toBe(digest);

      const next = new ForkSafeCache({ layout, lockfileDigest: digest, mode: 'restore-only' });
      expect(next.restore()).toBe(dest);
      expect(() => next.populate({ 'evil': 'no' })).toThrow(/restore-only cache must not write/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses a non-digest cache key', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-cache-'));
    try {
      expect(() => new ForkSafeCache({
        layout: ciLayout(root),
        lockfileDigest: '../etc',
        mode: 'read-write',
      })).toThrow(/hex content address/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
