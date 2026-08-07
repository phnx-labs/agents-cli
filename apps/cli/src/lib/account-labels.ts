import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { atomicWriteFileSync } from './fs-atomic.js';
import { getUserAgentsDir } from './state.js';
import { ACCOUNT_INSPECTION_AGENT_IDS } from './agents.js';
import type { AgentId } from './types.js';
import { collectRunCandidates, pickBalancedCandidate } from './rotate.js';

export interface AccountLabel { agent: AgentId; fingerprint: string }
export interface AccountLabelsDocument { labels: Record<string, AccountLabel> }
export interface DiscoveredAccount { agent: AgentId; fingerprint: string; display: string; versions: string[]; label: string | null }

function emptyDocument(): AccountLabelsDocument { return { labels: {} }; }
export function identityFingerprint(agent: string, accountKey: string): string { return crypto.createHash('sha256').update(`${agent}\0${accountKey}`).digest('hex'); }
export function accountLabelsPath(base = getUserAgentsDir()): string { return path.join(base, 'accounts.yaml'); }
export function readAccountLabels(base = getUserAgentsDir()): AccountLabelsDocument {
  const file = accountLabelsPath(base); if (!fs.existsSync(file)) return emptyDocument();
  const value = yaml.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Account labels corrupted at ${file}: expected a YAML map.`);
  const doc = value as AccountLabelsDocument; doc.labels ??= {}; return doc;
}
function writeAccountLabels(doc: AccountLabelsDocument, base = getUserAgentsDir()): void { const file = accountLabelsPath(base); fs.mkdirSync(path.dirname(file), { recursive: true }); atomicWriteFileSync(file, yaml.stringify(doc)); }
function assertLabel(label: string): void { if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(label)) throw new Error('Label must start with a letter or number and contain only letters, numbers, dot, underscore, or dash.'); }
export function nameAccount(label: string, agent: AgentId, fingerprint: string, base = getUserAgentsDir()): void {
  assertLabel(label); const doc = readAccountLabels(base);
  for (const [other, account] of Object.entries(doc.labels)) if (other !== label && account.agent === agent && account.fingerprint === fingerprint) throw new Error(`This ${agent} account is already named '${other}'.`);
  if (doc.labels[label] && (doc.labels[label].agent !== agent || doc.labels[label].fingerprint !== fingerprint)) throw new Error(`Account label '${label}' already names another account.`);
  doc.labels[label] = { agent, fingerprint }; writeAccountLabels(doc, base);
}
export function renameAccountLabel(oldLabel: string, newLabel: string, base = getUserAgentsDir()): void { assertLabel(newLabel); const doc = readAccountLabels(base); if (!doc.labels[oldLabel]) throw new Error(`Unknown account label '${oldLabel}'.`); if (doc.labels[newLabel]) throw new Error(`Account label '${newLabel}' already exists.`); doc.labels[newLabel] = doc.labels[oldLabel]; delete doc.labels[oldLabel]; writeAccountLabels(doc, base); }
export function removeAccountLabel(label: string, base = getUserAgentsDir()): void { const doc = readAccountLabels(base); if (!doc.labels[label]) throw new Error(`Unknown account label '${label}'.`); delete doc.labels[label]; writeAccountLabels(doc, base); }
export function labelForFingerprint(agent: AgentId, fingerprint: string, doc = readAccountLabels()): string | null { return Object.entries(doc.labels).find(([, account]) => account.agent === agent && account.fingerprint === fingerprint)?.[0] ?? null; }

export async function discoverAccounts(agentIds: readonly AgentId[] = ACCOUNT_INSPECTION_AGENT_IDS): Promise<DiscoveredAccount[]> {
  const labels = readAccountLabels(); const grouped = new Map<string, DiscoveredAccount>();
  await Promise.all(agentIds.map(async agent => {
    for (const candidate of await collectRunCandidates(agent)) {
      if (!candidate.signedIn || !candidate.accountKey) continue;
      const fingerprint = identityFingerprint(agent, candidate.accountKey); const key = `${agent}:${fingerprint}`; const existing = grouped.get(key);
      if (existing) existing.versions.push(candidate.version); else grouped.set(key, { agent, fingerprint, display: candidate.accountLabel || 'signed-in account', versions: [candidate.version], label: labelForFingerprint(agent, fingerprint, labels) });
    }
  }));
  return [...grouped.values()].sort((a, b) => a.agent.localeCompare(b.agent) || a.display.localeCompare(b.display));
}

export async function resolveAccountLabel(agent: AgentId, label: string): Promise<string> {
  const account = readAccountLabels().labels[label]; if (!account) throw new Error(`Unknown account label '${label}'.`); if (account.agent !== agent) throw new Error(`Account label '${label}' names a ${account.agent} account, not ${agent}.`);
  const candidates = (await collectRunCandidates(agent)).filter(candidate => candidate.accountKey && identityFingerprint(agent, candidate.accountKey) === account.fingerprint);
  const result = pickBalancedCandidate(candidates); if (!result) throw new Error(`No healthy installed ${agent} version is currently signed into account '${label}'.`);
  return result.picked.version;
}
