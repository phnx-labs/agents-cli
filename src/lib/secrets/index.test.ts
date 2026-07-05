/**
 * Tests for the platform-gated secret-value guard.
 *
 * The newline rejection exists ONLY to protect the macOS `get-batch` read path,
 * which is newline-delimited (see getKeychainTokens). Windows Credential Manager
 * (base64 blob) and the encrypted-file fallback store raw bytes and MUST accept
 * multiline values (PEM / SSH keys), so the guard is darwin-only.
 */

import { describe, it, expect } from 'vitest';
import { assertValueStorable, parseOrphanMigrationOutput } from './index.js';

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

describe('parseOrphanMigrationOutput', () => {
  it('parses OK / WARN / FAIL records and ignores blanks + unknown lines', () => {
    const out = [
      'OK agents-cli.secrets.hetzner.com.HCLOUD_TOKEN',
      '',
      'WARN agents-cli.secrets.ssh-keys.ED25519_PRIVKEY_B64 orphan-delete=-25300 (pinned copy in place)',
      'FAIL agents-cli.secrets.attio.com.EMAIL add=-34018',
      '   ', // whitespace-only
      'garbage line with no tag',
    ].join('\n');
    const results = parseOrphanMigrationOutput(out);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ item: 'agents-cli.secrets.hetzner.com.HCLOUD_TOKEN', status: 'ok' });
    // WARN/FAIL keep only the service in `item`, full text in `detail`.
    expect(results[1].item).toBe('agents-cli.secrets.ssh-keys.ED25519_PRIVKEY_B64');
    expect(results[1].status).toBe('warn');
    expect(results[1].detail).toContain('orphan-delete=-25300');
    expect(results[2]).toMatchObject({ item: 'agents-cli.secrets.attio.com.EMAIL', status: 'fail' });
    expect(results[2].detail).toContain('add=-34018');
  });

  it('returns [] for empty output', () => {
    expect(parseOrphanMigrationOutput('')).toEqual([]);
    expect(parseOrphanMigrationOutput('\n\n')).toEqual([]);
  });
});
