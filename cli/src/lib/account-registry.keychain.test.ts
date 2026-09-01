/**
 * macOS integration coverage for provider-account custody. This uses the real
 * signed helper and data-protection Keychain: no backend seam, no mock. The
 * unique bundle is deleted in finally so the user's keychain is left clean.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addAccount, resolveCredentialAccount } from './account-registry.js';
import { accountSecretItem } from './account-schema.js';
import { deleteBundle } from './secrets/bundles.js';
import { deleteKeychainToken } from './secrets/index.js';
import { isHeadlessSecretsContext } from './secrets/headless.js';
import { setInstallRootForTest } from './secrets/install-helper.js';

const realHome = process.env.AGENTS_TEST_REAL_KEYCHAIN_HOME;

describe.skipIf(process.platform !== 'darwin' || !realHome)('provider accounts (real macOS keychain)', () => {
  it('stores policy-never credentials no-ACL and resolves them in a headless launch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-account-keychain-'));
    const name = `phnx-2939-${randomUUID()}`;
    const secret = `sk-or-v1-${randomUUID()}`;
    const previousRuntime = process.env.AGENTS_RUNTIME;
    const previousInstallRoot = setInstallRootForTest(realHome!);

    try {
      addAccount(name, 'openrouter', 'api-key', secret, root);
      // 'headless' is an AGENTS_RUNTIME value isHeadlessSecretsContext() actually
      // matches (see secrets/headless.ts) — a made-up value like
      // 'test-headless-account-launch' never entered the headless path, so this
      // test passed with OR without the biometry-ACL fix and reproduced nothing
      // (PHNX-3352). Assert we are genuinely in the headless context so the
      // regression can never silently no-op again.
      process.env.AGENTS_RUNTIME = 'headless';
      expect(isHeadlessSecretsContext()).toBe(true);

      // Without the fix, the headless keychain guard rejects this policy-`never`,
      // no-ACL item as if it required Touch ID before the helper ever reads it,
      // and this resolve throws. The fix routes through the bundle path that
      // attests `silentNoAcl`, so it resolves prompt-free (PHNX-2939).
      expect(resolveCredentialAccount(name, 'claude', undefined, root).env.ANTHROPIC_AUTH_TOKEN).toBe(secret);
    } finally {
      if (previousRuntime === undefined) delete process.env.AGENTS_RUNTIME;
      else process.env.AGENTS_RUNTIME = previousRuntime;
      deleteKeychainToken(accountSecretItem(name, 'api-key'));
      deleteBundle(name);
      setInstallRootForTest(previousInstallRoot);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
