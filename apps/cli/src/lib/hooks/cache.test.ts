import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  generateHookShim,
  getHookShimPath,
  isValidHookShimName,
  parseCacheConfig,
  parseDuration,
  removeHookShim,
} from './cache.js';
import { toPosix } from '../platform/index.js';

describe('parseDuration', () => {
  it('accepts plain numeric seconds', () => {
    expect(parseDuration(30)).toBe(30);
  });

  it('parses bare-second strings', () => {
    expect(parseDuration('45')).toBe(45);
    expect(parseDuration('45s')).toBe(45);
  });

  it('parses minutes', () => {
    expect(parseDuration('5m')).toBe(300);
    expect(parseDuration('1min')).toBe(60);
  });

  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3600);
    expect(parseDuration('2hr')).toBe(7200);
  });

  it('rejects garbage', () => {
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('-5m')).toBeNull();
    expect(parseDuration(undefined)).toBeNull();
    expect(parseDuration(0)).toBeNull();
  });
});

describe('parseCacheConfig', () => {
  it('returns null for missing config', () => {
    expect(parseCacheConfig(undefined)).toBeNull();
  });

  it('expands the shorthand string into a canonical config', () => {
    expect(parseCacheConfig('5m')).toEqual({ ttl: 300, key: 'global', prefetch: 'none' });
    expect(parseCacheConfig('30s')).toEqual({ ttl: 30, key: 'global', prefetch: 'none' });
  });

  it('recognises -bg suffix as background prefetch', () => {
    expect(parseCacheConfig('5m-bg')).toEqual({ ttl: 300, key: 'global', prefetch: 'background' });
    expect(parseCacheConfig('1h-bg')).toEqual({ ttl: 3600, key: 'global', prefetch: 'background' });
  });

  it('passes through the full object form and fills defaults', () => {
    expect(parseCacheConfig({ ttl: '10m' })).toEqual({ ttl: 600, key: 'global', prefetch: 'none' });
    expect(parseCacheConfig({ ttl: 120, key: 'per-cwd', prefetch: 'background' })).toEqual({
      ttl: 120, key: 'per-cwd', prefetch: 'background',
    });
  });

  it('rejects unparseable ttl in the full form', () => {
    expect(parseCacheConfig({ ttl: 'garbage' })).toBeNull();
  });

  it('rejects unparseable shorthand', () => {
    expect(parseCacheConfig('not-a-duration')).toBeNull();
  });
});

describe('generateHookShim', () => {
  let tmpHome: string;
  let testPaths: { shimsDir: string; cacheDir: string; logsDir: string };

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-hook-cache-test-'));
    testPaths = {
      shimsDir: path.join(tmpHome, 'shims'),
      cacheDir: path.join(tmpHome, 'cache'),
      logsDir: path.join(tmpHome, 'logs'),
    };
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes an executable shim file at the expected path', () => {
    const shim = generateHookShim({
      name: 'my-hook',
      scriptPath: '/some/where/script.sh',
      cache: { ttl: 300, key: 'global', prefetch: 'none' },
      paths: testPaths,
    });
    expect(shim).toBe(path.join(testPaths.shimsDir, 'my-hook.sh'));
    expect(fs.existsSync(shim)).toBe(true);
    // NTFS has no POSIX exec bit; Node reports mode without 0o111 on Windows.
    if (process.platform !== 'win32') {
      const stat = fs.statSync(shim);
      expect(stat.mode & 0o111).not.toBe(0);
    }
  });

  it('embeds the canonical config in the shim body', () => {
    const shim = generateHookShim({
      name: 'linear',
      scriptPath: '/path/to/real.sh',
      cache: { ttl: 600, key: 'per-cwd', prefetch: 'background' },
      paths: testPaths,
    });
    const body = fs.readFileSync(shim, 'utf-8');
    expect(body).toMatch(/TTL=600/);
    expect(body).toMatch(/PREFETCH='background'/);
    expect(body).toMatch(/KEY_MODE='per-cwd'/);
    expect(body).toMatch(/SOURCE='\/path\/to\/real\.sh'/);
    expect(body).toMatch(/HOOK_NAME='linear'/);
  });

  it('is idempotent — same input produces same content', () => {
    const args = {
      name: 'idem',
      scriptPath: '/x/y.sh',
      cache: { ttl: 60, key: 'global', prefetch: 'none' } as const,
      paths: testPaths,
    };
    const a = generateHookShim(args);
    const aBody = fs.readFileSync(a, 'utf-8');
    const b = generateHookShim(args);
    const bBody = fs.readFileSync(b, 'utf-8');
    expect(b).toBe(a);
    expect(bBody).toBe(aBody);
  });

  it('safely escapes single quotes in the script path', () => {
    const shim = generateHookShim({
      name: 'quoted',
      scriptPath: "/path/with'apostrophe.sh",
      cache: { ttl: 30, key: 'global', prefetch: 'none' },
      paths: testPaths,
    });
    const body = fs.readFileSync(shim, 'utf-8');
    expect(body).toMatch(/SOURCE='\/path\/with'\\''apostrophe\.sh'/);
  });

  it('getHookShimPath returns the real (state.ts-resolved) path for production callers', () => {
    // The path is whatever getHookShimsDir() resolves to. Doesn't matter what
    // value — what matters is that production callers (who don't pass `paths`)
    // get a consistent location.
    expect(toPosix(getHookShimPath('foo'))).toMatch(/\.cache\/shims\/hooks\/foo\.sh$/);
  });

  it('rejects hook names that would escape the shims directory', () => {
    const escapeTarget = path.join(tmpHome, 'outside-pwned.sh');
    const cache = { ttl: 30, key: 'global' as const, prefetch: 'none' as const };
    const args = {
      scriptPath: '/x/y.sh',
      cache,
      paths: testPaths,
    };

    for (const badName of ['../evil', '../../tmp/pwned', 'foo/bar', 'a\\b', '-dash', '', '.', '..']) {
      expect(isValidHookShimName(badName)).toBe(false);
      expect(() => getHookShimPath(badName)).toThrow(/Invalid hook shim name/);
      expect(() => generateHookShim({ ...args, name: badName })).toThrow(/Invalid hook shim name/);
    }

    expect(fs.existsSync(escapeTarget)).toBe(false);
    expect(fs.existsSync(testPaths.shimsDir)).toBe(false);
  });

  it('removeHookShim no-ops on invalid names instead of deleting outside the shims dir', () => {
    const outside = path.join(tmpHome, 'victim.sh');
    fs.writeFileSync(outside, '#!/bin/sh\necho pwned\n', { mode: 0o755 });

    removeHookShim('../victim', testPaths.shimsDir);
    removeHookShim('../../tmp/pwned', testPaths.shimsDir);

    expect(fs.existsSync(outside)).toBe(true);
  });

  it('removeHookShim deletes the file if it exists', () => {
    const shim = generateHookShim({
      name: 'doomed',
      scriptPath: '/x/y.sh',
      cache: { ttl: 30, key: 'global', prefetch: 'none' },
      paths: testPaths,
    });
    expect(fs.existsSync(shim)).toBe(true);
    removeHookShim('doomed', testPaths.shimsDir);
    expect(fs.existsSync(shim)).toBe(false);
    // Removing again is a no-op
    expect(() => removeHookShim('doomed', testPaths.shimsDir)).not.toThrow();
  });
});
