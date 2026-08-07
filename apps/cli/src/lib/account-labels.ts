import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { atomicWriteFileSync } from './fs-atomic.js';
import { getUserAgentsDir } from './state.js';
import { getAccountInfo } from './agents.js';
import type { AgentId } from './types.js';
import { getVersionHomePath, listInstalledVersions } from './versions.js';
import { machineId } from './machine-id.js';

export interface AccountLabel { identities: Record<string, { fingerprint: string }> }
export interface AccountLabelsDocument { labels: Record<string, AccountLabel> }
export interface AccountBinding { label: string; fingerprint: string }
export interface AccountBindingsDocument { bindings: Record<string, AccountBinding> }

function readMap<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  const value = yaml.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Account configuration corrupted at ${file}: expected a YAML map.`);
  return value as T;
}
function writeMap(file: string, value: object): void { fs.mkdirSync(path.dirname(file), { recursive: true }); atomicWriteFileSync(file, yaml.stringify(value)); }
export function identityFingerprint(agent: string, accountKey: string): string { return crypto.createHash('sha256').update(`${agent}\0${accountKey}`).digest('hex'); }
export function accountLabelsPath(base = getUserAgentsDir()): string { return path.join(base, 'accounts.yaml'); }
export function accountBindingsPath(device: string, base = getUserAgentsDir()): string { return path.join(base, 'devices', device, 'accounts.yaml'); }
export function readAccountLabels(base = getUserAgentsDir()): AccountLabelsDocument { const doc = readMap(accountLabelsPath(base), { labels: {} }); doc.labels ??= {}; return doc; }
export function readAccountBindings(device: string, base = getUserAgentsDir()): AccountBindingsDocument { const doc = readMap(accountBindingsPath(device, base), { bindings: {} }); doc.bindings ??= {}; return doc; }
export function setAccountLabel(label: string, agent: string, accountKey: string, base = getUserAgentsDir()): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(label)) throw new Error('Label must start with a letter or number and contain only letters, numbers, dot, underscore, or dash.');
  const doc = readAccountLabels(base); const fingerprint = identityFingerprint(agent, accountKey);
  for (const [other, entry] of Object.entries(doc.labels)) if (other !== label && entry.identities?.[agent]?.fingerprint === fingerprint) throw new Error(`This ${agent} identity is already labeled '${other}'.`);
  doc.labels[label] ??= { identities: {} };
  const existing = doc.labels[label].identities[agent];
  if (existing && existing.fingerprint !== fingerprint) throw new Error(`Label '${label}' already names a different ${agent} identity.`);
  doc.labels[label].identities[agent] = { fingerprint }; writeMap(accountLabelsPath(base), doc); return fingerprint;
}
export function bindAccount(device: string, target: string, label: string, fingerprint: string, base = getUserAgentsDir()): void { const doc = readAccountBindings(device, base); doc.bindings[target] = { label, fingerprint }; writeMap(accountBindingsPath(device, base), doc); }
export function unbindAccount(device: string, target: string, base = getUserAgentsDir()): boolean { const doc = readAccountBindings(device, base); if (!doc.bindings[target]) return false; delete doc.bindings[target]; writeMap(accountBindingsPath(device, base), doc); return true; }
function deviceBindingDocs(base: string): Array<{ device: string; doc: AccountBindingsDocument }> {
  const devices = path.join(base, 'devices');
  if (!fs.existsSync(devices)) return [];
  return fs.readdirSync(devices).filter(device => fs.existsSync(accountBindingsPath(device, base))).map(device => ({ device, doc: readAccountBindings(device, base) }));
}
export function renameAccountLabel(oldLabel: string, newLabel: string, base = getUserAgentsDir()): void {
  const doc = readAccountLabels(base); if (!doc.labels[oldLabel]) throw new Error(`Unknown account label '${oldLabel}'.`); if (doc.labels[newLabel]) throw new Error(`Account label '${newLabel}' already exists.`);
  doc.labels[newLabel] = doc.labels[oldLabel]; delete doc.labels[oldLabel]; writeMap(accountLabelsPath(base), doc);
  for (const { device, doc: bindings } of deviceBindingDocs(base)) { let changed = false; for (const binding of Object.values(bindings.bindings)) if (binding.label === oldLabel) { binding.label = newLabel; changed = true; } if (changed) writeMap(accountBindingsPath(device, base), bindings); }
}
export function removeAccountLabel(label: string, base = getUserAgentsDir()): void {
  const doc = readAccountLabels(base); if (!doc.labels[label]) throw new Error(`Unknown account label '${label}'.`);
  const attached = deviceBindingDocs(base).flatMap(({ device, doc: bindings }) => Object.entries(bindings.bindings).filter(([, binding]) => binding.label === label).map(([target]) => `${device}:${target}`));
  if (attached.length) throw new Error(`Account label '${label}' is still attached to ${attached.join(', ')}. Detach those versions first.`);
  delete doc.labels[label]; writeMap(accountLabelsPath(base), doc);
}

export async function resolveAccountLabel(agent: AgentId, label: string, device = machineId()): Promise<string> {
  const identity = readAccountLabels().labels[label]?.identities[agent];
  if (!identity) throw new Error(`Account label '${label}' has no ${agent} identity.`);
  const bindings = readAccountBindings(device).bindings;
  const candidates = Object.entries(bindings).filter(([target, binding]) => target.startsWith(`${agent}@`) && binding.label === label).map(([target]) => target.slice(target.lastIndexOf('@') + 1));
  for (const version of candidates) {
    if (!listInstalledVersions(agent).includes(version)) continue;
    const info = await getAccountInfo(agent, getVersionHomePath(agent, version));
    const fingerprint = info.accountKey ? identityFingerprint(agent, info.accountKey) : null;
    if (fingerprint === identity.fingerprint && bindings[`${agent}@${version}`]?.fingerprint === fingerprint) return version;
  }
  throw new Error(`No installed ${agent} version is attached and signed into account label '${label}' on ${device}.`);
}
