import { describe, expect, it } from 'bun:test';
import { displayIdentity, normalizeStatusEmail, type StatusIdentitySource } from './statusIdentity';

describe('normalizeStatusEmail', () => {
  it('strips angle brackets and whitespace, blanks empties', () => {
    expect(normalizeStatusEmail('<tech@prix.dev>')).toBe('tech@prix.dev');
    expect(normalizeStatusEmail('  tech@prix.dev ')).toBe('tech@prix.dev');
    expect(normalizeStatusEmail('')).toBeUndefined();
    expect(normalizeStatusEmail(null)).toBeUndefined();
    expect(normalizeStatusEmail(undefined)).toBeUndefined();
  });
});

// The exact defect: a Kimi tab rendered the version + account of a DIFFERENT
// session left over in the same terminal. displayIdentity returns fields only
// when they were resolved for the session id now displayed.
describe('displayIdentity — only the current session\'s identity', () => {
  const claude: StatusIdentitySource = {
    identityAppliedSessionId: 'sess-A',
    version: '2.1.218',
    account: 'tech@prix.dev',
  };

  it('shows version + account resolved FOR the shown session', () => {
    expect(displayIdentity(claude, 'sess-A')).toEqual({ version: '2.1.218', account: 'tech@prix.dev' });
  });

  it('withholds a prior session\'s identity when the shown session differs (the Kimi bug)', () => {
    // Terminal now shows Kimi session sess-K, but the entry still carries the
    // Claude identity resolved for sess-A. Nothing must leak.
    expect(displayIdentity(claude, 'sess-K')).toEqual({});
  });

  it('withholds identity before any session id is known', () => {
    expect(displayIdentity(claude, undefined)).toEqual({});
  });

  it('withholds identity that was never applied (no identityAppliedSessionId)', () => {
    const leftover: StatusIdentitySource = { version: '2.1.218' }; // e.g. a restore-match leftover
    expect(displayIdentity(leftover, 'sess-K')).toEqual({});
  });

  it('shows a version-only harness (Grok/Cursor/Droid: version, no account)', () => {
    const grok: StatusIdentitySource = { identityAppliedSessionId: 'sess-G', version: '1.4.0' };
    expect(displayIdentity(grok, 'sess-G')).toEqual({ version: '1.4.0', account: undefined });
  });

  it('shows blank for an identity-less harness (Kimi: no version, no account) once resolved', () => {
    const kimi: StatusIdentitySource = { identityAppliedSessionId: 'sess-K' };
    expect(displayIdentity(kimi, 'sess-K')).toEqual({ version: undefined, account: undefined });
  });

  it('prefers the live version over the display-only statusVersion', () => {
    const entry: StatusIdentitySource = { identityAppliedSessionId: 's', version: '2.1.218', statusVersion: '2.0.0' };
    expect(displayIdentity(entry, 's').version).toBe('2.1.218');
  });
});
