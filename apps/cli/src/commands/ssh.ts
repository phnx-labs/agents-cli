/**
 * `agents devices` (registry) + `agents ssh` (smart wrapper).
 *
 * `agents devices` keeps a registry of SSH device profiles — platform, login
 * user, address, and auth — self-populated from `tailscale status --json`.
 * `agents ssh <name>` then connects through one hardened path: preflight
 * (offline → fail fast instead of a 2-minute hang), platform-aware exec
 * (PowerShell on Windows), and password-from-bundle auth via an askpass shim.
 * Rendering the registry to an ssh_config include also lets plain ssh / scp /
 * rsync / `agents sessions --host` resolve the same logical names.
 */

import type { Command } from 'commander';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { getCliVersion } from '../lib/version.js';
import { readAndResolveBundleEnv, isHeadlessSecretsContext } from '../lib/secrets/bundles.js';
import { machineId } from '../lib/session/sync/config.js';
import { registerFleetCaptureCommand } from './fleet-capture.js';
import { registerFleetApplyAlias } from './apply.js';
import {
  addIgnored,
  getDevice,
  loadDevices,
  loadIgnored,
  removeDevice,
  removeIgnored,
  upsertDevice,
  writeReachability,
  type DeviceAuthMethod,
  type DevicePlatform,
  type DeviceProfile,
  type DeviceRegistry,
} from '../lib/devices/registry.js';
import { collectReachabilityWriteBacks, deviceOnlineState } from '../lib/devices/reachability.js';
import { addControlToken } from '../lib/serve/token.js';
import { DEFAULT_SERVE_PORT } from '../lib/serve/server.js';
import {
  nodeToDeviceInput,
  parseTailscaleStatus,
  tailscaleStatusJson,
} from '../lib/devices/tailscale.js';
import { defaultPickerChecked, localLoginUser, planDeviceReconciliation, runDeviceSync, withDefaultUser } from '../lib/devices/sync.js';
import { resolveDeviceTarget, splitUserHost } from '../lib/devices/resolve-target.js';
import { clearPendingSentinel } from '../lib/devices/pending.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { hostNameFor, renderSshConfig } from '../lib/devices/ssh-config.js';
import {
  ASKPASS_BUNDLE_ENV,
  ASKPASS_KEY_ENV,
  ASKPASS_AGENT_ONLY_ENV,
  buildSshInvocation,
  fleetDialTarget,
  writeAskpassShim,
} from '../lib/devices/connect.js';
import { ensureManagedKnownHostsDir, isHostPinned } from '../lib/devices/known-hosts.js';
import { shouldSyncTerminfo, syncTerminfoToDevice, terminfoHostKey } from '../lib/devices/terminfo.js';
import {
  fanOutDevices,
  fleetHealthSkip,
  planFleetTargets,
  remoteFleetTargets,
  runFleet,
  skipLabel,
  upgradeCommand,
  type FanOutDeviceTarget,
  type FleetRunResult,
} from '../lib/devices/fleet.js';
import {
  fleetCapacity,
  fmtBytes,
  headroom,
  type DeviceStats,
  type Headroom,
} from '../lib/devices/health.js';
import {
  buildFleetHealthReport,
  renderFleetMatrix,
  renderFleetSummary,
  renderFleetWarnings,
  type FleetHealthRow,
} from '../lib/devices/health-report.js';
import { loadFleetStats, readStatsCache } from '../lib/devices/stats-cache.js';
import { collectLocalFleetInventory } from '../lib/devices/fleet-inventory.js';
import { checkSyncStatus, countOrphans } from '../lib/drift.js';
import { checkAllClis } from '../lib/teams/agents.js';
import { buildRemoteAgentsInvocation } from '../lib/hosts/remote-cmd.js';
import { sshExec, sshExecAsync, SSH_OPTS } from '../lib/ssh-exec.js';
import { ALL_AGENT_IDS } from '../lib/agents.js';
import { crabboxList, crabboxFind, crabboxSshArgv, type CrabboxBox } from '../lib/crabbox/cli.js';
import { boxAddress, boxStatus, fmtIdleShort, fmtExpiresShort } from './lease.js';
import {
  authCellColor,
  formatCheckedAge,
  isDeadVerdict,
  probeLocalFleetAuth,
  readAuthHealthCache,
  summarizeHostAuth,
  summarizeVerdicts,
  verdictColor,
  verdictLabel,
  writeFleetAuthRows,
  type AuthCellColor,
  type AuthProbeRow,
  type VerdictSummary,
} from '../lib/auth-health.js';
import { runFleetLogin, type LoginStatus } from '../lib/fleet/remote-login.js';

/** One-line summary of a device for `list`. `isSelf` marks the machine this
 * command is running on so it stands out from the rest of the tailnet. */
function deviceSummary(d: DeviceProfile, isSelf = false, stats?: DeviceStats): string {
  const addr = hostNameFor(d) ?? chalk.gray('no address');
  // Prefer a fresh live verdict (this run's probe, else the written-back
  // reachability) over the stale tailscale.online snapshot (RUSH-1965).
  const state = deviceOnlineState(d, stats);
  const online =
    state === 'online'
      ? chalk.green('online')
      : state === 'offline'
        ? chalk.gray('offline')
        : chalk.gray('unknown');
  const reach = state === 'online' && d.tailscale && !d.tailscale.direct ? chalk.yellow(' (relayed)') : '';
  const marker = isSelf ? chalk.cyan('▸ ') : '  ';
  const name = isSelf ? chalk.bold.cyan(d.name.padEnd(16)) : chalk.bold(d.name.padEnd(16));
  const here = isSelf ? chalk.cyan('  ← this machine') : '';
  return `${marker}${name} ${String(d.platform).padEnd(8)} ${(d.user ? d.user + '@' : '') + addr}  ${online}${reach}${here}`;
}

const HEADROOM_BADGE: Record<Headroom, string> = {
  idle: chalk.green('○ idle'),
  light: chalk.green('● light'),
  busy: chalk.yellow('● busy'),
  loaded: chalk.red('● loaded'),
  unknown: chalk.gray('· —'),
};

/** A right-aligned percentage cell, colored by severity (green/yellow/red). */
function pctCell(v: number | undefined, width: number): string {
  if (v === undefined) return chalk.gray('—'.padStart(width));
  const s = `${Math.round(v)}%`.padStart(width);
  if (v < 40) return chalk.green(s);
  if (v < 75) return chalk.yellow(s);
  return chalk.red(s);
}

/**
 * Render the device list. When `statsMap` is provided, resource columns are
 * appended — normalized load, memory, a headroom badge, and (in `full` mode)
 * core count and free/total memory — so it's obvious which boxes have room.
 * Without it (probe skipped) the classic reachability line is used. A fleet
 * capacity summary is appended whenever stats were gathered.
 */
function renderDeviceTable(
  reg: DeviceRegistry,
  names: string[],
  self: string | undefined,
  statsMap?: Map<string, DeviceStats>,
  full = false,
): string[] {
  if (!statsMap) return names.map((n) => deviceSummary(reg[n], n === self));

  const lines: string[] = [];
  const head =
    '  ' +
    chalk.gray('device'.padEnd(16)) +
    chalk.gray('platform'.padEnd(8)) +
    ' ' +
    (full ? chalk.gray('cores'.padStart(6)) : '') +
    chalk.gray('load'.padStart(5)) +
    chalk.gray('mem'.padStart(6)) +
    (full ? '  ' + chalk.gray('free/total'.padEnd(12)) : '') +
    '  ' +
    chalk.gray('headroom');
  lines.push(head);

  for (const name of names) {
    const d = reg[name];
    const isSelf = name === self;
    const marker = isSelf ? chalk.cyan('▸ ') : '  ';
    const label = isSelf ? chalk.bold.cyan(name.padEnd(16)) : chalk.bold(name.padEnd(16));
    const plat = String(d.platform).padEnd(8);
    const stats = statsMap.get(name);
    // Prefer this run's live probe, then the written-back verdict, over the
    // stale tailscale.online snapshot — so a reachable box never renders
    // "offline" while its live load/mem sit one column over (RUSH-1965).
    const offline = deviceOnlineState(d, stats) === 'offline';
    if (offline) {
      lines.push(`${marker}${label}${plat} ${chalk.gray('offline')}`);
      continue;
    }
    const relay = !isSelf && d.tailscale?.online && !d.tailscale.direct ? chalk.yellow(' relay') : '';
    const cores = full ? chalk.gray(String(stats?.ncpu ?? '—').padStart(6)) : '';
    const load = pctCell(stats?.loadPercent, 5);
    const mem = pctCell(stats?.memPercent, 6);
    const freeTotal = full
      ? '  ' +
        (stats?.reachable && stats.memTotalBytes
          ? `${fmtBytes(stats.memFreeBytes)}/${fmtBytes(stats.memTotalBytes)}`.padEnd(12)
          : chalk.gray('—'.padEnd(12)))
      : '';
    const badge = HEADROOM_BADGE[headroom(stats)];
    const here = isSelf ? chalk.cyan('  ← this machine') : '';
    lines.push(`${marker}${label}${plat} ${cores}${load}${mem}${freeTotal}  ${badge}${relay}${here}`);
  }

  // Fleet capacity summary — total cores + how much RAM is free right now.
  const cap = fleetCapacity(statsMap.values());
  if (cap.reachable > 0) {
    const freePct = cap.memTotalBytes > 0 ? Math.round((cap.memFreeBytes / cap.memTotalBytes) * 100) : 0;
    lines.push(
      chalk.gray(
        `  Fleet capacity: ${cap.cores} cores · ${fmtBytes(cap.memFreeBytes)} free / ${fmtBytes(cap.memTotalBytes)} RAM (${freePct}% free) across ${cap.reachable} reachable device${cap.reachable === 1 ? '' : 's'}`,
      ),
    );
  }
  return lines;
}

/**
 * Live "Leased boxes" section for `agents devices` (F4, RUSH-1923), computed
 * from `crabboxList()` — these are ephemeral crabbox leases, NEVER written into
 * the device registry. Returns [] when crabbox is unavailable / has no creds /
 * reports no boxes, so the section is simply omitted. `nowSecs` is injected so
 * the row formatting is deterministic in tests.
 */
export function renderLeasedBoxesSection(boxes: CrabboxBox[], nowSecs: number): string[] {
  if (boxes.length === 0) return [];
  const lines: string[] = [];
  lines.push('');
  lines.push(chalk.bold('Leased boxes') + chalk.gray(' (ephemeral · via crabbox)'));
  lines.push(
    '  ' +
      chalk.gray('box'.padEnd(16)) +
      chalk.gray('class'.padEnd(10)) +
      chalk.gray('address'.padEnd(24)) +
      chalk.gray('status'.padEnd(9)) +
      chalk.gray('idle'.padEnd(12)) +
      chalk.gray('expires'),
  );
  for (const b of boxes) {
    const addr = boxAddress(b) ?? '—';
    lines.push(
      '  ' +
        chalk.cyan(b.slug.padEnd(16)) +
        (b.class ?? '?').padEnd(10) +
        addr.padEnd(24) +
        boxStatus(b).padEnd(9) +
        chalk.gray(fmtIdleShort(b, nowSecs).padEnd(12)) +
        chalk.gray(fmtExpiresShort(b, nowSecs)),
    );
  }
  lines.push(chalk.gray('  Reuse a box with `agents run --box <slug>` · stop with `agents lease stop <slug>`'));
  return lines;
}

/** The leased-box rows for the devices list, or [] when crabbox can't be read. */
function loadLeasedBoxesSection(): string[] {
  try {
    const boxes = crabboxList({ secretsBundle: process.env.AGENTS_LEASE_SECRETS_BUNDLE, timeoutMs: 5000 });
    return renderLeasedBoxesSection(boxes, Math.floor(Date.now() / 1000));
  } catch {
    return []; // crabbox not installed / no provider creds — omit the section
  }
}

/**
 * `agents ssh <slug>` targeting a leased crabbox box. crabbox provisions a
 * per-lease identity key, so we ssh via crabbox's OWN emitted invocation
 * (`crabboxSshArgv`) — a raw `ssh crabbox@ip` fails publickey. Returns false when
 * `name` is not a known crabbox slug so the caller can fall through to the normal
 * "Unknown device" error.
 */
function trySshLeasedBox(name: string, cmd: string[]): boolean {
  let box: CrabboxBox | null;
  try {
    box = crabboxFind(name, { secretsBundle: process.env.AGENTS_LEASE_SECRETS_BUNDLE, timeoutMs: 5000 });
  } catch {
    return false; // crabbox unavailable — not a leased-box target
  }
  if (!box) return false;
  const sshArgv = crabboxSshArgv(name, { secretsBundle: process.env.AGENTS_LEASE_SECRETS_BUNDLE, timeoutMs: 8000 });
  if (!sshArgv) {
    console.error(chalk.red(`Leased box '${name}' is not reachable yet (status: ${boxStatus(box)}).`));
    process.exit(1);
  }
  const res = spawnSync(sshArgv[0], [...sshArgv.slice(1), ...cmd], { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

/** Resolve a device or exit with a clear error. */
async function mustGetDevice(name: string): Promise<DeviceProfile> {
  const d = await getDevice(name);
  if (!d) {
    console.error(chalk.red(`Unknown device '${name}'. See 'agents devices list'.`));
    process.exit(1);
  }
  return d;
}

/**
 * Interactive `agents devices sync`: discover tailscale nodes, present a
 * checkbox pre-checked with what's already registered, and reconcile the
 * choice. Checked = registered (and un-ignored). Unchecked = removed from the
 * registry AND added to the ignore-list, so auto-discovery never re-suggests
 * it — this is the "click to register/unregister" surface, with dismissals that
 * stick.
 */
async function runInteractiveDeviceSync(): Promise<void> {
  const spinner = ora('Reading tailscale status...').start();
  let nodes;
  try {
    nodes = parseTailscaleStatus(tailscaleStatusJson());
  } catch (err: any) {
    spinner.fail(err.message);
    process.exit(1);
  }
  const [reg, ignored] = await Promise.all([loadDevices(), loadIgnored()]);
  const registered = new Set(Object.keys(reg));
  spinner.stop();

  if (nodes.length === 0) {
    console.log(chalk.gray('No tailscale nodes found.'));
    return;
  }

  const { checkbox } = await import('@inquirer/prompts');
  let selected: string[];
  try {
    selected = await checkbox({
      // Everything not already dismissed starts checked, so pressing Enter keeps
      // the fleet as-is (matching what auto-sync would register). Unchecking a
      // device removes it AND dismisses it so auto-sync never re-adds it.
      // Sharee nodes (shared in by another user) start unchecked unless already
      // registered — registering one must be a deliberate check, never the
      // default Enter.
      message: 'Your fleet — uncheck a device to remove and stop suggesting it:',
      pageSize: Math.min(nodes.length, 20),
      choices: nodes.map((n) => {
        const flags = [n.platform, n.online ? undefined : 'offline', n.sharee ? 'shared' : undefined, ignored.has(n.name) ? 'ignored' : undefined]
          .filter(Boolean)
          .join(', ');
        return { value: n.name, name: `${n.name}  ${chalk.gray(`(${flags})`)}`, checked: defaultPickerChecked(n, registered, ignored) };
      }),
    });
  } catch (err) {
    if (isPromptCancelled(err)) {
      console.log(chalk.gray('Cancelled — no changes.'));
      return;
    }
    throw err;
  }

  const byName = new Map(nodes.map((n) => [n.name, n]));
  const plan = planDeviceReconciliation(byName.keys(), selected, registered, ignored);
  const localUser = localLoginUser();
  for (const name of plan.toRegister) {
    const input = withDefaultUser(nodeToDeviceInput(byName.get(name)!), reg[name]?.user, localUser);
    await upsertDevice(name, input);
  }
  for (const name of plan.toUnignore) await removeIgnored(name);
  for (const name of plan.toRemove) await removeDevice(name);
  for (const name of plan.toIgnore) await addIgnored(name);

  const parts = [
    chalk.green(`${plan.toRegister.length} registered`),
    plan.toRemove.length ? chalk.yellow(`${plan.toRemove.length} removed`) : null,
    plan.toIgnore.length ? chalk.gray(`${plan.toIgnore.length} ignored`) : null,
  ].filter(Boolean);
  console.log(parts.join(chalk.gray(' · ')));
}

/** Print a per-device result table for fleet update/run. */
function printFleetResults(results: FleetRunResult[]): void {
  const nameW = Math.max(8, ...results.map((r) => r.name.length));
  console.log(
    chalk.bold('DEVICE'.padEnd(nameW)) + '  ' +
    chalk.bold('STATUS'.padEnd(8)) + '  ' +
    chalk.bold('DETAIL'),
  );
  for (const r of results) {
    const status =
      r.status === 'ok' ? chalk.green('ok'.padEnd(8)) :
      r.status === 'skipped' ? chalk.gray('skipped'.padEnd(8)) :
      chalk.red('failed'.padEnd(8));
    const detail =
      r.status === 'skipped' ? chalk.gray(skipLabel(r.reason as 'offline' | 'no-address')) :
      r.status === 'failed' ? chalk.red(r.detail || `exit ${r.code ?? '?'}`) :
      chalk.gray(r.code === 0 ? 'exit 0' : '');
    console.log(`${r.name.padEnd(nameW)}  ${status}  ${detail}`);
  }
  const ok = results.filter((r) => r.status === 'ok').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  console.log(chalk.gray(`${ok} ok · ${failed} failed · ${skipped} skipped`));
  if (failed > 0) process.exitCode = 1;
}

interface RemoteDoctorJson {
  clis?: FleetHealthRow['clis'];
  sync?: FleetHealthRow['sync'];
  orphans?: FleetHealthRow['orphans'];
  auth?: FleetHealthRow['auth'];
  fleet?: FleetHealthRow['inventory'];
}

interface FleetStatusTarget extends FanOutDeviceTarget {
  platform?: string;
  /**
   * The address to hand `ssh` — the registry's drift-proof Tailscale dnsName/IP
   * (via {@link fleetDialTarget}), NOT the bare device name. Dialing the bare
   * name lets ssh resolve it through the user's ~/.ssh/config, where a stale
   * hand-written `Host <name>` block with a drifted LAN IP silently shadows the
   * correct entry and makes a reachable box look dead (the 60s fleet-status hang).
   */
  dialTarget: string;
}

function localHealthRow(self: string, stats?: DeviceStats): FleetHealthRow {
  return {
    name: self,
    platform: process.platform === 'darwin' ? 'macos' : process.platform,
    version: getCliVersion(),
    stats,
    clis: checkAllClis(),
    sync: checkSyncStatus(process.cwd()),
    orphans: countOrphans(),
    // Local baseline inventory for cross-device divergence (RUSH-2027) — the
    // yardstick every remote box is compared against.
    inventory: collectLocalFleetInventory(process.cwd()),
  };
}

async function probeRemoteHealth(target: FleetStatusTarget): Promise<Omit<FleetHealthRow, 'name' | 'platform' | 'stats'>> {
  const isWin = /^win/i.test((target.platform ?? '').trim());
  const env = isWin ? undefined : { PATH: '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH' };
  const versionCmd = buildRemoteAgentsInvocation(['--version'], undefined, isWin ? 'windows' : undefined, env);
  const versionRes = await sshExecAsync(target.dialTarget, versionCmd, { timeoutMs: 15000, multiplex: true });
  const version = versionRes.code === 0 ? versionRes.stdout.trim().split(/\s+/)[0] || null : null;

  const doctorCmd = buildRemoteAgentsInvocation(['doctor', '--json'], undefined, isWin ? 'windows' : undefined, env);
  const doctorRes = await sshExecAsync(target.dialTarget, doctorCmd, { timeoutMs: 30000, multiplex: true });
  if (doctorRes.code !== 0) {
    throw new Error(doctorRes.timedOut ? 'timed out' : (doctorRes.stderr.trim() || `exit ${doctorRes.code ?? 'unknown'}`));
  }
  const parsed = JSON.parse(doctorRes.stdout) as RemoteDoctorJson;
  return {
    version,
    clis: parsed.clis ?? {},
    sync: parsed.sync ?? [],
    orphans: parsed.orphans ?? [],
    // The remote self-reports its own cached auth rollup (fresh via its daemon),
    // so the Auth column is current without a prior fleet-wide `fleet ping`.
    // Older remotes that don't emit it fall back to this host's cache below.
    auth: parsed.auth,
    // Harness inventory (resources / agent versions / repo state) for
    // cross-device divergence detection (RUSH-2027). Undefined on an older CLI
    // that doesn't emit the `fleet` field — the comparator skips it.
    inventory: parsed.fleet,
  };
}

async function runFleetStatus(opts: { json?: boolean; strict?: boolean; stats?: boolean; refresh?: boolean; live?: boolean; verbose?: boolean }): Promise<void> {
  const reg = await loadDevices();
  const self = machineId();
  const forceRefresh = Boolean(opts.refresh || opts.live);
  const planned = planFleetTargets(reg);
  const probeable = planned.filter((t) => !t.skip).map((t) => t.device);
  // Cache-first: serve remote stats from the daemon-warmed cache (instant),
  // probe this machine locally, and only ssh out for missing/forced rows.
  const statsMap = opts.stats === false
    ? new Map<string, DeviceStats>()
    : (await loadFleetStats(probeable, { forceRefresh, selfName: self })).stats;

  // Persist the live probe's reachability verdict so the online/offline word is
  // read from a fresh probe, not a stale tailscale snapshot (RUSH-1965).
  // Best-effort: a registry write must never break the status render.
  await writeReachability(collectReachabilityWriteBacks(reg, statsMap)).catch(() => {});

  const rows: FleetHealthRow[] = [localHealthRow(self, statsMap.get(self))];
  const remoteTargets: FleetStatusTarget[] = remoteFleetTargets(planned, self)
    .map((t) => ({
      name: t.device.name,
      platform: t.device.platform,
      // Fail fast: gate the expensive version+doctor dials on the reachability
      // verdict the cheap stats probe already computed one step earlier. A box
      // it found unreachable skips straight to an `unreachable` row instead of
      // burning 15s+30s per box — so one genuinely-offline device can't stall
      // the matrix for ~60s (RUSH-1964). See {@link fleetHealthSkip} for why
      // this is trusted on the default path, not just under `--refresh`.
      skip: fleetHealthSkip(t.skip, statsMap.get(t.device.name)),
      dialTarget: fleetDialTarget(t.device),
    }));
  const remote = await fanOutDevices(remoteTargets, probeRemoteHealth);
  for (const result of remote) {
    const profile = reg[result.name];
    if (result.status === 'ok' && result.value) {
      rows.push({
        name: result.name,
        platform: profile?.platform,
        stats: statsMap.get(result.name),
        ...result.value,
      });
    } else {
      rows.push({
        name: result.name,
        platform: profile?.platform,
        stats: statsMap.get(result.name),
        skipped: result.reason ? String(result.reason) : undefined,
        error: result.error,
        clis: {},
        sync: [],
        orphans: [],
      });
    }
  }

  // Auth column: remote rows already carry the host's self-reported rollup from
  // its `doctor --json`. Fill the rest (this machine; older remotes that don't
  // emit it) from this host's local cache — written by `agents fleet ping` and
  // the daemon's local refresh. A never-probed host rolls up to "—". No network.
  const authCache = readAuthHealthCache();
  for (const row of rows) {
    if (!row.auth) row.auth = summarizeHostAuth(authCache, row.name);
    // Resolve the online/offline verdict and last-seen once (RUSH-1966) so the
    // summary view reads one truth — the same `deviceOnlineState` ordering the
    // registry write-back uses — instead of re-deriving it from error/skipped.
    const profile = reg[row.name];
    if (profile) {
      row.online = deviceOnlineState(profile, statsMap.get(row.name));
      row.lastSeen = profile.tailscale?.lastSeen ?? profile.reachability?.checkedAt;
    }
  }

  const report = buildFleetHealthReport(rows, new Date(), { self });
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (opts.verbose) {
    // Full grid: the auth/CLI/sync/version columns and the warnings rollup.
    for (const line of renderFleetWarnings(report)) console.log(line);
    console.log();
    for (const line of renderFleetMatrix(report)) console.log(line);
  } else {
    // Default: rollup + NEEDS ATTENTION + OS-grouped quiet rows + footer.
    for (const line of renderFleetSummary(report, { self })) console.log(line);
  }
  if (opts.strict && report.hasWarnings) process.exitCode = 1;
}

interface FleetPingHostResult {
  host: string;
  rows: AuthProbeRow[];
  error?: string;
  skipped?: string;
}

/** SSH into a host and run its local auth probe, returning its rows. */
async function probeRemoteAuth(target: FleetStatusTarget): Promise<AuthProbeRow[]> {
  const isWin = /^win/i.test((target.platform ?? '').trim());
  const env = isWin ? undefined : { PATH: '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH' };
  const cmd = buildRemoteAgentsInvocation(['devices', 'ping', '--local', '--json'], undefined, isWin ? 'windows' : undefined, env);
  const res = await sshExecAsync(target.dialTarget, cmd, { timeoutMs: 15000, multiplex: true });
  if (res.code !== 0) {
    throw new Error(res.timedOut ? 'timed out' : (res.stderr.trim() || `exit ${res.code ?? 'unknown'}`));
  }
  const parsed = JSON.parse(res.stdout) as { host: string; rows: AuthProbeRow[] };
  return parsed.rows ?? [];
}

/**
 * Race `fanOut` against an overall wall-clock deadline (RUSH-2041).
 *
 * If `fanOut` settles first the result passes through unchanged. If the
 * deadline fires first every pending remote target is mapped to `failed` (or
 * `skipped` for pre-skipped targets), so callers always get a complete result
 * array and the command exits promptly rather than hanging.
 *
 * Exported so the unit test can exercise the real path with a hanging probe
 * instead of reimplementing the logic.
 */
export async function raceFleetPingDeadline<T, Target extends FanOutDeviceTarget>(
  fanOut: Promise<import('../lib/devices/fleet.js').FanOutDeviceResult<T>[]>,
  remoteTargets: Target[],
  overallTimeoutMs: number,
): Promise<import('../lib/devices/fleet.js').FanOutDeviceResult<T>[]> {
  const overallDeadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('fleet ping overall deadline exceeded')), overallTimeoutMs),
  );
  try {
    return await Promise.race([fanOut, overallDeadline]);
  } catch (err) {
    // Overall deadline hit before all devices settled — mark every pending
    // device as failed so the command exits promptly. Individual probes that
    // already settled are not retrievable (Promise.all internals), so we
    // record all remote targets as timed out / skipped.
    const errMsg = err instanceof Error ? err.message : String(err);
    return remoteTargets.map((t) => ({
      name: t.name,
      status: t.skip ? ('skipped' as const) : ('failed' as const),
      reason: t.skip,
      error: t.skip ? undefined : errMsg,
    }));
  }
}

async function runFleetPing(opts: { json?: boolean; local?: boolean; verbose?: boolean; strict?: boolean }): Promise<void> {
  const self = machineId();
  const cliVersion = getCliVersion();

  // --local: probe just this host. Used both directly and as the fan-out worker.
  if (opts.local) {
    const rows = await probeLocalFleetAuth({ cliVersion });
    writeFleetAuthRows(self, rows);
    if (opts.json) {
      console.log(JSON.stringify({ host: self, rows }));
    } else {
      for (const line of renderAuthMatrix([{ host: self, rows }], { verbose: opts.verbose })) console.log(line);
    }
    if (opts.strict && rows.some((r) => isDeadVerdict(r.health.verdict))) {
      process.exitCode = 1;
    }
    return;
  }

  // Origin: probe locally, then fan out to the rest of the fleet in parallel.
  const reg = await loadDevices();
  const planned = planFleetTargets(reg);
  const results: FleetPingHostResult[] = [];

  const localRows = await probeLocalFleetAuth({ cliVersion });
  writeFleetAuthRows(self, localRows);
  results.push({ host: self, rows: localRows });

  const remoteTargets: FleetStatusTarget[] = remoteFleetTargets(planned, self).map((t) => ({
    name: t.device.name,
    platform: t.device.platform,
    skip: t.skip,
    dialTarget: fleetDialTarget(t.device),
  }));
  const probeable = remoteTargets.filter((t) => !t.skip).length;
  const spinner = isInteractiveTerminal() && !opts.json
    ? ora(`Pinging ${probeable} device${probeable === 1 ? '' : 's'}…`).start()
    : undefined;
  // Per-device: 15 s (matches the version probe budget; enough for the ~8 s
  // provider-fetch inside the remote local auth probe, with headroom).
  // Overall: 30 s hard cap so the command can never outlast a reasonable
  // budget when several devices are simultaneously unreachable (RUSH-2041).
  const FLEET_PING_DEVICE_TIMEOUT_MS = 15_000;
  const FLEET_PING_OVERALL_TIMEOUT_MS = 30_000;
  let remote: Awaited<ReturnType<typeof fanOutDevices<AuthProbeRow[], FleetStatusTarget>>>;
  try {
    const fanOut = fanOutDevices(remoteTargets, probeRemoteAuth, { perDeviceTimeoutMs: FLEET_PING_DEVICE_TIMEOUT_MS });
    remote = await raceFleetPingDeadline(fanOut, remoteTargets, FLEET_PING_OVERALL_TIMEOUT_MS);
  } finally {
    spinner?.stop();
  }
  for (const r of remote) {
    if (r.status === 'ok' && r.value) {
      results.push({ host: r.name, rows: r.value });
      writeFleetAuthRows(r.name, r.value);
    } else {
      results.push({
        host: r.name,
        rows: [],
        error: r.error,
        skipped: r.reason ? String(r.reason) : undefined,
      });
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const line of renderAuthMatrix(results, { verbose: opts.verbose })) console.log(line);
  }

  const anyBad = results.some((r) => r.rows.some((row) => isDeadVerdict(row.health.verdict)));
  if (opts.strict && anyBad) process.exitCode = 1;
}

/** Resolve an {@link AuthCellColor} to a chalk painter. Single map for cells + labels. */
const CELL_PAINT: Record<AuthCellColor, (s: string) => string> = {
  green: chalk.green,
  yellow: chalk.yellow,
  red: chalk.red,
  gray: chalk.gray,
  dim: chalk.dim,
};

/**
 * Color a per-host×agent cell. The numerator counts accounts that are usable
 * right now — live-verified PLUS signed-in-but-unverifiable (codex/grok) — over
 * the total, so a logged-in codex fleet reads "1/1", not a scary "0/1". Color is
 * the shared {@link authCellColor}: red only for revoked (re-login), yellow for
 * soft/expired (self-refreshes), gray for present-but-unverifiable, green when
 * all live.
 */
function authCell(summary: VerdictSummary, width: number): string {
  if (summary.total === 0) return chalk.dim('·'.padEnd(width));
  const ok = summary.live + summary.present;
  const padded = `${ok}/${summary.total}`.padEnd(width);
  return CELL_PAINT[authCellColor(summary)](padded);
}

/** Render the fleet auth matrix (device rows × agent columns) plus an optional per-account breakdown. */
function renderAuthMatrix(results: FleetPingHostResult[], opts?: { verbose?: boolean }): string[] {
  // Only show agent columns that appear somewhere in the results.
  const present = new Set<string>();
  for (const r of results) for (const row of r.rows) present.add(row.agent);
  const agents = ALL_AGENT_IDS.filter((a) => present.has(a));
  const cellW = 6; // 6 disambiguates opencode/openclaw (both 'openc' at 5)
  const nameW = Math.max(6, ...results.map((r) => r.host.length));

  const lines: string[] = [chalk.bold('Fleet auth')];
  const header = `  ${'Device'.padEnd(nameW)}  ${agents.map((a) => a.slice(0, cellW).padEnd(cellW)).join(' ')}`;
  lines.push(chalk.gray(header));

  for (const r of results) {
    const cells = agents.map((a) => {
      const verdicts = r.rows.filter((row) => row.agent === a).map((row) => row.health.verdict);
      return authCell(summarizeVerdicts(verdicts), cellW);
    });
    let note = '';
    if (r.skipped) note = chalk.dim(`  ${r.skipped}`);
    else if (r.error) note = chalk.red(`  ${r.error}`);
    else {
      const dead = r.rows.filter((row) => isDeadVerdict(row.health.verdict)).length;
      if (dead > 0) note = chalk.red(`  ${dead} revoked — re-login`);
    }
    lines.push(`  ${r.host.padEnd(nameW)}  ${cells.join(' ')}${note}`);
  }

  lines.push('');
  lines.push(chalk.gray('  cell = signed-in/total accounts · green live · gray signed-in (unverifiable: codex/grok) · yellow expired (self-refreshes) · red revoked (re-login)'));

  if (opts?.verbose) {
    lines.push('');
    lines.push(chalk.bold('Accounts'));
    for (const r of results) {
      if (r.rows.length === 0) continue;
      for (const row of r.rows.slice().sort((x, y) => (x.agent + x.version).localeCompare(y.agent + y.version))) {
        const v = row.health.verdict;
        const label = CELL_PAINT[verdictColor(v)](verdictLabel(v));
        const acctRaw = row.account ?? '—';
        const acct = row.account ? chalk.cyan(acctRaw.padEnd(28)) : chalk.dim(acctRaw.padEnd(28));
        const detail = row.health.detail ? chalk.dim(` ${row.health.detail}`) : '';
        const age = chalk.dim(` · ${formatCheckedAge(row.health.checkedAt)}`);
        lines.push(`  ${r.host.padEnd(nameW)}  ${`${row.agent}@${row.version}`.padEnd(22)}  ${acct}  ${label}${detail}${age}`);
      }
    }
  }

  return lines;
}

/** Render the final `fleet login` result summary in the house auth-matrix style. */
function renderLoginMatrix(results: LoginStatus[]): string[] {
  const lines: string[] = [chalk.bold('Fleet login')];
  if (results.length === 0) {
    lines.push(chalk.gray('  Nothing pending — every requested account is already logged in.'));
    return lines;
  }
  const nameW = Math.max(6, ...results.map((r) => `${r.agent}@${r.device}`.length));
  for (const r of results) {
    const who = `${r.agent}@${r.device}`.padEnd(nameW);
    let badge: string;
    switch (r.state) {
      case 'authorized': badge = chalk.green('authorized'); break;
      case 'ready': badge = chalk.cyan('code ready'); break;
      case 'driving': badge = chalk.yellow('driving'); break;
      case 'skipped': badge = chalk.gray('not remotable'); break;
      case 'error': badge = chalk.red('error'); break;
      default: badge = chalk.gray(r.state); break;
    }
    const note = r.detail ? chalk.dim(`  ${r.detail}`) : (r.reason && !r.remotable ? chalk.dim(`  ${r.reason}`) : '');
    lines.push(`  ${who}  ${badge}${note}`);
  }
  const auth = results.filter((r) => r.state === 'authorized').length;
  const remotable = results.filter((r) => r.remotable).length;
  lines.push('');
  lines.push(chalk.gray(`  ${auth}/${remotable} remotable logins authorized`));
  return lines;
}

/** Register the `agents devices` command tree (also aliased as `fleet`). */
function registerDevicesCommands(program: Command): void {
  const devicesCmd = program
    .command('devices')
    .alias('fleet')
    .description('Registry of SSH device profiles (platform, user, address, auth), self-populated from Tailscale. Alias: fleet.')
    .addHelpText('after', `
Typical workflow:
  agents devices sync            # curate: pick which tailscale nodes to keep (TTY)
  agents devices sync --yes      # non-interactive: register all non-ignored nodes
  agents devices list            # see what's registered
  agents devices ignore ipad165  # dismiss a node so it's never re-suggested
  agents devices set win-mini --auth password --bundle muqsit
  agents devices render --write  # write ~/.ssh/config.d/agents include
  agents fleet update            # roll out latest agents-cli to every online device
  agents fleet run uname -a      # run a command on every online device

\`agents fleet\` is an alias for \`agents devices\` — same subcommands.
`);

  devicesCmd
    .command('sync')
    .description('Ingest `tailscale status --json` into device profiles. In a terminal, opens a checkbox to register/unregister nodes; with --yes, registers every non-ignored node.')
    .option('--yes', 'skip the picker; register all discovered non-ignored nodes')
    .action(async (opts: { yes?: boolean }) => {
      if (isInteractiveTerminal() && !opts.yes) {
        await runInteractiveDeviceSync();
        return;
      }
      const spinner = ora('Reading tailscale status...').start();
      try {
        const res = await runDeviceSync();
        const extra = res.pending.length ? chalk.gray(` (${res.pending.length} new)`) : '';
        spinner.succeed(`Synced ${res.synced} device${res.synced === 1 ? '' : 's'} from Tailscale${extra}`);
      } catch (err: any) {
        spinner.fail(err.message);
        process.exit(1);
      }
    });

  // `agents fleet capture` — snapshot live state into agents.yaml fleet:.
  registerFleetCaptureCommand(devicesCmd);

  // `agents fleet apply` — same reconcile engine as the top-level `agents apply`,
  // surfaced under the fleet tree for discoverability.
  registerFleetApplyAlias(devicesCmd);

  devicesCmd
    .command('register <name>')
    .description('Register a discovered (pending) node by name — used by the menu-bar "NEW DEVICES → Register" action.')
    .action(async (name: string) => {
      try {
        const nodes = parseTailscaleStatus(tailscaleStatusJson());
        const node = nodes.find((n) => n.name === name);
        if (!node) {
          console.error(chalk.red(`'${name}' is not a current tailscale node. See 'agents devices sync'.`));
          process.exit(1);
        }
        await removeIgnored(name); // a re-registered node is no longer dismissed
        const d = await upsertDevice(name, nodeToDeviceInput(node));
        clearPendingSentinel(name); // drop the notification immediately
        console.log(chalk.green(`Registered '${name}'`) + chalk.gray(` (${d.platform})`));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  devicesCmd
    .command('ignore <name>')
    .description('Dismiss a node from auto-discovery so it is never re-suggested (and remove it from the registry if present).')
    .action(async (name: string) => {
      try {
        await removeDevice(name);
        await addIgnored(name);
        clearPendingSentinel(name); // drop the notification immediately
        console.log(chalk.green(`Ignored '${name}'`) + chalk.gray(" — it won't be suggested again. Undo with `agents devices unignore`."));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  devicesCmd
    .command('unignore <name>')
    .description('Undo `ignore`: allow a node to be discovered and registered again.')
    .action(async (name: string) => {
      const ok = await removeIgnored(name);
      if (!ok) {
        console.error(chalk.gray(`'${name}' was not ignored.`));
        return;
      }
      console.log(chalk.green(`No longer ignoring '${name}'`) + chalk.gray(' — run `agents devices sync` to register it.'));
    });

  const runList = async (opts: { json?: boolean; stats?: boolean; full?: boolean; refresh?: boolean; live?: boolean } = {}) => {
    const reg = await loadDevices();
    const names = Object.keys(reg).sort();
    if (opts.json) {
      // Registry-only, always fast — the Factory extension polls this path.
      process.stdout.write(JSON.stringify(names.map((n) => reg[n]), null, 2) + '\n');
      return;
    }
    if (names.length === 0) {
      console.log(chalk.gray("No devices. Run 'agents devices sync' or 'agents devices add <name> <user@host>'."));
      return;
    }
    const self = machineId();
    const forceRefresh = Boolean(opts.refresh || opts.live);

    let statsMap: Map<string, DeviceStats> | undefined;
    let freshness: { oldestFetchedAt: number | null; servedFromCache: boolean } | undefined;
    if (opts.stats !== false) {
      // Cache-first: serve remote devices from the daemon-warmed cache
      // (instant), probe this machine locally, and only ssh out for missing or
      // forced (--refresh/--live) rows — so a warm read never hangs on a box.
      const probeable = planFleetTargets(reg)
        .filter((t) => !t.skip)
        .map((t) => t.device);
      // Only spin when we'll actually ssh (forced, or a cold/partial cache).
      const cache = readStatsCache();
      const willSsh = forceRefresh || probeable.some((d) => d.name !== self && !cache[d.name]);
      const spinner = willSsh && isInteractiveTerminal()
        ? ora(`Probing ${probeable.length} device${probeable.length === 1 ? '' : 's'}…`).start()
        : undefined;
      try {
        const res = await loadFleetStats(probeable, { forceRefresh, selfName: self });
        statsMap = res.stats;
        freshness = res;
      } finally {
        spinner?.stop();
      }
      // Write the live verdict back so this and every other consumer read one
      // reachability truth instead of the stale tailscale snapshot (RUSH-1965).
      if (statsMap) await writeReachability(collectReachabilityWriteBacks(reg, statsMap)).catch(() => {});
    }

    console.log(chalk.bold(`Devices (${names.length})`));
    for (const line of renderDeviceTable(reg, names, self, statsMap, opts.full)) console.log(line);
    if (freshness?.servedFromCache && freshness.oldestFetchedAt != null) {
      console.log(chalk.gray(`  updated ${formatCheckedAge(freshness.oldestFetchedAt)} — pass --refresh (--live) for a live probe`));
    }
    // Ephemeral crabbox leases live alongside the registered fleet but are never
    // written into the registry — surface them as their own live section. This is
    // a live provider call, so honor --no-stats (the explicit "instant, no probes"
    // opt-out) and bound it so a slow provider can't hang `agents devices`.
    if (opts.stats !== false) {
      for (const line of loadLeasedBoxesSection()) console.log(line);
    }
  };

  devicesCmd.action(runList);

  devicesCmd
    .command('list')
    .alias('ls')
    .description('List registered devices with platform, address, reachability, and live resource headroom.')
    .option('--json', 'output the registry as a JSON array (for scripts and hooks)')
    .option('--no-stats', 'skip the live resource probe (instant; names/addresses only)')
    .option('--refresh', 'force a live probe of every device, bypassing the cache')
    .option('--live', 'alias of --refresh (shorter to type)')
    .option('-f, --full', 'full mode: add per-device core count and free/total memory')
    .action(runList);

  devicesCmd
    .command('status')
    .description('Fleet health at a glance: online/offline rollup, a NEEDS ATTENTION list (each with its fix command), and quiet per-device rows grouped by OS. Use --verbose for the full auth/CLI/sync grid.')
    .option('--json', 'output machine-readable JSON')
    .option('--strict', 'exit non-zero when any device has drift or is unreachable')
    .option('--no-stats', 'skip the live resource probe')
    .option('--refresh', 'force a live probe of every device, bypassing the cache')
    .option('--live', 'alias of --refresh (shorter to type)')
    .option('--verbose', 'show the full per-device auth/CLI/sync/version grid instead of the summary')
    .action(async (opts: { json?: boolean; strict?: boolean; stats?: boolean; refresh?: boolean; live?: boolean; verbose?: boolean }, cmd: Command) => {
      // The root program also defines a global `--verbose`; commander binds a
      // shared long flag to the program, not the leaf. Read the effective value
      // from the merged globals so `fleet status --verbose` works at either level
      // (same pattern as `fleet ping --verbose`).
      const verbose = opts.verbose ?? Boolean(cmd.optsWithGlobals().verbose);
      await runFleetStatus({ ...opts, verbose });
    });

  devicesCmd
    .command('ping')
    .description('Live auth health: complete a real request for every agent account across the fleet (unlike the cached "signed in" flag). Writes the shared auth-health cache read by `agents view` and `fleet status`.')
    .option('--json', 'output machine-readable JSON')
    .option('--local', 'probe only this host (used internally for fan-out)')
    .option('--verbose', 'show a per-account breakdown, not just the per-host rollup')
    .option('--strict', 'exit non-zero when any account is revoked (expired is soft — it self-refreshes)')
    .action(async (opts: { json?: boolean; local?: boolean; verbose?: boolean; strict?: boolean }, cmd: Command) => {
      // The root program also defines a global `--verbose` (startup self-heal
      // detail), and commander binds a shared long flag to the program, not the
      // leaf — so `fleet ping --verbose` never set opts.verbose and the
      // per-account breakdown was silently unreachable. Read the effective value
      // from the merged globals so the flag works at either level.
      const verbose = opts.verbose ?? Boolean(cmd.optsWithGlobals().verbose);
      await runFleetPing({ ...opts, verbose });
    });

  devicesCmd
    .command('login')
    .description('Log agent CLIs into fleet boxes over SSH: drive each box\'s device-code OAuth, scrape the URL + code, and surface every pending login in one local browser page. Default drives all codes at once; --interactive walks one box at a time (codes requested just-in-time so they don\'t expire).')
    .option('--agents <csv>', 'only these agents (comma-separated); default: every agent with a device-code flow')
    .option('--devices <csv>', 'only these devices (comma-separated); default: every online box')
    .option('--all', 'target every device-code pair regardless of cached login state (cold cache / forced re-login)')
    .option('--interactive', 'guided one-box-at-a-time wizard (codes requested just-in-time)')
    .option('--json', 'output the final result matrix as JSON')
    .action(async (opts: { agents?: string; devices?: string; all?: boolean; interactive?: boolean; json?: boolean }) => {
      const csv = (s?: string) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
      const results = await runFleetLogin({
        agents: csv(opts.agents),
        devices: csv(opts.devices),
        all: opts.all,
        interactive: opts.interactive,
        json: opts.json,
      });
      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        for (const line of renderLoginMatrix(results)) console.log(line);
      }
      if (results.some((r) => r.remotable && r.state !== 'authorized')) process.exitCode = 1;
    });

  devicesCmd
    .command('show <name>')
    .description('Show the full profile for one device.')
    .action(async (name: string) => {
      const d = await mustGetDevice(name);
      console.log(JSON.stringify(d, null, 2));
    });

  devicesCmd
    .command('add <name> <target>')
    .description('Add a device manually (target is user@host or host).')
    .option('--platform <platform>', 'windows | linux | macos')
    .action(async (name: string, target: string, opts: { platform?: string }) => {
      try {
        const { host, user } = splitUserHost(target);
        const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
        const d = await upsertDevice(name, {
          platform: (opts.platform as DevicePlatform) ?? undefined,
          user,
          address: { via: 'manual', dnsName: isIp ? undefined : host, ip: isIp ? host : undefined },
        });
        console.log(chalk.green(`Added device '${name}'`) + chalk.gray(` (${d.platform}, ${user ? user + '@' : ''}${host})`));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  devicesCmd
    .command('set <name>')
    .description('Update fields on an existing device (platform, user, auth).')
    .option('--platform <platform>', 'windows | linux | macos')
    .option('--user <user>', 'login user')
    .option('--auth <method>', 'key | password')
    .option('--bundle <bundle>', 'secrets bundle holding the password (for --auth password)')
    .option('--bundle-key <key>', "key within the bundle (default 'password')")
    .action(async (name: string, opts: { platform?: string; user?: string; auth?: string; bundle?: string; bundleKey?: string }) => {
      try {
        const existing = await mustGetDevice(name);
        const auth = opts.auth || opts.bundle || opts.bundleKey
          ? {
              method: (opts.auth as DeviceAuthMethod) ?? existing.auth.method,
              bundle: opts.bundle ?? existing.auth.bundle,
              bundleKey: opts.bundleKey ?? existing.auth.bundleKey,
            }
          : undefined;
        const d = await upsertDevice(name, {
          platform: (opts.platform as DevicePlatform) ?? undefined,
          user: opts.user ?? undefined,
          auth,
        });
        console.log(chalk.green(`Updated device '${name}'`) + chalk.gray(` (auth: ${d.auth.method}${d.auth.bundle ? ` via ${d.auth.bundle}` : ''})`));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  devicesCmd
    .command('pair-ios [name]')
    .description('Pair an iPhone/iPad cockpit (RUSH-1733): mint a control token for `agents serve --control` and mark the device control-only. The token is shown ONCE — enter it in the app. Run this on the anchor.')
    .option('--port <n>', 'Anchor control port to advertise to the app', String(DEFAULT_SERVE_PORT))
    .action(async (name: string | undefined, opts: { port?: string }) => {
      const label = (name || 'iphone').trim();
      // Mint the bearer token — hash-only on disk, raw shown once (see serve/token.ts).
      const { id, token } = addControlToken(label);
      // If a device with this name is already registered (e.g. discovered over
      // Tailscale as an `unknown`-platform node), mark it control-only so the
      // fleet stops trying to dial it for sessions/placement.
      let marked = false;
      let unknownName = false;
      if (name) {
        const existing = await getDevice(name);
        if (existing) {
          await upsertDevice(name, { role: 'control' });
          marked = true;
        } else {
          unknownName = true;
        }
      }
      const port = parseInt(opts.port ?? '', 10) || DEFAULT_SERVE_PORT;

      console.log(chalk.green(`Paired cockpit '${label}'`) + chalk.gray(` (token id ${id})`));
      if (marked) console.log(chalk.gray(`Marked device '${name}' role=control — the fleet won't dial it.`));
      if (unknownName) {
        console.log(
          chalk.yellow(`Note: no registered device named '${name}' — token minted, but no device was marked role=control.`) +
            chalk.gray(` Run \`agents devices sync\` first if this phone should appear in the fleet.`),
        );
      }
      console.log();
      console.log(chalk.bold('Control token (shown once — enter it in the app):'));
      console.log('  ' + chalk.cyan(token));
      console.log();
      console.log('On the anchor, expose the control server on your tailnet:');
      console.log(chalk.gray(`  agents serve --control --bind <anchor-tailnet-ip> --port ${port}`));
      console.log('Then point the app at:');
      console.log(chalk.gray(`  http://<anchor-tailnet-ip>:${port}   (Bearer: the token above)`));
      console.log(chalk.yellow('Keep the control server on the tailnet — never public Funnel.'));
    });

  devicesCmd
    .command('rm <name>')
    .alias('remove')
    .description('Remove a device from the registry.')
    .action(async (name: string) => {
      const ok = await removeDevice(name);
      if (!ok) {
        console.error(chalk.red(`Unknown device '${name}'.`));
        process.exit(1);
      }
      console.log(chalk.green(`Removed device '${name}'`));
    });

  devicesCmd
    .command('render')
    .description('Render the registry to ssh_config. Prints to stdout, or use --write to update ~/.ssh/config.d/agents.')
    .option('--write', 'write to ~/.ssh/config.d/agents instead of printing')
    .action(async (opts: { write?: boolean }) => {
      const reg = await loadDevices();
      const text = renderSshConfig(reg);
      if (!opts.write) {
        process.stdout.write(text);
        return;
      }
      const dir = path.join(os.homedir(), '.ssh', 'config.d');
      const file = path.join(dir, 'agents');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, text, { mode: 0o600 });
      console.log(chalk.green(`Wrote ${file}`));
      console.log(chalk.gray('Add this to ~/.ssh/config (once):  Include config.d/agents'));
    });

  devicesCmd
    .command('update')
    .description('Roll out agents-cli to every online registered device (`agents upgrade --yes` on each). Offline devices are skipped.')
    .argument('[version]', 'Target version or dist-tag (default: latest)')
    .action(async (version: string | undefined) => {
      let cmd: string[];
      try {
        cmd = upgradeCommand(version);
      } catch (err: any) {
        console.error(chalk.red(err?.message ?? err));
        process.exit(1);
      }
      const reg = await loadDevices();
      const targets = planFleetTargets(reg);
      if (targets.length === 0) {
        console.log(chalk.gray("No devices. Run 'agents devices sync' first."));
        return;
      }
      console.log(chalk.gray(`Running \`${cmd.join(' ')}\` on ${targets.filter((t) => !t.skip).length} online device(s)…`));
      const results = runFleet(targets, cmd, { self: machineId() });
      printFleetResults(results);
    });

  devicesCmd
    .command('run <cmd...>')
    .description('Run a command on every online registered device. Offline devices are skipped. Alias surface: agents fleet run …')
    .allowUnknownOption()
    .action(async (cmd: string[]) => {
      if (!cmd.length) {
        console.error(chalk.red('Usage: agents fleet run <cmd...>'));
        process.exit(1);
      }
      const reg = await loadDevices();
      const targets = planFleetTargets(reg);
      if (targets.length === 0) {
        console.log(chalk.gray("No devices. Run 'agents devices sync' first."));
        return;
      }
      console.log(chalk.gray(`Running \`${cmd.join(' ')}\` on ${targets.filter((t) => !t.skip).length} online device(s)…`));
      const results = runFleet(targets, cmd, { self: machineId() });
      printFleetResults(results);
    });
}

/** Register the `agents ssh` smart wrapper. */
function registerSshWrapper(program: Command): void {
  const sshCmd = program
    .command('ssh <name> [cmd...]')
    .description('Connect to a registered device. Preflights reachability, picks the right shell, and authenticates (key or password-from-bundle).')
    .allowUnknownOption()
    .addHelpText('after', `
Examples:
  agents ssh win-mini                       # interactive login
  agents ssh win-mini hostname              # run a command (PowerShell on Windows)
  agents ssh yosemite-s0 uptime             # run a command (POSIX)

Devices come from 'agents devices'. Password auth pulls the secret from a
secrets bundle via an askpass shim — the password never touches argv.
`)
    .action(async (name: string, cmd: string[]) => {
      // Hidden askpass bridge: ssh execs the shim, which re-invokes us here.
      if (name === '__askpass') {
        await runAskpass();
        return;
      }
      // Accept the full fleet target grammar: a registered `name`, a
      // `user@device` (same device, login user overridden — dialed via its
      // Tailscale route, not LAN DNS), or an ad-hoc `user@host`/`host` literal.
      // A bare unregistered alias still errors as "Unknown device".
      const device = await resolveDeviceTarget(name);
      if (!device) {
        // Not a registered device — it may be a leased crabbox box slug. ssh into
        // it directly (crabbox@<tailnet|ip>:2222) before giving up.
        trySshLeasedBox(name, cmd); // exits the process on a match
        console.error(chalk.red(`Unknown device '${name}'. See 'agents devices list'.`));
        process.exit(1);
      }

      // Preflight: a device Tailscale last saw offline would otherwise hang
      // for the full ConnectTimeout. Fail fast with a clear message instead.
      if (device.tailscale && !device.tailscale.online) {
        console.error(chalk.red(`Device '${device.name}' is offline (Tailscale last saw it ${device.tailscale.lastSeen ?? 'a while ago'}).`));
        console.error(chalk.gray("Run 'agents devices sync' to refresh reachability."));
        process.exit(1);
      }
      if (device.tailscale?.online && !device.tailscale.direct) {
        console.error(chalk.yellow(`Note: connection to '${device.name}' is relayed (DERP ${device.tailscale.relay ?? '?'}) — expect higher latency.`));
      }

      try {
        const shim = writeAskpassShim();
        // Pin the host key on first connect and verify strictly thereafter: the
        // managed known_hosts store must exist before ssh writes the learned key
        // into it, and a host already recorded there is checked with
        // StrictHostKeyChecking=yes (RUSH-1767).
        ensureManagedKnownHostsDir();
        const addr = hostNameFor(device);
        const pinned = addr ? isHostPinned(addr) : false;
        const { args, env } = buildSshInvocation(device, cmd, shim, { pinned });

        // Interactive login: make the local terminal's terminfo (e.g.
        // xterm-ghostty) available on the remote so backspace/colors/clear work.
        // Best-effort + cached per host — never blocks the login (see terminfo.ts).
        if (cmd.length === 0 && shouldSyncTerminfo({ term: process.env.TERM, shell: device.shell, interactive: process.stdout.isTTY ?? false })) {
          const { args: tinfoArgs, env: tinfoEnv } = buildSshInvocation(device, ['tic', '-x', '-'], shim, { pinned });
          syncTerminfoToDevice({ device, host: terminfoHostKey(device, addr), term: process.env.TERM, sshArgs: tinfoArgs, sshEnv: tinfoEnv });
        }

        const res = spawnSync('ssh', args, {
          stdio: 'inherit',
          env: { ...process.env, ...env },
        });
        process.exit(res.status ?? 1);
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  // Keep the hidden askpass invocation out of help.
  void sshCmd;
}

/**
 * The askpass side of password auth. Invoked by the shim (which ssh execs with
 * SSH_ASKPASS): read the target bundle/key from the environment the wrapper
 * set, resolve it through the existing Keychain path, and print the password
 * to stdout for ssh to consume.
 */
async function runAskpass(): Promise<void> {
  const bundle = process.env[ASKPASS_BUNDLE_ENV];
  const key = process.env[ASKPASS_KEY_ENV] ?? 'password';
  if (!bundle) {
    console.error(`askpass: ${ASKPASS_BUNDLE_ENV} not set`);
    process.exit(1);
  }
  // A read-only stats probe sets ASKPASS_AGENT_ONLY_ENV to force a broker-only
  // resolve even under a TTY — so `agents devices` never pops Touch ID just to
  // render load/mem for an uncached password-auth device (RUSH-1970). Otherwise
  // fall back to the headless-context heuristic.
  const agentOnly = process.env[ASKPASS_AGENT_ONLY_ENV] === '1' || isHeadlessSecretsContext();
  try {
    const { env } = readAndResolveBundleEnv(bundle, { caller: 'agents ssh', keys: [key], keyMode: 'storage', agentOnly });
    const value = env[key];
    if (value === undefined) {
      console.error(`askpass: key '${key}' not found in bundle '${bundle}'`);
      process.exit(1);
    }
    process.stdout.write(value);
  } catch (err: any) {
    console.error(`askpass: ${err?.message ?? err}`);
    process.exit(1);
  }
}

/** Register both `agents ssh` and `agents devices`. */
export function registerSshCommands(program: Command): void {
  registerSshWrapper(program);
  registerDevicesCommands(program);
}
