/**
 * Real paths only — the session file round-trip against a hermetic
 * AGENTS_STATE_DIR, the pure resolve* helpers against fixture data, and (when
 * this box has a live `~/.rush/user.yaml` — it does in dev, per the CLAUDE.md
 * memory of this session; CI boxes generally don't) one real GET against
 * api.prix.dev for each read-only endpoint. No network mocking: a live call
 * either gets a real response or the test skips with a stated reason.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  clearPrixSession,
  fetchWhoAmI,
  getPrixSessionFile,
  listSpaces,
  PrixApiError,
  readPrixSession,
  resolveMemberFromList,
  resolvePrixToken,
  resolveSpaceFromList,
  slugify,
  writePrixSession,
  type SpaceMember,
  type SpaceSummary,
} from './prix-account.js';

describe('slugify', () => {
  it('lowercases, hyphenates, and strips punctuation', () => {
    expect(slugify('Acme Team!')).toBe('acme-team');
    expect(slugify('  agi-cli  ')).toBe('agi-cli');
    expect(slugify('a_b/c')).toBe('a-b-c');
  });

  it('never returns an empty slug', () => {
    expect(slugify('!!!')).toBe('space');
  });
});

const space = (over: Partial<SpaceSummary> = {}): SpaceSummary => ({
  id: 'id-1', slug: 'prix', name: 'Prix', organization_id: null,
  owner_user_id: 'u1', user_role: 'owner', created_at: '2026-01-01T00:00:00Z', ...over,
});

describe('resolveSpaceFromList', () => {
  it('matches an explicit id or slug', () => {
    const spaces = [space(), space({ id: 'id-2', slug: 'other', name: 'Other' })];
    expect(resolveSpaceFromList(spaces, 'other').id).toBe('id-2');
    expect(resolveSpaceFromList(spaces, 'id-1').id).toBe('id-1');
  });

  it('throws a named-list error for an unknown explicit target', () => {
    expect(() => resolveSpaceFromList([space()], 'nope')).toThrow(/No space matching 'nope'/);
  });

  it('defaults to the sole space when none is passed', () => {
    expect(resolveSpaceFromList([space()], undefined).id).toBe('id-1');
  });

  it('refuses to guess with zero spaces', () => {
    expect(() => resolveSpaceFromList([], undefined)).toThrow(/You have no spaces/);
  });

  it('refuses to guess with more than one space, and lists the slugs', () => {
    const spaces = [space(), space({ id: 'id-2', slug: 'other', name: 'Other' })];
    expect(() => resolveSpaceFromList(spaces, undefined)).toThrow(/prix, other/);
  });
});

const member = (over: Partial<SpaceMember> = {}): SpaceMember => ({
  user_id: 'u1', email: 'dev@example.com', role: 'member', joined_at: '2026-01-01T00:00:00Z', ...over,
});

describe('resolveMemberFromList', () => {
  it('matches case-insensitively', () => {
    expect(resolveMemberFromList([member()], 'DEV@example.com').user_id).toBe('u1');
  });

  it('throws a named error for a non-member', () => {
    expect(() => resolveMemberFromList([member()], 'ghost@example.com')).toThrow(/not a member/);
  });
});

describe('prix session store', () => {
  const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-prix-account-test-'));
  let savedStateDir: string | undefined;

  beforeEach(() => {
    savedStateDir = process.env.AGENTS_STATE_DIR;
    process.env.AGENTS_STATE_DIR = path.join(TEST_HOME, '.agents', '.cache', 'state');
  });

  afterEach(() => {
    if (savedStateDir === undefined) delete process.env.AGENTS_STATE_DIR;
    else process.env.AGENTS_STATE_DIR = savedStateDir;
  });

  it('round-trips a session through write/read/clear', () => {
    expect(readPrixSession()).toBeNull();
    writePrixSession({ access_token: 'tok', email: 'dev@example.com', userId: 'u1' });
    const read = readPrixSession();
    expect(read?.access_token).toBe('tok');
    expect(read?.email).toBe('dev@example.com');
    expect(clearPrixSession()).toBe(true);
    expect(readPrixSession()).toBeNull();
    expect(clearPrixSession()).toBe(false);
  });

  it('writes the session file with 0600 permissions (no group/world read)', () => {
    writePrixSession({ access_token: 'tok' });
    const mode = fs.statSync(getPrixSessionFile()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('resolvePrixToken prefers the agents-owned session over rush fallback', () => {
    writePrixSession({ access_token: 'agents-tok' });
    const resolved = resolvePrixToken();
    expect(resolved?.source).toBe('agents');
    expect(resolved?.token).toBe('agents-tok');
  });
});

// --- live read-only endpoint probes -----------------------------------------
// `agents auth whoami` / `agents org list` share this exact client path.
// Skip cleanly (never fail the suite) when this box has no readable Rush
// session — the same env-gated-skip convention as ssh.e2e.test.ts.
const hasRushSession = fs.existsSync(path.join(os.homedir(), '.rush', 'user.yaml'));
const describeLive = hasRushSession ? describe : describe.skip;

describeLive('live api.prix.dev read-only endpoints', () => {
  it('GET /api/v1/auth/me returns a real shape or a real 401 — never throws unexpectedly', async () => {
    const resolved = resolvePrixToken();
    if (!resolved) return; // ~/.rush/user.yaml present but unreadable/empty — nothing to probe
    try {
      const who = await fetchWhoAmI(resolved.token);
      expect(who.valid).toBe(true);
      expect(who.email).toContain('@');
      expect(typeof who.userId).toBe('string');
    } catch (err) {
      // A stale/expired on-disk token is a real, expected outcome on a dev box —
      // assert it surfaces as our typed error, not a crash.
      expect(err).toBeInstanceOf(PrixApiError);
      expect((err as PrixApiError).status).toBe(401);
    }
  });

  it('GET /api/v1/spaces returns an array shaped like SpaceSummary, or a real 401', async () => {
    const resolved = resolvePrixToken();
    if (!resolved) return;
    try {
      const spaces = await listSpaces();
      expect(Array.isArray(spaces)).toBe(true);
      for (const s of spaces) {
        expect(typeof s.id).toBe('string');
        expect(typeof s.slug).toBe('string');
        expect(['owner', 'admin', 'member']).toContain(s.user_role);
      }
    } catch (err) {
      expect(err).toBeInstanceOf(PrixApiError);
      expect((err as PrixApiError).status).toBe(401);
    }
  });
});
