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
