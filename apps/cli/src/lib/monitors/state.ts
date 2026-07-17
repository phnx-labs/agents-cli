/**
 * Native per-monitor state-diff store.
 *
 * This is the one genuinely new primitive monitors add over routines: a
 * last-observed-*value* store. Routines persist per-*run* metadata but have no
 * last-seen value, so hand-built watchers (the RUSH-1107 SSL watcher) re-invented
 * state-diffing through a markdown memory file every time. This store kills that.
 *
 * Layout (sibling of the runs layout, atomic writes like writeRunMeta):
 *   ~/.agents/.history/monitors/<name>/state.json      # last-seen hash/value + fire bookkeeping
 *   ~/.agents/.history/monitors/<name>/fires/<id>/…    # fire history
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { getMonitorsHistoryDir, ensureAgentsDir } from '../state.js';
import { safeJoin } from '../paths.js';
import type { MonitorEvent } from './config.js';

/** Persisted last-seen state for one monitor. */
export interface MonitorState {
  monitorName: string;
  /** Hash of the last-seen de-dupe signature (see hasChanged). */
  lastHash: string;
  /** The last-seen raw observation (truncated for storage). */
  lastValue: string;
  /** RFC3339 timestamp of the last observation. */
  lastSeenAt: string;
  /** RFC3339 timestamp of the last fire, when the monitor has ever fired. */
  lastFiredAt?: string;
  /** Epoch-ms timestamps of recent fires, for the rate-limit / firehose guard. */
  fireTimes?: number[];
}

const MAX_STORED_VALUE = 4096;

/** Per-monitor history root, with the (untrusted) name contained to one segment. */
export function getMonitorHistoryDir(name: string): string {
  return safeJoin(getMonitorsHistoryDir(), name);
}

function getStatePath(name: string): string {
  return path.join(getMonitorHistoryDir(name), 'state.json');
}

/** Directory holding a monitor's fire history. */
export function getMonitorFiresDir(name: string): string {
  return path.join(getMonitorHistoryDir(name), 'fires');
}

/** Read a monitor's last-seen state, or null if it has never been observed. */
export function readState(name: string): MonitorState | null {
  const statePath = getStatePath(name);
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as MonitorState;
  } catch {
    return null;
  }
}

/** Persist a monitor's state atomically (temp file + rename, like writeRunMeta). */
export function writeStateRaw(state: MonitorState): void {
  ensureAgentsDir();
  const dir = getMonitorHistoryDir(state.monitorName);
  fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, 'state.json');
  const tmp = `${statePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, statePath);
}

/**
 * Record a new observation as the monitor's last-seen state, preserving fire
 * bookkeeping. Truncates the stored raw value so a firehose can't bloat disk.
 */
export function writeState(
  name: string,
  value: string,
  dedupeKey?: string,
  extra: Partial<Pick<MonitorState, 'lastFiredAt' | 'fireTimes'>> = {},
): MonitorState {
  const prev = readState(name);
  const state: MonitorState = {
    monitorName: name,
    lastHash: hashSignature(value, dedupeKey),
    lastValue: value.length > MAX_STORED_VALUE ? value.slice(0, MAX_STORED_VALUE) : value,
    lastSeenAt: new Date().toISOString(),
    ...(prev?.lastFiredAt ? { lastFiredAt: prev.lastFiredAt } : {}),
    ...(prev?.fireTimes ? { fireTimes: prev.fireTimes } : {}),
    ...extra,
  };
  writeStateRaw(state);
  return state;
}

/**
 * The de-dupe signature for an observation. When `dedupeKey` is set, the
 * signature is the first regex match of dedupeKey against the observation (so
 * "the same event" is same matched token); otherwise it is the full observation.
 * An unmatched dedupeKey falls back to the full observation.
 */
export function dedupeSignature(observation: string, dedupeKey?: string): string {
  if (!dedupeKey) return observation;
  try {
    const m = new RegExp(dedupeKey).exec(observation);
    if (m) return m[1] ?? m[0];
  } catch {
    /* invalid regex — fall back to full observation */
  }
  return observation;
}

function hashSignature(observation: string, dedupeKey?: string): string {
  return createHash('sha256').update(dedupeSignature(observation, dedupeKey)).digest('hex');
}

/**
 * True when `observation`'s de-dupe signature differs from the monitor's
 * last-seen signature (or the monitor has never been observed). Pure read — the
 * caller persists the new value via writeState only on a real fire.
 */
export function hasChanged(name: string, observation: string, dedupeKey?: string): boolean {
  const prev = readState(name);
  if (!prev) return true;
  return prev.lastHash !== hashSignature(observation, dedupeKey);
}

/**
 * Append a fire timestamp and return the pruned window (fires within `windowMs`).
 * The engine uses the returned length to decide whether the rate limit tripped.
 */
export function recordFireTime(name: string, now: number, windowMs: number): number[] {
  const prev = readState(name);
  const times = [...(prev?.fireTimes ?? []), now].filter((t) => now - t <= windowMs);
  return times;
}

/** Write a fire record to fires/<id>/event.json and return the fire id. */
export function writeFireRecord(
  event: MonitorEvent,
  meta: Record<string, unknown> = {},
): string {
  ensureAgentsDir();
  const fireId = event.firedAt.replace(/[:.]/g, '-');
  const fireDir = safeJoin(getMonitorFiresDir(event.monitorName), fireId);
  fs.mkdirSync(fireDir, { recursive: true });
  fs.writeFileSync(
    path.join(fireDir, 'event.json'),
    JSON.stringify({ ...event, ...meta }, null, 2),
    'utf-8',
  );
  return fireId;
}

/** A single fire history entry (as read back from disk). */
export interface FireRecord extends MonitorEvent {
  runId?: string;
  action?: string;
  ok?: boolean;
  error?: string;
}

/** List a monitor's fire history, chronologically ascending. */
export function listFires(name: string): FireRecord[] {
  const dir = getMonitorFiresDir(name);
  if (!fs.existsSync(dir)) return [];
  const ids = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const fires: FireRecord[] = [];
  for (const id of ids) {
    const eventPath = path.join(dir, id, 'event.json');
    if (!fs.existsSync(eventPath)) continue;
    try {
      fires.push(JSON.parse(fs.readFileSync(eventPath, 'utf-8')) as FireRecord);
    } catch {
      /* skip corrupt record */
    }
  }
  return fires;
}
