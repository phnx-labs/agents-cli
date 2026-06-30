/**
 * Wallet storage tests.
 *
 * The Keychain backend is swapped for an in-memory map via
 * setKeychainBackendForTest so tests don't touch the real Keychain (which
 * would surface biometric prompts). The wallet's file index is redirected
 * to a per-test tmp dir via _setIndexPathForTest. End-to-end Keychain +
 * Touch ID is verified manually on a real Mac per the plan's verify section.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  setKeychainBackendForTest,
  type KeychainBackend,
} from '../../secrets/index.js';
import {
  _setIndexPathForTest,
  addCard,
  detectBrand,
  findCard,
  isValidLuhn,
  listCards,
  removeCard,
  renameCard,
  showCard,
} from '../index.js';

// In-memory backend mirrors the shape the secrets module expects.
function makeMemoryBackend(): KeychainBackend {
  const store = new Map<string, string>();
  return {
    has: (k) => store.has(k),
    get: (k) => {
      if (!store.has(k)) throw new Error(`not found: ${k}`);
      return store.get(k)!;
    },
    set: (k, v) => { store.set(k, v); },
    delete: (k) => store.delete(k),
    list: (prefix) => [...store.keys()].filter((k) => k.startsWith(prefix)),
  };
}

// Stripe test PANs — these pass Luhn and don't correspond to real cards.
const VISA_PAN = '4242424242424242';
const MC_PAN = '5555555555554444';
const AMEX_PAN = '378282246310005';
const INVALID_PAN = '4242424242424241'; // Luhn fails

let tmpDir = '';
let prevBackend: KeychainBackend | null = null;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-test-'));
  _setIndexPathForTest(path.join(tmpDir, 'cards.json'));
  prevBackend = setKeychainBackendForTest(makeMemoryBackend());
});

afterEach(() => {
  setKeychainBackendForTest(prevBackend);
  _setIndexPathForTest(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Luhn', () => {
  it('accepts well-known test PANs', () => {
    expect(isValidLuhn(VISA_PAN)).toBe(true);
    expect(isValidLuhn(MC_PAN)).toBe(true);
    expect(isValidLuhn(AMEX_PAN)).toBe(true);
  });
  it('rejects a single-digit-flipped PAN', () => {
    expect(isValidLuhn(INVALID_PAN)).toBe(false);
  });
  it('rejects too-short and too-long inputs', () => {
    expect(isValidLuhn('1234')).toBe(false);
    expect(isValidLuhn('1'.repeat(20))).toBe(false);
  });
});

describe('detectBrand', () => {
  it('classifies known BINs', () => {
    expect(detectBrand(VISA_PAN)).toBe('visa');
    expect(detectBrand(MC_PAN)).toBe('mastercard');
    expect(detectBrand(AMEX_PAN)).toBe('amex');
    expect(detectBrand('6011000990139424')).toBe('discover');
    expect(detectBrand('3056930009020004')).toBe('diners');
    expect(detectBrand('3530111333300000')).toBe('jcb');
    expect(detectBrand('6200000000000005')).toBe('unionpay');
  });
  it('falls back to unknown on unrecognized BIN', () => {
    expect(detectBrand('9999999999999999')).toBe('unknown');
  });
});

describe('add → list → show → remove round-trip', () => {
  it('stores and retrieves a card', () => {
    const meta = addCard({
      nickname: 'Personal Visa',
      pan: VISA_PAN,
      cvc: '123',
      cardholder: 'MUQSIT NAWAZ',
      exp_month: '9',
      exp_year: '27',
    });
    expect(meta.brand).toBe('visa');
    expect(meta.last4).toBe('4242');
    expect(meta.exp_month).toBe('09');
    expect(meta.exp_year).toBe('2027');
    expect(meta.kind).toBe('pan_encrypted');
    expect(meta.id).toMatch(/^[0-9a-f]{12}$/);

    const cards = listCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].nickname).toBe('Personal Visa');

    const full = showCard(meta.id);
    expect(full.pan).toBe(VISA_PAN);
    expect(full.cvc).toBe('123');
    expect(full.cardholder).toBe('MUQSIT NAWAZ');

    const removed = removeCard(meta.id);
    expect(removed?.id).toBe(meta.id);
    expect(listCards()).toHaveLength(0);
    expect(() => showCard(meta.id)).toThrow(/No card found/);
  });

  it('looks up cards by nickname (case-insensitive)', () => {
    addCard({
      nickname: 'Business MC',
      pan: MC_PAN,
      cvc: '321',
      cardholder: 'MUQSIT NAWAZ',
      exp_month: '02',
      exp_year: '2029',
    });
    expect(findCard('business mc')?.last4).toBe('4444');
    expect(findCard('BUSINESS MC')?.last4).toBe('4444');
  });
});

describe('validation', () => {
  it('rejects a PAN with bad Luhn', () => {
    expect(() => addCard({
      nickname: 'Bad',
      pan: INVALID_PAN,
      cvc: '123',
      cardholder: 'X',
      exp_month: '1',
      exp_year: '2027',
    })).toThrow(/Luhn/);
  });
  it('rejects CVC that is not 3-4 digits', () => {
    expect(() => addCard({
      nickname: 'Bad CVC',
      pan: VISA_PAN,
      cvc: '12',
      cardholder: 'X',
      exp_month: '1',
      exp_year: '2027',
    })).toThrow(/CVC/);
  });
  it('rejects duplicate nicknames (case-insensitive)', () => {
    addCard({
      nickname: 'My Card',
      pan: VISA_PAN, cvc: '123', cardholder: 'X', exp_month: '1', exp_year: '2027',
    });
    expect(() => addCard({
      nickname: 'my card',
      pan: MC_PAN, cvc: '321', cardholder: 'X', exp_month: '1', exp_year: '2027',
    })).toThrow(/already exists/);
  });
  it('rejects bad expiration month', () => {
    expect(() => addCard({
      nickname: 'X', pan: VISA_PAN, cvc: '123', cardholder: 'X',
      exp_month: '13', exp_year: '2027',
    })).toThrow(/month/);
  });
});

describe('rename', () => {
  it('renames a card and rejects collisions', () => {
    const a = addCard({
      nickname: 'A', pan: VISA_PAN, cvc: '123', cardholder: 'X', exp_month: '1', exp_year: '2027',
    });
    const b = addCard({
      nickname: 'B', pan: MC_PAN, cvc: '321', cardholder: 'X', exp_month: '1', exp_year: '2027',
    });
    const renamed = renameCard(a.id, 'A New Name');
    expect(renamed.nickname).toBe('A New Name');
    expect(findCard('A New Name')?.id).toBe(a.id);

    expect(() => renameCard(b.id, 'a new name')).toThrow(/already exists/);
  });
});

describe('index file safety', () => {
  it('keeps Keychain and index in sync on rollback', () => {
    // Force the index to fail by pointing it at an unwritable path
    // mid-test. Simulates a disk-full / permission failure between the
    // Keychain write and the index write.
    const card = addCard({
      nickname: 'OK', pan: VISA_PAN, cvc: '123', cardholder: 'X', exp_month: '1', exp_year: '2027',
    });
    // Confirm Keychain has the secret (would throw if missing)
    expect(showCard(card.id).pan).toBe(VISA_PAN);

    // Now simulate index write failure: put a regular file where the index
    // dir needs to be, so mkdir(recursive) throws ENOTDIR/EEXIST on every OS.
    // (A leading-`/` path is drive-relative on Windows and mkdir succeeds there.)
    const blocker = path.join(tmpDir, 'blocker-file');
    fs.writeFileSync(blocker, 'not a directory');
    _setIndexPathForTest(path.join(blocker, 'cards.json'));
    expect(() => addCard({
      nickname: 'Will Fail', pan: MC_PAN, cvc: '321', cardholder: 'X', exp_month: '1', exp_year: '2027',
    })).toThrow();
    // Restore real tmp index
    _setIndexPathForTest(path.join(tmpDir, 'cards.json'));
    const remaining = listCards();
    // Only the first card should still be present; the rollback should
    // have removed the partial Keychain entry for "Will Fail".
    expect(remaining.map((c) => c.nickname)).toEqual(['OK']);
  });
});
