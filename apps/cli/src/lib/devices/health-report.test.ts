import { describe, expect, it } from 'vitest';
import {
  buildFleetHealthReport,
  freshnessFooter,
  renderFleetMatrix,
  renderFleetWarnings,
  type FleetHealthRow,
} from './health-report.js';
import { stripAnsi } from '../session/width.js';

function row(overrides: Partial<FleetHealthRow> & { name: string }): FleetHealthRow {
  return {
    name: overrides.name,
    platform: overrides.platform ?? 'linux',
    version: overrides.version ?? '1.2.3',
    stats: overrides.stats,
    error: overrides.error,
    skipped: overrides.skipped,
    clis: overrides.clis ?? {
      codex: { installed: true, path: '/bin/codex', error: null },
    },
    sync: overrides.sync ?? [
      { agent: 'codex', version: '0.1.0', status: 'fresh', isDefault: true },
    ],
    orphans: overrides.orphans ?? [],
    auth: overrides.auth,
  };
}

describe('buildFleetHealthReport', () => {
  it('rolls up unreachable, drift, CLI gaps, and version skew', () => {
    const report = buildFleetHealthReport([
      row({ name: 'a', version: '1.0.0' }),
      row({
        name: 'b',
        version: '1.0.1',
        clis: { codex: { installed: false, path: null, error: 'missing' } },
        sync: [{ agent: 'codex', version: '0.1.0', status: 'stale', isDefault: true }],
      }),
      row({ name: 'c', error: 'timed out' }),
    ], new Date('2026-07-17T00:00:00.000Z'));

    expect(report.generatedAt).toBe('2026-07-17T00:00:00.000Z');
    expect(report.hasWarnings).toBe(true);
    expect(report.hasDrift).toBe(true);
    expect(report.warnings.map((w) => w.kind)).toEqual([
      'unreachable',
      'drift',
      'cli',
      'version-skew',
    ]);
  });
});

describe('fleet health renderers', () => {
  it('renders a warnings rollup and matrix without ANSI-sensitive assertions', () => {
    const report = buildFleetHealthReport([
      row({ name: 'fresh-box' }),
      row({
        name: 'drift-box',
        sync: [{ agent: 'codex', version: '0.1.0', status: 'never-synced', isDefault: true }],
      }),
    ], new Date('2026-07-17T00:00:00.000Z'));

    const warnings = stripAnsi(renderFleetWarnings(report).join('\n'));
    const matrix = stripAnsi(renderFleetMatrix(report).join('\n'));
    expect(warnings).toContain('Fleet warnings');
    expect(warnings).toContain('sync drift');
    expect(matrix).toContain('Fleet status');
    expect(matrix).toContain('fresh-box');
    expect(matrix).toContain('drift-box');
    expect(matrix).toContain('cold');
    // Header must reserve the same 2-char status-glyph slot the rows prepend, so every
    // column lines up (regression guard for the shipped-broken-table review fix).
    const mlines = matrix.split('\n');
    const header = mlines.find((l) => l.includes('Device'))!;
    const dataRow = mlines.find((l) => l.includes('fresh-box'))!;
    expect(header.indexOf('Device')).toBe(dataRow.indexOf('fresh-box'));
  });
});

describe('Auth column + freshness', () => {
  it('renders a compact per-host auth cell and includes an Auth header', () => {
    const report = buildFleetHealthReport([
      row({ name: 'live-box', auth: { live: 4, present: 0, degraded: 0, revoked: 0, total: 4, oldestCheckedAt: 1000 } }),
      row({ name: 'mixed-box', auth: { live: 2, present: 3, degraded: 1, revoked: 1, total: 7, oldestCheckedAt: 1000 } }),
      row({ name: 'nocache-box' }), // no auth rollup → em dash
    ]);
    const lines = renderFleetMatrix(report).map(stripAnsi);
    expect(lines.find((l) => l.includes('Device'))).toContain('Auth');
    expect(lines.find((l) => l.includes('live-box'))).toContain('●4');
    const mixed = lines.find((l) => l.includes('mixed-box'))!;
    expect(mixed).toContain('●2');
    expect(mixed).toContain('·3'); // present (signed in, unprobeable) — neutral, not alarming
    expect(mixed).toContain('◐1'); // degraded (soft)
    expect(mixed).toContain('○1'); // revoked (re-login)
    expect(lines.find((l) => l.includes('nocache-box'))).toContain('—');
  });

  it('sizes the Auth column so a wide mixed-auth cell never misaligns later columns', () => {
    // Regression: a full `●2 ·3 ◐1 ○1` cell (11 display cells) overflowed a
    // hard-coded 9-wide slot, shoving Version/Load-Mem/Note right on that row.
    // Same name width + same version → the Version value must start at the same
    // column in both the wide-auth row and the em-dash row.
    const report = buildFleetHealthReport([
      row({ name: 'aaaa', version: '9.9.9', auth: { live: 2, present: 3, degraded: 1, revoked: 1, total: 7, oldestCheckedAt: 1 } }),
      row({ name: 'bbbb', version: '9.9.9' }), // no auth → '—'
    ]);
    const lines = renderFleetMatrix(report).map(stripAnsi);
    const wide = lines.find((l) => l.includes('aaaa'))!;
    const narrow = lines.find((l) => l.includes('bbbb'))!;
    expect(wide.indexOf('9.9.9')).toBe(narrow.indexOf('9.9.9'));
  });

  it('does not paint present (unverified) accounts as degraded ◐', () => {
    // The bug this guards: a fleet of signed-in codex/grok accounts (all
    // `unverified`) must not read as degraded. Only `·` should appear, no `◐`.
    const report = buildFleetHealthReport([
      row({ name: 'unprobeable', auth: { live: 0, present: 6, degraded: 0, revoked: 0, total: 6, oldestCheckedAt: 1000 } }),
    ]);
    const cell = renderFleetMatrix(report).map(stripAnsi).find((l) => l.includes('unprobeable'))!;
    expect(cell).toContain('·6');
    expect(cell).not.toContain('◐'); // never rendered as degraded
  });

  it('freshnessFooter dates both stats and auth and points at --refresh', () => {
    const now = 100_000;
    const foot = freshnessFooter([
      row({ name: 'a', stats: { host: 'a', reachable: true, fetchedAt: now - 120_000 } as never,
            auth: { live: 1, present: 0, degraded: 0, revoked: 0, total: 1, oldestCheckedAt: now - 300_000 } }),
    ], now);
    expect(foot).toContain('stats 2m ago');
    expect(foot).toContain('auth 5m ago');
    expect(foot).toContain('--refresh');
    expect(foot).toContain('--live');
  });

  it('freshnessFooter returns null when no row carries a timestamp', () => {
    expect(freshnessFooter([row({ name: 'a' })])).toBeNull();
  });
});
