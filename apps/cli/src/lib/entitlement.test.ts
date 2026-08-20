import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';

import {
  getTier,
  accountCapForTier,
  entitlementCachePath,
  setEntitlementUserYamlPathForTest,
  setEntitlementCachePathForTest,
  setEntitlementFetchForTest,
  ENTITLEMENT_CACHE_TTL_MS,
  type EntitlementTier,
} from './entitlement.js';

let dir: string;
let userYamlPath: string;
let cachePath: string;

function writeUserYaml(token = 'test-token'): void {
  fs.writeFileSync(userYamlPath, yaml.stringify({ session: { access_token: token } }));
}

function writeCache(tierName: string, isPaid: boolean, fetchedAt: number): void {
  fs.writeFileSync(cachePath, JSON.stringify({ version: 1, tierName, isPaid, fetchedAt }));
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-entitlement-'));
  userYamlPath = path.join(dir, 'user.yaml');
  cachePath = path.join(dir, '.entitlement-cache.json');
  setEntitlementUserYamlPathForTest(userYamlPath);
  setEntitlementCachePathForTest(cachePath);
});

afterEach(() => {
  setEntitlementUserYamlPathForTest(null);
  setEntitlementCachePathForTest(null);
  setEntitlementFetchForTest(globalThis.fetch);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('getTier — no session file', () => {
  it('resolves to the free tier with no network call, when ~/.rush/user.yaml is absent', async () => {
    let fetchCalled = false;
    setEntitlementFetchForTest(async () => {
      fetchCalled = true;
      return jsonResponse({ tierName: 'admin' });
    });
    const tier = await getTier();
    expect(tier).toEqual<EntitlementTier>({ tierName: 'free', isPaid: false, source: 'no-session' });
    expect(fetchCalled).toBe(false);
  });
});

describe('getTier — cache + TTL', () => {
  it('honors a fresh cache entry with no network call', async () => {
    writeUserYaml();
    writeCache('admin', true, Date.now());
    let fetchCalled = false;
    setEntitlementFetchForTest(async () => {
      fetchCalled = true;
      return jsonResponse({ tierName: 'free' });
    });
    const tier = await getTier();
    expect(tier).toEqual<EntitlementTier>({ tierName: 'admin', isPaid: true, source: 'cache' });
    expect(fetchCalled).toBe(false);
  });

  it('re-fetches when the cache entry is past the TTL, and persists the fresh result', async () => {
    writeUserYaml();
    writeCache('free', false, Date.now() - ENTITLEMENT_CACHE_TTL_MS - 1000);
    setEntitlementFetchForTest(async () => jsonResponse({ tierName: 'admin' }));

    const tier = await getTier();
    expect(tier).toEqual<EntitlementTier>({ tierName: 'admin', isPaid: true, source: 'live' });

    // The lib's own real cache path now reflects the live fetch — verified by
    // disabling the network and reading straight back through getTier() again.
    setEntitlementFetchForTest(async () => { throw new Error('should not be called'); });
    const second = await getTier();
    expect(second).toEqual<EntitlementTier>({ tierName: 'admin', isPaid: true, source: 'cache' });
    expect(fs.existsSync(entitlementCachePath())).toBe(true);
  });
});

describe('getTier — offline tolerance', () => {
  it('falls back to a stale cache when the network call fails, never silently dropping a known-paid tier to free', async () => {
    writeUserYaml();
    writeCache('admin', true, Date.now() - ENTITLEMENT_CACHE_TTL_MS - 1000);
    setEntitlementFetchForTest(async () => { throw new Error('network down'); });
    const tier = await getTier();
    expect(tier).toEqual<EntitlementTier>({ tierName: 'admin', isPaid: true, source: 'offline' });
  });

  it('falls back to free when the network fails and there is no cache at all', async () => {
    writeUserYaml();
    setEntitlementFetchForTest(async () => { throw new Error('network down'); });
    const tier = await getTier();
    expect(tier).toEqual<EntitlementTier>({ tierName: 'free', isPaid: false, source: 'offline' });
  });

  it('falls back to a stale cache on a non-2xx response', async () => {
    writeUserYaml();
    writeCache('admin', true, Date.now() - ENTITLEMENT_CACHE_TTL_MS - 1000);
    setEntitlementFetchForTest(async () => jsonResponse({}, false, 500));
    const tier = await getTier();
    expect(tier).toEqual<EntitlementTier>({ tierName: 'admin', isPaid: true, source: 'offline' });
  });
});

describe('getTier — tier classification', () => {
  it('classifies tierName "free" as free', async () => {
    writeUserYaml();
    setEntitlementFetchForTest(async () => jsonResponse({ tierName: 'free' }));
    const tier = await getTier();
    expect(tier.tierName).toBe('free');
    expect(tier.isPaid).toBe(false);
  });

  it('classifies tierName "admin" as paid', async () => {
    writeUserYaml();
    setEntitlementFetchForTest(async () => jsonResponse({ tierName: 'admin' }));
    const tier = await getTier();
    expect(tier.isPaid).toBe(true);
  });

  it('classifies any other tier name as paid', async () => {
    writeUserYaml();
    setEntitlementFetchForTest(async () => jsonResponse({ tierName: 'pro' }));
    const tier = await getTier();
    expect(tier.tierName).toBe('pro');
    expect(tier.isPaid).toBe(true);
  });

  it('an absent tierName in the response classifies as free', async () => {
    writeUserYaml();
    setEntitlementFetchForTest(async () => jsonResponse({}));
    const tier = await getTier();
    expect(tier).toMatchObject({ tierName: 'free', isPaid: false });
  });
});

describe('accountCapForTier', () => {
  it('caps free at 3', () => {
    expect(accountCapForTier({ isPaid: false })).toBe(3);
  });
  it('caps paid/admin at 10', () => {
    expect(accountCapForTier({ isPaid: true })).toBe(10);
  });
});
