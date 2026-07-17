import chalk from 'chalk';
import { padToWidth, terminalWidth, truncateToWidth } from '../session/width.js';
import { fmtBytes, headroom, type DeviceStats } from './health.js';

export interface FleetCliStatus {
  installed: boolean;
  path: string | null;
  error: string | null;
}

export interface FleetSyncStatus {
  agent: string;
  version: string;
  status: 'fresh' | 'stale' | 'never-synced';
  isDefault: boolean;
  divergence?: string[];
}

export interface FleetOrphanStatus {
  agent: string;
  version: string;
  commands: number;
  skills: number;
  hooks: number;
}

export interface FleetHealthRow {
  name: string;
  platform?: string;
  version?: string | null;
  stats?: DeviceStats;
  error?: string;
  skipped?: string;
  clis: Record<string, FleetCliStatus>;
  sync: FleetSyncStatus[];
  orphans: FleetOrphanStatus[];
}

export interface FleetWarning {
  kind: 'unreachable' | 'drift' | 'cli' | 'version-skew';
  devices: string[];
  message: string;
}

export interface FleetHealthReport {
  generatedAt: string;
  devices: FleetHealthRow[];
  warnings: FleetWarning[];
  hasWarnings: boolean;
  hasDrift: boolean;
}

function driftRows(row: FleetHealthRow): FleetSyncStatus[] {
  return row.sync.filter((s) => s.status !== 'fresh');
}

function installedCliCount(row: FleetHealthRow): { installed: number; total: number } {
  const statuses = Object.values(row.clis);
  return {
    installed: statuses.filter((s) => s.installed).length,
    total: statuses.length,
  };
}

export function buildFleetHealthReport(rows: FleetHealthRow[], now = new Date()): FleetHealthReport {
  const warnings: FleetWarning[] = [];
  const unreachable = rows
    .filter((r) => r.error || r.skipped)
    .map((r) => r.name);
  if (unreachable.length > 0) {
    warnings.push({
      kind: 'unreachable',
      devices: unreachable,
      message: `${unreachable.length} device${unreachable.length === 1 ? '' : 's'} unreachable or skipped`,
    });
  }

  const drifted = rows.filter((r) => driftRows(r).length > 0).map((r) => r.name);
  if (drifted.length > 0) {
    warnings.push({
      kind: 'drift',
      devices: drifted,
      message: `${drifted.length} device${drifted.length === 1 ? '' : 's'} have sync drift`,
    });
  }

  const cliIssues = rows
    .filter((r) => {
      const counts = installedCliCount(r);
      return counts.total > 0 && counts.installed < counts.total;
    })
    .map((r) => r.name);
  if (cliIssues.length > 0) {
    warnings.push({
      kind: 'cli',
      devices: cliIssues,
      message: `${cliIssues.length} device${cliIssues.length === 1 ? ' is' : 's are'} missing one or more agent CLIs`,
    });
  }

  const versions = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.version) continue;
    const list = versions.get(row.version) ?? [];
    list.push(row.name);
    versions.set(row.version, list);
  }
  if (versions.size > 1) {
    warnings.push({
      kind: 'version-skew',
      devices: rows.filter((r) => r.version).map((r) => r.name),
      message: `agents-cli version skew: ${Array.from(versions.keys()).sort().join(', ')}`,
    });
  }

  return {
    generatedAt: now.toISOString(),
    devices: rows,
    warnings,
    hasWarnings: warnings.length > 0,
    hasDrift: drifted.length > 0 || unreachable.length > 0,
  };
}

function statusGlyph(row: FleetHealthRow): string {
  if (row.error || row.skipped) return chalk.red('○');
  if (driftRows(row).length > 0) return chalk.yellow('◐');
  return chalk.green('●');
}

function headroomLabel(row: FleetHealthRow): string {
  const h = headroom(row.stats);
  switch (h) {
    case 'idle':
      return chalk.green('idle');
    case 'light':
      return chalk.green('light');
    case 'busy':
      return chalk.yellow('busy');
    case 'loaded':
      return chalk.red('loaded');
    case 'unknown':
      return chalk.gray('unknown');
  }
}

function driftLabel(row: FleetHealthRow): string {
  if (row.error) return chalk.red('probe failed');
  if (row.skipped) return chalk.gray(row.skipped);
  const drift = driftRows(row);
  if (drift.length === 0) return chalk.green('fresh');
  const stale = drift.filter((r) => r.status === 'stale').length;
  const cold = drift.filter((r) => r.status === 'never-synced').length;
  const parts: string[] = [];
  if (stale) parts.push(`${stale} stale`);
  if (cold) parts.push(`${cold} cold`);
  return chalk.yellow(parts.join(' · '));
}

function cliLabel(row: FleetHealthRow): string {
  if (row.error || row.skipped) return chalk.gray('-');
  const { installed, total } = installedCliCount(row);
  if (total === 0) return chalk.gray('none');
  return installed === total ? chalk.green(`${installed}/${total}`) : chalk.yellow(`${installed}/${total}`);
}

function loadLabel(stats: DeviceStats | undefined): string {
  if (!stats?.reachable) return chalk.gray('-');
  const load = stats.loadPercent === undefined ? '-' : `${Math.round(stats.loadPercent)}%`;
  const mem = stats.memPercent === undefined ? '-' : `${Math.round(stats.memPercent)}%`;
  return `${load}/${mem}`;
}

export function renderFleetWarnings(report: FleetHealthReport): string[] {
  if (report.warnings.length === 0) return [chalk.green('Fleet warnings: none')];
  return [
    chalk.bold(`Fleet warnings (${report.warnings.length})`),
    ...report.warnings.map((w) => `  ${chalk.yellow(w.kind.padEnd(12))} ${w.message} ${chalk.gray(`(${w.devices.join(', ')})`)}`),
  ];
}

export function renderFleetMatrix(report: FleetHealthReport): string[] {
  if (report.devices.length === 0) return [chalk.gray('No registered devices. Run `agents devices` to register some.')];
  const nameW = Math.min(
    22,
    Math.max(6, ...report.devices.map((r) => r.name.length)),
  );
  const versionW = Math.min(
    14,
    Math.max(7, ...report.devices.map((r) => (r.version ?? '-').length)),
  );
  const width = terminalWidth();
  // 4 = leading "  " + the per-row status glyph + its trailing space (rows prefix
  // `  ${statusGlyph} `; the header reserves the same 4 cols so every column lines up).
  const fixed = 4 + nameW + 2 + 8 + 2 + 9 + 2 + 9 + 2 + versionW + 2 + 9 + 2 + 9;
  const noteW = Math.max(12, width - fixed);
  const lines = [
    chalk.bold('Fleet status'),
    chalk.gray(
      `    ${padToWidth('Device', nameW)}  ${padToWidth('OS', 8)}  ${padToWidth('Health', 9)}  ${padToWidth('Sync', 9)}  ${padToWidth('CLI', 9)}  ${padToWidth('Version', versionW)}  ${padToWidth('Load/Mem', 9)}  Note`,
    ),
  ];
  for (const row of report.devices) {
    const note = row.error ?? row.skipped ?? (row.orphans.length > 0 ? `${row.orphans.length} orphaned version${row.orphans.length === 1 ? '' : 's'}` : '');
    lines.push(
      `  ${statusGlyph(row)} ${padToWidth(truncateToWidth(row.name, nameW), nameW)}  ` +
      `${padToWidth(truncateToWidth(row.platform ?? '-', 8), 8)}  ` +
      `${padToWidth(headroomLabel(row), 9)}  ` +
      `${padToWidth(driftLabel(row), 9)}  ` +
      `${padToWidth(cliLabel(row), 9)}  ` +
      `${padToWidth(truncateToWidth(row.version ?? '-', versionW), versionW)}  ` +
      `${padToWidth(loadLabel(row.stats), 9)}  ` +
      chalk.gray(truncateToWidth(note || `free ${fmtBytes(row.stats?.memFreeBytes)}`, noteW)),
    );
  }
  lines.push(chalk.gray('  ● fresh · ◐ drift · ○ unreachable/skipped'));
  return lines;
}
