/**
 * Fleet-wide native-account labels, tracked in the user repo.
 *
 * `agents accounts label` used to write only the device-local
 * `meta.accounts.native` cache (UUID-keyed, in agents.yaml). A label set on
 * one box then did not select `codex#personal` on another. Labels bind to a
 * stable (agent, identityKey) pair — email / org key, machine-independent —
 * so they belong in a tracked file that `agents repo push/pull` syncs, the
 * same way device role/description live in `devices/<name>/agents.yaml`.
 *
 * The device-local registry remains the read cache: `readMeta` overlays this
 * file onto `accounts.native` (tracked name wins; cache id is kept).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as yaml from 'yaml';
import { atomicWriteFileSync } from './fs-atomic.js';
import type { AgentId, Meta } from './types.js';

export interface NativeLabelRecord {
  agent: AgentId;
  identityKey: string;
  name: string;
  identityLabel?: string;
  scope: 'version' | 'device';
}

type LabelEntry = { name: string; identityLabel?: string; scope: 'version' | 'device' };
type LabelsDoc = Record<string, Record<string, LabelEntry>>;

const HEADER = `# Native-account labels — fleet-wide, keyed by (agent, identityKey).
# Syncs via \`agents repo push/pull\`. The device-local registry is the read cache.

`;

export function nativeLabelsPath(base: string): string {
  return path.join(base, 'accounts', 'native.yaml');
}

export function nativeLabelKey(agent: AgentId, identityKey: string): string {
  return `${agent}\0${identityKey}`;
}

/** Stable id for a tracked label that has no device-local cache row yet. */
export function syntheticNativeId(agent: AgentId, identityKey: string): string {
  return crypto.createHash('sha256').update(`native:${agent}:${identityKey}`).digest('hex').slice(0, 32);
}

function corrupted(file: string, detail: string): Error {
  return new Error(`Native-account labels corrupted at ${file}: ${detail}. Inspect and restore from backup.`);
}

function parseScope(value: unknown): 'version' | 'device' | null {
  return value === 'version' || value === 'device' ? value : null;
}

function writeIfChanged(filePath: string, content: string): void {
  let current: string | null = null;
  try { current = fs.readFileSync(filePath, 'utf-8'); } catch { /* absent */ }
  if (current === content) return;
  atomicWriteFileSync(filePath, content);
}

function readLabelsDoc(base: string): LabelsDoc {
  const file = nativeLabelsPath(base);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT') return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw corrupted(file, message);
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw corrupted(file, `expected a YAML map, got ${Array.isArray(parsed) ? 'a list' : JSON.stringify(parsed)}`);
  }
  const doc: LabelsDoc = {};
  for (const [agent, identities] of Object.entries(parsed as Record<string, unknown>)) {
    // Agent ids are an open set across CLI versions — a newer harness must
    // still round-trip. Reject only keys that cannot be a harness id.
    if (!agent || /[/\\]/.test(agent)) throw corrupted(file, `invalid agent key '${agent}'`);
    if (identities === null || identities === undefined) continue;
    if (typeof identities !== 'object' || Array.isArray(identities)) {
      throw corrupted(file, `'${agent}' must be a mapping of identityKey → label`);
    }
    const group: Record<string, LabelEntry> = {};
    for (const [identityKey, value] of Object.entries(identities as Record<string, unknown>)) {
      if (!identityKey) throw corrupted(file, `'${agent}' has an empty identityKey`);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw corrupted(file, `'${agent}' / '${identityKey}' must be a mapping`);
      }
      const entry = value as Record<string, unknown>;
      if (typeof entry.name !== 'string' || !entry.name) {
        throw corrupted(file, `'${agent}' / '${identityKey}' is missing name`);
      }
      const scope = parseScope(entry.scope);
      if (!scope) throw corrupted(file, `'${agent}' / '${identityKey}' scope must be version or device`);
      const record: LabelEntry = { name: entry.name, scope };
      if (typeof entry.identityLabel === 'string' && entry.identityLabel) record.identityLabel = entry.identityLabel;
      group[identityKey] = record;
    }
    if (Object.keys(group).length > 0) doc[agent] = group;
  }
  return doc;
}

export function readNativeLabels(base: string): NativeLabelRecord[] {
  const out: NativeLabelRecord[] = [];
  for (const [agent, identities] of Object.entries(readLabelsDoc(base))) {
    for (const [identityKey, entry] of Object.entries(identities)) {
      out.push({
        agent: agent as AgentId,
        identityKey,
        name: entry.name,
        identityLabel: entry.identityLabel,
        scope: entry.scope,
      });
    }
  }
  return out;
}

function writeLabelsDoc(base: string, doc: LabelsDoc): void {
  const file = nativeLabelsPath(base);
  const agents = Object.keys(doc).sort();
  const compact: LabelsDoc = {};
  for (const agent of agents) {
    const identities = doc[agent];
    if (!identities) continue;
    const keys = Object.keys(identities).sort();
    if (keys.length === 0) continue;
    const group: Record<string, LabelEntry> = {};
    for (const key of keys) group[key] = identities[key]!;
    compact[agent] = group;
  }
  if (Object.keys(compact).length === 0) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmdirSync(path.dirname(file));
    } catch { /* dir not empty, or the file was already gone */ }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeIfChanged(file, HEADER + yaml.stringify(compact));
}

function setLabel(doc: LabelsDoc, label: NativeLabelRecord): void {
  const group = doc[label.agent] ?? {};
  const entry: LabelEntry = { name: label.name, scope: label.scope };
  if (label.identityLabel) entry.identityLabel = label.identityLabel;
  group[label.identityKey] = entry;
  doc[label.agent] = group;
}

/** Write one label, seeding any not-yet-tracked cache rows so they start syncing. */
export function upsertNativeLabel(label: NativeLabelRecord, base: string, seed: NativeLabelRecord[] = []): void {
  const doc = readLabelsDoc(base);
  if (Object.keys(doc).length === 0) {
    for (const extra of seed) setLabel(doc, extra);
  }
  setLabel(doc, label);
  writeLabelsDoc(base, doc);
}

export function removeNativeLabel(agent: AgentId, identityKey: string, base: string): void {
  const doc = readLabelsDoc(base);
  const group = doc[agent];
  if (!group || !(identityKey in group)) return;
  delete group[identityKey];
  if (Object.keys(group).length === 0) delete doc[agent];
  writeLabelsDoc(base, doc);
}

export function seedNativeLabels(labels: NativeLabelRecord[], base: string): void {
  if (labels.length === 0) return;
  const doc = readLabelsDoc(base);
  for (const label of labels) setLabel(doc, label);
  writeLabelsDoc(base, doc);
}

/**
 * Overlay tracked labels onto `meta.accounts.native` in place.
 *
 * Tracked name/identityLabel/scope win. A cache row's id is kept so existing
 * bindings survive. A tracked identity with no cache row is synthesized with a
 * stable id so `codex#personal` resolves on a box that has only pulled the file.
 */
export function overlayNativeAccountLabels(meta: Meta, base: string): void {
  const labels = readNativeLabels(base);
  if (labels.length === 0) return;
  const native = { ...(meta.accounts?.native ?? {}) };
  const idByKey = new Map<string, string>();
  for (const [id, account] of Object.entries(native)) {
    idByKey.set(nativeLabelKey(account.agent, account.identityKey), id);
  }
  for (const label of labels) {
    const key = nativeLabelKey(label.agent, label.identityKey);
    const existingId = idByKey.get(key);
    if (existingId) {
      const prev = native[existingId]!;
      native[existingId] = {
        ...prev,
        name: label.name,
        identityLabel: label.identityLabel,
        scope: label.scope,
      };
      continue;
    }
    const id = syntheticNativeId(label.agent, label.identityKey);
    native[id] = {
      id,
      name: label.name,
      agent: label.agent,
      identityKey: label.identityKey,
      identityLabel: label.identityLabel,
      scope: label.scope,
    };
  }
  meta.accounts = { ...meta.accounts, native };
}
