import chalk from 'chalk';
import { padToWidth, stringWidth, terminalWidth, truncateToWidth } from '../session/width.js';
import { fmtBytes, headroom, type DeviceStats } from './health.js';
import { formatCheckedAge, type HostAuthSummary } from '../auth-health.js';

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
  /** Cached auth-health rollup for this host (the Auth column). Undefined when
   *  the host has never been probed (`agents fleet ping`) or the cache is cold. */
  auth?: HostAuthSummary;
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

/**
 * Compact per-host auth cell. Four buckets, deliberately distinct so the column
 * doesn't cry wolf on healthy accounts:
 *   `●{live}`     green  — live-verified
 *   `·{present}`  gray   — signed in but no live probe (codex/grok/…): benign
 *   `◐{degraded}` yellow — soft/self-healing (expired/limited/error)
 *   `○{revoked}`  red    — server rejected the token: re-login now
 * A host with no cached auth rows shows "—"; an unreachable/skipped row shows
 * "-" like the other probe columns.
 */
function authLabel(row: FleetHealthRow): string {
  if (row.error || row.skipped) return chalk.gray('-');
  const s = row.auth;
  if (!s || s.total === 0) return chalk.gray('—');
  const parts: string[] = [];
  if (s.live > 0) parts.push(chalk.green(`●${s.live}`));
  if (s.present > 0) parts.push(chalk.gray(`·${s.present}`));
  if (s.degraded > 0) parts.push(chalk.yellow(`◐${s.degraded}`));
  if (s.revoked > 0) parts.push(chalk.red(`○${s.revoked}`));
  // All-zero can't happen (total > 0); but if only present/degraded exist we
  // still lead with them — never show an empty cell for a probed host.
  return parts.length > 0 ? parts.join(' ') : chalk.gray('—');
}

/** Oldest epoch-ms timestamp across rows for a field, or null when none present. */
function oldestAcross(rows: FleetHealthRow[], pick: (r: FleetHealthRow) => number | null | undefined): number | null {
  let oldest: number | null = null;
  for (const row of rows) {
    const t = pick(row);
    if (t == null) continue;
    if (oldest === null || t < oldest) oldest = t;
  }
  return oldest;
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
  // Auth cells are variable-length (up to four space-separated buckets, e.g.
  // `●2 ·3 ◐1 ○1`); size the column to the widest so a mixed-auth row can't
  // overflow the fixed slot and shove every later column out of alignment.
  const authW = Math.max(9, ...report.devices.map((r) => stringWidth(authLabel(r))));
  const width = terminalWidth();
  // 4 = leading "  " + the per-row status glyph + its trailing space (rows prefix
  // `  ${statusGlyph} `; the header reserves the same 4 cols so every column lines up).
  // Columns: Device, OS(8), Health(9), Sync(9), CLI(9), Auth(authW), Version, Load/Mem(9), then Note.
  const fixed = 4 + nameW + 2 + 8 + 2 + 9 + 2 + 9 + 2 + 9 + 2 + authW + 2 + versionW + 2 + 9;
  const noteW = Math.max(12, width - fixed);
  const lines = [
    chalk.bold('Fleet status'),
    chalk.gray(
      `    ${padToWidth('Device', nameW)}  ${padToWidth('OS', 8)}  ${padToWidth('Health', 9)}  ${padToWidth('Sync', 9)}  ${padToWidth('CLI', 9)}  ${padToWidth('Auth', authW)}  ${padToWidth('Version', versionW)}  ${padToWidth('Load/Mem', 9)}  Note`,
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
      `${padToWidth(authLabel(row), authW)}  ` +
      `${padToWidth(truncateToWidth(row.version ?? '-', versionW), versionW)}  ` +
      `${padToWidth(loadLabel(row.stats), 9)}  ` +
      chalk.gray(truncateToWidth(note || `free ${fmtBytes(row.stats?.memFreeBytes)}`, noteW)),
    );
  }
  lines.push(chalk.gray('  ● fresh · ◐ drift · ○ unreachable/skipped · Auth ●live ·present ◐degraded ○revoked'));
  const foot = freshnessFooter(report.devices);
  if (foot) lines.push(chalk.gray(foot));
  return lines;
}

/**
 * "as of …" line so cache-served output is honest about age and points at the
 * refresh flag. Stats age comes from `stats.fetchedAt`, auth age from the
 * cached rollup's `oldestCheckedAt`; either may be absent. Returns null when the
 * table carries no timestamped data at all (nothing to date).
 */
export function freshnessFooter(rows: FleetHealthRow[], now: number = Date.now()): string | null {
  const oldestStats = oldestAcross(rows, (r) => r.stats?.fetchedAt);
  const oldestAuth = oldestAcross(rows, (r) => r.auth?.oldestCheckedAt);
  const parts: string[] = [];
  if (oldestStats != null) parts.push(`stats ${formatCheckedAge(oldestStats, now)}`);
  if (oldestAuth != null) parts.push(`auth ${formatCheckedAge(oldestAuth, now)}`);
  if (parts.length === 0) return null;
  return `  updated ${parts.join(' · ')} — pass --refresh (--live) for a live probe`;
}
