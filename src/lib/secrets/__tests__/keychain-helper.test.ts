import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const helperSource = () => fs.readFileSync(path.join(process.cwd(), 'src/lib/secrets/keychain-helper.swift'), 'utf8');

// Slice the source for a single `case "<cmd>":` block so an assertion can't be
// satisfied by an unrelated command elsewhere in the file. `order` lists the
// switch cases in source order; the block runs from the named case up to the
// next case in that list (or the `default:` for the last one).
const order = ['list', 'has', 'get', 'get-batch', 'set', 'delete', 'migrate-acl', 'list-orphans', 'migrate-orphans', 'watch-lock'];
function caseBlock(source: string, cmd: string): string {
  const idx = order.indexOf(cmd);
  const start = source.indexOf(`case "${cmd}":`);
  const nextMarker = idx + 1 < order.length ? `case "${order[idx + 1]}":` : 'default:';
  const end = source.indexOf(nextMarker, start);
  expect(start, `case "${cmd}" present`).toBeGreaterThanOrEqual(0);
  expect(end, `marker after case "${cmd}" present`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('keychain-helper Touch ID policy', () => {
  it('writes secrets with SecAccessControl user-presence protection', () => {
    const source = helperSource();
    expect(source).toContain('SecAccessControlCreateWithFlags');
    expect(source).toContain('kSecAttrAccessibleWhenUnlockedThisDeviceOnly');
    expect(source).toContain('.biometryCurrentSet');
    expect(source).toContain('.devicePasscode');
    expect(source).toContain('addAttrs[kSecAttrAccessControl] = buildBiometryAccessControl()');
  });

  it('reads secrets through a shared LocalAuthentication context', () => {
    const source = helperSource();
    expect(source).toContain('import LocalAuthentication');
    expect(source).toContain('let authContext: LAContext');
    expect(source).toContain('kSecUseAuthenticationContext] = authContext');
    expect(source).toContain('case "get":');
    expect(source).toContain('case "get-batch":');
  });
});

describe('keychain-helper data-protection keychain routing', () => {
  // Issue #279: the biometry SecAccessControl already routed our items to the
  // data-protection keychain implicitly, but the routing and the access group
  // were never stated. dpBase() makes all three explicit (DP key + pinned access
  // group + device-local) so every write/read/delete is deterministic and never
  // relies on default-access-group resolution under a wildcard-only entitlement.
  it('dpBase pins the DP keychain, a concrete access group, and device-local', () => {
    const source = helperSource();
    const block = source.slice(source.indexOf('func dpBase('), source.indexOf('func fileBase('));
    expect(block).toContain('kSecUseDataProtectionKeychain: kCFBooleanTrue!');
    expect(block).toContain('kSecAttrAccessGroup: kAccessGroup as CFString');
    expect(block).toContain('kSecAttrSynchronizable: kCFBooleanFalse!');
    // The access group is the stable application-identifier from the profile.
    expect(source).toContain('let kAccessGroup = "2HTP252L87.com.phnx-labs.agents-keychain"');
  });

  it('fileBase carries no DP key and no access group (legacy reads only)', () => {
    const source = helperSource();
    const fbStart = source.indexOf('func fileBase(');
    const block = source.slice(fbStart, source.indexOf('\n}', fbStart)); // fileBase body only
    expect(block).not.toContain('kSecUseDataProtectionKeychain');
    expect(block).not.toContain('kSecAttrAccessGroup');
  });

  it('every write/delete attrs dictionary is built from dpBase or fileBase', () => {
    const source = helperSource();
    // No SecItemAdd/Delete/CopyMatching may hand-roll a kSecClass dictionary that
    // bypasses the dpBase/fileBase helpers — that is how the old set/delete paths
    // silently targeted only one keychain. Allow kSecClass only inside the
    // helpers themselves and the two prefix-enumeration queries in `list`.
    const count = (s: string) => s.split('kSecClass: kSecClassGenericPassword').length - 1;
    const occurrences = count(source);
    const allowed =
      3 + // dpBase + dpBaseUnpinned + fileBase
      count(caseBlock(source, 'list')) + // fileQuery + dpQuery
      count(caseBlock(source, 'list-orphans')) + // enumQuery
      count(caseBlock(source, 'migrate-orphans')); // enumQuery
    expect(
      occurrences,
      'kSecClass only appears in dpBase/dpBaseUnpinned/fileBase and the list / orphan enumeration queries',
    ).toBe(allowed);
  });
});

describe('keychain-helper set / delete cover both keychains', () => {
  it('set writes to DP and clears any stale copy from both keychains, all groups', () => {
    const block = caseBlock(helperSource(), 'set');
    // Un-pinned DP delete clears the concrete-group copy AND any orphan shadow so
    // a rotate can't leave a stale pre-#279 copy behind.
    expect(block).toContain('SecItemDelete(dpBaseUnpinned(service: service, account: account) as CFDictionary)');
    expect(block).toContain('SecItemDelete(fileBase(service: service, account: account) as CFDictionary)');
    expect(block).toContain('var addAttrs = dpBase(service: service, account: account)');
    expect(block).toContain('addAttrs[kSecAttrAccessControl] = buildBiometryAccessControl()');
    expect(block).toContain('SecItemAdd(addAttrs as CFDictionary, nil)');
  });

  it('delete removes from both keychains (all groups) and reports existence in either', () => {
    const block = caseBlock(helperSource(), 'delete');
    expect(block).toContain('let dpStatus = SecItemDelete(dpBaseUnpinned(');
    expect(block).toContain('let fileStatus = SecItemDelete(fileBase(');
    expect(block).toContain('(dpStatus == errSecSuccess || fileStatus == errSecSuccess)');
  });
});

describe('keychain-helper forward migration (file-based -> data-protection)', () => {
  // Items written by a pre-migration helper live in whichever keychain the old
  // attrs selected. readItem now resolves DP first, then the legacy file-based
  // keychain ONCE on a clean miss; get/get-batch then migrate the value forward.
  // This is the per-item, self-retiring analogue of a one-shot bulk migration:
  // once an item is rewritten to DP, the DP lookup hits and the fallback never
  // fires again — so it is idempotent without a separate sentinel.
  it('readItem queries pinned DP, then un-pinned DP (orphans), then file-based', () => {
    const source = helperSource();
    const block = source.slice(source.indexOf('func readItem('), source.indexOf('func migrateInline('));
    const dpIdx = block.indexOf('var dpQuery = dpBase(');
    const orphanIdx = block.indexOf('var orphanQuery = dpBaseUnpinned(');
    const fileIdx = block.indexOf('var fileQuery = fileBase(');
    expect(dpIdx).toBeGreaterThanOrEqual(0);
    expect(orphanIdx).toBeGreaterThan(dpIdx); // pinned DP first, un-pinned DP second
    expect(fileIdx).toBeGreaterThan(orphanIdx); // file fallback last
    // Each fallback only runs on a clean not-found, never on auth errors.
    expect(block).toContain('guard dpStatus == errSecItemNotFound else {');
    expect(block).toContain('guard orphanStatus == errSecItemNotFound else {');
    // The un-pinned pass returns the persistent ref so get/get-batch can re-home.
    expect(block).toContain('orphanQuery[kSecReturnPersistentRef] = kCFBooleanTrue!');
    expect(block).toContain('let ref = dict[kSecValuePersistentRef] as? Data');
    expect(block).toContain('ReadOutcome(value: value, status: orphanStatus, needsMigration: false, orphanRef: ref)');
    // A value found only in the file-based keychain is flagged for migration.
    expect(block).toContain('ReadOutcome(value: value, status: fileStatus, needsMigration: true, orphanRef: nil)');
  });

  it('migrateInline adds the DP copy and does NOT delete the legacy copy inline', () => {
    const source = helperSource();
    const block = source.slice(source.indexOf('func migrateInline('), source.indexOf('func rehomeOrphan('));
    // Clears any stale DP copy first (DP-scoped) so the add can't hit errSecDuplicateItem.
    expect(block).toContain('SecItemDelete(dpBase(service: service, account: account) as CFDictionary)');
    // Adds the DP copy: DP base (incl. access group) plus the biometry ACL.
    expect(block).toContain('var addAttrs = dpBase(service: service, account: account)');
    expect(block).toContain('addAttrs[kSecAttrAccessControl] = buildBiometryAccessControl()');
    expect(block).toContain('SecItemAdd(addAttrs as CFDictionary, nil)');
    // Regression guard: migrateInline must NOT delete the legacy copy inline.
    // On macOS 26 the unscoped SecItemDelete(fileBase) also removes the
    // just-added DP copy (same service+account), so the relocation never sticks.
    // Legacy purge is migrate-acl's job (it clears both keychains before its add,
    // after an encrypted backup).
    expect(block).not.toContain('SecItemDelete(fileBase(service: service, account: account) as CFDictionary)');
  });

  it('get and get-batch only migrate / re-home items in our own namespace', () => {
    const source = helperSource();
    // Both callers gate migration AND orphan re-home on the agents-cli prefix so
    // we never rewrite another app's items.
    const getBlock = caseBlock(source, 'get');
    const batchBlock = caseBlock(source, 'get-batch');
    for (const block of [getBlock, batchBlock]) {
      expect(block).toContain('service.hasPrefix("agents-cli.")');
      expect(block).toContain('if outcome.needsMigration {');
      expect(block).toContain('migrateInline(service: service, account: account, value: value)');
      expect(block).toContain('} else if let ref = outcome.orphanRef {');
      expect(block).toContain('rehomeOrphan(service: service, account: account, value: value, orphanRef: ref)');
    }
  });

  it('migrate-acl reads the legacy file copy and rewrites it into the DP keychain', () => {
    const block = caseBlock(helperSource(), 'migrate-acl');
    expect(block).toContain('var readQuery = fileBase(service: service, account: account)');
    expect(block).toContain('SecItemDelete(fileBase(service: service, account: account) as CFDictionary)');
    expect(block).toContain('var addAttrs = dpBase(service: service, account: account)');
    expect(block).toContain('SecItemAdd(addAttrs as CFDictionary, nil)');
  });
});

describe('keychain-helper has / list still probe both keychains', () => {
  it('has probes file-based, pinned DP, and un-pinned DP (orphans) without prompting', () => {
    const block = caseBlock(helperSource(), 'has');
    expect(block).toContain('var fileQuery = fileBase(service: service, account: account)');
    expect(block).toContain('var dpQuery = dpBase(service: service, account: account)');
    expect(block).toContain('var orphanQuery = dpBaseUnpinned(service: service, account: account)');
    expect(block).toContain('for query in [fileQuery, dpQuery, orphanQuery]');
    expect(block).toContain('kSecUseAuthenticationUIFail');
    expect(block).toContain('errSecInteractionNotAllowed');
  });

  it('list enumerates both keychains un-pinned so orphaned bundles reappear', () => {
    const block = caseBlock(helperSource(), 'list');
    expect(block).toContain('kSecUseDataProtectionKeychain: kCFBooleanTrue!');
    // The DP pass is UN-pinned now — no concrete access group — so it spans the
    // orphan group too and orphaned bundle metadata is no longer invisible.
    expect(block).not.toContain('kSecAttrAccessGroup: kAccessGroup as CFString');
    expect(block).toContain('for query in [fileQuery, dpQuery]');
    expect(block).toContain('if status == errSecInteractionNotAllowed { continue }');
    expect(block).toContain('kSecReturnAttributes');
  });
});

describe('keychain-helper orphaned-access-group recovery', () => {
  // Pre-#279 helpers wrote without kSecAttrAccessGroup, so macOS filed items
  // under the implicit default group (the literal wildcard "2HTP252L87.*"), NOT
  // the concrete kAccessGroup. The pinned queries then can't see them ("missing")
  // even though the wildcard entitlement authorizes reading them.
  it('dpBaseUnpinned mirrors dpBase but omits the access-group pin', () => {
    const source = helperSource();
    const block = source.slice(source.indexOf('func dpBaseUnpinned('), source.indexOf('// Read one item'));
    expect(block).toContain('kSecUseDataProtectionKeychain: kCFBooleanTrue!');
    expect(block).toContain('kSecAttrSynchronizable: kCFBooleanFalse!');
    // The whole point: no concrete access group, so it spans every entitled group.
    expect(block).not.toContain('kSecAttrAccessGroup');
  });

  it('rehomeOrphan adds the pinned copy BEFORE deleting the orphan by persistent ref', () => {
    const source = helperSource();
    const block = source.slice(source.indexOf('func rehomeOrphan('), source.indexOf('func dieIfCancelled('));
    const addIdx = block.indexOf('SecItemAdd(addAttrs as CFDictionary, nil)');
    const delIdx = block.indexOf('SecItemDelete([kSecValuePersistentRef: orphanRef] as CFDictionary)');
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(addIdx); // add-before-delete: a failed add leaves the orphan intact
    // The pinned copy carries the biometry ACL, like every other write.
    expect(block).toContain('var addAttrs = dpBase(service: service, account: account)');
    expect(block).toContain('addAttrs[kSecAttrAccessControl] = buildBiometryAccessControl()');
    // Guard: on a failed add we must NOT delete the orphan.
    expect(block).toContain('guard addStatus == errSecSuccess else {');
  });

  it('list-orphans enumerates DP items whose group differs from kAccessGroup, no prompt', () => {
    const block = caseBlock(helperSource(), 'list-orphans');
    expect(block).toContain('kSecReturnAttributes: kCFBooleanTrue!');
    expect(block).not.toContain('kSecReturnData'); // attributes only — never decrypts
    expect(block).toContain('guard group != kAccessGroup else { continue }');
    expect(block).toContain('errSecInteractionNotAllowed'); // tolerates a locked keybag
  });

  it('migrate-orphans reads by persistent ref, re-homes add-before-delete, honors cancel', () => {
    const block = caseBlock(helperSource(), 'migrate-orphans');
    // Enumerate with persistent refs so each orphan is deleted exactly.
    expect(block).toContain('kSecReturnPersistentRef: kCFBooleanTrue!');
    expect(block).toContain('guard group != kAccessGroup else { continue }');
    // Read the exact orphan by ref (Touch ID, reused across the batch).
    expect(block).toContain('kSecValuePersistentRef: o.ref');
    expect(block).toContain('kSecUseAuthenticationContext: authContext');
    expect(block).toContain('dieIfCancelled(rStatus)');
    // Add-before-delete ordering.
    const addIdx = block.indexOf('let addStatus = SecItemAdd(addAttrs as CFDictionary, nil)');
    const delIdx = block.indexOf('let delStatus = SecItemDelete([kSecValuePersistentRef: o.ref] as CFDictionary)');
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(addIdx);
    // A failed add is FAILed and skips the orphan delete.
    expect(block).toContain('print("FAIL \\(o.service) add=\\(addStatus)")');
    expect(block).toContain('print("OK \\(o.service)")');
  });
});
