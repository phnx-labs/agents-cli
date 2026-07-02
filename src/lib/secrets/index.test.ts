/**
 * Tests for the platform-gated secret-value guard.
 *
 * The newline rejection exists ONLY to protect the macOS `get-batch` read path,
 * which is newline-delimited (see getKeychainTokens). Windows Credential Manager
 * (base64 blob) and the encrypted-file fallback store raw bytes and MUST accept
 * multiline values (PEM / SSH keys), so the guard is darwin-only.
 */

import { describe, it, expect } from 'vitest';
import { assertValueStorable } from './index.js';

describe('assertValueStorable', () => {
  const multiline = '-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----\n';

  it('rejects empty / whitespace-only values on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(() => assertValueStorable('', platform)).toThrow(/empty/i);
      expect(() => assertValueStorable('   ', platform)).toThrow(/empty/i);
    }
  });

  it('darwin still rejects embedded newlines (batch-read framing)', () => {
    expect(() => assertValueStorable(multiline, 'darwin')).toThrow(/newline/i);
    expect(() => assertValueStorable('a\rb', 'darwin')).toThrow(/newline/i);
  });

  it('darwin accepts single-line values', () => {
    expect(() => assertValueStorable('sk-single-line-token', 'darwin')).not.toThrow();
  });

  it('win32 accepts multiline values (CredMan / file store are newline-safe)', () => {
    expect(() => assertValueStorable(multiline, 'win32')).not.toThrow();
  });

  it('linux accepts multiline values (secret-tool / file store are newline-safe)', () => {
    expect(() => assertValueStorable(multiline, 'linux')).not.toThrow();
  });
});
