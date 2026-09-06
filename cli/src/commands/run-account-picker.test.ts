import { afterEach, describe, expect, it, vi } from 'vitest';
import { foldRunAccountRows, type RotateCandidate, type RunAccountRow } from '../lib/accounting/rotate.js';
import type { UsageSnapshot, UsageWindowKey } from '../lib/accounting/usage.js';
import { buildRunAccountChoices, buildSwitchAccountChoices, formatAccountLimits, noVerifiedUsageDecision, pickSignInLaunchVersion, pickerHeaderLines, rowState, signInLaunchDecision } from './run-account-picker.js';

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
  const version = overrides.version ?? '2.1.0';
  return {
    agent: 'claude',
    version,
    releaseVersion: version,
    updatePolicy: 'latest',
    identityKey: 'claude:account=one',
    identityEmail: 'one@example.com',
    accountName: null,
    accountId: null,
    organizationName: null,
    accountKey: 'claude:account=one',
    accountLabel: 'one@example.com',
    email: 'one@example.com',
    usageKey: 'claude:org=one',
    usageStatus: 'available',
    usageSnapshot: snapshot([['session', 25], ['week', 60], ['month', 90]]),
    usageError: null,
    usageMinutesToLimit: null,
    plan: 'Max',
    signedIn: true,
    authVerdict: null,
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

/** Rows the picker renders: the real fold over candidates, default home `2.1.0`. */
function rows(candidates: RotateCandidate[], over: { latestRelease?: string; globalDefault?: string | null; defaultIdentity?: string | null } = {}): RunAccountRow[] {
  return foldRunAccountRows(candidates, {
    latestRelease: over.latestRelease ?? '2.1.0',
    globalDefault: over.globalDefault === undefined ? '2.1.0' : over.globalDefault,
    defaultIdentity: over.defaultIdentity,
  });
}

/** A second, unnamed identity so two candidates make two rows. */
function other(overrides: Partial<RotateCandidate> = {}): RotateCandidate {
  return candidate({
    identityKey: 'claude:account=two', accountKey: 'claude:account=two', usageKey: 'claude:org=two',
    email: 'two@example.com', identityEmail: 'two@example.com', accountLabel: 'two@example.com',
    ...overrides,
  });
}

describe('buildRunAccountChoices (rows are ACCOUNTS, PHNX-3940 S1)', () => {
  it('shows `name · email`, plan, headroom, and the state word — and no version on any row', () => {
    const [choice] = buildRunAccountChoices(rows([
      candidate({ version: '2.1.221', releaseVersion: '2.1.263', accountName: 'work', accountId: 'id-work' }),
    ], { latestRelease: '2.1.263', globalDefault: '2.1.221' }));
    expect(choice.ready).toBe(true);
    expect(choice.name).toContain('work · one@example.com');
    expect(choice.name).toContain('Max');
    expect(choice.name).toContain('Session 75% left');
    expect(choice.name).toContain('default');
    // The label AND the release stay off the row: the release is the header's.
    expect(choice.name).not.toContain('2.1.221');
    expect(choice.name).not.toContain('2.1.263');
    // The value is the ACCOUNT selector, resolved by the same path `claude#work` takes.
    expect(choice.value).toBe('work');
  });

  it('an unnamed account is shown and selected by its email', () => {
    const [choice] = buildRunAccountChoices(rows([candidate()]));
    expect(choice.name).toContain('one@example.com');
    expect(choice.value).toBe('claude:account=one');
  });

  it('puts usable accounts first, then the sign-in row, and marks each state in the audit vocabulary', () => {
    const choices = buildRunAccountChoices(rows([
      candidate({ version: '2.0.0', identityKey: null, identityEmail: null, accountKey: null, accountLabel: '', email: null, signedIn: false, usageSnapshot: null }),
      candidate({ version: '2.1.0', usageSnapshot: snapshot([['session', 25]]), }),
    ]));
    expect(choices[0].ready).toBe(true);
    expect(choices[0].name).toContain('one@example.com');
    // A signed-in account whose usage number is not fresh reads `unverified`, not `logged in`.
    expect(choices[0].name).toContain('unverified');
    expect(choices[1]).toMatchObject({ ready: false, signInRequired: true, value: '2.0.0' });
    expect(choices[1].disabled).toBeUndefined();
    expect(choices[1].name).toContain('sign in to a new account');
    expect(choices[1].name).toContain('logged out');
    expect(choices[1].name).toContain('launch to sign in');
  });

  it('a fresh usage snapshot reads `live`', () => {
    const fresh = snapshot([['session', 25]]);
    fresh.capturedAt = new Date();
    expect(rowState(rows([candidate({ usageSnapshot: fresh })])[0])).toEqual({ state: 'live', fix: null });
  });

  it('tags a pinned home behind the latest release as `pinned <release>` (S2/J5)', () => {
    const [choice] = buildRunAccountChoices(rows([
      candidate({ version: '2.1.207', releaseVersion: '2.1.207', updatePolicy: 'pinned' }),
    ], { latestRelease: '2.1.263', globalDefault: null }));
    expect(choice.name).toContain('pinned 2.1.207');
  });

  it('keeps a logged-out named account SELECTABLE under its name so the launch can carry you into the login (RUSH-2334, J9)', () => {
    const [choice] = buildRunAccountChoices(rows([
      candidate({ signedIn: false, usageSnapshot: null, accountKey: null, email: null, accountName: 'prix', accountId: 'id-prix' }),
    ]));
    // Disabling this row is what left a fully logged-out harness unreachable.
    expect(choice.disabled).toBeUndefined();
    expect(choice).toMatchObject({ ready: false, signInRequired: true, value: 'prix' });
    expect(choice.name).toContain('prix · one@example.com');
    expect(choice.name).toContain('logged out');
    expect(choice.name).toContain('launch to sign in');
  });

  it('orders ready > needs-sign-in > throttled, so the actionable row beats the hopeless one', () => {
    const choices = buildRunAccountChoices(rows([
      candidate({ version: '1.0.0', usageSnapshot: snapshot([['session', 100], ['week', 100]]) }),
      other({ version: '2.0.0', signedIn: false, accountKey: null, email: null, usageSnapshot: null }),
      candidate({ version: '3.0.0', identityKey: 'claude:account=three', accountKey: 'claude:account=three', email: 'three@example.com', identityEmail: 'three@example.com' }),
    ], { globalDefault: null }));
    expect(choices.map((c) => c.value)).toEqual(['claude:account=three', 'claude:account=two', 'claude:account=one']);
    expect(choices.map((c) => !!c.disabled)).toEqual([false, false, true]);
  });

  it('disables exhausted accounts with the exact blocking windows and the `rate-limited` state', () => {
    const [choice] = buildRunAccountChoices(rows([
      candidate({ usageSnapshot: snapshot([['session', 100], ['week', 100]]) }),
    ]));
    expect(choice).toMatchObject({ ready: false, disabled: 'Session and Week limits reached' });
    expect(choice.name).toContain('Session exhausted');
    expect(choice.name).toContain('Week exhausted');
    expect(choice.name).toContain('rate-limited');
  });

  it('marks a server-revoked account (token rejected) as `reconnect needed`, but keeps it pickable', () => {
    const [choice] = buildRunAccountChoices(rows([
      candidate({ authVerdict: 'revoked', usageSnapshot: snapshot([['session', 0], ['week', 0]]) }),
    ]));
    expect(choice).toMatchObject({ ready: false, signInRequired: true });
    expect(choice.disabled).toBeUndefined();
    expect(choice.name).toContain('reconnect needed');
    expect(choice.name).toContain('launch to re-authenticate');
  });

  it('keeps a signed-in account selectable when quota data is unavailable', () => {
    const [choice] = buildRunAccountChoices(rows([
      candidate({ usageSnapshot: null, usageError: 'network unavailable' }),
    ]));
    expect(choice.ready).toBe(true);
    expect(choice.disabled).toBeUndefined();
    expect(choice.name).toContain('limits unavailable');
  });

  it('does not disable a usable account solely because the Sonnet sub-limit is exhausted', () => {
    const [choice] = buildRunAccountChoices(rows([
      candidate({ usageSnapshot: snapshot([['session', 20], ['week', 30], ['sonnet_week', 100]]) }),
    ]));
    expect(choice.ready).toBe(true);
    expect(choice.name).toContain('Sonnet week exhausted');
  });

  it('uses a usage-reported plan when the credential has no plan claim', () => {
    const [choice] = buildRunAccountChoices(rows([
      candidate({ plan: null, usageSnapshot: snapshot([['session', 10]], 'Team') }),
    ]));
    expect(choice.name).toContain('Team');
  });
});

describe('pickerHeaderLines (the release is stated ONCE, above the rows — S2/S7)', () => {
  it('names the harness release and the update switch, then the reason the picker appeared', () => {
    expect(pickerHeaderLines('claude', '2.1.263', true, 'no claude account has usage newer than 5 min')).toEqual([
      'Claude 2.1.263 · automatic updates on',
      'no claude account has usage newer than 5 min',
    ]);
    expect(pickerHeaderLines('claude', '2.1.263', false)).toEqual(['Claude 2.1.263 · automatic updates off']);
    expect(pickerHeaderLines('claude', null, true)).toEqual([]);
  });
});

describe('buildSwitchAccountChoices', () => {
  it('marks the current default and shows native usage next to provider credentials', () => {
    const choices = buildSwitchAccountChoices([
      {
        accountName: 'work',
        kind: 'provider',
        detail: 'anthropic',
        current: true,
        candidate: null,
      },
      {
        accountName: 'personal',
        kind: 'native',
        detail: 'one@example.com',
        current: false,
        candidate: candidate({ usageSnapshot: snapshot([['session', 25], ['week', 60]]) }),
      },
    ]);
    expect(choices[0]).toMatchObject({ value: 'work', ready: true });
    expect(choices[0].name).toContain('work (default)');
    expect(choices[0].name).toContain('provider · anthropic');
    expect(choices[0].name).toContain('credential');
    expect(choices[1].value).toBe('personal');
    expect(choices[1].name).toContain('native · one@example.com');
    expect(choices[1].name).toContain('Session 75% left');
  });

  it('keeps a rate-limited native account selectable — switch sets a default, it does not launch', () => {
    const [choice] = buildSwitchAccountChoices([
      {
        accountName: 'maxed',
        kind: 'native',
        detail: 'one@example.com',
        current: false,
        candidate: candidate({ usageSnapshot: snapshot([['session', 100], ['week', 100]]) }),
      },
    ]);
    expect(choice.disabled).toBeUndefined();
    expect(choice.ready).toBe(false);
    expect(choice.name).toContain('rate limited');
    expect(choice.name).toContain('Session exhausted');
  });
});

describe('pickSignInLaunchVersion (RUSH-2334)', () => {
  afterEach(() => vi.restoreAllMocks());

  function captureStderr(): { lines: () => string } {
    const chunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    return { lines: () => chunks.join('') };
  }

  it('a single logged-out account launches WITHOUT a prompt — a one-item picker decides nothing', async () => {
    const stderr = captureStderr();
    const version = await pickSignInLaunchVersion(
      'claude',
      [candidate({ version: '2.1.0', signedIn: false, usageSnapshot: null })],
    );
    expect(version).toBe('2.1.0');
    // The release, not the label, and the account — never `claude@<label>` (S1/S3).
    expect(stderr.lines()).toContain('launching Claude 2.1.0 · sign in to a new account');
    expect(stderr.lines()).not.toContain('claude@2.1.0');
    // The message must name the actual login command, not just say "logged out".
    expect(stderr.lines()).toContain('claude, then /login');
  });

  it('a single revoked account says the token was rejected, not that you are logged out', async () => {
    const stderr = captureStderr();
    const version = await pickSignInLaunchVersion(
      'claude',
      [candidate({ version: '2.1.0', authVerdict: 'revoked' })],
    );
    expect(version).toBe('2.1.0');
    expect(stderr.lines()).toContain('the server rejected its token');
  });

  it('--quiet launches the same version but prints nothing', async () => {
    const stderr = captureStderr();
    const version = await pickSignInLaunchVersion(
      'claude',
      [candidate({ version: '2.1.0', signedIn: false, usageSnapshot: null })],
      true,
    );
    expect(version).toBe('2.1.0');
    expect(stderr.lines()).toBe('');
  });

  it('no recoverable candidate returns null so the caller falls back to failing loud', async () => {
    expect(await pickSignInLaunchVersion('claude', [])).toBeNull();
  });
});

describe('signInLaunchDecision (RUSH-2334)', () => {
  const base = { recoverable: 1, tty: true, json: false };

  it('launches when a human is present and an account only needs a login', () => {
    expect(signInLaunchDecision(base)).toBe('launch');
  });

  it('--json NEVER launches, even on a real terminal — a machine consumer must not get a picker or a TUI', () => {
    expect(signInLaunchDecision({ ...base, json: true })).toBe('fail-loud');
  });

  it('off a TTY it fails loud — nobody is there to complete a login', () => {
    expect(signInLaunchDecision({ ...base, tty: false })).toBe('fail-loud');
  });

  it('an all-throttled exhausted set fails loud even for a present human (RUSH-2132)', () => {
    expect(signInLaunchDecision({ ...base, recoverable: 0 })).toBe('fail-loud');
  });
});

describe('noVerifiedUsageDecision (PHNX-2526 — entirely-stale usage divert)', () => {
  const base = { tty: true, json: false, headless: false };

  it('shows the account picker when a human is present at a real terminal', () => {
    expect(noVerifiedUsageDecision(base)).toBe('picker');
  });

  it('off a TTY it fails loud with NO_VERIFIED_USAGE — no human to answer a picker', () => {
    expect(noVerifiedUsageDecision({ ...base, tty: false })).toBe('fail-loud');
  });

  it('--json NEVER opens a picker — a machine consumer gets the parseable error', () => {
    expect(noVerifiedUsageDecision({ ...base, json: true })).toBe('fail-loud');
  });

  it('--headless fails loud even on a TTY — an unattended dispatch has no one to choose', () => {
    expect(noVerifiedUsageDecision({ ...base, headless: true })).toBe('fail-loud');
  });
});
