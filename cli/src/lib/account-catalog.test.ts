import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNativeCatalog, groupNativeAccountRows, isLaunchableSignedIn, type NativeHomeRow } from './account-catalog.js';
import type { Meta } from './types.js';

describe('native account catalog', () => {
  it('groups matching identities across versions without merging different harnesses', () => {
    const rows = [
      { agent: 'claude' as const, version: '2.1.1', accountKey: 'claude:user=1', email: 'a@example.com', signedIn: true },
      { agent: 'claude' as const, version: '2.1.2', accountKey: 'claude:user=1', email: 'a@example.com', signedIn: true },
      { agent: 'codex' as const, version: '1.0.0', accountKey: 'codex:user=1', email: 'a@example.com', signedIn: true },
      { agent: 'claude' as const, version: '2.0.0', accountKey: 'claude:user=2', email: 'out@example.com', signedIn: false },
    ];
    expect(groupNativeAccountRows(rows)).toEqual([
      { kind: 'native', id: 'claude:user=1', agent: 'claude', display: 'a@example.com', email: 'a@example.com', versions: ['2.1.1', '2.1.2'] },
      { kind: 'native', id: 'codex:user=1', agent: 'codex', display: 'a@example.com', email: 'a@example.com', versions: ['1.0.0'] },
    ]);
  });
});

describe('buildNativeCatalog account-first read model', () => {
  const home = (over: Partial<NativeHomeRow>): NativeHomeRow => ({
    agent: 'claude', label: 'acct-1', releaseVersion: '2.1.220', accountKey: 'claude:user=1', email: 'a@example.com', signedIn: true, ...over,
  });
  const noGlobalDefault = () => null;

  it('folds homes by identity and reports connected state + release/home diagnostics', () => {
    const rows = [
      home({ label: 'acct-1', releaseVersion: '2.1.220' }),
      home({ label: 'acct-2', releaseVersion: '2.1.219' }),
    ];
    const meta: Pick<Meta, 'accounts' | 'deviceAccounts'> = {
      accounts: { native: { 'id-1': { id: 'id-1', name: 'work', agent: 'claude', identityKey: 'claude:user=1', identityLabel: 'a@example.com', scope: 'version' } } },
      deviceAccounts: { homes: { 'id-1': 'acct-1' } },
    };
    const [row] = buildNativeCatalog(rows, meta, noGlobalDefault);
    expect(row).toMatchObject({
      kind: 'native', agent: 'claude', identityKey: 'claude:user=1', name: 'work', id: 'id-1',
      email: 'a@example.com', home: 'acct-1', isDefault: false, state: 'connected',
    });
    expect(row.installations).toEqual([
      { label: 'acct-1', releaseVersion: '2.1.220', signedIn: true },
      { label: 'acct-2', releaseVersion: '2.1.219', signedIn: true },
    ]);
  });

  it('reports reconnect-needed for a registered account whose homes are all signed out', () => {
    const rows = [home({ signedIn: false })];
    const meta: Pick<Meta, 'accounts' | 'deviceAccounts'> = {
      accounts: { native: { 'id-1': { id: 'id-1', name: 'work', agent: 'claude', identityKey: 'claude:user=1', scope: 'version' } } },
    };
    expect(buildNativeCatalog(rows, meta, noGlobalDefault)[0].state).toBe('reconnect-needed');
  });

  it('surfaces a registered account with NO discovered home as reconnect-needed', () => {
    const meta: Pick<Meta, 'accounts' | 'deviceAccounts'> = {
      accounts: { native: { 'id-1': { id: 'id-1', name: 'gone', agent: 'claude', identityKey: 'claude:user=9', identityLabel: 'g@x.com', scope: 'version' } } },
    };
    const [row] = buildNativeCatalog([], meta, noGlobalDefault);
    expect(row).toMatchObject({ name: 'gone', state: 'reconnect-needed', installations: [], email: 'g@x.com' });
  });

  it('marks the configured default account authoritative regardless of homes', () => {
    const rows = [home({})];
    const meta: Pick<Meta, 'accounts' | 'deviceAccounts'> = {
      accounts: {
        defaults: { claude: 'work' },
        native: { 'id-1': { id: 'id-1', name: 'work', agent: 'claude', identityKey: 'claude:user=1', scope: 'version' } },
      },
    };
    expect(buildNativeCatalog(rows, meta, noGlobalDefault)[0].isDefault).toBe(true);
  });

  it('does not invent a native default from an unmatched/provider account default', () => {
    const rows = [home({})];
    const meta: Pick<Meta, 'accounts' | 'deviceAccounts'> = {
      // The configured default names a provider bundle, not this native account.
      accounts: { defaults: { claude: 'openrouter-work' }, native: { 'id-1': { id: 'id-1', name: 'work', agent: 'claude', identityKey: 'claude:user=1', scope: 'version' } } },
    };
    expect(buildNativeCatalog(rows, meta, () => 'acct-1')[0].isDefault).toBe(false);
  });

  it('falls back to the global-default home only when no account default is configured', () => {
    const rows = [home({ label: 'acct-1' }), home({ label: 'acct-2', accountKey: 'claude:user=2', email: 'b@example.com' })];
    const meta: Pick<Meta, 'accounts' | 'deviceAccounts'> = { accounts: {} };
    const catalog = buildNativeCatalog(rows, meta, (a) => (a === 'claude' ? 'acct-2' : null));
    expect(catalog.find(r => r.identityKey === 'claude:user=2')?.isDefault).toBe(true);
    expect(catalog.find(r => r.identityKey === 'claude:user=1')?.isDefault).toBe(false);
  });
});

describe('isLaunchableSignedIn (strict — a live credential, not metadata alone)', () => {
  const tmps: string[] = [];
  const mkHome = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-launchable-')); tmps.push(d); return d; };
  afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it('returns false when the metadata says signed in but no credential file exists in the home', () => {
    const home = mkHome();
    expect(isLaunchableSignedIn('claude', home, { signedIn: true })).toBe(false);
  });

  it('is still false with metadata present but a BLANK credential (stale/expired login)', () => {
    const home = mkHome();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    // `.claude.json` metadata exists but no usable credential behind it.
    fs.writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }));
    expect(isLaunchableSignedIn('claude', home, { signedIn: true })).toBe(false);
  });

  it('returns true once a real credential sits behind the metadata', () => {
    const home = mkHome();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }));
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok', refreshToken: 'ref' } }));
    expect(isLaunchableSignedIn('claude', home, { signedIn: true })).toBe(true);
  });

  it('is false when metadata itself is not signed in, regardless of files', () => {
    const home = mkHome();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.claude.json'), '{}');
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }));
    expect(isLaunchableSignedIn('claude', home, { signedIn: false })).toBe(false);
  });
});
