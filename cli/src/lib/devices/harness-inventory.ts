/**
 * Per-device harness inventory: for every installed (agent, version) on a host,
 * resolve its account identity, sign-in state, usage quota, and a single "ready"
 * verdict — the data behind `agents devices harnesses` and `agents devices
 * accounts`.
 *
 * The collector ({@link collectLocalHarnessInventory}) runs on ONE host (the
 * `--local` worker); the command fans it out over SSH exactly like
 * `agents devices ping`. Everything else here is pure so the table/grouping/ready
 * logic is unit-tested without a shell or a network.
 *
 * Quota is read cache-only by default (the daemon warms the usage cache every few
 * minutes), so a glance never blocks on a per-account network fetch; `--refresh`
 * opts into a live read.
 */
import chalk from 'chalk';

import {
  ALL_AGENT_IDS,
  accountDisplayLabel,
  getAccountInfo,
  type AccountInfo,
} from '../agents.js';
import type { AgentId } from '../types.js';
import {
  deriveUsageStatusFromSnapshot,
  getUsageInfoByIdentity,
  getUsageLookupKey,
  type UsageIdentityInput,
  type UsageSnapshot,
} from '../accounting/usage.js';
import { getVersionHomePath, listInstalledVersions } from '../installations/store.js';
import { readMeta } from '../state.js';
import { listNativeAccounts } from '../account-registry.js';

/** An account's usage headroom rolled into one glanceable summary. */
export interface QuotaSummary {
  /**
   * `available` / `rate_limited` from the live usage windows, or `null` when
   * there is no snapshot at all (no data yet, or the agent has no usage source).
   */
  status: 'available' | 'rate_limited' | 'out_of_credits' | null;
  /** Canonical launch verdict. Kept separate from utilization for JSON clients. */
  verdict: 'available' | 'rate_limited' | 'out_of_credits' | 'unavailable';
  /** Max utilization across blocking windows (0-100, rounded), or null when unknown. */
  usedPercent: number | null;
  /** True when the snapshot is a cached `last_seen`, not a fresh `live` read. */
  stale: boolean;
  /** ISO-8601 timestamp for the underlying usage observation. */
  capturedAt: string | null;
  /** Earliest reset across blocking windows, ISO-8601. */
  resetsAt: string | null;
  /** Why quota could not be evaluated; null when a verdict is available. */
  unavailableReason: string | null;
}

/** One installed (agent, version) on a host, fully resolved. */
export interface HarnessRow {
  agent: AgentId;
  version: string;
  /** Account display label (email / id), or null when signed out or unidentifiable. */
  account: string | null;
  signedIn: boolean;
  quota: QuotaSummary;
  /** signed in AND not rate-limited — usable for a run right now. */
  ready: boolean;
  /** When `!ready`, a short reason ("signed out" / "rate-limited"). */
  reason?: string;
}

/** One host's rows, or the reason it produced none. */
export interface HostHarnessResult {
  host: string;
  rows: HarnessRow[];
  /** Set when the host failed to probe (offline / error). */
  error?: string;
  /** Set when the host was skipped (control / offline). */
  skipped?: string;
}

/** An account collapsed across the installs on one host that share it. */
export interface AccountGroup {
  /** Account display label, or null for the signed-out bucket. */
  account: string | null;
  /** Distinct agent ids using this account, sorted. */
  agents: AgentId[];
  /** How many (agent, version) installs share this account. */
  installs: number;
  /** True when at least one install under this account is signed in. */
  signedIn: boolean;
  /** Representative quota — an account maps to one provider identity, so its usage is shared. */
  quota: QuotaSummary;
  ready: boolean;
  reason?: string;
}

/**
 * Roll one usage snapshot into a {@link QuotaSummary}. Mirrors the blocking-window
 * selection of {@link deriveUsageStatusFromSnapshot} (the model-specific
 * `sonnet_week` sub-limit is excluded so hitting it doesn't read as a throttled
 * account) and takes the highest utilization across those windows. Pure.
 */
export function summarizeQuota(
  snapshot: UsageSnapshot | null | undefined,
  unavailableReason: string | null = null,
  accountStatus: AccountInfo['usageStatus'] = null,
): QuotaSummary {
  if (!snapshot || snapshot.windows.length === 0) {
    // An active refusal marker (persisted out_of_credits, or an unexpired
    // session_limit) blocks even when there are no live utilization windows —
    // which is the normal state hours/days after a run, once cached windows
    // expire. Check it BEFORE trusting the coarse account status, which is
    // hardcoded 'available' for a signed-in Claude; otherwise a tokens-exhausted
    // account reads ready:true here (RUSH-3018 finding, `agents devices harnesses`).
    const marker = snapshot?.unavailable;
    let status = accountStatus;
    let reason = unavailableReason;
    if (marker?.reason === 'out_of_credits') {
      status = 'out_of_credits';
      reason = 'out of credits';
    } else if (
      marker?.reason === 'session_limit' &&
      (!marker.resetsAt || marker.resetsAt.getTime() > Date.now())
    ) {
      status = 'rate_limited';
      reason = 'session-limited';
    }
    return {
      status,
      verdict: status ?? 'unavailable',
      usedPercent: null,
      stale: false,
      capturedAt: snapshot?.capturedAt?.toISOString() ?? null,
      resetsAt: marker?.resetsAt?.toISOString() ?? null,
      unavailableReason: status ? null : (reason ?? 'usage unavailable'),
    };
  }
  const blocking = snapshot.windows.filter((w) => w.key !== 'sonnet_week');
  const windows = blocking.length > 0 ? blocking : snapshot.windows;
  const derived = deriveUsageStatusFromSnapshot(snapshot);
  const status = accountStatus === 'out_of_credits' ? accountStatus : derived;
  let usedPercent = Math.round(Math.max(...windows.map((w) => w.usedPercent)));
  // Never show 100% for an account that isn't actually capped: a genuinely-100
  // blocking window makes the status `rate_limited` (rendered "limited"), so a
  // rounded 100 on an `available` account (e.g. 99.6% → 100) would read as maxed
  // next to a "ready" verdict. Cap the display at 99 to keep the two consistent.
  if (status !== 'rate_limited' && usedPercent >= 100) usedPercent = 99;
  return {
    status,
    verdict: status ?? 'unavailable',
    usedPercent,
    stale: snapshot.source !== 'live',
    capturedAt: snapshot.capturedAt?.toISOString() ?? null,
    resetsAt: windows
      .map((window) => window.resetsAt)
      .filter((value): value is Date => value instanceof Date)
      .sort((a, b) => a.getTime() - b.getTime())[0]?.toISOString() ?? null,
    unavailableReason: null,
  };
}

/**
 * "Ready" = signed in AND not rate-limited. A missing quota snapshot does NOT
 * block readiness: the account is signed in and usable, we just have no live
 * utilization to show. Pure.
 */
export function computeReady(
  signedIn: boolean,
  quota: QuotaSummary,
): { ready: boolean; reason?: string } {
  if (!signedIn) return { ready: false, reason: 'signed out' };
  if (quota.status === 'rate_limited') return { ready: false, reason: 'rate-limited' };
  if (quota.status === 'out_of_credits') return { ready: false, reason: 'out of credits' };
  return { ready: true };
}

/**
 * Enumerate every installed (agent, version) on THIS host, resolve account +
 * sign-in + quota + ready, and return the rows. Signed-out installs are kept
 * (they are the actionable ones), unlike the auth-health probe which drops
 * `unconfigured`. Quota is cache-only unless `refresh` is set.
 */
export async function collectLocalHarnessInventory(opts?: {
  agents?: readonly AgentId[];
  refresh?: boolean;
}): Promise<HarnessRow[]> {
  const agentIds = opts?.agents ?? ALL_AGENT_IDS;

  interface Pending {
    agent: AgentId;
    version: string;
    info: AccountInfo | null;
  }
  const pending: Pending[] = [];
  const usageInputs: UsageIdentityInput[] = [];
  for (const agent of agentIds) {
    for (const version of listInstalledVersions(agent)) {
      const home = getVersionHomePath(agent, version);
      const info = await getAccountInfo(agent, home).catch(() => null);
      pending.push({ agent, version, info });
      // Only signed-in installs can have usage; a signed-out one has no identity
      // to look up (and would just widen the fetch set for nothing).
      if (info?.signedIn) {
        usageInputs.push({ agentId: agent, info, home, cliVersion: version });
      }
    }
  }

  const usageByKey = usageInputs.length
    ? (await getUsageInfoByIdentity(usageInputs, opts?.refresh ? { forceRefresh: true } : undefined)).usageByKey
    : new Map();

  const savedNative = listNativeAccounts(readMeta());
  return pending.map(({ agent, version, info }) => {
    const key = getUsageLookupKey(info);
    const usage = key ? usageByKey.get(key) : undefined;
    const snapshot = usage?.snapshot ?? null;
    const quota = summarizeQuota(snapshot, usage?.error ?? null, info?.usageStatus ?? null);
    const signedIn = !!info?.signedIn;
    const { ready, reason } = computeReady(signedIn, quota);
    const display = info ? accountDisplayLabel(info) || null : null;
    const identityKey = info?.accountKey ?? info?.email?.toLowerCase();
    const saved = identityKey ? savedNative.find(item => item.agent === agent && item.identityKey === identityKey) : undefined;
    const account = saved ? `${saved.name} · ${display || saved.identityLabel || identityKey}` : display;
    return { agent, version, account, signedIn, quota, ready, reason };
  });
}

/**
 * Collapse a host's rows into one {@link AccountGroup} per distinct account (the
 * signed-out installs fall into the `null` bucket). Because an account label maps
 * to a single provider identity, every install sharing it shares one quota, so
 * the group's quota is taken from the first row carrying real data (preferring a
 * `rate_limited` row so a throttle is never hidden). Pure.
 */
export function groupByAccount(rows: HarnessRow[]): AccountGroup[] {
  const order: string[] = [];
  const groups = new Map<string, HarnessRow[]>();
  for (const row of rows) {
    // Signed-out rows share one bucket under a sentinel key. Use the NUL-prefixed
    // literal (a TS `\0` escape, NOT a raw NUL byte in the source) so the key can
    // never collide with a real account label named literally "signed-out".
    const key = row.account ?? '\0signed-out';
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(row);
  }

  return order.map((key) => {
    const members = groups.get(key)!;
    const account = members[0].account;
    const agents = [...new Set(members.map((m) => m.agent))].sort() as AgentId[];
    const signedIn = members.some((m) => m.signedIn);
    // Prefer a throttled member's quota (a hidden rate-limit is the dangerous
    // miss), else the first member with any real usage data, else the first row.
    const withData = members.filter((m) => m.quota.status !== null);
    const rep =
      withData.find((m) => m.quota.status === 'out_of_credits') ??
      withData.find((m) => m.quota.status === 'rate_limited') ?? withData[0] ?? members[0];
    const quota = rep.quota;
    const { ready, reason } = computeReady(signedIn, quota);
    return {
      account,
      agents,
      installs: members.length,
      signedIn,
      quota,
      ready,
      reason,
    };
  });
}

/** Short human quota cell: "12%", "limited", or "—" when no data. */
export function formatQuota(quota: QuotaSummary): string {
  if (quota.status === 'out_of_credits') return 'no credits';
  if (quota.status === 'rate_limited') return 'limited';
  if (quota.usedPercent === null) return '—';
  return `${quota.usedPercent}%${quota.stale ? '*' : ''}`;
}

// ---------------------------------------------------------------------------
// Rendering. Each cell is padded as PLAIN text to a computed width, then colored
// — coloring first would let chalk's escape codes throw off the alignment.
// chalk auto-disables color off a TTY, so the strings tests assert on are plain.
// ---------------------------------------------------------------------------

/** Pad plain `text` to `width`, then apply `paint`. Alignment survives coloring. */
function cell(text: string, width: number, paint: (s: string) => string): string {
  return paint(text.padEnd(width));
}

/** Color for a quota value: red limited, yellow ≥80%, green below, dim unknown. */
function quotaPaint(quota: QuotaSummary): (s: string) => string {
  if (quota.status === 'rate_limited') return chalk.red;
  if (quota.usedPercent === null) return chalk.dim;
  return quota.usedPercent >= 80 ? chalk.yellow : chalk.green;
}

/** The ready cell text + color: green "ready", else the reason. */
function readyCell(ready: boolean, reason: string | undefined, width: number): string {
  if (ready) return cell('ready', width, chalk.green);
  const label = reason ?? 'not ready';
  return cell(label, width, reason === 'signed out' ? chalk.gray : chalk.yellow);
}

/** The signed-in cell — three chars so the column stays aligned. */
function signedCell(signedIn: boolean): string {
  return signedIn ? chalk.green('yes') : chalk.gray('no ');
}

/** A host note (skipped / error / no installs), or '' when the host has rows. */
function hostNote(result: HostHarnessResult): string {
  if (result.skipped) return chalk.dim(`  ${result.skipped}`);
  if (result.error) return chalk.red(`  ${result.error}`);
  if (result.rows.length === 0) return chalk.dim('  no harnesses installed');
  return '';
}

/** Widest string in a list, floored at `min`. */
function colWidth(values: string[], min: number): number {
  return Math.max(min, ...values.map((v) => v.length));
}

const QUOTA_W = 7;

/**
 * Render the device × harness table: one block per device, one row per installed
 * (agent, version) with account / signed-in / quota / ready. Pure.
 */
export function renderHarnessMatrix(results: HostHarnessResult[]): string[] {
  const lines: string[] = [chalk.bold('Fleet harnesses')];
  const allRows = results.flatMap((r) => r.rows);
  const harnessW = colWidth(allRows.map((r) => `${r.agent}@${r.version}`), 10);
  const acctW = colWidth(allRows.map((r) => r.account ?? '—'), 6);

  for (const result of results) {
    lines.push(`  ${chalk.cyan(result.host)}${hostNote(result)}`);
    for (const row of result.rows) {
      const harness = cell(`${row.agent}@${row.version}`, harnessW, chalk.white);
      const account = cell(row.account ?? '—', acctW, chalk.dim);
      const quota = cell(formatQuota(row.quota), QUOTA_W, quotaPaint(row.quota));
      const ready = readyCell(row.ready, row.reason, 12);
      lines.push(`      ${harness}  ${account}  ${signedCell(row.signedIn)}  ${quota}  ${ready}`);
    }
  }
  lines.push('');
  lines.push(chalk.gray('  quota = highest window utilization (* = cached) · ready = signed in and not rate-limited'));
  return lines;
}

/**
 * Render the device × account table: one block per device, one row per distinct
 * account (installs sharing it collapsed), showing which harnesses use it. Pure.
 */
export function renderAccountsMatrix(results: HostHarnessResult[]): string[] {
  const lines: string[] = [chalk.bold('Fleet accounts')];
  const grouped = results.map((r) => ({ ...r, groups: groupByAccount(r.rows) }));
  const allGroups = grouped.flatMap((r) => r.groups);
  const acctW = colWidth(allGroups.map((g) => g.account ?? 'signed out'), 8);
  const agentsW = colWidth(allGroups.map((g) => g.agents.join(', ')), 8);

  for (const result of grouped) {
    lines.push(`  ${chalk.cyan(result.host)}${hostNote(result)}`);
    for (const group of result.groups) {
      const label = group.account ?? 'signed out';
      const account = cell(label, acctW, group.account ? chalk.dim : chalk.gray);
      const agents = cell(group.agents.join(', '), agentsW, chalk.dim);
      const quota = cell(formatQuota(group.quota), QUOTA_W, quotaPaint(group.quota));
      const ready = readyCell(group.ready, group.reason, 12);
      lines.push(`      ${account}  ${agents}  ${signedCell(group.signedIn)}  ${quota}  ${ready}`);
    }
  }
  lines.push('');
  lines.push(chalk.gray('  one row per account · agents = harnesses signed into it · ready = signed in and not rate-limited'));
  return lines;
}
