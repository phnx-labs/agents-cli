/**
 * Wallet: device-local credit-card vault.
 *
 * Two-tier storage so listing the wallet doesn't pop Touch ID, but reading
 * a card always does:
 *
 *   Card metadata (id, nickname, brand, last4, expiry, created_at, kind)
 *     -> ~/.agents/wallet/cards.json, mode 0600
 *     -> Display-only data, equivalent of Apple Wallet's "card art" tier.
 *
 *   Card secret (PAN, CVC, cardholder)
 *     -> Keychain item `agents-cli.secrets.wallet.<id>` (JSON-encoded)
 *     -> Routed through the signed helper, so the OS gates decryption with
 *        Touch ID + biometryCurrentSet. Re-enrolling Touch ID invalidates
 *        the item, matching Apple Pay's AR-value rotation behavior.
 *
 * Not Apple Pay: we store a real PAN, not a network DPAN, and we do not
 * generate per-transaction cryptograms. Callers must surface this clearly.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  deleteKeychainToken,
  getKeychainToken,
  secretsKeychainItem,
  setKeychainToken,
} from '../secrets/index.js';

const WALLET_BUNDLE = 'wallet';
const DEFAULT_INDEX_DIR = path.join(os.homedir(), '.agents', 'wallet');
const DEFAULT_INDEX_PATH = path.join(DEFAULT_INDEX_DIR, 'cards.json');

let indexPathOverride: string | null = null;

function indexPath(): string {
  return indexPathOverride ?? DEFAULT_INDEX_PATH;
}

function indexDir(): string {
  return path.dirname(indexPath());
}

/** Test seam: override the index path. Returns the previous override (or null). */
export function _setIndexPathForTest(p: string | null): string | null {
  const prev = indexPathOverride;
  indexPathOverride = p;
  return prev;
}

export type CardBrand =
  | 'visa'
  | 'mastercard'
  | 'amex'
  | 'discover'
  | 'diners'
  | 'jcb'
  | 'unionpay'
  | 'unknown';

/** Storage kind discriminator. Reserved for future kind: 'stripe_token'. */
export type CardKind = 'pan_encrypted';

/** Non-sensitive card metadata. Safe to display without biometric auth. */
export interface CardMetadata {
  id: string;
  nickname: string;
  brand: CardBrand;
  last4: string;
  exp_month: string;
  exp_year: string;
  created_at: string;
  kind: CardKind;
}

/** Sensitive card fields. Keychain-stored, Touch ID required to read. */
export interface CardSecret {
  pan: string;
  cvc: string;
  cardholder: string;
}

/** Card metadata plus its secret payload. Returned by show() only. */
export interface CardFull extends CardMetadata, CardSecret {}

/** Input shape for add(). */
export interface AddCardInput {
  nickname: string;
  pan: string;
  cvc: string;
  cardholder: string;
  exp_month: string;
  exp_year: string;
}

/** Compute the Luhn checksum and verify a candidate PAN. */
export function isValidLuhn(pan: string): boolean {
  const digits = pan.replace(/\D/g, '');
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Detect card brand from the BIN (first 6 digits). */
export function detectBrand(pan: string): CardBrand {
  const d = pan.replace(/\D/g, '');
  if (/^4/.test(d)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(d)) return 'mastercard';
  if (/^3[47]/.test(d)) return 'amex';
  if (/^6(011|5|4[4-9])/.test(d)) return 'discover';
  if (/^3(0[0-5]|[689])/.test(d)) return 'diners';
  if (/^35(2[89]|[3-8])/.test(d)) return 'jcb';
  if (/^(62|81)/.test(d)) return 'unionpay';
  return 'unknown';
}

function normalizeMonth(mm: string): string {
  const n = Number(mm);
  if (!Number.isInteger(n) || n < 1 || n > 12) {
    throw new Error(`Invalid expiration month: ${mm}`);
  }
  return n.toString().padStart(2, '0');
}

function normalizeYear(yy: string): string {
  const d = yy.replace(/\D/g, '');
  if (d.length === 2) return '20' + d;
  if (d.length === 4) {
    const n = Number(d);
    if (n < 2000 || n > 2100) throw new Error(`Invalid expiration year: ${yy}`);
    return d;
  }
  throw new Error(`Invalid expiration year: ${yy}`);
}

function ensureIndexDir(): void {
  fs.mkdirSync(indexDir(), { recursive: true, mode: 0o700 });
}

/** Atomically read the index file. Returns [] when missing. */
export function readIndex(): CardMetadata[] {
  const p = indexPath();
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf-8');
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Wallet index at ${p} is not an array.`);
  }
  return parsed as CardMetadata[];
}

/** Atomically write the index file via tmp + rename. */
function writeIndex(cards: CardMetadata[]): void {
  ensureIndexDir();
  const p = indexPath();
  const tmp = p + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(cards, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, indexPath());
}

function walletKeychainItem(id: string): string {
  return secretsKeychainItem(WALLET_BUNDLE, id);
}

function generateId(): string {
  // 12 hex chars (6 bytes). Unique enough for a per-user wallet; short
  // enough to type if needed.
  return crypto.randomBytes(6).toString('hex');
}

/** List all stored cards. Does NOT trigger biometric auth. */
export function listCards(): CardMetadata[] {
  return readIndex();
}

/** Look up a card by id (or by case-insensitive nickname). Returns undefined when missing. */
export function findCard(idOrNickname: string): CardMetadata | undefined {
  const cards = readIndex();
  const exact = cards.find((c) => c.id === idOrNickname);
  if (exact) return exact;
  const lc = idOrNickname.toLowerCase();
  return cards.find((c) => c.nickname.toLowerCase() === lc);
}

/**
 * Add a new card. Validates Luhn + expiry. Returns the metadata for the
 * stored card. The PAN/CVC/cardholder are written to Keychain in a single
 * JSON blob; only metadata is mirrored to the index file.
 */
export function addCard(input: AddCardInput): CardMetadata {
  const pan = input.pan.replace(/\s+/g, '');
  if (!/^\d+$/.test(pan)) throw new Error('PAN must contain only digits.');
  if (!isValidLuhn(pan)) throw new Error('PAN failed Luhn checksum.');
  const cvc = input.cvc.replace(/\s+/g, '');
  if (!/^\d{3,4}$/.test(cvc)) throw new Error('CVC must be 3 or 4 digits.');
  const nickname = input.nickname.trim();
  if (!nickname) throw new Error('Nickname is required.');
  const cardholder = input.cardholder.trim();
  if (!cardholder) throw new Error('Cardholder name is required.');
  if (/[\r\n]/.test(cardholder)) throw new Error('Cardholder name contains newlines.');

  const exp_month = normalizeMonth(input.exp_month);
  const exp_year = normalizeYear(input.exp_year);
  const last4 = pan.slice(-4);
  const brand = detectBrand(pan);

  const cards = readIndex();
  if (cards.some((c) => c.nickname.toLowerCase() === nickname.toLowerCase())) {
    throw new Error(`A card named '${nickname}' already exists. Pick a different nickname.`);
  }

  const id = generateId();
  const meta: CardMetadata = {
    id,
    nickname,
    brand,
    last4,
    exp_month,
    exp_year,
    created_at: new Date().toISOString(),
    kind: 'pan_encrypted',
  };

  const secret: CardSecret = { pan, cvc, cardholder };
  // Keychain item first; if it succeeds, mirror to index. If the index
  // write fails afterward, attempt to roll back the keychain insertion
  // so callers don't see ghost secrets.
  setKeychainToken(walletKeychainItem(id), JSON.stringify(secret));
  try {
    writeIndex([...cards, meta]);
  } catch (err) {
    try { deleteKeychainToken(walletKeychainItem(id)); } catch { /* best-effort rollback */ }
    throw err;
  }
  return meta;
}

/**
 * Reveal a card by id. **Triggers Touch ID on macOS.** Throws if the card
 * isn't in the index or if the keychain entry is missing/cancelled.
 */
export function showCard(idOrNickname: string): CardFull {
  const meta = findCard(idOrNickname);
  if (!meta) throw new Error(`No card found matching '${idOrNickname}'.`);
  const raw = getKeychainToken(walletKeychainItem(meta.id));
  let secret: CardSecret;
  try {
    secret = JSON.parse(raw) as CardSecret;
  } catch (err) {
    throw new Error(`Card secret for '${meta.nickname}' is corrupted (not valid JSON).`);
  }
  if (!secret.pan || !secret.cvc || !secret.cardholder) {
    throw new Error(`Card secret for '${meta.nickname}' is missing required fields.`);
  }
  return { ...meta, ...secret };
}

/** Delete a card from both the index and Keychain. Returns the removed metadata or undefined. */
export function removeCard(idOrNickname: string): CardMetadata | undefined {
  const cards = readIndex();
  const meta = findCard(idOrNickname);
  if (!meta) return undefined;
  const remaining = cards.filter((c) => c.id !== meta.id);
  writeIndex(remaining);
  try { deleteKeychainToken(walletKeychainItem(meta.id)); } catch { /* keychain may already be gone */ }
  return meta;
}

/** Rename a card. Throws if the new nickname collides with an existing card. */
export function renameCard(idOrNickname: string, newNickname: string): CardMetadata {
  const nickname = newNickname.trim();
  if (!nickname) throw new Error('Nickname is required.');
  const cards = readIndex();
  const meta = findCard(idOrNickname);
  if (!meta) throw new Error(`No card found matching '${idOrNickname}'.`);
  if (
    cards.some(
      (c) => c.id !== meta.id && c.nickname.toLowerCase() === nickname.toLowerCase(),
    )
  ) {
    throw new Error(`A card named '${nickname}' already exists.`);
  }
  const updated: CardMetadata = { ...meta, nickname };
  const next = cards.map((c) => (c.id === meta.id ? updated : c));
  writeIndex(next);
  return updated;
}

