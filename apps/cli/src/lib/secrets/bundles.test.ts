import { describe, it, expect } from 'vitest';
import {
  filterAgentHitBySubsetAndExpiry,
  assertRemoteBundleFlagsUnsupported,
  type SecretsBundle,
} from './bundles.js';

/**
 * Regression tests for the two least-privilege bypasses on the
 * `--secrets X --secrets-keys K [--allow-expired]` path.
 *
 * Pre-fix, `readAndResolveBundleEnv`'s secrets-agent fast-path returned the
 * cached snapshot verbatim — so once the broker had the bundle, `--keys`
 * silently injected every key and an expired key silently flowed through.
 * These tests drive the extracted helper (`filterAgentHitBySubsetAndExpiry`)
 * that the fast-path now runs before returning the hit.
 *
 * The remote (`bundle@host`) path also ignored those flags; the shared
 * `assertRemoteBundleFlagsUnsupported` guard now fails loud instead of
 * silently dropping them.
 */

const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function agentHit(
  vars: Record<string, string>,
  meta: SecretsBundle['meta'] = undefined,
): { bundle: SecretsBundle; env: Record<string, string> } {
  const bundle: SecretsBundle = {
    name: 'prod',
    vars,
    meta,
  };
  // The broker caches the fully-resolved env — one entry per var, values
  // already fetched from keychain. Mirror that shape here.
  const env: Record<string, string> = {};
  for (const k of Object.keys(vars)) env[k] = `v-${k}`;
  return { bundle, env };
}

describe('filterAgentHitBySubsetAndExpiry (agent fast-path gate)', () => {
  it('returns the cached hit untouched when no --keys / --allow-expired is set', () => {
    const hit = agentHit({ API_KEY: 'k', DB_URL: 'k' });
    const out = filterAgentHitBySubsetAndExpiry(hit, {});
    // Same reference — the hot path should not re-allocate for the default flow.
    expect(out).toBe(hit);
    expect(out.env).toEqual({ API_KEY: 'v-API_KEY', DB_URL: 'v-DB_URL' });
  });

  it('narrows the returned env to the requested subset (least-privilege honoured on fast-path)', () => {
    // Pre-fix: the fast-path returned all 3 keys regardless of `keys`.
    const hit = agentHit({ API_KEY: 'k', DB_URL: 'k', SLACK_TOKEN: 'k' });
    const out = filterAgentHitBySubsetAndExpiry(hit, { keys: ['API_KEY'] });
    expect(Object.keys(out.env).sort()).toEqual(['API_KEY']);
    expect(out.env.API_KEY).toBe('v-API_KEY');
    expect(out.env.DB_URL).toBeUndefined();
    expect(out.env.SLACK_TOKEN).toBeUndefined();
  });

  it('throws a fail-loud error if a requested key is not in the bundle', () => {
    const hit = agentHit({ API_KEY: 'k' });
    expect(() => filterAgentHitBySubsetAndExpiry(hit, { keys: ['GHOST'] }))
      .toThrow(/does not contain key\(s\): GHOST/);
  });

  it('aborts on an expired key (pre-fix the agent snapshot silently injected it)', () => {
    const hit = agentHit(
      { API_KEY: 'k', DB_URL: 'k' },
      { API_KEY: { expires: YESTERDAY } },
    );
    // No --keys: every key is selected, so the expired one aborts.
    expect(() => filterAgentHitBySubsetAndExpiry(hit, {}))
      .toThrow(/API_KEY' expired on/);
    // Requested a still-valid key: no abort, and DB_URL comes through.
    const out = filterAgentHitBySubsetAndExpiry(hit, { keys: ['DB_URL'] });
    expect(Object.keys(out.env)).toEqual(['DB_URL']);
    // Requested the expired key without --allow-expired: aborts.
    expect(() => filterAgentHitBySubsetAndExpiry(hit, { keys: ['API_KEY'] }))
      .toThrow(/API_KEY' expired on/);
  });

  it('honours --allow-expired: injects the expired key without aborting', () => {
    const hit = agentHit(
      { API_KEY: 'k' },
      { API_KEY: { expires: YESTERDAY } },
    );
    const out = filterAgentHitBySubsetAndExpiry(hit, { keys: ['API_KEY'], allowExpired: true });
    expect(out.env).toEqual({ API_KEY: 'v-API_KEY' });
  });

  it('does not abort on a future expiry', () => {
    const hit = agentHit(
      { API_KEY: 'k' },
      { API_KEY: { expires: TOMORROW } },
    );
    const out = filterAgentHitBySubsetAndExpiry(hit, { keys: ['API_KEY'] });
    expect(out.env).toEqual({ API_KEY: 'v-API_KEY' });
  });
});

describe('assertRemoteBundleFlagsUnsupported (remote bundle guard)', () => {
  const labels = { keysFlag: '--secrets-keys', allowExpiredFlag: '--allow-expired' };

  it('is a no-op when neither flag is set (remote resolve proceeds as before)', () => {
    expect(() => assertRemoteBundleFlagsUnsupported('prod', 'host', {}, labels)).not.toThrow();
    expect(() => assertRemoteBundleFlagsUnsupported('prod', 'host', { keys: [] }, labels)).not.toThrow();
  });

  it('throws a clear error when --keys narrows a remote bundle (pre-fix: silently ignored)', () => {
    expect(() => assertRemoteBundleFlagsUnsupported('prod', 'yosemite', { keys: ['API_KEY'] }, labels))
      .toThrow(/Bundle 'prod@yosemite': --secrets-keys and --allow-expired are not supported for remote/);
  });

  it('throws a clear error when --allow-expired is combined with a remote bundle', () => {
    expect(() => assertRemoteBundleFlagsUnsupported('prod', 'yosemite', { allowExpired: true }, labels))
      .toThrow(/not supported for remote \(bundle@host\) bundles/);
  });

  it('renders the caller-supplied flag labels (secrets exec uses --keys, run uses --secrets-keys)', () => {
    expect(() =>
      assertRemoteBundleFlagsUnsupported('prod', 'yosemite', { keys: ['A'] }, {
        keysFlag: '--keys',
        allowExpiredFlag: '--allow-expired',
      }),
    ).toThrow(/--keys and --allow-expired are not supported/);
  });
});
