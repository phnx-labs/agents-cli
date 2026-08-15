/**
 * Token-free usage replication from the configured primary host.
 *
 * The publisher writes only the already-derived usage windows and routing
 * headroom. Credentials, OAuth material, and provider responses never enter
 * this envelope. Subscribers fetch that file over the existing SSH trust path
 * and merge it into their local caches.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';

import { buildSshInvocation, writeAskpassShim } from './devices/connect.js';
import { loadDevices } from './devices/registry.js';
import { atomicWriteFileSync } from './fs-atomic.js';
import { getCacheDir } from './state.js';
import {
  readHeadroomCache,
  writeHeadroomEntries,
  type HeadroomEntry,
} from './usage-refresh.js';
import {
  readClaudeUsageCache,
  writeClaudeUsageCache,
  type UsageSnapshot,
  type UsageWindow,
} from './accounting/usage.js';

export const USAGE_FLEET_VERSION = 1;
export const USAGE_FLEET_FILE = '.usage-fleet.json';

export interface UsageFleetWindow {
  key: UsageWindow['key'];
  label: string;
  shortLabel: string;
  usedPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
}

export interface UsageFleetSnapshot {
  capturedAt: string | null;
  plan: string | null;
  windows: UsageFleetWindow[];
}

export interface UsageFleetExport {
  version: 1;
  publishedAt: number;
  usage: Record<string, UsageFleetSnapshot>;
  headroom: Record<string, HeadroomEntry>;
}

/** Publisher/subscriber role selection, kept pure for the daemon gate test. */
export function usageRefreshRole(primaryHost: string | undefined, self: string): 'publisher' | 'subscriber' {
  return primaryHost && primaryHost !== self ? 'subscriber' : 'publisher';
}

let exportPathOverride: string | null = null;
export function setUsageFleetExportPathForTest(value: string | null): string | null {
  const previous = exportPathOverride;
  exportPathOverride = value;
  return previous;
}

function exportPath(): string {
  return exportPathOverride ?? path.join(getCacheDir(), USAGE_FLEET_FILE);
}

function safeSnapshot(snapshot: UsageSnapshot): UsageFleetSnapshot {
  return {
    capturedAt: snapshot.capturedAt?.toISOString() ?? null,
    plan: snapshot.plan ?? null,
    windows: snapshot.windows.map((window) => ({
      key: window.key,
      label: window.label,
      shortLabel: window.shortLabel,
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt?.toISOString() ?? null,
      windowMinutes: window.windowMinutes,
    })),
  };
}

function liveSnapshot(snapshot: UsageFleetSnapshot): UsageSnapshot {
  return {
    source: 'last_seen',
    sourceLabel: 'primary host cache',
    capturedAt: snapshot.capturedAt ? new Date(snapshot.capturedAt) : null,
    plan: snapshot.plan,
    windows: snapshot.windows.map((window) => ({
      ...window,
      resetsAt: window.resetsAt ? new Date(window.resetsAt) : null,
    })),
  };
}

/** Build and persist the primary's safe cache envelope. */
export function exportUsageFleet(now = Date.now()): UsageFleetExport {
  const headroom = readHeadroomCache();
  const usage: Record<string, UsageFleetSnapshot> = {};
  for (const usageKey of Object.keys(headroom)) {
    const snapshot = readClaudeUsageCache(usageKey);
    if (snapshot) usage[usageKey] = safeSnapshot(snapshot);
  }
  const payload: UsageFleetExport = {
    version: USAGE_FLEET_VERSION,
    publishedAt: now,
    usage,
    headroom,
  };
  atomicWriteFileSync(exportPath(), JSON.stringify(payload, null, 2), 'utf-8');
  return payload;
}

function isUsageFleetExport(value: unknown): value is UsageFleetExport {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<UsageFleetExport>;
  return payload.version === USAGE_FLEET_VERSION
    && typeof payload.publishedAt === 'number'
    && !!payload.usage && typeof payload.usage === 'object'
    && !!payload.headroom && typeof payload.headroom === 'object';
}

/** Merge a primary-host envelope into the subscriber's existing caches. */
export function importUsageFleet(value: unknown): UsageFleetExport {
  if (!isUsageFleetExport(value)) throw new Error('usage fleet export has an unsupported shape');
  for (const [usageKey, snapshot] of Object.entries(value.usage)) {
    writeClaudeUsageCache(usageKey, liveSnapshot(snapshot));
  }
  writeHeadroomEntries(value.headroom);
  return value;
}

/** Fetch the primary's published envelope over the registered device SSH path. */
export async function importUsageFleetFromHost(host: string): Promise<UsageFleetExport> {
  const device = (await loadDevices())[host];
  if (!device) throw new Error(`usage primary host '${host}' is not a registered device`);
  const remoteRead = device.shell === 'powershell'
    ? ['Get-Content', '-Raw', '(Join-Path $HOME \'.agents/.cache/.usage-fleet.json\')']
    : ['cat', '"$HOME/.agents/.cache/.usage-fleet.json"'];
  const { args, env } = buildSshInvocation(device, remoteRead, writeAskpassShim(), {}, { agentOnly: true });
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn('ssh', args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`usage primary host '${host}' export failed: ${stderr.trim() || `ssh exited ${code}`}`));
    });
  });
  return importUsageFleet(JSON.parse(raw) as unknown);
}
