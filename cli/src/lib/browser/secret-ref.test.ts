import { describe, it, expect } from 'vitest';
import { parseSecretRef } from './secret-ref.js';

describe('parseSecretRef', () => {
  it('parses <bundle>/<KEY>', () => {
    expect(parseSecretRef('logins/GITHUB_PASSWORD')).toEqual({ bundle: 'logins', key: 'GITHUB_PASSWORD' });
  });

  it('accepts an optional secret: prefix', () => {
    expect(parseSecretRef('secret:logins/GITHUB_PASSWORD')).toEqual({ bundle: 'logins', key: 'GITHUB_PASSWORD' });
  });

  it('keeps slashes inside the key (only the first slash splits)', () => {
    expect(parseSecretRef('b/a/b/c')).toEqual({ bundle: 'b', key: 'a/b/c' });
  });

  it('rejects malformed refs', () => {
    expect(parseSecretRef('nokey')).toBeNull();
    expect(parseSecretRef('/leadingslash')).toBeNull();
    expect(parseSecretRef('trailing/')).toBeNull();
    expect(parseSecretRef('')).toBeNull();
    expect(parseSecretRef('secret:')).toBeNull();
  });
});
