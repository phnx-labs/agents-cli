/**
 * Daemon service catalog + persistent toggle config.
 *
 * Defines the services the daemon hosts, loads their on/off state from
 * ~/.agents/daemon/services.yaml, and exposes lightweight helpers so both the
 * daemon and service clients (e.g. secrets) can check whether a service is
 * enabled without pulling in the whole daemon lifecycle.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { getDaemonConfigDir } from './state.js';
import { atomicWriteFileSync } from './fs-atomic.js';

/** Every service the daemon can host. IDs are kebab-case and stable. */
export type DaemonServiceId =
  | 'secrets-broker'
  | 'scheduler'
  | 'monitors'
  | 'browser-ipc'
  | 'self-heal'
  | 'keychain-reap'
  | 'account-state'
  | 'watchdog'
  | 'device-probe'
  | 'state-dir-check';

/** Human-readable metadata for each service. */
export interface DaemonServiceDef {
  id: DaemonServiceId;
  title: string;
  description: string;
}

export const DAEMON_SERVICES: DaemonServiceDef[] = [
  {
    id: 'secrets-broker',
    title: 'Secrets broker',
    description: 'Hosts the keychain-backed secrets broker socket so unlocked bundles stay warm across agent runs.',
  },
  {
    id: 'scheduler',
    title: 'Routine scheduler',
    description: 'Fires cron-scheduled routines and catches up missed fires.',
  },
  {
    id: 'monitors',
    title: 'Monitor engine',
    description: 'Watches event sources and triggers monitor-driven routines.',
  },
  {
    id: 'browser-ipc',
    title: 'Browser IPC',
    description: 'Keeps a supervised browser automation IPC socket available for sessions.',
  },
  {
    id: 'self-heal',
    title: 'Self-heal registry',
    description: 'Repairs shims, PATH, shadowing, and resource drift on a schedule.',
  },
  {
    id: 'keychain-reap',
    title: 'Keychain reap',
    description: 'Reaps orphaned keychain helpers and stuck agents processes.',
  },
  {
    id: 'account-state',
    title: 'Account state',
    description: 'Refreshes account quota/usage and publishes the local fleet-status row.',
  },
  {
    id: 'watchdog',
    title: 'Watchdog',
    description: 'Nudges stalled agent sessions on this host when opted in via watchdog.enabled.',
  },
  {
    id: 'device-probe',
    title: 'Device probe',
    description: 'Discovers Tailscale devices and surfaces pending ones for registration.',
  },
  {
    id: 'state-dir-check',
    title: 'State-dir self-check',
    description: 'Self-terminates the daemon if its state directory is removed.',
  },
];

/** Stable order of service IDs. */
export const DAEMON_SERVICE_IDS: DaemonServiceId[] = DAEMON_SERVICES.map((s) => s.id);

/** Persistent service toggles. */
export interface DaemonServicesConfig {
  services: Record<DaemonServiceId, boolean>;
}

function defaultServicesConfig(): DaemonServicesConfig {
  const services = {} as Record<DaemonServiceId, boolean>;
  for (const id of DAEMON_SERVICE_IDS) services[id] = true;
  return { services };
}

/** Path to ~/.agents/daemon/services.yaml. */
export function getDaemonServicesConfigPath(): string {
  return path.join(getDaemonConfigDir(), 'services.yaml');
}

/**
 * Read the services config from disk. Missing or malformed files return the
 * default (all services enabled). Never throws.
 */
export function readDaemonServicesConfig(): DaemonServicesConfig {
  const cfg = defaultServicesConfig();
  try {
    const raw = fs.readFileSync(getDaemonServicesConfigPath(), 'utf-8');
    const parsed = yaml.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && parsed.services && typeof parsed.services === 'object') {
      for (const id of DAEMON_SERVICE_IDS) {
        const value = (parsed.services as Record<string, unknown>)[id];
        if (typeof value === 'boolean') cfg.services[id] = value;
      }
    }
  } catch {
    // Missing or corrupt -> defaults.
  }
  return cfg;
}

/**
 * Write the services config to disk, creating the daemon config dir if needed.
 * Preserves unknown keys/ordering in the existing file when possible.
 */
export function writeDaemonServicesConfig(cfg: DaemonServicesConfig): void {
  const dir = getDaemonConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = getDaemonServicesConfigPath();

  // Preserve any extra top-level fields the user may have added.
  let preserved: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') preserved = parsed;
  } catch {
    // ignore
  }

  const services: Record<string, boolean> = {};
  for (const id of DAEMON_SERVICE_IDS) services[id] = cfg.services[id] ?? true;

  const out = yaml.stringify({ ...preserved, services }, { sortMapEntries: false });
  atomicWriteFileSync(filePath, out, 'utf-8');
}

/**
 * Check whether a single service is enabled. Returns true (enabled) when the
 * config file is missing or the ID is unknown, so disabling must be explicit.
 */
export function isDaemonServiceEnabled(id: DaemonServiceId): boolean {
  return readDaemonServicesConfig().services[id] !== false;
}

/**
 * Toggle one service and persist. Returns the new config.
 */
export function setDaemonServiceEnabled(id: DaemonServiceId, enabled: boolean): DaemonServicesConfig {
  const cfg = readDaemonServicesConfig();
  cfg.services[id] = enabled;
  writeDaemonServicesConfig(cfg);
  return cfg;
}

/**
 * List every known service with its current enabled state and metadata.
 */
export function listDaemonServiceStates(): Array<DaemonServiceDef & { enabled: boolean }> {
  const cfg = readDaemonServicesConfig();
  return DAEMON_SERVICES.map((s) => ({ ...s, enabled: cfg.services[s.id] !== false }));
}
