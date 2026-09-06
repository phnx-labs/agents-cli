/**
 * macOS integration coverage for provider-account custody. This drives the real
 * standalone `secrets` CLI against the real signed helper and data-protection
 * Keychain: no backend seam, no mock. The unique bundle is deleted in finally so
 * the user's keychain is left clean.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addAccount, resolveCredentialAccount } from './account-registry.js';
import { accountSecretItem } from './account-schema.js';
import { deleteBundleSync, deleteKeychainTokenSync } from './secrets-client.js';

const realHome = process.env.AGENTS_TEST_REAL_KEYCHAIN_HOME;

describe.skipIf(process.platform !== 'darwin' || !realHome)('provider accounts (real macOS keychain)', () => {
  it('stores policy-never credentials no-ACL and resolves them in a headless launch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-account-keychain-'));
    const name = `phnx-2939-${randomUUID()}`;
    const secret = `sk-or-v1-${randomUUID()}`;
    const previousRuntime = process.env.AGENTS_RUNTIME;

    try {
      addAccount(name, 'openrouter', 'api-key', secret, root);
      // 'headless' is the AGENTS_RUNTIME value the standalone's headless detector
      // matches (a made-up value never entered the headless path, so the old
      // form of this test passed with OR without the biometry-ACL fix and
      // reproduced nothing — PHNX-3352). The client inherits the env into
      // `secrets __serve`, so the resolve below genuinely runs headless.
      process.env.AGENTS_RUNTIME = 'headless';

      // Without the fix, the headless keychain guard rejects this policy-`never`,
      // no-ACL item as if it required Touch ID before the helper ever reads it,
      // and this resolve throws. The fix routes through the bundle path that
      // attests `silentNoAcl`, so it resolves prompt-free (PHNX-2939).
      expect(resolveCredentialAccount(name, 'claude', undefined, root).env.ANTHROPIC_AUTH_TOKEN).toBe(secret);
    } finally {
      if (previousRuntime === undefined) delete process.env.AGENTS_RUNTIME;
      else process.env.AGENTS_RUNTIME = previousRuntime;
      deleteKeychainTokenSync(accountSecretItem(name, 'api-key'));
      deleteBundleSync(name);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
