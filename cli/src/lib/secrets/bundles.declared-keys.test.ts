/**
 * Regression for RUSH-2248 / RUSH-2252 / RUSH-2253: a present keychain secret
 * read as "stored item not found" because the read set was built from a lossy
 * enumeration instead of the bundle's declared keys.
 *
 * On macOS the keychain helper's `list` omits every biometry-ACL'd item and
 * skips the whole data-protection pass when the keychain is locked. A `hold`
 * bundle's value items are all ACL'd, so enumeration returned them as absent and
 * `--reveal` / `unlock` failed with `stored item '<item>' not found`, telling the
 * user to `secrets add` — which would overwrite the good secret — even though
 * `secrets view` (a direct point probe) reported the same key as `stored`.
 *
 * The `list`-drop is simulated with a backend whose `list()` hides value items
 * (mirroring the helper's UISkip) while `has()` / `get()` answer per item — no
 * real Keychain, per the storage-test convention (see bundles-storage.test.ts).
 *
 * RUSH-2252: the declared key is still read (declared-key union), despite the
 *            empty enumeration.
 * RUSH-2253: a present-but-unreadable item reports LOCKED (with how to unlock),
 *            never "not found" / "add the key"; a genuinely-absent key still
 *            reports not-found.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readAndResolveBundleEnv, writeBundle } from './bundles.js';
import { _resetFileStoreForTest } from './filestore.js';
import {
  SECRETS_ITEM_PREFIX,
  secretsKeychainItem,
  setKeychainBackendForTest,
  type KeychainBackend,
} from './index.js';

/**
 * A backend that models the three states the secrets stack must tell apart:
 *   - readable  → `get()` returns a value  (present + unlocked)
 *   - locked    → present but `get()` throws (biometry ACL held / keychain
 *                 locked); `has()` still reports it present
 *   - absent    → nowhere
 * and whose `list()` drops value items (`agents-cli.secrets.*`), reproducing the
 * macOS helper's biometry/locked enumeration blind spot. Metadata items
 * (`agents-cli.bundles.*`) are no-ACL and still enumerate.
 */
class ProbeKeychain implements KeychainBackend {
  readable = new Map<string, string>();
  locked = new Set<string>();
  /** Items whose existence probe (`has`) fails — the keychain is unreachable
   * for them. Models the RUSH-2235 fail-loud contract: `hasKeychainToken` throws
   * rather than answering a false "no". */
  unreachable = new Set<string>();

  has(item: string): boolean {
    if (this.unreachable.has(item)) throw new Error(`keychain unreachable probing ${item}`);
    return this.readable.has(item) || this.locked.has(item);
  }
  get(item: string): string {
    if (this.locked.has(item)) throw new Error(`keychain locked for ${item}`);
    const v = this.readable.get(item);
    if (v === undefined) throw new Error(`missing ${item}`);
    return v;
  }
  set(item: string, value: string): void {
    this.readable.set(item, value);
    this.locked.delete(item);
  }
  delete(item: string): boolean {
    this.locked.delete(item);
    return this.readable.delete(item);
  }
  list(prefix: string): string[] {
    const names = [...this.readable.keys(), ...this.locked.keys()].filter((k) => k.startsWith(prefix));
    // The helper's `list` cannot see biometry-ACL'd value items — drop them so
    // the read set can only be completed from the bundle's declared keys.
    return names.filter((k) => !k.startsWith(SECRETS_ITEM_PREFIX));
  }
}

const NAME = 'rush2252-declared.test';
let probe: ProbeKeychain;
let prevBackend: ReturnType<typeof setKeychainBackendForTest>;
let fileDir: string;

beforeEach(() => {
  probe = new ProbeKeychain();
  prevBackend = setKeychainBackendForTest(probe);
  fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-declared-'));
  _resetFileStoreForTest({ fileDir });
});

afterEach(() => {
  setKeychainBackendForTest(prevBackend);
  _resetFileStoreForTest();
  try { fs.rmSync(fileDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('readAndResolveBundleEnv builds the read set from declared keys (RUSH-2252)', () => {
  it('resolves a declared keychain key whose item the enumeration dropped', () => {
    writeBundle({ name: NAME, policy: 'hold', vars: { API: 'keychain:API' } });
    // The value item exists and is readable, but list() hides it — exactly the
    // biometry-drop that made --reveal report "stored item not found".
    probe.readable.set(secretsKeychainItem(NAME, 'API'), 'the-secret');

    const { env } = readAndResolveBundleEnv(NAME, { noAgent: true });
    expect(env.API).toBe('the-secret');
  });

  it('reads every declared key of a multi-key bundle behind the enumeration drop', () => {
    writeBundle({ name: NAME, policy: 'hold', vars: { A: 'keychain:A', B: 'keychain:B', LIT: 'plain' } });
    probe.readable.set(secretsKeychainItem(NAME, 'A'), 'aval');
    probe.readable.set(secretsKeychainItem(NAME, 'B'), 'bval');

    const { env } = readAndResolveBundleEnv(NAME, { noAgent: true });
    expect(env).toEqual({ A: 'aval', B: 'bval', LIT: 'plain' });
  });
});

describe('present-but-unreadable is not reported as absent (RUSH-2253)', () => {
  it('a present-but-locked item reports LOCKED with how to unlock, never "add the key"', () => {
    writeBundle({ name: NAME, policy: 'hold', vars: { API: 'keychain:API' } });
    // Present (has() sees it) but unreadable (get() throws) — a locked keychain
    // / held biometry ACL, the RUSH-2248 divergence between `view` and `--reveal`.
    probe.locked.add(secretsKeychainItem(NAME, 'API'));

    let caught: Error | undefined;
    try {
      readAndResolveBundleEnv(NAME, { noAgent: true });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/present but could not be read/i);
    expect(caught!.message).toMatch(/agents secrets unlock/);
    // The dangerous remediation must NOT be OFFERED for a present secret (the
    // message may still name it to warn the user off it).
    expect(caught!.message).not.toMatch(/Run: agents secrets add/);
    expect(caught!.message).not.toMatch(/\bnot found\b/i);
  });

  it('a genuinely-absent declared key still reports not-found with the add remediation', () => {
    writeBundle({ name: NAME, policy: 'hold', vars: { API: 'keychain:API' } });
    // Nothing seeded: the item exists nowhere.

    let caught: Error | undefined;
    try {
      readAndResolveBundleEnv(NAME, { noAgent: true });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/not found/i);
    expect(caught!.message).toMatch(new RegExp(`agents secrets add ${NAME} API`));
    // An absence must not masquerade as the locked state.
    expect(caught!.message).not.toMatch(/present but could not be read/i);
  });

  it('an unreachable keychain surfaces the reachability failure, never a false not-found (RUSH-2235)', () => {
    writeBundle({ name: NAME, policy: 'hold', vars: { API: 'keychain:API' } });
    // The value item can't be read AND its existence can't be proven — the
    // keychain is unreachable. `has` fails loud, so the classifier must not
    // guess "absent" (which would tell the user to overwrite a maybe-present
    // secret).
    probe.unreachable.add(secretsKeychainItem(NAME, 'API'));

    let caught: Error | undefined;
    try {
      readAndResolveBundleEnv(NAME, { noAgent: true });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/unreachable/i);
    expect(caught!.message).not.toMatch(/Run: agents secrets add/);
    expect(caught!.message).not.toMatch(/\bnot found\b/i);
  });
});
