/**
 * Bearer-token store for the authenticated `agents serve --control` server.
 *
 * Only the SHA-256 *hash* of each token is written to disk — the raw token is
 * shown once at creation (like an API key) and never persisted, so a leaked
 * store file cannot be replayed. This is the anchor-side credential the iOS
 * cockpit presents on every request; `agents devices pair-ios` (Phase 3) mints
 * additional per-device tokens through {@link addControlToken}.
 *
 * Store path: `<cache>/serve/control-tokens.json` — under `.cache/`, which is
 * gitignored, so no credential material lands in a version-controlled repo.
 */
import fs from 'fs';
import path from 'path';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { getCacheDir } from '../state.js';

/** One issued token, stored by hash only. */
export interface ControlTokenRecord {
  /** Short public id for display / revocation (not secret). */
  id: string;
  /** SHA-256 hex of the raw token. */
  hash: string;
  /** Human label, e.g. "muqsit-iphone". */
  label: string;
  createdAt: string;
}

interface TokenStore {
  tokens: ControlTokenRecord[];
}

function storePath(): string {
  return path.join(getCacheDir(), 'serve', 'control-tokens.json');
}

function readStore(): TokenStore {
  try {
    const raw = fs.readFileSync(storePath(), 'utf-8');
    const parsed = JSON.parse(raw) as TokenStore;
    if (parsed && Array.isArray(parsed.tokens)) return parsed;
  } catch {
    // Missing/corrupt store → start empty; a fresh token gets minted below.
  }
  return { tokens: [] };
}

function writeStore(store: TokenStore): void {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // 0600: readable only by the owner — it holds token hashes. `mode` on
  // writeFileSync is honored only at *creation*, so chmod every write to
  // self-heal if the perms were ever widened externally (this is a credential
  // file, even if only hashes).
  fs.writeFileSync(p, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Mint a new control token, persist its hash, and return the raw token ONCE.
 * The caller must surface it to the operator immediately — it cannot be
 * recovered later.
 */
export function addControlToken(label: string): { id: string; token: string } {
  const store = readStore();
  const id = randomBytes(4).toString('hex');
  const token = randomBytes(32).toString('hex');
  store.tokens.push({ id, hash: sha256(token), label, createdAt: new Date().toISOString() });
  writeStore(store);
  return { id, token };
}

/**
 * Ensure at least one token exists. Returns the raw token only when it had to
 * mint one (first `--control` boot); otherwise `{ created: false }` and the
 * existing tokens stand.
 */
export function ensureControlToken(
  label = 'default',
): { created: true; id: string; token: string } | { created: false } {
  const store = readStore();
  if (store.tokens.length > 0) return { created: false };
  const { id, token } = addControlToken(label);
  return { created: true, id, token };
}

/** True when `presented` matches a stored token hash (constant-time compare). */
export function verifyControlToken(presented: string | undefined): boolean {
  if (!presented) return false;
  const want = Buffer.from(sha256(presented), 'hex');
  for (const rec of readStore().tokens) {
    const have = Buffer.from(rec.hash, 'hex');
    if (have.length === want.length && timingSafeEqual(have, want)) return true;
  }
  return false;
}

/** List issued tokens (hashes only — safe to display). */
export function listControlTokens(): ControlTokenRecord[] {
  return readStore().tokens;
}
