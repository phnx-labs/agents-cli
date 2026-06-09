import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const helperSource = () => fs.readFileSync(path.join(process.cwd(), 'src/lib/secrets/keychain-helper.swift'), 'utf8');

describe('keychain-helper Touch ID policy', () => {
  it('writes secrets with SecAccessControl user-presence protection', () => {
    const source = helperSource();

    expect(source).toContain('SecAccessControlCreateWithFlags');
    expect(source).toContain('kSecAttrAccessibleWhenUnlockedThisDeviceOnly');
    expect(source).toContain('.biometryCurrentSet');
    expect(source).toContain('.devicePasscode');
    expect(source).toContain('kSecAttrAccessControl: buildBiometryAccessControl()');
  });

  it('reads secrets through a shared LocalAuthentication context', () => {
    const source = helperSource();

    expect(source).toContain('import LocalAuthentication');
    expect(source).toContain('let authContext: LAContext');
    expect(source).toContain('kSecUseAuthenticationContext: authContext');
    expect(source).toContain('case "get":');
    expect(source).toContain('case "get-batch":');
  });
});

describe('keychain-helper data-protection keychain coverage', () => {
  // Items written by `set` carry a biometry ACL, which forces them into the
  // data-protection keychain. A query with kSecUseAuthenticationUIFail and
  // no kSecUseDataProtectionKeychain key never sees those items, so has/list
  // reported every stored secret as missing (RUSH-1083). Each command needs
  // a DP pass alongside the file-based one.
  it('has probes both the file-based and data-protection keychains', () => {
    const source = helperSource();
    const hasBlock = source.slice(source.indexOf('case "has":'), source.indexOf('case "get":'));

    expect(hasBlock).toContain('for dp in [false, true]');
    expect(hasBlock).toContain('kSecUseDataProtectionKeychain');
    // UIFail is the no-prompt guarantee; a present DP item then surfaces as
    // errSecInteractionNotAllowed, which must count as "exists".
    expect(hasBlock).toContain('kSecUseAuthenticationUIFail');
    expect(hasBlock).toContain('errSecInteractionNotAllowed');
  });

  it('list enumerates both keychains and tolerates a locked DP keybag', () => {
    const source = helperSource();
    const listBlock = source.slice(source.indexOf('case "list":'), source.indexOf('case "has":'));

    expect(listBlock).toContain('kSecUseDataProtectionKeychain');
    expect(listBlock).toContain('for query in [fileQuery, dpQuery]');
    // The DP keybag locks with the screen; enumeration must skip, not die.
    expect(listBlock).toContain('if status == errSecInteractionNotAllowed { continue }');
    // The DP pass must keep an explicit kSecReturn* key: with none at all,
    // SecItemCopyMatching evaluates the biometry ACL and blocks on Touch ID.
    expect(listBlock).toContain('kSecReturnAttributes');
  });
});
