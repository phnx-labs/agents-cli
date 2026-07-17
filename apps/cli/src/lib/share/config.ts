// Config + credential glue for `agents share`.
//
// - The endpoint config (base URL, account, worker/bucket names) lives in
//   `agents.yaml` under `share:` (Meta.share) so it syncs fleet-wide via
//   `agents repo push/pull`.
// - The raw write token lives in the `share` secrets bundle (keychain-backed,
//   fleet-injectable) — never on disk in plaintext.
// - The Cloudflare API token (for provisioning) is read from the user's existing
//   `cloudflare.com` bundle.

import { randomBytes } from 'node:crypto';
import { readMeta, updateMeta } from '../state.js';
import {
  bundleItemStore,
  bundlePolicy,
  isHeadlessSecretsContext,
  keychainRef,
  readAndResolveBundleEnv,
  readBundle,
  writeBundle,
  type SecretsBundle,
} from '../secrets/bundles.js';
import { secretsKeychainItem } from '../secrets/index.js';

export interface ShareConfig {
  /** Public base, e.g. `https://share.agents-cli.sh` or `https://agent-share.<acct>.workers.dev`. */
  baseUrl: string;
  accountId: string;
  workerName: string;
  bucketName: string;
  /** Custom domain when mapped (e.g. `share.agents-cli.sh`). */
  domain?: string;
}

export const SHARE_BUNDLE = 'share';
export const SHARE_TOKEN_KEY = 'SHARE_WRITE_TOKEN';
export const DEFAULT_CF_BUNDLE = 'cloudflare.com';
export const DEFAULT_WORKER_NAME = 'agents-share';
export const DEFAULT_BUCKET_NAME = 'agents-share';

/** Read the persisted endpoint config, or null if `agents share setup`/`join` never ran. */
export function readShareConfig(): ShareConfig | null {
  const s = readMeta().share;
  if (!s?.baseUrl || !s.accountId || !s.workerName || !s.bucketName) return null;
  return {
    baseUrl: s.baseUrl.replace(/\/+$/, ''),
    accountId: s.accountId,
    workerName: s.workerName,
    bucketName: s.bucketName,
    domain: s.domain,
  };
}

/** Persist the endpoint config to `agents.yaml` (syncs across the fleet). */
export function writeShareConfig(cfg: ShareConfig): void {
  updateMeta((meta) => ({ ...meta, share: { ...meta.share, ...cfg } }));
}

/** A fresh 32-byte hex write token. */
export function generateWriteToken(): string {
  return randomBytes(32).toString('hex');
}

/** Persist the raw write token into the `share` secrets bundle (keychain-backed,
 * fleet-injectable). Mirrors the add-key sequence in `commands/secrets.ts`. */
export function storeWriteToken(token: string): void {
  let bundle: SecretsBundle;
  try {
    bundle = readBundle(SHARE_BUNDLE);
  } catch {
    bundle = {
      name: SHARE_BUNDLE,
      description: 'agents share — write token for the R2 share endpoint',
      vars: {},
    } as SecretsBundle;
  }
  const store = bundleItemStore(bundle.backend, { noAcl: bundlePolicy(bundle) === 'never' });
  store.set(secretsKeychainItem(bundle.name, SHARE_TOKEN_KEY), token);
  bundle.vars[SHARE_TOKEN_KEY] = keychainRef(SHARE_TOKEN_KEY);
  writeBundle(bundle);
}

/** Read the raw write token from the `share` secrets bundle. Throws with an
 * actionable message if absent (run setup/join first). */
export function readWriteToken(): string {
  const { env } = readAndResolveBundleEnv(SHARE_BUNDLE, {
    caller: 'share',
    agentOnly: isHeadlessSecretsContext(),
  });
  const token = env[SHARE_TOKEN_KEY];
  if (!token) {
    throw new Error(
      `No ${SHARE_TOKEN_KEY} in the '${SHARE_BUNDLE}' secrets bundle. ` +
        `Run 'agents share setup' (to provision your own endpoint) or 'agents share join' (to use an existing one).`,
    );
  }
  return token;
}

/** Cloudflare API credentials for provisioning, read from `cloudflare.com` (or a
 * user-named bundle). Fuzzy-matches key names so it works across bundle layouts. */
export function readCloudflareCreds(
  bundle = DEFAULT_CF_BUNDLE,
  override?: { apiToken?: string; accountId?: string },
): { apiToken: string; accountId: string } {
  // Explicit --token/--account bypass the bundle entirely (robust escape hatch).
  if (override?.apiToken) {
    return { apiToken: override.apiToken, accountId: override.accountId ?? '' };
  }
  const { env } = readAndResolveBundleEnv(bundle, {
    caller: 'share',
    agentOnly: isHeadlessSecretsContext(),
  });
  const find = (re: RegExp): string => {
    for (const [k, v] of Object.entries(env)) if (re.test(k) && v) return v;
    return '';
  };
  const apiToken = env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN || find(/API[_-]?TOKEN|(?:^|_)TOKEN$/i);
  const accountId =
    override?.accountId || env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID || find(/ACCOUNT[_-]?ID/i);
  if (!apiToken) {
    const keys = Object.keys(env);
    throw new Error(
      `No Cloudflare API token in the '${bundle}' bundle ` +
        `(keys present: ${keys.length ? keys.join(', ') : 'none'}). ` +
        `Pass it directly with --token <t> [--account <id>], or add it: ` +
        `agents secrets add ${bundle} CLOUDFLARE_API_TOKEN`,
    );
  }
  return { apiToken, accountId };
}
