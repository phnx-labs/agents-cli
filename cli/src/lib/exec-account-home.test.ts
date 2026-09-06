import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { addNativeAccount, nativeAccountHome, removeAccount } from './account-registry.js';
import { recordSlot, slotDir } from './accounts/slots.js';
import { getVersionHomePath } from './installations/store.js';
import { getHistoryDir, getVersionsDir, readMeta, updateMeta } from './state.js';
import {
  isAccountSlotDir,
  missingSlotHint,
  resolveNativeSpawnHome,
  symlinkAdoptedAccountError,
} from './exec-account-home.js';
import { isSymlinkAdoptedHarness } from './installations/shims.js';

const suffix = `t5-${Date.now()}`;
const planted: string[] = [];

function clearDevice() {
  updateMeta((m) => ({
    ...m,
    accounts: { ...m.accounts, native: {}, defaults: {} },
    deviceAccounts: undefined,
  }));
}

beforeEach(() => {
  process.env.AGENTS_SYNC_MACHINE_ID = 't5-spawn-box';
  clearDevice();
});

afterEach(() => {
  clearDevice();
  for (const p of planted) fs.rmSync(p, { recursive: true, force: true });
  planted.length = 0;
  delete process.env.AGENTS_SYNC_MACHINE_ID;
});

describe('isAccountSlotDir', () => {
  it('recognizes dirs under ~/.agents/.history/accounts/', () => {
    const dir = path.join(getHistoryDir(), 'accounts', 'claude', 'abc');
    expect(isAccountSlotDir(dir)).toBe(true);
    expect(isAccountSlotDir(path.join(getHistoryDir(), 'versions', 'claude', 'main', 'home'))).toBe(false);
  });
});

describe('isSymlinkAdoptedHarness', () => {
  it('is the slotEnv-null set that is not CONFIG_ENV isolated', () => {
    expect(isSymlinkAdoptedHarness('droid')).toBe(true);
    expect(isSymlinkAdoptedHarness('antigravity')).toBe(true);
    expect(isSymlinkAdoptedHarness('gemini')).toBe(true);
    expect(isSymlinkAdoptedHarness('openclaw')).toBe(true);
    expect(isSymlinkAdoptedHarness('amp')).toBe(true);
    expect(isSymlinkAdoptedHarness('goose')).toBe(true);
    expect(isSymlinkAdoptedHarness('hermes')).toBe(true);
    expect(isSymlinkAdoptedHarness('warp')).toBe(true);
    expect(isSymlinkAdoptedHarness('claude')).toBe(false);
    expect(isSymlinkAdoptedHarness('cursor')).toBe(false);
    expect(isSymlinkAdoptedHarness('grok')).toBe(false);
  });
});

describe('resolveNativeSpawnHome', () => {
  it('uses a slot dir that exists on disk', () => {
    const account = addNativeAccount(`work-${suffix}`, 'claude', `claude:user=t5-work-${suffix}`, 'work@example.com', 'version');
    const dir = slotDir('claude', account.id);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    planted.push(dir);
    recordSlot(account.id, {
      accountId: account.id,
      slotDir: dir,
      authMode: 'native',
      verdict: 'live',
    });
    const resolved = resolveNativeSpawnHome('claude', account, readMeta());
    expect(resolved.source).toBe('slot');
    expect(resolved.execHome).toBe(dir);
    removeAccount(account.name);
  });

  it('falls back to the recorded homes label when the slot dir was never created (T1 backfill)', () => {
    const account = addNativeAccount(`legacy-${suffix}`, 'claude', `claude:user=t5-legacy-${suffix}`, 'legacy@example.com', 'version');
    const missingSlot = slotDir('claude', account.id);
    expect(fs.existsSync(missingSlot)).toBe(false);
    recordSlot(account.id, {
      accountId: account.id,
      slotDir: missingSlot,
      authMode: 'native',
      verdict: 'unconfigured',
    });
    const label = `acct-${suffix}`;
    updateMeta((m) => ({
      ...m,
      deviceAccounts: {
        ...m.deviceAccounts,
        homes: { ...m.deviceAccounts?.homes, [account.id]: label },
      },
    }));
    expect(nativeAccountHome(account.id, readMeta())).toBe(label);
    const legacyHome = getVersionHomePath('claude', label);
    fs.mkdirSync(legacyHome, { recursive: true });
    planted.push(path.join(getVersionsDir(), 'claude', label));
    const resolved = resolveNativeSpawnHome('claude', account, readMeta());
    expect(resolved.source).toBe('legacy-home');
    expect(resolved.execHome).toBe(legacyHome);
    expect(resolved.execHome).not.toBe(missingSlot);
    removeAccount(account.name);
  });

  it('fails loud with the T4 hint when there is no slot and no legacy home', () => {
    const account = addNativeAccount(`gone-${suffix}`, 'claude', `claude:user=t5-gone-${suffix}`, 'gone@example.com', 'version');
    expect(() => resolveNativeSpawnHome('claude', account, readMeta())).toThrow(/has no slot on this device/);
    expect(missingSlotHint('claude', account.name)).toMatch(/accounts (login|add) claude/);
    removeAccount(account.name);
  });
});

describe('symlinkAdoptedAccountError', () => {
  it('names the one-active-slot rule and the default command', () => {
    expect(symlinkAdoptedAccountError('droid', 'work', 'personal')).toMatch(/one active account per device/);
    expect(symlinkAdoptedAccountError('droid', 'work', 'personal')).toMatch(/accounts default droid work/);
    expect(symlinkAdoptedAccountError('droid', 'work', undefined)).toMatch(/Set the default first/);
  });
});
