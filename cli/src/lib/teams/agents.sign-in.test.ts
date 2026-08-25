import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkCliSignedIn, resolveSignInAdvisory } from './agents.js';

// The advisory sign-in status shown by `teams doctor`. The load-bearing rule:
// a RUNNING teammate is live proof the agent works, so it overrides a
// (frequently false-negative) sign-in probe — doctor must never report a
// working agent as logged out.
describe('resolveSignInAdvisory', () => {
  it('running overrides a negative probe (never show a working agent as logged out)', () => {
    expect(resolveSignInAdvisory(true, true, false)).toEqual({ signedIn: true, running: true });
  });

  it('installed + probe positive → signed in', () => {
    expect(resolveSignInAdvisory(true, false, true)).toEqual({ signedIn: true, running: false });
  });

  it('installed + probe negative + not running → unverified (false, not null)', () => {
    expect(resolveSignInAdvisory(true, false, false)).toEqual({ signedIn: false, running: false });
  });

  it('not installed → signedIn null and running forced false regardless of inputs', () => {
    expect(resolveSignInAdvisory(false, true, true)).toEqual({ signedIn: null, running: false });
  });
});

// checkCliSignedIn is advisory and must NEVER throw — a probe failure returns
// false so callers warn-and-proceed instead of crashing the team.
describe('checkCliSignedIn', () => {
  let tmpHome: string;
  let realHome: string;
  let origHome: string | undefined;
  let origRealHome: string | undefined;
  let origKeychain: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    origRealHome = process.env.AGENTS_REAL_HOME;
    origKeychain = process.env.AGENTS_NO_KEYCHAIN_PROBE;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-home-'));
    realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-real-'));
    // Sign-in is account-global: getAccountInfo falls back from the base home to
    // the active config under AGENTS_REAL_HOME. Pin both to empty dirs so the
    // "signed out" assertion doesn't leak into the developer's real login.
    process.env.HOME = tmpHome;
    process.env.AGENTS_REAL_HOME = realHome;
    process.env.AGENTS_NO_KEYCHAIN_PROBE = '1';
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origRealHome === undefined) delete process.env.AGENTS_REAL_HOME; else process.env.AGENTS_REAL_HOME = origRealHome;
    if (origKeychain === undefined) delete process.env.AGENTS_NO_KEYCHAIN_PROBE; else process.env.AGENTS_NO_KEYCHAIN_PROBE = origKeychain;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(realHome, { recursive: true, force: true });
  });

  it('returns false for a logged-out home without throwing', async () => {
    await expect(checkCliSignedIn('claude' as never)).resolves.toBe(false);
  });

  it('returns a boolean (never throws) for an odd agent type', async () => {
    await expect(checkCliSignedIn('not-a-real-agent' as never)).resolves.toBe(false);
  });
});
