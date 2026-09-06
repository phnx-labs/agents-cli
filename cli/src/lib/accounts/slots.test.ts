import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { addNativeAccount, readSlots, removeAccount } from '../account-registry.js';
import { getGlobalDefault, getVersionHomePath, listInstalledVersions } from '../installations/store.js';
import { getHistoryDir, readMeta, updateMeta } from '../state.js';
import { ensureSlot, recordSlot, slotDir } from './slots.js';

describe('slotDir', () => {
  it('is ~/.agents/.history/accounts/<harness>/<accountId>/', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(slotDir('claude', id)).toBe(path.join(getHistoryDir(), 'accounts', 'claude', id));
  });

  it('refuses a path-shaped account id', () => {
    expect(() => slotDir('claude', '../escape')).toThrow(/Invalid account id/);
    expect(() => slotDir('claude', 'a/b')).toThrow(/Invalid account id/);
  });
});

describe('ensureSlot', () => {
  const id = `slot-test-${Date.now()}`;
  afterEach(() => {
    fs.rmSync(slotDir('claude', id), { recursive: true, force: true });
  });

  it('creates a HOME-shaped dir and does not copy credentials', () => {
    const slot = ensureSlot('claude', id);
    expect(slot.accountId).toBe(id);
    expect(slot.slotDir).toBe(slotDir('claude', id));
    expect(slot.authMode).toBe('native');
    expect(slot.verdict).toBe('unconfigured');
    expect(fs.existsSync(path.join(slot.slotDir, '.claude'))).toBe(true);

    const cred = path.join(slot.slotDir, '.claude', '.credentials.json');
    const oauth = path.join(slot.slotDir, '.claude.json');
    expect(fs.existsSync(cred)).toBe(false);
    if (fs.existsSync(oauth)) {
      const parsed = JSON.parse(fs.readFileSync(oauth, 'utf8')) as { oauthAccount?: unknown };
      expect(parsed.oauthAccount).toBeUndefined();
    }

    const version = getGlobalDefault('claude') ?? listInstalledVersions('claude')[0];
    if (version) {
      const fromHome = getVersionHomePath('claude', version);
      const srcSettings = path.join(fromHome, '.claude', 'settings.json');
      const destSettings = path.join(slot.slotDir, '.claude', 'settings.json');
      if (fs.existsSync(srcSettings)) {
        expect(fs.existsSync(destSettings)).toBe(true);
      }
      const srcCred = path.join(fromHome, '.claude', '.credentials.json');
      if (fs.existsSync(srcCred)) {
        expect(fs.existsSync(cred)).toBe(false);
      }
    }
  });

  it('is idempotent: a second call does not throw', () => {
    ensureSlot('claude', id);
    expect(() => ensureSlot('claude', id)).not.toThrow();
  });
});

describe('recordSlot / readSlots device-doc round-trip', () => {
  const prevMid = process.env.AGENTS_SYNC_MACHINE_ID;
  const clear = () => updateMeta((m) => ({
    ...m,
    accounts: { ...m.accounts, native: {} },
    deviceAccounts: undefined,
  }));
  beforeEach(() => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'slotbox';
    clear();
  });
  afterEach(() => {
    clear();
    if (prevMid === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = prevMid;
  });

  it('persists slots in the device doc, never central, and round-trips', () => {
    const created = addNativeAccount('work', 'claude', 'claude:user=slot-1', 'work@example.com', 'version');
    const slot = ensureSlot('claude', created.id);
    recordSlot(created.id, slot);

    const read = readSlots(readMeta());
    expect(read[created.id]).toMatchObject({
      accountId: created.id,
      slotDir: slot.slotDir,
      authMode: 'native',
      verdict: 'unconfigured',
    });

    expect(readMeta().accounts).not.toHaveProperty('slots');
    expect(JSON.stringify(readMeta().accounts?.native?.[created.id] ?? {})).not.toContain('slotDir');

    removeAccount('work');
    expect(readSlots(readMeta())[created.id]).toBeUndefined();
    fs.rmSync(slot.slotDir, { recursive: true, force: true });
  });

  it('refuses a recordSlot key that does not match the slot', () => {
    expect(() => recordSlot('aaa', {
      accountId: 'bbb',
      slotDir: '/tmp/no',
      authMode: 'native',
      verdict: 'unconfigured',
    })).toThrow(/mismatch/);
  });
});
