import { describe, it, expect } from 'vitest';
import {
  buildAccountPool,
  pickFromPool,
  eligibleAccounts,
  injectionFor,
  type PoolInputs,
} from './account-pool.js';

function inputs(over: Partial<PoolInputs> = {}): PoolInputs {
  return { native: [], registry: [], ...over };
}

describe('buildAccountPool', () => {
  it('unions native logins and registry accounts, tagging kind + source', () => {
    const pool = buildAccountPool('claude', inputs({
      native: [{ accountKey: 'claude:org=a', email: 'a@x.com', version: '2.1.220' }],
      registry: [{ accountKey: 'claude:org=b', email: 'b@x.com', name: 'claude-b', provider: 'anthropic', auth: 'setup-token' }],
    }));
    expect(pool.map((p) => [p.accountKey, p.kind, p.source])).toEqual([
      ['claude:org=a', 'oauth', 'native-login'],
      ['claude:org=b', 'setup-token', 'registry'],
    ]);
    expect(pool[0].version).toBe('2.1.220');
    expect(pool[1].secretRef).toBe('claude-b');
    expect(pool[1].provider).toBe('anthropic');
  });

  it('dedups by accountKey with the native login winning the tie', () => {
    const pool = buildAccountPool('claude', inputs({
      native: [{ accountKey: 'claude:org=a', email: 'a@x.com', version: '2.1.220' }],
      registry: [{ accountKey: 'claude:org=a', email: 'a@x.com', name: 'claude-a', provider: 'anthropic', auth: 'setup-token' }],
    }));
    expect(pool).toHaveLength(1);
    expect(pool[0].source).toBe('native-login');
    expect(pool[0].version).toBe('2.1.220');
  });

  it('keeps (agent, account) distinct — same email under a different agent is a different member', () => {
    // Identity keys are agent-scoped upstream (buildIdentityKey → `${agent}:…`),
    // so the same email produces different accountKeys per harness.
    const claudePool = buildAccountPool('claude', inputs({
      registry: [{ accountKey: 'claude:org=gmail', email: 'gmail@x.com', name: 'c', provider: 'anthropic', auth: 'setup-token' }],
    }));
    const codexPool = buildAccountPool('codex', inputs({
      registry: [{ accountKey: 'codex:org=gmail', email: 'gmail@x.com', name: 'x', provider: 'openai', auth: 'api-key' }],
    }));
    expect(claudePool[0].accountKey).not.toBe(codexPool[0].accountKey);
    expect(claudePool[0].agent).toBe('claude');
    expect(codexPool[0].agent).toBe('codex');
  });
});

describe('eligibleAccounts / pickFromPool', () => {
  const pool = buildAccountPool('claude', inputs({
    registry: [
      { accountKey: 'claude:org=fresh', email: 'fresh@x.com', name: 'fresh', provider: 'anthropic', auth: 'setup-token', usedPercent: 10 },
      { accountKey: 'claude:org=busy', email: 'busy@x.com', name: 'busy', provider: 'anthropic', auth: 'setup-token', usedPercent: 90 },
      { accountKey: 'claude:org=dead', email: 'dead@x.com', name: 'dead', provider: 'anthropic', auth: 'setup-token', rateLimited: true },
    ],
  }));

  it('excludes rate-limited accounts from eligibility', () => {
    expect(eligibleAccounts(pool).map((a) => a.accountKey)).toEqual(['claude:org=fresh', 'claude:org=busy']);
  });

  it('balanced weights by remaining capacity — low roll picks the fresh account', () => {
    // weights: fresh=90, busy=10, total=100. roll = 0 → fresh.
    const pick = pickFromPool(pool, 'balanced', { rng: () => 0 });
    expect(pick?.accountKey).toBe('claude:org=fresh');
  });

  it('balanced can still land on the busy account on a high roll (floor keeps it reachable)', () => {
    // roll = 0.95*100 = 95 → 95-90=5 >0 → 5-10=-5 → busy.
    const pick = pickFromPool(pool, 'balanced', { rng: () => 0.95 });
    expect(pick?.accountKey).toBe('claude:org=busy');
  });

  it('never picks the rate-limited account, at any roll', () => {
    for (const r of [0, 0.5, 0.999]) {
      expect(pickFromPool(pool, 'balanced', { rng: () => r })?.accountKey).not.toBe('claude:org=dead');
    }
  });

  it('available picks the account with the most headroom', () => {
    expect(pickFromPool(pool, 'available')?.accountKey).toBe('claude:org=fresh');
  });

  it('pinned selects by accountKey or email, only when eligible', () => {
    expect(pickFromPool(pool, 'pinned', { preferred: 'busy@x.com' })?.accountKey).toBe('claude:org=busy');
    expect(pickFromPool(pool, 'pinned', { preferred: 'claude:org=fresh' })?.accountKey).toBe('claude:org=fresh');
    // a pinned but rate-limited account is not launchable
    expect(pickFromPool(pool, 'pinned', { preferred: 'dead@x.com' })).toBeNull();
  });

  it('returns null when nothing is eligible (caller fails loud)', () => {
    const allDead = buildAccountPool('claude', inputs({
      registry: [{ accountKey: 'claude:org=x', email: null, name: 'x', provider: 'anthropic', auth: 'setup-token', rateLimited: true }],
    }));
    expect(pickFromPool(allDead, 'balanced')).toBeNull();
    expect(pickFromPool([], 'balanced')).toBeNull();
  });
});

describe('injectionFor', () => {
  it('a native login runs in its own version home', () => {
    const [native] = buildAccountPool('claude', inputs({
      native: [{ accountKey: 'claude:org=a', email: 'a@x.com', version: '2.1.220' }],
    }));
    expect(injectionFor(native)).toEqual({ nativeHome: '2.1.220' });
  });

  it('a Claude setup-token injects CLAUDE_CODE_OAUTH_TOKEN, not ANTHROPIC_API_KEY', () => {
    const [acct] = buildAccountPool('claude', inputs({
      registry: [{ accountKey: 'claude:org=b', email: 'b@x.com', name: 'claude-b', provider: 'anthropic', auth: 'setup-token' }],
    }));
    expect(injectionFor(acct)).toEqual({ envVar: 'CLAUDE_CODE_OAUTH_TOKEN', secretRef: 'claude-b' });
  });

  it('an API-key account uses the provider envFor mapping', () => {
    const [acct] = buildAccountPool('codex', inputs({
      registry: [{ accountKey: 'codex:org=o', email: null, name: 'openai-key', provider: 'openai', auth: 'api-key' }],
    }));
    expect(injectionFor(acct)).toEqual({ envVar: 'OPENAI_API_KEY', secretRef: 'openai-key' });
  });

  it('throws (fails loud) when a provider cannot authenticate the harness', () => {
    // cursor provider has no mapping for the claude harness
    const [acct] = buildAccountPool('claude', inputs({
      registry: [{ accountKey: 'claude:org=c', email: null, name: 'cursor-key', provider: 'cursor', auth: 'api-key' }],
    }));
    expect(() => injectionFor(acct)).toThrow(/cannot authenticate the claude/);
  });
});
