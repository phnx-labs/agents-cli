import { describe, expect, it } from 'vitest';
import type { RotateCandidate } from '../lib/rotate.js';
import type { UsageSnapshot, UsageWindowKey } from '../lib/usage.js';
import { buildRunAccountChoices, formatAccountLimits } from './run-account-picker.js';

function snapshot(windows: Array<[UsageWindowKey, number]>, plan: string | null = null): UsageSnapshot {
  return {
    source: 'live',
    sourceLabel: 'live',
    capturedAt: null,
    plan,
    windows: windows.map(([key, usedPercent]) => ({
      key,
      label: key,
      shortLabel: key,
      usedPercent,
      resetsAt: null,
      windowMinutes: null,
    })),
  };
}

function candidate(overrides: Partial<RotateCandidate> = {}): RotateCandidate {
  return {
    agent: 'claude',
    version: '2.1.0',
    accountKey: 'claude:account=one',
    accountLabel: 'one@example.com',
    email: 'one@example.com',
    usageKey: 'claude:org=one',
    usageStatus: 'available',
    usageSnapshot: snapshot([['session', 25], ['week', 60], ['month', 90]]),
    usageError: null,
    plan: 'Max',
    signedIn: true,
    lastActive: null,
    ...overrides,
  };
}

describe('formatAccountLimits', () => {
  it('shows remaining session, weekly, and monthly capacity in human terms', () => {
    expect(formatAccountLimits(candidate())).toBe(
      'Session 75% left · Week 40% left · Month 10% left',
    );
  });

  it('states when signed-in usage data is unavailable instead of implying zero use', () => {
    expect(formatAccountLimits(candidate({ usageSnapshot: null, usageError: 'unavailable' })))
      .toBe('limits unavailable');
  });
});

describe('buildRunAccountChoices', () => {
  it('puts usable accounts first and shows identity, exact version, login, plan, and limits', () => {
    const choices = buildRunAccountChoices([
      candidate({
        version: '2.0.0',
        accountLabel: '',
        email: null,
        signedIn: false,
        usageSnapshot: null,
      }),
      candidate({ version: '2.1.0' }),
    ], '2.1.0');

    expect(choices[0].ready).toBe(true);
    expect(choices[0].name).toContain('one@example.com');
    expect(choices[0].name).toContain('2.1.0 (default)');
    expect(choices[0].name).toContain('logged in');
    expect(choices[0].name).toContain('Max');
    expect(choices[0].name).toContain('Session 75% left');
    expect(choices[1]).toMatchObject({ ready: false, disabled: 'logged out' });
    expect(choices[1].name).toContain('logged out');
  });

  it('disables exhausted accounts with the exact blocking windows', () => {
    const [choice] = buildRunAccountChoices([
      candidate({ usageSnapshot: snapshot([['session', 100], ['week', 100]]) }),
    ], null);
    expect(choice).toMatchObject({
      ready: false,
      disabled: 'Session and Week limits reached',
    });
    expect(choice.name).toContain('Session exhausted');
    expect(choice.name).toContain('Week exhausted');
  });

  it('keeps a signed-in account selectable when quota data is unavailable', () => {
    const [choice] = buildRunAccountChoices([
      candidate({ usageSnapshot: null, usageError: 'network unavailable' }),
    ], null);
    expect(choice.ready).toBe(true);
    expect(choice.disabled).toBeUndefined();
    expect(choice.name).toContain('limits unavailable');
  });

  it('does not disable a usable account solely because the Sonnet sub-limit is exhausted', () => {
    const [choice] = buildRunAccountChoices([
      candidate({ usageSnapshot: snapshot([['session', 20], ['week', 30], ['sonnet_week', 100]]) }),
    ], null);
    expect(choice.ready).toBe(true);
    expect(choice.name).toContain('Sonnet week exhausted');
  });

  it('uses a usage-reported plan when the credential has no plan claim', () => {
    const [choice] = buildRunAccountChoices([
      candidate({ plan: null, usageSnapshot: snapshot([['session', 10]], 'Team') }),
    ], null);
    expect(choice.name).toContain('Team');
  });
});
