import { describe, expect, it } from 'vitest';
import { renderAccountList } from './accounts.js';
import type { NativeAccountCatalogRow } from '../lib/account-catalog.js';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function row(overrides: Partial<NativeAccountCatalogRow> = {}): NativeAccountCatalogRow {
  return {
    kind: 'native',
    agent: 'claude',
    identityKey: 'claude:user=1',
    name: 'work',
    id: 'id-work',
    email: 'w@example.com',
    display: 'w@example.com',
    identityLabel: 'w@example.com',
    home: 'main',
    installations: [{ label: 'main', releaseVersion: '2.1.220', signedIn: true }],
    isDefault: true,
    state: 'connected',
    provisioning: 'portable',
    verdict: 'live',
    checkedAt: '2026-09-06T00:00:00.000Z',
    devices: [{ device: 'zion', authMode: 'native', verdict: 'live' }],
    usage: {
      status: 'available',
      verdict: 'available',
      usedPercent: 20,
      stale: false,
      capturedAt: '2026-09-06T00:00:00.000Z',
      resetsAt: null,
      unavailableReason: null,
    },
    fix: null,
    ...overrides,
  };
}

describe('renderAccountList', () => {
  it('renders one account row with state, where, usage, and default marker', () => {
    const out = stripAnsi(renderAccountList([row()]));
    expect(out).toContain('ACCOUNT');
    expect(out).toContain('IDENTITY');
    expect(out).toContain('STATE');
    expect(out).toContain('WHERE');
    expect(out).toContain('* work');
    expect(out).toContain('LIVE');
    expect(out).toContain('+1');
    expect(out).toContain('20%');
  });

  it('prints the exact repair command and attention count for an expired account', () => {
    const out = stripAnsi(renderAccountList([
      row({
        verdict: 'expired',
        fix: 'agents accounts connect claude work',
        devices: [{ device: 'zion', authMode: 'native', verdict: 'expired' }],
      }),
    ]));
    expect(out).toContain('EXPIRED');
    expect(out).toContain('fix: agents accounts connect claude work');
    expect(out).toContain('1 accounts need you');
  });

  it.each([
    ['live', 'LIVE'],
    ['expired', 'EXPIRED'],
    ['revoked', 'REVOKED'],
    ['rate_limited', 'LIMITED'],
    ['unverified', 'UNVERIFIED'],
    ['missing', 'MISSING'],
    ['per-device', 'PER-DEVICE'],
  ] as const)('renders the %s verdict as %s', (verdict, label) => {
    const out = stripAnsi(renderAccountList([row({
      verdict,
      fix: verdict === 'live' || verdict === 'rate_limited' ? null : 'repair',
    })]));
    expect(out).toContain(label);
  });

  it('never exposes reserved credential stores in account output', () => {
    const out = stripAnsi(renderAccountList([row()]));
    expect(out.toLowerCase()).not.toContain('bundle');
    expect(out).not.toContain('__claude__');
  });

  it('handles an empty account list', () => {
    const out = stripAnsi(renderAccountList([]));
    expect(out).toContain('No accounts found');
    expect(out).toContain('0 accounts need you');
  });

  it('does not count an unverified worker (no repair) as needing you', () => {
    const out = stripAnsi(renderAccountList([row({
      verdict: 'unverified',
      fix: null,
      usage: {
        status: null,
        verdict: 'unavailable',
        usedPercent: null,
        stale: false,
        capturedAt: null,
        resetsAt: null,
        unavailableReason: 'usage unavailable (headless)',
      },
    })]));
    expect(out).toContain('UNVERIFIED');
    expect(out).not.toMatch(/out of credits|no credits/i);
    expect(out).toContain('0 accounts need you');
  });
});
