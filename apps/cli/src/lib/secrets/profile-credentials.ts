import { createHash } from 'crypto';
import type { Profile } from '../profiles.js';
import {
  bundleExists,
  deleteBundle,
  keychainRef,
  readAndResolveBundleEnv,
  readBundle,
  writeBundleWithItems,
} from './bundles.js';
import { deleteKeychainToken, getKeychainToken, hasKeychainToken, secretsKeychainItem } from './index.js';

export type ProfileAuth = {
  envVar: string;
  /** Canonical prompt-free bundle binding for newly stored provider tokens. */
  bundle?: string;
  bundleKey?: string;
  /** Legacy direct-keychain binding. Kept readable until an explicit login migrates it. */
  keychainItem?: string;
};

const PROFILE_BUNDLE_PREFIX = 'profile.';
const PROFILE_TOKEN_KEY = 'TOKEN';

export function profileCredentialBundleName(provider: string): string {
  const slug = provider.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'provider';
  const digest = createHash('sha256').update(provider).digest('hex').slice(0, 8);
  const maxSlugLength = 48 - PROFILE_BUNDLE_PREFIX.length - digest.length - 1;
  return `${PROFILE_BUNDLE_PREFIX}${slug.slice(0, maxSlugLength)}.${digest}`;
}

export function profileAuthForProvider(envVar: string, provider: string): ProfileAuth {
  return { envVar, bundle: profileCredentialBundleName(provider), bundleKey: PROFILE_TOKEN_KEY };
}

export function profileAuthStored(auth: ProfileAuth): boolean {
  if (auth.bundle) {
    if (!bundleExists(auth.bundle)) return false;
    try {
      return (auth.bundleKey ?? PROFILE_TOKEN_KEY) in readBundle(auth.bundle).vars;
    } catch {
      return false;
    }
  }
  return auth.keychainItem ? hasKeychainToken(auth.keychainItem) : false;
}

export function resolveProfileAuthToken(auth: ProfileAuth, caller: string): string {
  if (auth.bundle) {
    const key = auth.bundleKey ?? PROFILE_TOKEN_KEY;
    const { env } = readAndResolveBundleEnv(auth.bundle, { caller, keys: [key], keyMode: 'storage' });
    const token = env[key];
    if (!token) throw new Error(`Profile credential '${auth.bundle}:${key}' is empty.`);
    return token;
  }
  if (auth.keychainItem) return getKeychainToken(auth.keychainItem);
  throw new Error('Profile auth has no credential binding.');
}

export function storeProfileCredential(provider: string, token: string): ProfileAuth {
  const auth = profileAuthForProvider('', provider);
  const bundle = auth.bundle!;
  const key = auth.bundleKey!;
  writeBundleWithItems(
    {
      name: bundle,
      description: `Provider credential for ${provider} profiles`,
      backend: 'file',
      policy: 'never',
      vars: { [key]: keychainRef(key) },
    },
    new Map([[secretsKeychainItem(bundle, key), token]]),
  );
  return auth;
}

export function deleteProfileCredential(provider: string, legacyKeychainItem?: string): boolean {
  const deletedBundle = deleteBundle(profileCredentialBundleName(provider));
  const deletedLegacy = legacyKeychainItem ? deleteKeychainToken(legacyKeychainItem) : false;
  return deletedBundle || deletedLegacy;
}

export function profileAuthCacheKey(profile: Profile): string {
  const auth = profile.auth;
  if (!auth) return profile.name;
  if (auth.bundle) return `bundle:${auth.bundle}:${auth.bundleKey ?? PROFILE_TOKEN_KEY}`;
  return `keychain:${auth.keychainItem ?? profile.name}`;
}
