import { ALL_AGENT_IDS, getAccountInfo, supportsAccountInspection } from './agents.js';
import { getVersionHomePath, listInstalledVersions } from './versions.js';
import type { AgentId } from './types.js';

export interface NativeAccountCatalogEntry {
  kind: 'native';
  id: string;
  agent: AgentId;
  display: string;
  email: string | null;
  versions: string[];
}

export function groupNativeAccountRows(rows: Array<{ agent: AgentId; version: string; accountKey: string | null; email: string | null; signedIn: boolean }>): NativeAccountCatalogEntry[] {
  const grouped = new Map<string, NativeAccountCatalogEntry>();
  for (const row of rows) {
    if (!row.signedIn) continue;
    const identity = row.accountKey ?? row.email?.toLowerCase();
    if (!identity) continue;
    const key = `${row.agent}:${identity}`;
    const existing = grouped.get(key);
    if (existing) existing.versions.push(row.version);
    else grouped.set(key, {
      kind: 'native',
      id: identity,
      agent: row.agent,
      display: row.email ?? identity,
      email: row.email,
      versions: [row.version],
    });
  }
  return [...grouped.values()].map(entry => ({ ...entry, versions: [...new Set(entry.versions)].sort() }))
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.display.localeCompare(b.display));
}

/** Discover signed-in harness-native identities without copying their auth files. */
export async function discoverNativeAccounts(): Promise<NativeAccountCatalogEntry[]> {
  const rows: Array<{ agent: AgentId; version: string; accountKey: string | null; email: string | null; signedIn: boolean }> = [];
  for (const agent of ALL_AGENT_IDS.filter(supportsAccountInspection)) {
    for (const version of listInstalledVersions(agent)) {
      const info = await getAccountInfo(agent, getVersionHomePath(agent, version));
      rows.push({ agent, version, accountKey: info.accountKey, email: info.email, signedIn: info.signedIn });
    }
  }
  return groupNativeAccountRows(rows);
}
