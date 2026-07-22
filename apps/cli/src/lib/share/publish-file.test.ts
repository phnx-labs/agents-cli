import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { KeychainBackend } from '../secrets/index.js';

type ConfigMod = typeof import('./config.js');
type PublishMod = typeof import('./publish.js');

let cfg: ConfigMod;
let publish: PublishMod;
let tmpHome: string;
let tmpDir: string;
const keychain = new Map<string, string>();
let originalHome: string | undefined;
let originalNoAgent: string | undefined;
let originalNoPrompt: string | undefined;
let restoreKeychain: KeychainBackend | null;

beforeAll(async () => {
  vi.resetModules();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-share-publish-home-'));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-share-publish-files-'));
  originalHome = process.env.HOME;
  originalNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
  originalNoPrompt = process.env.AGENTS_SECRETS_NO_PROMPT;
  process.env.HOME = tmpHome;
  process.env.AGENTS_SECRETS_NO_AGENT = '1';
  // The token is read from an in-memory keychain backend (installed below), which
  // never prompts Touch ID. On darwin-headless (the release-gated macOS CI matrix)
  // isHeadlessSecretsContext() would otherwise force the agentOnly no-prompt path
  // to throw before the direct read. Pin NO_PROMPT=0 so the read runs on every OS.
  process.env.AGENTS_SECRETS_NO_PROMPT = '0';
  const secrets = await import('../secrets/index.js');
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
  publish = await import('./publish.js');
  cfg.writeShareConfig({
    baseUrl: 'https://share.example.com',
    accountId: 'acct_1',
    workerName: 'agents-share',
    bucketName: 'agents-share',
  });
  cfg.storeWriteToken('write-token-1');
});

afterAll(async () => {
  const secrets = await import('../secrets/index.js');
  secrets.setKeychainBackendForTest(restoreKeychain);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
  else process.env.AGENTS_SECRETS_NO_AGENT = originalNoAgent;
  if (originalNoPrompt === undefined) delete process.env.AGENTS_SECRETS_NO_PROMPT;
  else process.env.AGENTS_SECRETS_NO_PROMPT = originalNoPrompt;
  vi.resetModules();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('publishFile with injected uploader', () => {
  it('uploads the file body with auth, content type, and expiry headers', async () => {
    const htmlPath = path.join(tmpDir, 'report.html');
    fs.writeFileSync(htmlPath, '<!doctype html><title>Report</title>');
    const uploads: Array<{ url: string; body: string; headers: Record<string, string> }> = [];

    const result = await publish.publishFile(htmlPath, {
      slug: 'rush-1800-report',
      expire: '2030-01-01',
      cover: false,
      uploader: async (url, body, headers) => {
        uploads.push({ url, body: body.toString('utf8'), headers });
        return { ok: true, status: 200, url };
      },
    });

    expect(result).toEqual({
      url: 'https://share.example.com/rush-1800-report',
      expiresAt: new Date('2030-01-01').toISOString(),
      coverUrl: undefined,
    });
    expect(uploads).toEqual([
      {
        url: 'https://share.example.com/rush-1800-report',
        body: '<!doctype html><title>Report</title>',
        headers: {
          authorization: 'Bearer write-token-1',
          'content-type': 'text/html; charset=utf-8',
          'x-share-expires-at': new Date('2030-01-01').toISOString(),
        },
      },
    ]);
  });

  it('uses the same uploader seam for cover upload before the page publish', async () => {
    const htmlPath = path.join(tmpDir, 'cover.html');
    fs.writeFileSync(htmlPath, '<html><head><title>Cover</title></head><body>ok</body></html>');
    const uploads: string[] = [];

    const result = await publish.publishFile(htmlPath, {
      slug: 'cover-page',
      uploader: async (url) => {
        uploads.push(url);
        return { ok: true, status: 200, url };
      },
      capturer: async () => Buffer.from('PNG'),
    });

    expect(result.coverUrl).toBe('https://share.example.com/cover-page.png');
    expect(uploads).toEqual([
      'https://share.example.com/cover-page.png',
      'https://share.example.com/cover-page',
    ]);
  });
});
