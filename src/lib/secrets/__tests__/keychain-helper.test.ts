import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const helperSource = () => fs.readFileSync(path.join(process.cwd(), 'src/lib/secrets/keychain-helper.swift'), 'utf8');

describe('keychain-helper Touch ID policy', () => {
  it('writes secrets with SecAccessControl user-presence protection', () => {
    const source = helperSource();

    expect(source).toContain('SecAccessControlCreateWithFlags');
    expect(source).toContain('kSecAttrAccessibleWhenUnlocked');
    expect(source).toContain('kSecAttrAccessibleWhenUnlockedThisDeviceOnly');
    expect(source).toContain('.biometryCurrentSet');
    expect(source).toContain('.devicePasscode');
    expect(source).toContain('addAttrs[kSecAttrAccessControl] = access');
  });

  it('reads secrets through a LocalAuthentication context', () => {
    const source = helperSource();

    expect(source).toContain('import LocalAuthentication');
    expect(source).toContain('let context = LAContext()');
    expect(source).toContain('context.localizedReason = reason');
    expect(source).toContain('query[kSecUseAuthenticationContext] = context');
    expect(source).toContain('case "get-auth":');
    expect(source).toContain('case "get-batch":');
  });
});
