/**
 * Account attribution over a real on-disk version layout.
 *
 * Every fixture is a real directory tree with real `.claude.json` files — no mocking,
 * per the repo rule. The first test is the regression guard for the bug this module
 * exists to fix: one process-global email stamped onto every Claude session.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-accounts-test-'));
process.env.HOME = TEST_HOME;
process.env.AGENTS_DIR = path.join(TEST_HOME, '.agents');

// Imported after HOME is redirected: the module captures os.homedir() at load.
const { buildClaudeAccountIndex, resolveClaudeAccount } =
  await import('./claude-accounts.js');

/** Two orgs deliberately share an email — the trap this module must not fall into. */
const MODSQUAD = { org: 'org-modsquad', email: 'dev@modsquad.example', name: 'ModSquad', type: 'claude_team' };
const TURING_TEAM = { org: 'org-turing-team', email: 'dev@turing.example', name: 'Turing Labs', type: 'claude_team' };
const TURING_MAX = { org: 'org-turing-personal', email: 'dev@turing.example', name: "dev's Organization", type: 'claude_max' };

interface Acct { org: string; email: string; name: string; type: string }

function historyDir(): string {
  return path.join(TEST_HOME, '.agents', '.history');
}

function writeHome(home: string, acct: Acct | null): void {
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  const config = acct
    ? {
      oauthAccount: {
        accountUuid: `acct-${acct.email}`,
        emailAddress: acct.email,
        organizationUuid: acct.org,
        organizationName: acct.name,
        organizationType: acct.type,
      },
    }
    // Signed out: a config with no oauthAccount at all.
    : { numStartups: 3 };
  fs.writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify(config));
}

function versionHome(version: string): string {
  return path.join(historyDir(), 'versions', 'claude', version, 'home');
}

function trashHome(version: string, stamp: string): string {
  return path.join(historyDir(), 'trash', 'versions', 'claude', version, stamp, 'home');
}

/** A transcript path inside a home's config dir. */
function transcript(home: string, name: string): string {
  return path.join(home, '.claude', 'projects', '-some-project', `${name}.jsonl`);
}

beforeAll(() => {
  writeHome(versionHome('2.1.219'), MODSQUAD);
  writeHome(versionHome('2.1.220'), TURING_TEAM);
  writeHome(versionHome('2.1.218'), TURING_MAX);
  writeHome(versionHome('2.1.170'), null);            // signed out
  writeHome(trashHome('2.1.183', '2026-07-01T00-00-00Z'), TURING_TEAM);  // retired, still identifiable
  writeHome(trashHome('2.1.200', '2026-07-21T00-00-00Z'), MODSQUAD);
  // One version with two retired snapshots that disagree — must not be guessed.
  writeHome(trashHome('2.1.215', '2026-07-01T00-00-00Z'), MODSQUAD);
  writeHome(trashHome('2.1.215', '2026-07-27T00-00-00Z'), TURING_TEAM);

  // The live symlink, pointing at the ModSquad home like the real layout does.
  fs.symlinkSync(path.join(versionHome('2.1.219'), '.claude'), path.join(TEST_HOME, '.claude'));
});

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('buildClaudeAccountIndex', () => {
  it('keys on the org, so two orgs sharing one email stay distinct', () => {
    const index = buildClaudeAccountIndex();
    const team = resolveClaudeAccount(index, transcript(versionHome('2.1.220'), 'a'));
    const max = resolveClaudeAccount(index, transcript(versionHome('2.1.218'), 'b'));

    expect(team.email).toBe(max.email);          // same email…
    expect(team.key).not.toBe(max.key);          // …different quota bucket
    expect(team.key).toContain('org-turing-team');
    expect(max.key).toContain('org-turing-personal');
    expect(team.plan).toBe('Team');
    expect(max.plan).toBe('Max');
  });

  it('discovers retired trash homes, which keep their config', () => {
    const index = buildClaudeAccountIndex();
    const bucket = resolveClaudeAccount(
      index,
      transcript(trashHome('2.1.183', '2026-07-01T00-00-00Z'), 'c'),
    );
    expect(bucket.attributed).toBe(true);
    expect(bucket.orgName).toBe('Turing Labs');
    expect(bucket.evidence).toBe('version-home');
  });
});

describe('resolveClaudeAccount', () => {
  it('attributes each version home to its own account, not one global email', () => {
    // The regression guard. Before this module the scanner resolved a single email
    // and stamped it on every Claude session, so all three of these came back equal.
    const index = buildClaudeAccountIndex();
    const buckets = ['2.1.219', '2.1.220', '2.1.218'].map((v) =>
      resolveClaudeAccount(index, transcript(versionHome(v), 'x')),
    );
    expect(new Set(buckets.map((b) => b.key)).size).toBe(3);
    expect(buckets.map((b) => b.orgName)).toEqual(['ModSquad', 'Turing Labs', "dev's Organization"]);
  });

  it('uses the recorded version for rows under the mutable ~/.claude symlink', () => {
    const index = buildClaudeAccountIndex();
    const underSymlink = path.join(TEST_HOME, '.claude', 'projects', '-p', 'y.jsonl');

    // The symlink points at 2.1.219 (ModSquad), but this row was written by 2.1.220.
    const byVersion = resolveClaudeAccount(index, underSymlink, '2.1.220');
    expect(byVersion.orgName).toBe('Turing Labs');
    expect(byVersion.evidence).toBe('recorded-version');

    // A retired-only version still resolves, from its trash snapshot.
    expect(resolveClaudeAccount(index, underSymlink, '2.1.200').orgName).toBe('ModSquad');

    // With no recorded version the current target is the only evidence available,
    // and the weaker tier is reported as such.
    const fallback = resolveClaudeAccount(index, underSymlink, null);
    expect(fallback.orgName).toBe('ModSquad');
    expect(fallback.evidence).toBe('symlink-target');
  });

  it('reports a signed-out home as dark rather than guessing', () => {
    const index = buildClaudeAccountIndex();
    const bucket = resolveClaudeAccount(index, transcript(versionHome('2.1.170'), 'z'));
    expect(bucket.attributed).toBe(false);
    expect(bucket.key).toBe('unattributed:signed-out home 2.1.170');
  });

  it('refuses to pick between disagreeing snapshots of one version', () => {
    const index = buildClaudeAccountIndex();
    const underSymlink = path.join(TEST_HOME, '.claude', 'projects', '-p', 'w.jsonl');
    const bucket = resolveClaudeAccount(index, underSymlink, '2.1.215');
    expect(bucket.attributed).toBe(false);
    expect(bucket.key).toContain('ambiguous');
  });

  it('keeps distinct dark reasons in distinct buckets', () => {
    const index = buildClaudeAccountIndex();
    const backup = resolveClaudeAccount(
      index,
      path.join(historyDir(), 'backups', 'claude', '2026-07-01', 'projects', '-p', 'v.jsonl'),
    );
    const unknown = resolveClaudeAccount(index, '');
    const signedOut = resolveClaudeAccount(index, transcript(versionHome('2.1.170'), 'z'));

    expect(backup.key).toBe('unattributed:backup mirror');
    expect(unknown.key).toBe('unattributed:unknown home');
    expect(new Set([backup.key, unknown.key, signedOut.key]).size).toBe(3);
  });

  it('never returns null, so no transcript is silently dropped', () => {
    const index = buildClaudeAccountIndex();
    for (const p of ['', '/nowhere/at/all.jsonl', 'relative.jsonl']) {
      const bucket = resolveClaudeAccount(index, p);
      expect(bucket.key).toBeTruthy();
      expect(bucket.attributed).toBe(false);
    }
  });
});
