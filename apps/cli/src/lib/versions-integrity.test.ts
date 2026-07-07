import { describe, expect, it } from 'vitest';
import { isMissingBinarySignature } from './versions.js';

/**
 * isMissingBinarySignature is the gate that decides whether a freshly-installed
 * agent's `--version` probe failure means "the runnable binary is missing"
 * (a gutted install we must reject) versus an ordinary nonzero exit we must
 * tolerate. Getting this wrong either lets a broken install become the default
 * (the ENOENT bug) or false-fails a healthy one.
 */
describe('isMissingBinarySignature (gutted-install detector)', () => {
  it('flags the real codex ENOENT crash (wrapper present, native binary missing)', () => {
    const blob =
      'Error: spawn /Users/x/.agents/.history/versions/codex/0.116.0/node_modules/' +
      '@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex ENOENT';
    expect(isMissingBinarySignature(blob)).toBe(true);
  });

  it('flags the other missing-file phrasings', () => {
    expect(isMissingBinarySignature('bash: codex: command not found')).toBe(true);
    expect(isMissingBinarySignature('dyld: no such file or directory')).toBe(true);
    expect(isMissingBinarySignature("'codex' is not recognized as an internal or external command")).toBe(true);
  });

  it('does NOT flag an agent that merely dislikes --version (ordinary nonzero exit)', () => {
    expect(isMissingBinarySignature('error: unknown option `--version`')).toBe(false);
    expect(isMissingBinarySignature('Usage: codex [options] <command>')).toBe(false);
    expect(isMissingBinarySignature('')).toBe(false);
  });

  it('does NOT match on unrelated text that merely contains a substring like "enoent"', () => {
    // Word-boundaried: only a standalone ENOENT token counts, not e.g. a hash.
    expect(isMissingBinarySignature('token: abcENOENTxyz')).toBe(false);
  });
});
