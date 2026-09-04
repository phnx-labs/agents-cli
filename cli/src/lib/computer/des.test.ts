import { describe, it, expect } from 'vitest';
import { desEncryptBlock } from './des.js';

describe('desEncryptBlock', () => {
  it('matches the canonical FIPS-46 DES test vector', () => {
    // The textbook DES worked example: key 133457799BBCDFF1,
    // plaintext 0123456789ABCDEF -> ciphertext 85E813540F0AB405.
    const key = Buffer.from('133457799BBCDFF1', 'hex');
    const pt = Buffer.from('0123456789ABCDEF', 'hex');
    const ct = desEncryptBlock(key, pt);
    expect(ct.toString('hex').toUpperCase()).toBe('85E813540F0AB405');
  });

  it('is deterministic and key-sensitive', () => {
    const pt = Buffer.alloc(8, 0x42);
    const a = desEncryptBlock(Buffer.alloc(8, 1), pt);
    const b = desEncryptBlock(Buffer.alloc(8, 1), pt);
    const c = desEncryptBlock(Buffer.alloc(8, 2), pt);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });

  it('rejects wrong-length inputs', () => {
    expect(() => desEncryptBlock(Buffer.alloc(7), Buffer.alloc(8))).toThrow(/key must be 8/);
    expect(() => desEncryptBlock(Buffer.alloc(8), Buffer.alloc(4))).toThrow(/block must be 8/);
  });
});
