import { describe, expect, it } from 'vitest';
import {
  buildFleetHealthReport,
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
  });
});
