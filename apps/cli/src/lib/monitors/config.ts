/**
 * Monitor (event-triggered watcher) configuration, validation, and CRUD.
 *
 * A monitor is a routine whose trigger is a *watched source* instead of a
 * *clock*. It watches a SOURCE, detects a CONDITION change, and fires an ACTION —
 * reusing the routines daemon, dispatch engine, device model, and notify path.
 *
 * Monitors are YAML files in ~/.agents/monitors/. This module owns the on-disk
 * shape (mirroring lib/routines.ts read/write helpers), hand-rolled validation
 * (mirroring validateJob — no zod), and the device-owner eligibility gate.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { getMonitorsDir, ensureAgentsDir } from '../state.js';
import { safeJoin, isSafeSegmentName } from '../paths.js';
import { atomicWriteFileSync } from '../fs-atomic.js';
import { machineId, normalizeHost } from '../machine-id.js';
import type { AgentId } from '../types.js';
import { ALL_AGENT_IDS } from '../agents.js';

/** Source types a monitor can watch. */
export type MonitorSourceType =
  | 'command'
  | 'poll'
  | 'poll-http'
  | 'webhook'
  | 'ws'
  | 'file'
  | 'device';

/** Webhook source filters — reuse the github/linear matcher shape from triggers/webhook.ts. */
export interface MonitorWebhookSource {
  source: 'github' | 'linear';
  event: string;
  repo?: string;
  branch?: string;
  action?: string;
  teamKey?: string;
  label?: string;
}

/**
 * What a monitor watches. Exactly one source-payload field is populated, keyed by
 * `type`: `command`/`interval` for command/poll, `url`/`interval` for poll-http,
 * `wsUrl` for ws, `path` for file, `device` for device, `webhook` for webhook.
 */
export interface MonitorSource {
  type: MonitorSourceType;
  /** Shell command whose stdout is the observation (command, poll). */
  command?: string;
  /** Re-evaluation interval (poll, poll-http; optional for command/file/device). e.g. `30s`, `15m`, `8h`. */
  interval?: string;
  /** URL to GET (poll-http). */
  url?: string;
  /** WebSocket URL; each frame is an observation (ws). */
  wsUrl?: string;
  /** File or directory to watch (file). */
  path?: string;
  /** A registered fleet device whose health/reachability is the observation (device). */
  device?: string;
  /** Webhook trigger filters (webhook). */
  webhook?: MonitorWebhookSource;
}

/** How an observation becomes a fire. */
export type MonitorConditionMode = 'on-change' | 'match' | 'every';

export interface MonitorCondition {
  mode: MonitorConditionMode;
  /** Regex (required for `match` mode) — fire when the observation matches. */
  match?: string;
  /**
   * What counts as "the same event" for de-duplication. When set, the dedupe
   * signature is the first regex match of this expression against the
   * observation (so re-observing the same token is silent); when omitted, the
   * full observation is the signature.
   */
  dedupeKey?: string;
}

/** Action types a monitor can fire. */
export type MonitorActionType = 'run' | 'routine' | 'notify' | 'webhook-out';

/**
 * What a monitor does on a fire. Shares the run-shaped fields (agent, prompt,
 * mode, effort, timeout) conceptually with JobConfig (lib/routines.ts) so
 * dispatch reuses the routines path (executeJobDetached). The fired event is
 * injected into the prompt as `{event}`.
 */
export interface ActionConfig {
  type: MonitorActionType;
  /** run: which agent to spawn. */
  agent?: AgentId;
  /** run: the prompt; `{event}` is replaced with the fired event summary. */
  prompt?: string;
  /** run: execution mode (shared with routines). */
  mode?: 'plan' | 'edit' | 'auto' | 'skip' | 'full';
  /** run: reasoning effort (shared with routines). */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
  /** run: kill the action if it runs longer than this (e.g. `10m`). */
  timeout?: string;
  /** routine: name of an existing routine to fire. */
  routine?: string;
  /** notify: channel for the notification (default `telegram`). */
  notifyChannel?: string;
  /** webhook-out: URL to POST the event to. */
  url?: string;
}

/** Full monitor configuration (persisted as YAML in ~/.agents/monitors/). */
export interface MonitorConfig {
  name: string;
  enabled: boolean;
  source: MonitorSource;
  condition: MonitorCondition;
  action: ActionConfig;
  /**
   * Pin-to-one OWNER device — the single machine whose daemon evaluates the
   * source and fires. Exactly-once for v1 (no distributed lock). When set, only
   * that machine is eligible; everywhere else the monitor is inert.
   */
  device?: string;
  /**
   * Fleet allowlist (advanced) — each listed device evaluates and fires
   * independently, like routines' `devices`. Mutually exclusive with `device`.
   */
  devices?: string[];
  /** Execute the ACTION on this machine over SSH (placement), distinct from the owner that fires it. */
  runOn?: string;
  /** Firehose guard: auto-pause the monitor if it fires more than `max` times per `per`. */
  rateLimit?: { max: number; per: string };
  /** User-defined prompt variables (expanded like routines' variables). */
  variables?: Record<string, string>;
  /** Pin the agent version for `run` actions (omit to use the run strategy). */
  version?: string;
}

/**
 * A fired event. `summary` is injected into the action prompt as `{event}`;
 * `payload` carries the structured observation for `webhook-out` and inspection.
 */
export interface MonitorEvent {
  monitorName: string;
  firedAt: string;
  summary: string;
  payload: Record<string, unknown>;
}

/** Default values applied to every monitor config when fields are omitted. */
const MONITOR_DEFAULTS: Partial<MonitorConfig> = {
  enabled: true,
};

const SOURCE_TYPES: readonly MonitorSourceType[] = [
  'command',
  'poll',
  'poll-http',
  'webhook',
  'ws',
  'file',
  'device',
];

const CONDITION_MODES: readonly MonitorConditionMode[] = ['on-change', 'match', 'every'];
const ACTION_TYPES: readonly MonitorActionType[] = ['run', 'routine', 'notify', 'webhook-out'];

/**
 * Parse a human interval string (e.g. `30s`, `15m`, `8h`, `1d`, `1h30m`) into
 * milliseconds. Unlike routines' parseTimeout, seconds are supported (polls tick
 * in seconds). Returns null on empty/unparseable/zero input.
 */
export function parseInterval(interval: string): number | null {
  const match = interval.trim().match(/^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match) return null;
  const weeks = parseInt(match[1] || '0', 10);
  const days = parseInt(match[2] || '0', 10);
  const hours = parseInt(match[3] || '0', 10);
  const minutes = parseInt(match[4] || '0', 10);
  const seconds = parseInt(match[5] || '0', 10);
  const ms = ((((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  return ms > 0 ? ms : null;
}

/**
 * True when the monitor may evaluate + fire on this machine. Owner semantics:
 * `device` (single owner, exactly-once) → only that machine; else `devices`
 * (allowlist) → any listed machine; else unrestricted. Both sides normalize so
 * `Yosemite-S0` and `yosemite-s0.tailnet.ts.net` agree with `yosemite-s0`.
 */
export function monitorRunsOnThisDevice(
  config: Pick<MonitorConfig, 'device' | 'devices'>,
): boolean {
  const self = machineId();
  if (config.device) return normalizeHost(config.device) === self;
  if (config.devices && config.devices.length > 0) {
    return config.devices.some((d) => normalizeHost(d) === self);
  }
  return true;
}

/** Count the populated source-payload fields to detect "two sources". */
function populatedSourceFields(source: MonitorSource): string[] {
  const fields: Array<[string, unknown]> = [
    ['command', source.command],
    ['url', source.url],
    ['wsUrl', source.wsUrl],
    ['path', source.path],
    ['device', source.device],
    ['webhook', source.webhook],
  ];
  return fields.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k]) => k);
}

/** Which source-payload field each source type requires. */
const SOURCE_TYPE_FIELD: Record<MonitorSourceType, string> = {
  command: 'command',
  poll: 'command',
  'poll-http': 'url',
  webhook: 'webhook',
  ws: 'wsUrl',
  file: 'path',
  device: 'device',
};

/** Count the populated action-payload fields to detect "two actions". */
function populatedActionFields(action: ActionConfig): string[] {
  const fields: Array<[string, unknown]> = [
    ['agent', action.agent],
    ['routine', action.routine],
    ['url', action.url],
  ];
  return fields.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k]) => k);
}

/**
 * Validate a partial monitor config, returning a list of human-readable errors.
 * Hand-rolled like validateJob (lib/routines.ts) — no zod. Rejects: no source,
 * two sources, no action, two actions, match-mode without `match`, plus the
 * per-type field/shape checks.
 */
export function validateMonitor(config: Partial<MonitorConfig>): string[] {
  const errors: string[] = [];

  if (!config.name || typeof config.name !== 'string') {
    errors.push('name is required');
  } else if (!isSafeSegmentName(config.name)) {
    errors.push(
      `invalid name ${JSON.stringify(config.name)}: must be a single path segment ` +
        `(no '/', '\\\\', or null bytes, and not '.' or '..')`,
    );
  }

  // ─── SOURCE ───────────────────────────────────────────────────────────────
  const source = config.source;
  if (!source || typeof source !== 'object') {
    errors.push('a source is required (source: { type, ... })');
  } else {
    if (!source.type || !SOURCE_TYPES.includes(source.type)) {
      errors.push(`source.type must be one of: ${SOURCE_TYPES.join(', ')}`);
    }
    const populated = populatedSourceFields(source);
    if (source.type && SOURCE_TYPES.includes(source.type)) {
      const required = SOURCE_TYPE_FIELD[source.type];
      // Two sources: any populated field that doesn't belong to this type.
      const stray = populated.filter((f) => f !== required);
      if (stray.length > 0) {
        errors.push(
          `source has conflicting fields (${[required, ...stray].join(', ')}); specify exactly one source`,
        );
      }
      if (!populated.includes(required)) {
        errors.push(`source.type '${source.type}' requires source.${required}`);
      }
    } else if (populated.length > 1) {
      errors.push(`source has conflicting fields (${populated.join(', ')}); specify exactly one source`);
    }
    // Interval-bearing sources must carry a parseable interval.
    if ((source.type === 'poll' || source.type === 'poll-http') && source.interval === undefined) {
      errors.push(`source.type '${source.type}' requires source.interval (e.g. 30s, 15m, 8h)`);
    }
    if (source.interval !== undefined && parseInterval(source.interval) === null) {
      errors.push(`source.interval must be like 30s, 15m, 8h, 1d (got ${JSON.stringify(source.interval)})`);
    }
    if (source.webhook !== undefined) {
      const w = source.webhook;
      if (!w || typeof w !== 'object') {
        errors.push('source.webhook must be an object');
      } else if (w.source !== 'github' && w.source !== 'linear') {
        errors.push("source.webhook.source must be 'github' or 'linear'");
      } else if (!w.event || typeof w.event !== 'string') {
        errors.push('source.webhook.event is required');
      }
    }
  }

  // ─── CONDITION ──────────────────────────────────────────────────────────────
  const condition = config.condition;
  if (!condition || typeof condition !== 'object') {
    errors.push('a condition is required (condition: { mode, ... })');
  } else {
    if (!condition.mode || !CONDITION_MODES.includes(condition.mode)) {
      errors.push(`condition.mode must be one of: ${CONDITION_MODES.join(', ')}`);
    }
    if (condition.mode === 'match') {
      if (!condition.match || typeof condition.match !== 'string') {
        errors.push("condition.mode 'match' requires condition.match (a regex)");
      }
    }
    for (const key of ['match', 'dedupeKey'] as const) {
      const val = condition[key];
      if (val !== undefined) {
        if (typeof val !== 'string') {
          errors.push(`condition.${key} must be a regex string`);
        } else {
          try {
            new RegExp(val);
          } catch {
            errors.push(`condition.${key} is not a valid regular expression: ${JSON.stringify(val)}`);
          }
        }
      }
    }
  }

  // ─── ACTION ─────────────────────────────────────────────────────────────────
  const action = config.action;
  if (!action || typeof action !== 'object') {
    errors.push('an action is required (action: { type, ... })');
  } else {
    if (!action.type || !ACTION_TYPES.includes(action.type)) {
      errors.push(`action.type must be one of: ${ACTION_TYPES.join(', ')}`);
    }
    const populatedAct = populatedActionFields(action);
    const requiredByType: Partial<Record<MonitorActionType, string>> = {
      run: 'agent',
      routine: 'routine',
      'webhook-out': 'url',
    };
    if (action.type && ACTION_TYPES.includes(action.type)) {
      const required = requiredByType[action.type];
      // Two actions: a populated field that belongs to a different action type.
      const stray = populatedAct.filter((f) => f !== required);
      if (stray.length > 0) {
        errors.push(
          `action has conflicting fields (${[...(required ? [required] : []), ...stray].join(', ')}); specify exactly one action`,
        );
      }
      if (required && !populatedAct.includes(required)) {
        errors.push(`action.type '${action.type}' requires action.${required}`);
      }
    } else if (populatedAct.length > 1) {
      errors.push(`action has conflicting fields (${populatedAct.join(', ')}); specify exactly one action`);
    }
    if (action.type === 'run') {
      if (action.agent && !ALL_AGENT_IDS.includes(action.agent as AgentId)) {
        errors.push(`action.agent must be one of: ${ALL_AGENT_IDS.join(', ')}`);
      }
      if (!action.prompt || typeof action.prompt !== 'string') {
        errors.push("action.type 'run' requires action.prompt");
      }
      if (action.mode && !['plan', 'edit', 'auto', 'skip', 'full'].includes(action.mode)) {
        errors.push("action.mode must be plan, edit, auto, or skip ('full' accepted as alias for skip)");
      }
      if (action.effort && !['low', 'medium', 'high', 'xhigh', 'max', 'auto'].includes(action.effort)) {
        errors.push('action.effort must be low, medium, high, xhigh, max, or auto');
      }
    }
    if (action.type === 'webhook-out' && action.url) {
      try {
        // eslint-disable-next-line no-new
        new URL(action.url);
      } catch {
        errors.push(`action.url must be an absolute URL (got ${JSON.stringify(action.url)})`);
      }
    }
  }

  // ─── PLACEMENT ───────────────────────────────────────────────────────────────
  if (config.device !== undefined && config.devices !== undefined) {
    errors.push("device (single owner) and devices (allowlist) are mutually exclusive — pick one");
  }
  if (config.device !== undefined && (typeof config.device !== 'string' || config.device.trim() === '')) {
    errors.push('device must be a non-empty device name');
  }
  if (config.devices !== undefined) {
    if (!Array.isArray(config.devices)) {
      errors.push('devices must be an array of device names');
    } else {
      for (const d of config.devices) {
        if (typeof d !== 'string' || d.trim() === '') {
          errors.push('each entry in devices must be a non-empty device name');
          break;
        }
      }
    }
  }
  if (config.runOn !== undefined && (typeof config.runOn !== 'string' || config.runOn.trim() === '')) {
    errors.push('runOn must be a non-empty machine name (a registered host, device, capability tag, or user@host)');
  }

  // ─── HYGIENE ─────────────────────────────────────────────────────────────────
  if (config.rateLimit !== undefined) {
    const rl = config.rateLimit;
    if (!rl || typeof rl !== 'object' || typeof rl.max !== 'number' || rl.max <= 0) {
      errors.push('rateLimit.max must be a positive number');
    }
    if (!rl || typeof rl.per !== 'string' || parseInterval(rl.per) === null) {
      errors.push('rateLimit.per must be an interval like 1m, 1h, 1d');
    }
  }

  return errors;
}

function readMonitorFile(filePath: string): MonitorConfig | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      ...MONITOR_DEFAULTS,
      ...parsed,
      name: parsed.name || path.basename(filePath).replace(/\.ya?ml$/, ''),
    } as MonitorConfig;
  } catch {
    return null;
  }
}

/** List all monitor configs in ~/.agents/monitors/. */
export function listMonitors(): MonitorConfig[] {
  ensureAgentsDir();
  const dir = getMonitorsDir();
  if (!fs.existsSync(dir)) return [];
  const monitors: MonitorConfig[] = [];
  const seen = new Set<string>();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
    const monitor = readMonitorFile(path.join(dir, file));
    if (!monitor || seen.has(monitor.name)) continue;
    seen.add(monitor.name);
    monitors.push(monitor);
  }
  return monitors;
}

/** Read a single monitor config by name. Returns null if not found or corrupt. */
export function readMonitor(name: string): MonitorConfig | null {
  ensureAgentsDir();
  const dir = getMonitorsDir();
  for (const ext of ['.yml', '.yaml']) {
    const filePath = safeJoin(dir, name + ext);
    if (fs.existsSync(filePath)) return readMonitorFile(filePath);
  }
  return null;
}

/** Get the filesystem path of a monitor's YAML config, or null if not found. */
export function getMonitorPath(name: string): string | null {
  const dir = getMonitorsDir();
  for (const ext of ['.yml', '.yaml']) {
    const filePath = safeJoin(dir, name + ext);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

/** Write a monitor config to disk atomically, omitting fields that match defaults. */
export function writeMonitor(config: MonitorConfig): void {
  ensureAgentsDir();
  const dir = getMonitorsDir();
  fs.mkdirSync(dir, { recursive: true });
  const ymlPath = safeJoin(dir, config.name + '.yml');
  const yamlPath = safeJoin(dir, config.name + '.yaml');
  if (fs.existsSync(ymlPath) && fs.existsSync(yamlPath)) {
    throw new Error(
      `Monitor '${config.name}' has both .yml and .yaml files; resolve the ambiguity before editing.`,
    );
  }
  const filePath = fs.existsSync(yamlPath) ? yamlPath : ymlPath;

  const output: Record<string, unknown> = { ...config };
  if (output.enabled === true) delete output.enabled;
  const devArr = output.devices as string[] | undefined;
  if (!devArr || devArr.length === 0) delete output.devices;

  atomicWriteFileSync(filePath, yaml.stringify(output));
}

/** Delete a monitor config file by name. Returns true if the file existed. */
export function deleteMonitor(name: string): boolean {
  const dir = getMonitorsDir();
  for (const ext of ['.yml', '.yaml']) {
    const filePath = safeJoin(dir, name + ext);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  }
  return false;
}

/** Enable or disable a monitor by name. */
export function setMonitorEnabled(name: string, enabled: boolean): void {
  const monitor = readMonitor(name);
  if (!monitor) throw new Error(`Monitor '${name}' not found`);
  monitor.enabled = enabled;
  writeMonitor(monitor);
}

/** Check whether a monitor with the given name exists on disk. */
export function monitorExists(name: string): boolean {
  return readMonitor(name) !== null;
}
