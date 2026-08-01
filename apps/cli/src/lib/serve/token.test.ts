/**
 * Verifies the control-token store: mint-once semantics, constant-time verify,
 * and — the load-bearing security property — that only the token HASH lands on
 * disk, never the raw token. Runs against a temp HOME so it never touches the
 * real ~/.agents cache. state.ts reads HOME at module load, so we set it before
 * a dynamic import of the store.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

type TokenMod = typeof import('./token.js');
let tok: TokenMod;
let tmpHome: string;

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-token-'));
  process.env.HOME = tmpHome;
  tok = await import('./token.js');
});

describe('control-token store', () => {
  it('mints a token on first ensure and not again', () => {
    const first = tok.ensureControlToken('default');
    expect(first.created).toBe(true);
    const second = tok.ensureControlToken('default');
    expect(second.created).toBe(false);
  });

  it('verifies a minted token and rejects others', () => {
    const issued = tok.addControlToken('phone');
    expect(tok.verifyControlToken(issued.token)).toBe(true);
    expect(tok.verifyControlToken('not-the-token')).toBe(false);
    expect(tok.verifyControlToken(undefined)).toBe(false);
  });

  it('persists only the hash — the raw token never lands on disk', () => {
    const issued = tok.addControlToken('audit');
    const storeFile = path.join(tmpHome, '.agents', '.cache', 'serve', 'control-tokens.json');
    const raw = fs.readFileSync(storeFile, 'utf-8');
    // The raw secret must be absent; its hash present.
    expect(raw).not.toContain(issued.token);
    const store = JSON.parse(raw) as { tokens: Array<{ hash: string; label: string }> };
    expect(store.tokens.some((t) => t.label === 'audit')).toBe(true);
    for (const t of store.tokens) expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // Unix permission bits are unenforceable on Windows: Node reports 0o666 for
  // every file regardless of chmod, so the 0600 assertions only hold on POSIX.
  it.skipIf(process.platform === 'win32')('writes the store 0600 (owner-only)', () => {
    const storeFile = path.join(tmpHome, '.agents', '.cache', 'serve', 'control-tokens.json');
    const mode = fs.statSync(storeFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('self-heals 0600 on rewrite if perms were widened externally', () => {
    const storeFile = path.join(tmpHome, '.agents', '.cache', 'serve', 'control-tokens.json');
    // Simulate an external widen (backup/restore, manual chmod).
    fs.chmodSync(storeFile, 0o644);
    expect(fs.statSync(storeFile).mode & 0o777).toBe(0o644);
    // A subsequent write must restore owner-only — mode on writeFileSync alone
    // would NOT (it's honored only at creation); the explicit chmod does.
    tok.addControlToken('rewrite');
    expect(fs.statSync(storeFile).mode & 0o777).toBe(0o600);
  });
});
