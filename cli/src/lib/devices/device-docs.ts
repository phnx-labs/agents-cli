/**
 * Union-on-read across every tracked device document (PHNX-3315).
 *
 * Phase 2 device-scopes three writers that used to rewrite one fleet-shared
 * block in the central `agents.yaml` (fleet discovery/dismissals, the host
 * registry, and device-scoped accounts). Each box now records only its OWN
 * decisions in `~/.agents/devices/<machine>/agents.yaml`, so pulls never
 * conflict — and the effective fleet view is recomputed here as a deterministic,
 * order-independent UNION across every device doc, exactly like the browser
 * profile registry (`lib/browser/registry.ts` `profileRegistry`).
 *
 * These readers walk the device docs ONLY. The central-legacy values (present
 * until the fold-then-delete migration drains them) are merged in by each
 * caller, so a value mid-migration is never lost. A doc that fails to parse is a
 * hard error — silently returning an empty union would let a later write wipe a
 * peer's decision, the same corruption contract `routine-activation.ts` and the
 * device registry keep.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { getUserAgentsDir } from '../state.js';
import type { HostEntry } from '../types.js';
import type { IgnoredDeviceEntry } from '../fleet/types.js';

/** One parsed device doc under `~/.agents/devices/`. */
export interface DeviceDoc {
  device: string;
  doc: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Every device doc, sorted by device name so the union is order-independent. A
 * corrupt or non-map doc throws (loud), never silently skipped — a dropped doc
 * would let the next writer clobber that peer's slice.
 */
export function readAllDeviceDocs(): DeviceDoc[] {
  const devicesDir = path.join(getUserAgentsDir(), 'devices');
  if (!fs.existsSync(devicesDir)) return [];
  const out: DeviceDoc[] = [];
  const names = fs
    .readdirSync(devicesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const device of names) {
    const file = path.join(devicesDir, device, 'agents.yaml');
    if (!fs.existsSync(file)) continue;
    let parsed: unknown;
    try {
      parsed = yaml.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Device config corrupted at ${file}: ${(err as Error).message}. Inspect and restore from backup.`);
    }
    if (parsed == null) continue;
    if (!isRecord(parsed)) {
      throw new Error(`Device config corrupted at ${file}: document root must be a map.`);
    }
    out.push({ device, doc: parsed });
  }
  return out;
}

/**
 * Union the per-box `fleet.discovery` maps. Precedence for a name declared by
 * more than one box is deterministic and order-independent: `ignored` beats
 * `approved` (a dismissal on any box wins), so every box computes the identical
 * effective policy regardless of walk order.
 */
export function unionDeviceDiscovery(docs: DeviceDoc[] = readAllDeviceDocs()): Record<string, 'approved' | 'ignored'> {
  const out: Record<string, 'approved' | 'ignored'> = {};
  for (const { device, doc } of docs) {
    const fleet = doc.fleet;
    if (fleet === undefined) continue;
    if (!isRecord(fleet)) throw new Error(`Device config corrupted at devices/${device}/agents.yaml: fleet must be a map.`);
    const discovery = fleet.discovery;
    if (discovery === undefined) continue;
    if (!isRecord(discovery)) throw new Error(`Device config corrupted at devices/${device}/agents.yaml: fleet.discovery must be a map.`);
    for (const [name, status] of Object.entries(discovery)) {
      if (status !== 'approved' && status !== 'ignored') {
        throw new Error(`Device discovery policy for '${name}' in devices/${device}/agents.yaml must be approved or ignored.`);
      }
      // ignored beats approved; once ignored, never downgraded by another box.
      if (out[name] === 'ignored') continue;
      out[name] = status;
    }
  }
  return out;
}

/**
 * Union the per-box `fleet.ignored` dismissal lists by node name. When two boxes
 * dismissed the same node, the entry with the newest `ignoredAt` wins (ties
 * broken by `ignoredOn`), so the attribution is deterministic and
 * order-independent. Sorted by name to match the central writer's ordering.
 */
export function unionDeviceIgnored(docs: DeviceDoc[] = readAllDeviceDocs()): IgnoredDeviceEntry[] {
  const byName = new Map<string, IgnoredDeviceEntry>();
  for (const { device, doc } of docs) {
    const fleet = doc.fleet;
    if (fleet === undefined) continue;
    if (!isRecord(fleet)) throw new Error(`Device config corrupted at devices/${device}/agents.yaml: fleet must be a map.`);
    const ignored = fleet.ignored;
    if (ignored === undefined) continue;
    if (!Array.isArray(ignored)) throw new Error(`Device config corrupted at devices/${device}/agents.yaml: fleet.ignored must be a list.`);
    for (const raw of ignored) {
      if (!raw || typeof raw.name !== 'string' || typeof raw.ignoredAt !== 'string' || typeof raw.ignoredOn !== 'string') {
        throw new Error(`Device config corrupted at devices/${device}/agents.yaml: fleet.ignored entries must be { name, ignoredAt, ignoredOn }.`);
      }
      addIgnoredEntry(byName, raw);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Insert/replace a dismissal, newest ignoredAt (then ignoredOn) winning. */
export function addIgnoredEntry(byName: Map<string, IgnoredDeviceEntry>, entry: IgnoredDeviceEntry): void {
  const prev = byName.get(entry.name);
  if (!prev) { byName.set(entry.name, entry); return; }
  const at = Date.parse(entry.ignoredAt);
  const prevAt = Date.parse(prev.ignoredAt);
  if (at > prevAt || (at === prevAt && entry.ignoredOn.localeCompare(prev.ignoredOn) > 0)) {
    byName.set(entry.name, entry);
  }
}

/**
 * Union the per-box `hosts:` registries by host name. When two boxes registered
 * the same name, the newest `addedAt` wins (ties broken by device name), so the
 * merged directory is deterministic. Entries missing `addedAt` sort oldest.
 */
export function unionDeviceHosts(docs: DeviceDoc[] = readAllDeviceDocs()): Record<string, HostEntry> {
  const out: Record<string, HostEntry> = {};
  const wonAt = new Map<string, number>();
  for (const { device, doc } of docs) {
    const hosts = doc.hosts;
    if (hosts === undefined) continue;
    if (!isRecord(hosts)) throw new Error(`Device config corrupted at devices/${device}/agents.yaml: hosts must be a map.`);
    for (const [name, entry] of Object.entries(hosts)) {
      if (!isRecord(entry)) throw new Error(`Device config corrupted at devices/${device}/agents.yaml: host '${name}' must be a map.`);
      const at = typeof entry.addedAt === 'string' ? Date.parse(entry.addedAt) : 0;
      const prev = wonAt.get(name);
      if (prev === undefined || at > prev) {
        out[name] = entry as unknown as HostEntry;
        wonAt.set(name, Number.isNaN(at) ? 0 : at);
      }
    }
  }
  return out;
}

// Native accounts and their bindings are machine-local (a native login lives in
// the harness home on ONE box), so account-registry.ts reads THIS box's own
// slice (meta.deviceAccounts) merged with the fleet-shared central store rather
// than a cross-box union — there is deliberately no unionDeviceAccounts here.
