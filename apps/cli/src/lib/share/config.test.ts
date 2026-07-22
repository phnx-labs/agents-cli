import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

type ConfigMod = typeof import('./config.js');
type SecretsMod = typeof import('../secrets/index.js');

let cfg: ConfigMod;
let secrets: SecretsMod;
let tmpHome: string;
const keychain = new Map<string, string>();
let originalHome: string | undefined;
let originalNoAgent: string | undefined;
let restoreKeychain: SecretsMod['setKeychainBackendForTest'] extends (b: infer T) => infer R ? R : never;

beforeAll(async () => {
  vi.resetModules();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-share-home-'));
  originalHome = process.env.HOME;
  originalNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
  process.env.HOME = tmpHome;
  process.env.AGENTS_SECRETS_NO_AGENT = '1';
  secrets = await import('../secrets/index.js');
  restoreKeychain = secrets.setKeychainBackendForTest({
    has: (item) => keychain.has(item),
    get: (item) => {
      const value = keychain.get(item);
      if (value === undefined) throw new Error(`missing ${item}`);
      return value;
    },
    set: (item, value) => { keychain.set(item, value); },
    delete: (item) => keychain.delete(item),
    list: (prefix) => Array.from(keychain.keys()).filter((key) => key.startsWith(prefix)),
  });
  cfg = await import('./config.js');
});

afterAll(() => {
  secrets.setKeychainBackendForTest(restoreKeychain);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
  else process.env.AGENTS_SECRETS_NO_AGENT = originalNoAgent;
  vi.resetModules();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('share config and token store', () => {
  it('mints a 32-byte hex write token', () => {
    expect(cfg.generateWriteToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores endpoint config under redirected HOME', () => {
    cfg.writeShareConfig({
      baseUrl: 'https://share.example.com/',
      accountId: 'acct_1',
      workerName: 'agents-share',
      bucketName: 'agents-share',
      domain: 'share.example.com',
    });

    expect(cfg.readShareConfig()).toEqual({
      baseUrl: 'https://share.example.com',
      accountId: 'acct_1',
      workerName: 'agents-share',
      bucketName: 'agents-share',
      domain: 'share.example.com',
    });
    expect(fs.existsSync(path.join(tmpHome, '.agents', 'agents.yaml'))).toBe(true);
  });

  it('stores the write token in the share secrets bundle and reads it back', () => {
    const token = cfg.generateWriteToken();
    cfg.storeWriteToken(token);

    expect(cfg.readWriteToken()).toBe(token);
    expect(keychain.get('agents-cli.secrets.share.SHARE_WRITE_TOKEN')).toBe(token);
    expect(fs.readFileSync(path.join(tmpHome, '.agents', 'agents.yaml'), 'utf8')).not.toContain(token);
  });
});
