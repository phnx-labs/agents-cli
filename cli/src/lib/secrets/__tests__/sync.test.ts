import { describe, it, expect } from 'vitest';
import { encryptBlob, decryptBlob, MIN_PASSPHRASE_LEN } from '../sync.js';

describe('sync encrypt/decrypt', () => {
  it('round-trips arbitrary JSON under a passphrase', () => {
    const plaintext = JSON.stringify({
      bundle: { name: 'demo', vars: { K: 'keychain:K' } },
      secrets: { K: 'sk_live_super_secret_value' },
    });
    const env = encryptBlob(plaintext, 'correct-horse-battery');
    expect(env.v).toBe(1);
    expect(env.kdf).toBe('pbkdf2-sha256');
    // Ciphertext must not contain the plaintext or any of its substrings.
    expect(env.ct).not.toContain('sk_live');
    const decoded = decryptBlob(env, 'correct-horse-battery');
    expect(decoded).toBe(plaintext);
  });

  it('fails on wrong passphrase', () => {
    const env = encryptBlob('payload', 'right-passphrase');
    expect(() => decryptBlob(env, 'wrong-passphrase')).toThrow(/Decryption failed/);
  });

  it('rejects short passphrases', () => {
    const short = 'x'.repeat(MIN_PASSPHRASE_LEN - 1);
    expect(() => encryptBlob('payload', short)).toThrow(/at least 12 characters/);
  });

  it('rejects tampered ciphertext (auth tag mismatch)', () => {
    const env = encryptBlob('payload', 'correct-horse-battery');
    // Flip a byte in the ciphertext: base64-decode, mutate, re-encode.
    const ctBuf = Buffer.from(env.ct, 'base64');
    ctBuf[0] = ctBuf[0] ^ 0x01;
    const tampered = { ...env, ct: ctBuf.toString('base64') };
    expect(() => decryptBlob(tampered, 'correct-horse-battery')).toThrow(/Decryption failed/);
  });
});
