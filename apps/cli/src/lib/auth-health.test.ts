import { describe, it, expect } from 'vitest';

import {
  authAccountLabel,
  authCacheKey,
  authCellColor,
  classifyHttpStatus,
  groupFleetAuthInstalls,
  mergeAuthHealthEntries,
  formatCheckedAge,
  probeAuthHealth,
  probeDetail,
  summarizeHostAuth,
  summarizeVerdicts,
  verdictColor,
  verdictFromProbe,
  verdictGlyph,
  verdictLabel,
  type AuthHealth,
  type AuthVerdict,
  type FleetAuthInstall,
} from './auth-health.js';
import type { AccountInfo } from './agent-spec/agents.js';

describe('classifyHttpStatus', () => {
  it('maps 2xx to live', () => {
    expect(classifyHttpStatus(200)).toBe('live');
    expect(classifyHttpStatus(204)).toBe('live');
  });
  it('maps 401/403 to revoked — the exact case the "signed in" flag misses', () => {
    expect(classifyHttpStatus(401)).toBe('revoked');
    expect(classifyHttpStatus(403)).toBe('revoked');
  });
  it('maps 429 to rate_limited (token good, throttled)', () => {
    expect(classifyHttpStatus(429)).toBe('rate_limited');
  });
  it('maps other statuses to error, not a false negative', () => {
    expect(classifyHttpStatus(500)).toBe('error');
    expect(classifyHttpStatus(404)).toBe('error');
  });
});

describe('verdictFromProbe', () => {
  it('missing credential -> unconfigured', () => {
    expect(verdictFromProbe({ status: null, token: 'missing' })).toBe('unconfigured');
  });
  it('locally expired -> expired (never revoked, since no refresh on read path)', () => {
    expect(verdictFromProbe({ status: null, token: 'expired' })).toBe('expired');
  });
  it('present token + network error -> error, so we keep the last known verdict', () => {
    expect(verdictFromProbe({ status: null, token: 'present', error: 'timeout' })).toBe('error');
  });
  it('present token + 401 -> revoked', () => {
    expect(verdictFromProbe({ status: 401, token: 'present' })).toBe('revoked');
  });
  it('present token + 200 -> live', () => {
    expect(verdictFromProbe({ status: 200, token: 'present' })).toBe('live');
  });
  it('setup-token usage-scope 403 -> unverified, never revoked (RUSH-2392)', () => {
    // Bare 403 is still revoked (unknown denial). The reason field is the
    // only signal that this is the known headless scope gap.
    expect(verdictFromProbe({ status: 403, token: 'present' })).toBe('revoked');
    expect(
      verdictFromProbe({
        status: 403,
        token: 'present',
        reason: 'usage_scope',
        error: 'usage unavailable (headless)',
      }),
    ).toBe('unverified');
  });
});

describe('probeDetail', () => {
  it('surfaces the HTTP status for non-2xx', () => {
    expect(probeDetail({ status: 401, token: 'present' })).toBe('HTTP 401');
  });
  it('surfaces the network error when there was no status', () => {
    expect(probeDetail({ status: null, token: 'present', error: 'ETIMEDOUT' })).toBe('ETIMEDOUT');
  });
  it('is undefined for a clean 200', () => {
    expect(probeDetail({ status: 200, token: 'present' })).toBeUndefined();
  });
  it('names the headless scope gap for usage_scope (RUSH-2392)', () => {
    expect(
      probeDetail({
        status: 403,
        token: 'present',
        reason: 'usage_scope',
        error: 'usage unavailable (headless)',
      }),
    ).toBe('usage unavailable (headless)');
  });
});

describe('verdictGlyph / verdictLabel', () => {
  const verdicts: AuthVerdict[] = ['live', 'revoked', 'expired', 'rate_limited', 'unverified', 'unconfigured', 'error'];
  it('returns a non-empty glyph and label for every verdict', () => {
    for (const v of verdicts) {
      expect(verdictGlyph(v).length).toBeGreaterThan(0);
      expect(verdictLabel(v).length).toBeGreaterThan(0);
    }
  });
  it('live and revoked read differently', () => {
    expect(verdictGlyph('live')).not.toBe(verdictGlyph('revoked'));
    expect(verdictLabel('live')).toBe('live');
    expect(verdictLabel('revoked')).toBe('revoked');
  });
});

describe('authAccountLabel', () => {
  it('prefers email, then accountId, then userId', () => {
    expect(authAccountLabel({ email: 'a@b.com', accountId: 'x', userId: 'y' })).toBe('a@b.com');
    expect(authAccountLabel({ email: null, accountId: 'x', userId: 'y' })).toBe('x');
    expect(authAccountLabel({ email: null, accountId: null, userId: 'y' })).toBe('y');
    expect(authAccountLabel({ email: null, accountId: null, userId: null })).toBeUndefined();
    expect(authAccountLabel(null)).toBeUndefined();
  });
});

describe('authCacheKey', () => {
  it('is one entry per install — host+agent+version (unique per token)', () => {
    expect(authCacheKey('zion', 'claude', '2.1.170')).toBe('zion:claude:2.1.170');
    expect(authCacheKey('yosemite-s0', 'kimi', 'default')).toBe('yosemite-s0:kimi:default');
  });
  it('distinguishes two installs of the same account on one host', () => {
    // gmail live in 2.1.207 but revoked in 2.1.186 — different keys, no collision
    expect(authCacheKey('yosemite-s1', 'claude', '2.1.207'))
      .not.toBe(authCacheKey('yosemite-s1', 'claude', '2.1.186'));
  });
});

describe('summarizeVerdicts', () => {
  it('counts live, present (unverified), bad (revoked), and warn (soft)', () => {
    expect(summarizeVerdicts(['live', 'live', 'live', 'live'])).toEqual({ live: 4, present: 0, bad: 0, warn: 0, total: 4 });
    // only revoked is "bad"; expired is soft -> warn; unverified is benign signed-in -> present
    expect(summarizeVerdicts(['live', 'revoked', 'expired', 'unverified'])).toEqual({ live: 1, present: 1, bad: 1, warn: 1, total: 4 });
    // unverified (codex/grok signed in, no probe) must NOT land in warn — it's `present`
    expect(summarizeVerdicts(['unverified', 'unverified'])).toEqual({ live: 0, present: 2, bad: 0, warn: 0, total: 2 });
    expect(summarizeVerdicts(['rate_limited', 'error'])).toEqual({ live: 0, present: 0, bad: 0, warn: 2, total: 2 });
    expect(summarizeVerdicts([])).toEqual({ live: 0, present: 0, bad: 0, warn: 0, total: 0 });
  });
});

describe('verdictColor', () => {
  it('reserves red for revoked; expired is soft yellow, never red', () => {
    // the exact regression: the ping verbose list painted `expired` red (lumped with revoked)
    expect(verdictColor('revoked')).toBe('red');
    expect(verdictColor('expired')).toBe('yellow');
    expect(verdictColor('rate_limited')).toBe('yellow');
    expect(verdictColor('error')).toBe('yellow');
  });
  it('unverified (signed in, no probe) is neutral gray, not an alarm', () => {
    expect(verdictColor('unverified')).toBe('gray');
    expect(verdictColor('live')).toBe('green');
    expect(verdictColor('unconfigured')).toBe('dim');
  });
});

describe('authCellColor', () => {
  const s = (o: Partial<ReturnType<typeof summarizeVerdicts>>) =>
    ({ live: 0, present: 0, bad: 0, warn: 0, total: 0, ...o });
  it('red only when a token is genuinely revoked', () => {
    expect(authCellColor(s({ bad: 1, total: 1 }))).toBe('red');
    // revoked wins even alongside live accounts
    expect(authCellColor(s({ live: 2, bad: 1, total: 3 }))).toBe('red');
  });
  it('expired-only cell is soft yellow, NOT red (kimi/droid self-refresh)', () => {
    expect(authCellColor(s({ warn: 1, total: 1 }))).toBe('yellow');
  });
  it('all-unverified cell (codex/grok signed in) is neutral gray, NOT yellow', () => {
    // this is the "cry wolf" fix: a fully-logged-in codex fleet must not read as degraded
    expect(authCellColor(s({ present: 1, total: 1 }))).toBe('gray');
  });
  it('all-live cell is green; empty cell is dim', () => {
    expect(authCellColor(s({ live: 3, total: 3 }))).toBe('green');
    expect(authCellColor(s({ total: 0 }))).toBe('dim');
  });
});

describe('mergeAuthHealthEntries', () => {
  it('a fresh error does NOT clobber a prior known verdict (keeps last known)', () => {
    const current = { 'zion:claude:2.1.170': { verdict: 'live' as const, checkedAt: 100 } };
    const incoming = { 'zion:claude:2.1.170': { verdict: 'error' as const, checkedAt: 200, detail: 'timeout' } };
    // the live entry survives the transient error
    expect(mergeAuthHealthEntries(current, incoming)['zion:claude:2.1.170']).toEqual({ verdict: 'live', checkedAt: 100 });
  });
  it('a real verdict (revoked/live) DOES overwrite', () => {
    const current = { k: { verdict: 'live' as const, checkedAt: 100 } };
    expect(mergeAuthHealthEntries(current, { k: { verdict: 'revoked' as const, checkedAt: 200 } }).k.verdict).toBe('revoked');
  });
  it('an error on a brand-new key is still recorded (nothing prior to keep)', () => {
    expect(mergeAuthHealthEntries({}, { k: { verdict: 'error' as const, checkedAt: 200 } }).k.verdict).toBe('error');
  });
});

describe('summarizeHostAuth', () => {
  const h = (verdict: AuthVerdict, checkedAt: number): AuthHealth => ({ verdict, checkedAt });
  const cache: Record<string, AuthHealth> = {
    'zion:claude:1.0.0': h('live', 5000),
    'zion:claude:1.1.0': h('live', 3000),
    'zion:codex:0.1.0': h('unverified', 7000),   // signed in, no probe → present
    'zion:opencode:0.1.0': h('revoked', 4000),   // server rejected → revoked
    'zion:kimi:0.1.0': h('expired', 6000),        // soft/self-healing → degraded
    'zion-2:claude:1.0.0': h('revoked', 1000),   // sibling host, must not bleed into 'zion'
    'yosemite-s1:claude:1.0.0': h('live', 9000),
  };

  it('splits present/degraded/revoked into distinct buckets and tracks oldest', () => {
    const r = summarizeHostAuth(cache, 'zion');
    // 5 zion rows — the 'zion-2' row (a `zion` substring) is excluded.
    expect(r).toEqual({
      live: 2,       // two claude
      present: 1,    // codex unverified — NOT counted as degraded
      degraded: 1,   // kimi expired (soft)
      revoked: 1,    // opencode revoked (the only real re-login)
      total: 5,
      oldestCheckedAt: 3000, // not zion-2's 1000
    });
  });

  it('matches on the host prefix, not a substring (no cross-host bleed)', () => {
    const r = summarizeHostAuth(cache, 'yosemite-s1');
    expect(r).toEqual({ live: 1, present: 0, degraded: 0, revoked: 0, total: 1, oldestCheckedAt: 9000 });
  });

  it('returns an empty summary for a host with no cached rows', () => {
    const r = summarizeHostAuth(cache, 'never-probed');
    expect(r).toEqual({ live: 0, present: 0, degraded: 0, revoked: 0, total: 0, oldestCheckedAt: null });
  });
});

describe('groupFleetAuthInstalls — probe once per account (RUSH-2111)', () => {
  const inst = (agent: string, version: string, account: string | undefined): FleetAuthInstall =>
    ({ agent: agent as FleetAuthInstall['agent'], version, account });

  it('collapses two homes on the SAME account into ONE probe group', () => {
    const groups = groupFleetAuthInstalls([
      inst('claude', '1.0.0', 'alice@example.com'),
      inst('claude', '1.1.0', 'alice@example.com'),
    ]);
    // The whole point: two version homes, one live probe.
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.version)).toEqual(['1.0.0', '1.1.0']);
    // The representative is the first-seen home; every member rides its verdict.
    expect(groups[0].probe.version).toBe('1.0.0');
  });

  it('keeps DIFFERENT accounts on the same agent as separate probes', () => {
    const groups = groupFleetAuthInstalls([
      inst('claude', '1.0.0', 'alice@example.com'),
      inst('claude', '1.1.0', 'bob@example.com'),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.members.length === 1)).toBe(true);
  });

  it('never merges the same account label across different agents', () => {
    const groups = groupFleetAuthInstalls([
      inst('claude', '1.0.0', 'shared@example.com'),
      inst('kimi', '2.0.0', 'shared@example.com'),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('never merges installs with no resolvable account — each is its own group', () => {
    const groups = groupFleetAuthInstalls([
      inst('claude', '1.0.0', undefined),
      inst('claude', '1.1.0', undefined),
    ]);
    // Can't prove they're the same account, so probe each (matches the old
    // per-install behaviour for the un-labelable / unconfigured case).
    expect(groups).toHaveLength(2);
  });

  it('deduplicates within an account while isolating the un-labelable ones', () => {
    const groups = groupFleetAuthInstalls([
      inst('claude', '1.0.0', 'alice@example.com'),
      inst('claude', '1.1.0', 'alice@example.com'),
      inst('claude', '1.2.0', undefined),
      inst('claude', '1.3.0', 'bob@example.com'),
    ]);
    // alice(1 group of 2) + bob(1) + un-labelable(1) = 3 probes for 4 homes.
    expect(groups).toHaveLength(3);
    const alice = groups.find((g) => g.probe.account === 'alice@example.com');
    expect(alice?.members.map((m) => m.version)).toEqual(['1.0.0', '1.1.0']);
  });

  it('returns no groups for no installs', () => {
    expect(groupFleetAuthInstalls([])).toEqual([]);
  });

  it('only merges installs the isMergeable predicate accepts', () => {
    // The real caller passes `LIVE_PROBE_AGENTS.has(agent)`: claude merges (it can
    // 429), cursor does not (a cheap local verdict with no rate limit — merging
    // could silently override one home's signedIn state with another's).
    const isLive = (i: FleetAuthInstall) => i.agent === 'claude';
    const groups = groupFleetAuthInstalls(
      [
        inst('claude', '1.0.0', 'alice@example.com'),
        inst('claude', '1.1.0', 'alice@example.com'),
        inst('cursor', '2.0.0', 'alice@example.com'),
        inst('cursor', '2.1.0', 'alice@example.com'),
      ],
      isLive,
    );
    // claude: 2 homes -> 1 group; cursor: 2 homes -> 2 groups (never merged).
    expect(groups).toHaveLength(3);
    const claude = groups.find((g) => g.probe.agent === 'claude');
    expect(claude?.members).toHaveLength(2);
    expect(groups.filter((g) => g.probe.agent === 'cursor').every((g) => g.members.length === 1)).toBe(true);
  });
});

describe('formatCheckedAge', () => {
  const now = 1_000_000_000_000;
  it('renders seconds/minutes/hours/days', () => {
    expect(formatCheckedAge(now - 5_000, now)).toBe('5s ago');
    expect(formatCheckedAge(now - 3 * 60_000, now)).toBe('3m ago');
    expect(formatCheckedAge(now - 2 * 3_600_000, now)).toBe('2h ago');
    expect(formatCheckedAge(now - 3 * 86_400_000, now)).toBe('3d ago');
  });
  it('never goes negative for a future timestamp', () => {
    expect(formatCheckedAge(now + 5_000, now)).toBe('0s ago');
  });
});

describe('probeAuthHealth — liveProbe gate (RUSH-2998)', () => {
  const signedIn = { signedIn: true } as AccountInfo;
  const signedOut = { signedIn: false } as AccountInfo;

  // The daemon fleet-cache warm on a usage SUBSCRIBER passes liveProbe:false so
  // only the usage-primary host hits /oauth/usage. Every other device probing it
  // every 3 minutes multiplied the fleet's request rate against one per-account
  // quota until the endpoint 429'd every account and the shared backoff froze the
  // usage cache. A subscriber must therefore take the local-verdict path even for
  // a network agent — no request, no re-armed throttle.
  it('claude with liveProbe:false takes the local verdict, never the network probe', async () => {
    const health = await probeAuthHealth('claude', undefined, { liveProbe: false, info: signedIn });
    expect(health.verdict).toBe('unverified'); // present but not live-confirmed — never a network 'live'
    expect(health.detail).toBeUndefined();
  });

  it('claude with liveProbe:false reports unconfigured when signed out', async () => {
    const health = await probeAuthHealth('claude', undefined, { liveProbe: false, info: signedOut });
    expect(health.verdict).toBe('unconfigured');
  });
});
