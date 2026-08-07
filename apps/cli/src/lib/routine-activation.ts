/** Device-scoped routine activation.
 *
 * Definitions say what a routine does. This module owns the independent answer
 * to whether THIS device runs it: membership in the top-level `routines:` list
 * of `~/.agents/devices/<machine>/agents.yaml`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { machineId } from './machine-id.js';
import { getUserAgentsDir, readMeta, updateMeta } from './state.js';

export function normalizeRoutineNames(names: Iterable<string>): string[] {
  return [...new Set([...names].map((name) => name.trim()).filter(Boolean))].sort();
}

/** null means this device has not materialized activation state yet. */
export function enabledRoutineNames(): string[] | null {
  const names = readMeta().deviceRoutines;
  return Array.isArray(names) ? normalizeRoutineNames(names) : null;
}

export function routineEnabledOnThisDevice(name: string): boolean | null {
  const names = enabledRoutineNames();
  return names === null ? null : names.includes(name);
}

export function replaceEnabledRoutines(names: Iterable<string>): string[] {
  const normalized = normalizeRoutineNames(names);
  updateMeta((meta) => ({ ...meta, deviceRoutines: normalized }));
  return normalized;
}

/** Add newly introduced replacements to an already-materialized device manifest. */
export function addEnabledRoutinesOnUpgrade(names: Iterable<string>): boolean {
  const current = enabledRoutineNames();
  if (current === null) return false;
  const next = normalizeRoutineNames([...current, ...names]);
  if (next.length === current.length && next.every((name, index) => name === current[index])) return false;
  replaceEnabledRoutines(next);
  return true;
}

/**
 * Add or remove one routine on this machine. `legacyEnabledNames` seeds the
 * manifest the first time an upgraded host changes activation, preserving every
 * other routine that was effectively enabled under the old definition fields.
 */
export function setRoutineEnabledOnThisDevice(
  name: string,
  enabled: boolean,
  legacyEnabledNames: Iterable<string> = [],
): string[] {
  const current = enabledRoutineNames() ?? normalizeRoutineNames(legacyEnabledNames);
  const next = new Set(current);
  if (enabled) next.add(name);
  else next.delete(name);
  return replaceEnabledRoutines(next);
}

/** Read-only fleet view from synced device documents. Never writes a peer file. */
export function devicesWithRoutineEnabled(name: string): string[] {
  const devicesDir = path.join(getUserAgentsDir(), 'devices');
  if (!fs.existsSync(devicesDir)) return [];
  const devices: string[] = [];
  for (const entry of fs.readdirSync(devicesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(devicesDir, entry.name, 'agents.yaml');
    if (!fs.existsSync(file)) continue;
    let parsed: unknown;
    try {
      parsed = yaml.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      throw new Error(`Device config corrupted at ${file}: ${(err as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Device config corrupted at ${file}: expected a YAML map.`);
    }
    const routines = (parsed as { routines?: unknown }).routines;
    if (routines === undefined) continue;
    if (!Array.isArray(routines) || routines.some((routine) => typeof routine !== 'string')) {
      throw new Error(`Device config corrupted at ${file}: routines must be a string list.`);
    }
    if (routines.includes(name)) devices.push(entry.name);
  }
  return devices.sort();
}

export function currentRoutineDevice(): string {
  return machineId();
}
