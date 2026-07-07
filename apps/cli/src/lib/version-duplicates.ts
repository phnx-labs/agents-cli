import chalk from 'chalk';
import { getAccountInfo, agentLabel, type AccountInfo } from './agents.js';
import type { AgentId } from './types.js';
import {
  compareVersions,
  getVersionHomePath,
  listInstalledVersions,
} from './versions.js';
import {
  getUsageInfoByIdentity,
  getUsageLookupKey,
} from './usage.js';

export interface VersionAccountEntry {
  version: string;
  info: AccountInfo;
}

export interface NewerDuplicateVersion {
  version: string;
  email: string | null;
  plan: string | null;
}

function duplicateIdentity(info: AccountInfo | undefined): string | null {
  if (!info) return null;
  const usageKey = getUsageLookupKey(info);
  if (usageKey) return usageKey;
  return info.email ? `email:${info.email.toLowerCase()}` : null;
}

/**
 * Return installed versions newer than selectedVersion that share the same
 * account identity. This is intentionally pure so command output can share one
 * duplicate rule with tests.
 */
export function findNewerDuplicateVersions(
  entries: VersionAccountEntry[],
  selectedVersion: string,
): NewerDuplicateVersion[] {
  const selected = entries.find((entry) => entry.version === selectedVersion);
  const selectedIdentity = duplicateIdentity(selected?.info);
  if (!selectedIdentity) return [];

  return entries
    .filter((entry) =>
      entry.version !== selectedVersion &&
      compareVersions(entry.version, selectedVersion) > 0 &&
      duplicateIdentity(entry.info) === selectedIdentity
    )
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((entry) => ({
      version: entry.version,
      email: entry.info.email,
      plan: entry.info.plan,
    }));
}

/** Collect account info for an agent and find newer duplicates of selectedVersion. */
export async function getNewerDuplicateVersions(
  agentId: AgentId,
  selectedVersion: string,
): Promise<NewerDuplicateVersion[]> {
  const rows = await Promise.all(
    listInstalledVersions(agentId).map(async (version) => {
      const home = getVersionHomePath(agentId, version);
      const info = await getAccountInfo(agentId, home);
      return { version, home, info };
    })
  );

  const { canonicalByUsageKey } = await getUsageInfoByIdentity(
    rows.map(({ version, home, info }) => ({
      agentId,
      home,
      cliVersion: version,
      info,
    }))
  );

  const entries = rows.map(({ version, info }) => {
    const key = getUsageLookupKey(info);
    const canon = key ? canonicalByUsageKey.get(key) : undefined;
    return {
      version,
      info: canon
        ? {
            ...info,
            plan: canon.plan,
            usageStatus: canon.usageStatus,
            overageCredits: canon.overageCredits,
          }
        : info,
    };
  });

  return findNewerDuplicateVersions(entries, selectedVersion);
}

/** Format the non-interactive guidance shown by view/run when duplicates exist. */
export function formatNewerDuplicateNotice(
  agentId: AgentId,
  selectedVersion: string,
  duplicates: NewerDuplicateVersion[],
  selectedLabel = '',
): string {
  if (duplicates.length === 0) return '';

  const versionLabel = selectedLabel
    ? `${selectedLabel} ${agentLabel(agentId)}@${selectedVersion}`
    : `${agentLabel(agentId)}@${selectedVersion}`;
  const plural = duplicates.length === 1 ? 'duplicate' : 'duplicates';
  const maxVersion = Math.max(...duplicates.map((duplicate) => duplicate.version.length));
  const maxEmail = Math.max(0, ...duplicates.map((duplicate) => duplicate.email?.length ?? 0));
  const lines = [
    `Found ${duplicates.length} newer ${plural} for ${versionLabel}:`,
  ];

  for (const duplicate of duplicates) {
    const parts = [`  ${duplicate.version.padEnd(maxVersion)}`];
    if (maxEmail > 0) {
      parts.push(duplicate.email ? chalk.cyan(duplicate.email.padEnd(maxEmail)) : ''.padEnd(maxEmail));
    }
    if (duplicate.plan) {
      parts.push(duplicate.plan);
    }
    lines.push(parts.join('  '));
  }

  lines.push('');
  lines.push(`Run: agents use ${agentId}@${duplicates[0].version}`);
  return lines.join('\n');
}
