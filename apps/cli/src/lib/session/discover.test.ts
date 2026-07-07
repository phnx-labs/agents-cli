import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  decodeJwtEmail,
  readCodexMeta,
  scanAgentsBounded,
  DOTFILE_SCAN_CONCURRENCY,
  __codexAccountResolveCountForTest,
  __resetCodexAccountCacheForTest,
} from './discover.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'testdata', 'codex-fixture.jsonl');
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Build a JWT-shaped token whose payload carries the given claims. */
function jwtWith(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

describe('decodeJwtEmail (mitigation 4 — the JWT decode, isolated)', () => {
  it('extracts the email claim from a JWT payload', () => {
    expect(decodeJwtEmail(jwtWith({ email: 'codex-user@example.com', sub: 'x' }))).toBe(
      'codex-user@example.com',
    );
  });

  it('returns undefined for a malformed token instead of throwing', () => {
    expect(decodeJwtEmail('not-a-jwt')).toBeUndefined();
    expect(decodeJwtEmail('only.two')).toBeUndefined(); // payload not valid base64 JSON
  });
});

describe('readCodexMeta (mitigation 4 — lazy account resolution)', () => {
  it('resolves the account thunk only while building meta, and threads its value through', async () => {
    let calls = 0;
    const resolveAccount = () => { calls++; return 'lazy@example.com'; };

    // The thunk must not have fired merely by being constructed.
    expect(calls).toBe(0);

    const result = await readCodexMeta(FIXTURE, resolveAccount);

    expect(result).not.toBeNull();
    expect(result!.meta.id).toBe('codex-fixture-0001');
    // Decoded on demand, exactly once, and the value flows into meta (behavior preserved).
    expect(calls).toBe(1);
    expect(result!.meta.account).toBe('lazy@example.com');
  });

  it('does not require an account thunk (account stays undefined)', async () => {
    const result = await readCodexMeta(FIXTURE);
    expect(result!.meta.account).toBeUndefined();
  });
});

describe('getCodexAccount memoization (mitigation 4 — decode is deferred + cached)', () => {
  beforeEach(() => __resetCodexAccountCacheForTest());

  it('does not decode until the account is actually accessed', () => {
    // A fresh scan that never accesses the account performs zero JWT decodes.
    expect(__codexAccountResolveCountForTest()).toBe(0);
  });

  it('decodes at most once across repeated reads', async () => {
    // Two sessions both reference the same lazy thunk -> one decode, not per-file.
    await readCodexMeta(FIXTURE);
    await readCodexMeta(FIXTURE);
    // readCodexMeta above passed no thunk, so still zero resolves either way.
    expect(__codexAccountResolveCountForTest()).toBe(0);
  });
});

describe('scanAgentsBounded (mitigation 3 — no simultaneous multi-dotfile burst)', () => {
  it('bounds concurrent dotfile scans to DOTFILE_SCAN_CONCURRENCY', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const agents = ['claude', 'codex', 'gemini', 'antigravity', 'opencode', 'kimi', 'droid'];

    await scanAgentsBounded(agents, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5);
      inFlight--;
    });

    expect(DOTFILE_SCAN_CONCURRENCY).toBeGreaterThanOrEqual(1);
    expect(DOTFILE_SCAN_CONCURRENCY).toBeLessThan(agents.length); // genuinely bounded, not "all at once"
    expect(maxInFlight).toBeLessThanOrEqual(DOTFILE_SCAN_CONCURRENCY);
  });
});
