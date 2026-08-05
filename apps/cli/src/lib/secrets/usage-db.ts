/**
 * Secrets usage read-model — thin adapter over the analytics usage warehouse
 * (`kind=secret`). Kept so `secrets view` / `list` / `activity` keep their API
 * while the durable store lives at ~/.agents/.history/analytics/usage.db.
 */

import {
  recordUsage,
  getSecretBundleRollup,
  getSecretBundleAgents,
  getAllSecretBundleRollups,
  getSecretHistory,
  closeUsageDb,
} from '../analytics/usage-db.js';

export type SecretUsageEvent = 'access' | 'unlock' | 'import' | 'export' | 'create' | 'view';

export const SECRET_USAGE_EVENTS: readonly SecretUsageEvent[] = [
  'access',
  'unlock',
  'import',
  'export',
  'create',
  'view',
] as const;

export interface RecordUsageParams {
  bundle: string;
  event: SecretUsageEvent;
  agent?: string;
  host?: string;
  source?: string;
  status?: 'success' | 'error';
  keyCount?: number;
}

export interface UsageStat {
  count: number;
  last: string | null;
}

export interface BundleUsageSummary {
  bundle: string;
  total: number;
  events: Record<SecretUsageEvent, UsageStat>;
  lastUsedAt: string | null;
  firstUsedAt: string | null;
  byAgent: Array<{ agent: string; count: number }>;
}

export interface SecretUsageHistoryEntry {
  ts: string;
  bundle: string;
  event: SecretUsageEvent;
  agent: string | null;
  host: string | null;
  source: string | null;
  status: string | null;
  keyCount: number | null;
}

function emptyEvents(): Record<SecretUsageEvent, UsageStat> {
  return {
    access: { count: 0, last: null },
    unlock: { count: 0, last: null },
    import: { count: 0, last: null },
    export: { count: 0, last: null },
    create: { count: 0, last: null },
    view: { count: 0, last: null },
  };
}

function toSummary(
  bundle: string,
  rows: Array<{ event: string; n: number; last: string | null; first: string | null }>,
  byAgent: Array<{ agent: string; count: number }>,
): BundleUsageSummary {
  const events = emptyEvents();
  let total = 0;
  let lastUsedAt: string | null = null;
  let firstUsedAt: string | null = null;
  for (const r of rows) {
    if (r.event in events) {
      const stat = events[r.event as SecretUsageEvent];
      stat.count = r.n;
      stat.last = r.last;
    }
    total += r.n;
    if (r.last && (!lastUsedAt || r.last > lastUsedAt)) lastUsedAt = r.last;
    if (r.first && (!firstUsedAt || r.first < firstUsedAt)) firstUsedAt = r.first;
  }
  return { bundle, total, events, lastUsedAt, firstUsedAt, byAgent };
}

export function recordSecretUsage(p: RecordUsageParams): void {
  if (!p.bundle) return;
  const meta: Record<string, unknown> = {};
  if (p.keyCount != null) meta.keyCount = p.keyCount;
  if (p.host) meta.host = p.host;
  recordUsage({
    kind: 'secret',
    name: p.bundle,
    event: p.event,
    agent: p.agent,
    source: p.source,
    status: p.status,
    meta: Object.keys(meta).length ? meta : undefined,
  });
}

export function getBundleUsage(bundle: string): BundleUsageSummary | undefined {
  const rows = getSecretBundleRollup(bundle);
  if (rows.length === 0) return undefined;
  const agents = getSecretBundleAgents(bundle);
  return toSummary(bundle, rows, agents.map((a) => ({ agent: a.agent, count: a.n })));
}

export function getAllBundleUsage(): Map<string, BundleUsageSummary> {
  const out = new Map<string, BundleUsageSummary>();
  const rows = getAllSecretBundleRollups();
  const byBundle = new Map<string, Array<{ event: string; n: number; last: string | null; first: string | null }>>();
  for (const r of rows) {
    const list = byBundle.get(r.name) ?? [];
    list.push(r);
    byBundle.set(r.name, list);
  }
  for (const [bundle, list] of byBundle) out.set(bundle, toSummary(bundle, list, []));
  return out;
}

export function getUsageHistory(bundle: string | undefined, limit = 20): SecretUsageHistoryEntry[] {
  return getSecretHistory(bundle, limit).map((r) => ({
    ts: r.ts,
    bundle: r.bundle,
    event: r.event as SecretUsageEvent,
    agent: r.agent,
    host: r.host,
    source: r.source,
    status: r.status,
    keyCount: r.keyCount,
  }));
}

export function closeSecretsUsageDb(): void {
  closeUsageDb();
}
