/**
 * View command for inspecting installed agents, versions, accounts, and resources.
 *
 * Implements `agents view` -- shows installed agent CLIs with version info,
 * account emails, usage stats, and active status. When given an agent@version
 * argument, displays a detailed breakdown of commands, skills, MCP servers,
 * rules, hooks, and promptcuts synced to that version.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

import {
  AGENTS,
  ALL_AGENT_IDS,
  getAllCliStates,
  getAccountInfo,
  resolveAgentName,
  formatAgentError,
  agentLabel,
  colorAgent,
} from '../lib/agents.js';
import type { AccountInfo } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import {
  formatUsageSection,
  formatUsageSummary,
  formatUsageStatusBadge,
  getUsageInfoForIdentity,
  getUsageInfoByIdentity,
  getUsageLookupKey,
} from '../lib/usage.js';
import { readManifest } from '../lib/manifest.js';
import {
  listInstalledVersions,
  listInstalledVersionDirs,
  getGlobalDefault,
  getVersionHomePath,
  getVersionDir,
  resolveVersion,
  resolveVersionAlias,
  getAvailableResources,
  getActuallySyncedResources,
  getNewResources,
  getProjectOnlyResources,
  hasNewResources,
  promptNewResourceSelection,
  syncResourcesToVersion,
  removeVersion,
  printTrashFooter,
} from '../lib/versions.js';
import {
  getShimsDir,
  isShimsInPath,
  ensureVersionedAliasCurrent,
  removeShim,
} from '../lib/shims.js';
import { getAgentResources, listResources } from '../lib/resources.js';
import { WORKFLOW_CAPABLE_AGENTS } from '../lib/workflows.js';
import { discoverPlugins, pluginSupportsAgent } from '../lib/plugins.js';
import { PLUGINS_CAPABLE_AGENTS } from '../lib/agents.js';
import { getAgentsDir, getUserAgentsDir, getEffectivePromptcutsPath, readMergedPromptcuts } from '../lib/state.js';
import { isGitRepo, getGitSyncStatus } from '../lib/git.js';
import { getCentralRulesFileName } from '../lib/rules/rules.js';
import { composeRulesFromState, type ComposedSubrule } from '../lib/rules/compose.js';
import { getConfiguredRunStrategy } from '../lib/rotate.js';
import { listProfiles, profileSummary, type ProfileSummary } from '../lib/profiles.js';
import { confirm } from '@inquirer/prompts';
import { formatPath, isInteractiveTerminal, isPromptCancelled } from './utils.js';

/**
 * Group profile summaries by their host harness, optionally filtered to a
 * single agent. Profile YAMLs that fail validation are silently skipped by
 * `listProfiles` so this never throws on a malformed file.
 */
function getProfilesByAgent(filterAgentId?: AgentId): Map<AgentId, ProfileSummary[]> {
  const byAgent = new Map<AgentId, ProfileSummary[]>();
  for (const profile of listProfiles()) {
    if (filterAgentId && profile.host.agent !== filterAgentId) continue;
    const summary = profileSummary(profile);
    const existing = byAgent.get(profile.host.agent);
    if (existing) existing.push(summary);
    else byAgent.set(profile.host.agent, [summary]);
  }
  return byAgent;
}

/** Build the usage-column equivalent for a profile row: "profile  <model>". */
function profileKindAndModel(model: string, planWidth: number): string {
  const kind = 'profile'.padEnd(Math.max(planWidth, 'profile'.length));
  return `${kind}  ${model}`;
}

function termLink(text: string, filePath: string): string {
  const url = `file://${filePath}`;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/**
 * Resolve a resource path to something the IDE can open inline. When `p` is a
 * directory, OSC 8 file:// links cause IDEs (Cursor/VS Code) to open it as a
 * new workspace window; pointing at the bundle's marker file (SKILL.md /
 * WORKFLOW.md / AGENT.md) opens in the current window instead.
 */
function linkTarget(p: string): string {
  try {
    if (!fs.statSync(p).isDirectory()) return p;
  } catch { return p; }
  for (const marker of ['SKILL.md', 'WORKFLOW.md', 'AGENT.md']) {
    const candidate = path.join(p, marker);
    if (fs.existsSync(candidate)) return candidate;
  }
  return p;
}

function formatLastActive(date: Date | null): string {
  if (!date) return '';
  const now = Date.now();
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return chalk.green('just now');
  if (mins < 60) return chalk.green(`${mins}m ago`);
  if (hours < 24) return chalk.white(`${hours}h ago`);
  if (days < 7) return chalk.gray(`${days}d ago`);
  return chalk.gray(`${days}d ago`);
}

function visibleWidth(s: string): number {
  return s.replace(/\u001b\[[0-9;]*m/g, '').length;
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] > partsB[i]) return 1;
    if (partsA[i] < partsB[i]) return -1;
  }
  return 0;
}

function getProjectVersionFromCwd(agent: AgentId): string | null {
  const manifestPath = path.join(process.cwd(), '.agents', 'agents.yaml');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const manifest = readManifest(process.cwd());
    return manifest?.agents?.[agent] || null;
  } catch {
    return null;
  }
}

type SyncState = 'synced' | 'new' | 'modified' | 'deleted';

interface ResourceWithSync {
  name: string;
  path?: string;
  ruleCount?: number;
  syncState?: SyncState;
  scope?: 'user' | 'project';
}

/**
 * Show installed versions for one or all agents.
 * Called when: `agents view` or `agents view claude`
 */
async function showInstalledVersions(filterAgentId?: AgentId): Promise<void> {
  const spinnerText = filterAgentId
    ? `Checking ${agentLabel(filterAgentId)} agents...`
    : 'Checking installed agents...';
  const spinner = ora({ text: spinnerText, isSilent: !process.stdout.isTTY }).start();
  const cliStates = await getAllCliStates();
  spinner.stop();

  const agentsToShow = filterAgentId ? [filterAgentId] : ALL_AGENT_IDS;
  const showPaths = !!filterAgentId;
  const profilesByAgent = getProfilesByAgent(filterAgentId);
  const profileSummaries = [...profilesByAgent.values()].flat();

  // Auto-heal stale versioned aliases. Pre-v2 aliases (e.g. pre-CLAUDE_CONFIG_DIR
  // claude shims) silently route login through the default version's symlinked
  // home, so `agents view` would never reflect the right account. Regenerate on
  // sight — it's safe, idempotent, and fixes the symptom exactly where the user
  // notices it.
  // Yield between agents so the heal loop doesn't block the event loop as one
  // long sync burst — per-version readFileSync+writeFileSync across 5 agents
  // can otherwise stall spinners and stdout flushes.
  const healedAliases: string[] = [];
  for (const agentId of agentsToShow) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const version of listInstalledVersions(agentId)) {
      const status = ensureVersionedAliasCurrent(agentId, version);
      if (status === 'updated' || status === 'created') {
        healedAliases.push(`${agentId}@${version}`);
      }
    }
  }
  // Shim healing is silent — users don't need to know about internal repairs

  console.log(chalk.bold('Installed Agent CLIs\n'));

  // Pre-fetch account info for all versions in parallel
  const infoFetches: Promise<{ agentId: AgentId; version: string; home: string; info: AccountInfo }>[] = [];
  const globalInfoFetches: Promise<{ agentId: AgentId; cliVersion: string | null; info: AccountInfo }>[] = [];
  for (const agentId of agentsToShow) {
    const versions = listInstalledVersions(agentId);
    if (versions.length > 0) {
      for (const ver of versions) {
        const home = getVersionHomePath(agentId, ver);
        infoFetches.push(
          getAccountInfo(agentId, home).then((info) => ({
            agentId,
            version: ver,
            home,
            info,
          }))
        );
      }
    } else {
      globalInfoFetches.push(
        getAccountInfo(agentId).then((info) => ({
          agentId,
          cliVersion: cliStates[agentId]?.version || null,
          info,
        }))
      );
    }
  }
  const infoResults = await Promise.all(infoFetches);
  const globalInfoResults = await Promise.all(globalInfoFetches);

  // Build lookup: agentId:version -> AccountInfo
  const infoMap = new Map<string, AccountInfo>();
  for (const { agentId, version, info } of infoResults) {
    infoMap.set(`${agentId}:${version}`, info);
  }
  const globalInfoMap = new Map<string, AccountInfo>();
  for (const { agentId, info } of globalInfoResults) {
    globalInfoMap.set(agentId, info);
  }

  // Usage status, plan, and overage credits belong to the same underlying account
  // or org scope, not a specific installed version. Version homes cache those
  // values independently, so older installs can show stale values. Reuse the
  // freshest cache entry per stable usage identity and keep lastActive per version.
  const { canonicalByUsageKey, usageByKey } = await getUsageInfoByIdentity([
    ...infoResults.map(({ agentId, home, version, info }) => ({
      agentId,
      home,
      cliVersion: version,
      info,
    })),
    ...globalInfoResults.map(({ agentId, cliVersion, info }) => ({
      agentId,
      cliVersion,
      info,
    })),
  ]);

  const mergeCanonical = (info: AccountInfo): AccountInfo => {
    const key = getUsageLookupKey(info);
    if (!key) return info;
    const canon = canonicalByUsageKey.get(key);
    if (!canon) return info;
    return {
      ...info,
      plan: canon.plan,
      usageStatus: canon.usageStatus,
      overageCredits: canon.overageCredits,
    };
  };

  // Separate version-managed from globally-installed agents
  const versionManaged: AgentId[] = [];
  const globallyInstalled: AgentId[] = [];
  const profileOnly: AgentId[] = [];

  for (const agentId of agentsToShow) {
    const versions = listInstalledVersions(agentId);
    const cliState = cliStates[agentId];
    const hasProfiles = (profilesByAgent.get(agentId)?.length ?? 0) > 0;

    if (versions.length > 0) {
      versionManaged.push(agentId);
    } else if (cliState?.installed) {
      globallyInstalled.push(agentId);
    } else if (hasProfiles) {
      profileOnly.push(agentId);
    }
  }

  // Show version-managed agents
  if (versionManaged.length > 0) {
    // Calculate column widths across all agents for alignment
    let maxVerLabel = 0;
    let maxEmail = 0;
    let maxPlanWidth = 3;
    let maxUsageWidth = 0;
    let maxStatusWidth = 0;
    for (const agentId of versionManaged) {
      const versions = listInstalledVersions(agentId);
      const globalDefault = getGlobalDefault(agentId);
      for (const v of versions) {
        const label = v === globalDefault ? `${v} (default)` : v;
        maxVerLabel = Math.max(maxVerLabel, label.length);
        const rawInfo = infoMap.get(`${agentId}:${v}`);
        const info = rawInfo ? mergeCanonical(rawInfo) : undefined;
        if (info?.email) maxEmail = Math.max(maxEmail, info.email.length);
        if (info?.plan) maxPlanWidth = Math.max(maxPlanWidth, info.plan.length);
      }
      // Profile rows share these columns with version rows so they line up.
      for (const profile of profilesByAgent.get(agentId) ?? []) {
        maxVerLabel = Math.max(maxVerLabel, profile.name.length);
        maxEmail = Math.max(maxEmail, profile.auth.length);
        maxPlanWidth = Math.max(maxPlanWidth, 'profile'.length);
      }
    }
    // Second pass: compute max visible usage + status widths (now that maxPlanWidth is settled)
    for (const agentId of versionManaged) {
      const versions = listInstalledVersions(agentId);
      for (const v of versions) {
        const rawInfo = infoMap.get(`${agentId}:${v}`);
        const info = rawInfo ? mergeCanonical(rawInfo) : undefined;
        const usageKey = getUsageLookupKey(info);
        const usageInfo = usageKey ? usageByKey.get(usageKey) : undefined;
        const usageStr = formatUsageSummary(info?.plan || null, usageInfo?.snapshot || null, maxPlanWidth);
        maxUsageWidth = Math.max(maxUsageWidth, visibleWidth(usageStr));
        const statusStr = formatUsageStatusBadge(info?.usageStatus);
        maxStatusWidth = Math.max(maxStatusWidth, visibleWidth(statusStr));
      }
      for (const profile of profilesByAgent.get(agentId) ?? []) {
        const usageEquivalent = profileKindAndModel(profile.model, maxPlanWidth);
        maxUsageWidth = Math.max(maxUsageWidth, visibleWidth(usageEquivalent));
      }
    }

    for (const agentId of versionManaged) {
	      const agent = AGENTS[agentId];
	      const versions = listInstalledVersions(agentId);
	      const globalDefault = getGlobalDefault(agentId);
	      const runStrategy = getConfiguredRunStrategy(agentId);

	      const strategyLabel = chalk.gray(` (${runStrategy})`);
	      const noDefaultLabel = !globalDefault ? chalk.yellow(' (no default)') : '';
	      console.log(`  ${chalk.bold(agentLabel(agentId))}${strategyLabel}${noDefaultLabel}`);

	      // Sort versions with default first, then by semver descending
      const sortedVersions = [...versions].sort((a, b) => {
        if (a === globalDefault) return -1;
        if (b === globalDefault) return 1;
        return compareVersions(b, a);
      });

      for (const version of sortedVersions) {
        const isDefault = version === globalDefault;
        const base = isDefault ? `${version} (default)` : version;
        const padded = base.padEnd(maxVerLabel);
        const label = isDefault ? `${version}${chalk.green(' (default)')}${' '.repeat(maxVerLabel - base.length)}` : padded;
        const rawInfo = infoMap.get(`${agentId}:${version}`);
        const vInfo = rawInfo ? mergeCanonical(rawInfo) : undefined;
        const usageKey = getUsageLookupKey(vInfo);
        const usageInfo = usageKey ? usageByKey.get(usageKey) : undefined;

        // Build columns, trimming trailing whitespace when columns are empty
        const parts = [`    ${label}`];
        const hasEmail = !!vInfo?.email;
        const usageStr = formatUsageSummary(vInfo?.plan || null, usageInfo?.snapshot || null, maxPlanWidth);
        const hasUsage = usageStr.length > 0;
        // Only show lastActive for versions with an actual logged-in account.
        // Otherwise it reflects install time (misleading "just now" for fresh installs).
        const activeStr = vInfo && hasEmail ? formatLastActive(vInfo.lastActive) : '';
        const hasActive = activeStr.length > 0;

        if (!hasEmail && !hasUsage) {
          // Installed but never signed in
          parts.push(chalk.gray('(not signed in — run ' + agent.cliCommand + ' to log in)'));
        } else {
          if (hasEmail || hasUsage || hasActive) {
            const emailCol = (vInfo?.email || '').padEnd(maxEmail);
            parts.push(hasEmail ? chalk.cyan(emailCol) : ' '.repeat(maxEmail));
          }
          if (hasUsage || hasActive) {
            const usagePad = ' '.repeat(Math.max(0, maxUsageWidth - visibleWidth(usageStr)));
            parts.push(usageStr + usagePad);
          }
          const statusStr = formatUsageStatusBadge(vInfo?.usageStatus);
          if (maxStatusWidth > 0) {
            const statusPad = ' '.repeat(Math.max(0, maxStatusWidth - visibleWidth(statusStr)));
            parts.push(statusStr + statusPad);
          }
          if (hasActive) parts.push(activeStr);
        }

        console.log(parts.join('  '));
        if (showPaths) {
          const versionDir = getVersionDir(agentId, version);
          console.log(chalk.gray(`      ${versionDir}`));
        }
      }

      // Profile rows share the same columns as versions: name | auth | "profile"+model.
      // No status badge, no last-active — profiles don't accumulate usage state.
      for (const profile of profilesByAgent.get(agentId) ?? []) {
        const nameCol = chalk.cyan(profile.name.padEnd(maxVerLabel));
        const authCol = chalk.gray(profile.auth.padEnd(maxEmail));
        const usageEquivalent = profileKindAndModel(profile.model, maxPlanWidth);
        const usagePad = ' '.repeat(Math.max(0, maxUsageWidth - visibleWidth(usageEquivalent)));
        console.log(`    ${nameCol}  ${authCol}  ${chalk.gray(usageEquivalent + usagePad)}`);
        if (showPaths) {
          console.log(chalk.gray(`      ${profile.path}`));
        }
      }

      // Check for project override
      const projectVersion = getProjectVersionFromCwd(agentId);
      if (projectVersion && projectVersion !== globalDefault) {
        console.log(chalk.cyan(`    -> ${projectVersion} (project)`));
      }

      console.log();
    }
  }

  // Show globally installed (not managed) agents
  if (globallyInstalled.length > 0) {
    console.log(chalk.bold('Not Managed by Agents CLI\n'));

    // Calculate max version label width for alignment
    const globalMaxVerLabel = Math.max(
      ...globallyInstalled.map((agentId) => {
        const cliState = cliStates[agentId];
        return `${cliState?.version || 'installed'} (global)`.length;
      })
    );
    // Pre-pass: max badge width so rows with `lastActive` line up whether or
    // not THIS row carries a throttle badge. Without this, the row that DOES
    // have "out of credits" shifts every other row's `lastActive` left by
    // ~16 chars, exactly what the version-managed block at maxStatusWidth
    // already solves above.
    let gMaxStatusWidth = 0;
    for (const agentId of globallyInstalled) {
      const gInfoRaw = globalInfoMap.get(agentId);
      const gInfo = gInfoRaw ? mergeCanonical(gInfoRaw) : undefined;
      const w = visibleWidth(formatUsageStatusBadge(gInfo?.usageStatus));
      if (w > gMaxStatusWidth) gMaxStatusWidth = w;
    }

    for (const agentId of globallyInstalled) {
      const agent = AGENTS[agentId];
      const cliState = cliStates[agentId];

      console.log(`  ${chalk.bold(agentLabel(agentId))}`);
      const gInfoRaw = globalInfoMap.get(agentId);
      const gInfo = gInfoRaw ? mergeCanonical(gInfoRaw) : undefined;
      const verLabel = `${cliState?.version || 'installed'} ${chalk.gray('(global)')}`;
      const verLabelLen = `${cliState?.version || 'installed'} (global)`.length;
      const padding = ' '.repeat(Math.max(0, globalMaxVerLabel - verLabelLen));
      const parts = [`    ${verLabel}${padding}`];
      const gUsageKey = getUsageLookupKey(gInfo);
      const gUsage = gUsageKey ? usageByKey.get(gUsageKey) : undefined;
      const gUsageStr = formatUsageSummary(gInfo?.plan || null, gUsage?.snapshot || null);
      const gActiveStr = gInfo ? formatLastActive(gInfo.lastActive) : '';
      if (gInfo?.email || gUsageStr || gActiveStr) parts.push(gInfo?.email ? chalk.cyan(gInfo.email) : '');
      if (gUsageStr || gActiveStr) parts.push(gUsageStr);
      const gStatusStr = formatUsageStatusBadge(gInfo?.usageStatus);
      if (gMaxStatusWidth > 0) {
        const statusPad = ' '.repeat(Math.max(0, gMaxStatusWidth - visibleWidth(gStatusStr)));
        parts.push(gStatusStr + statusPad);
      }
      if (gActiveStr) parts.push(gActiveStr);
      console.log(parts.join('  '));
      if (showPaths && cliState?.path) {
        console.log(chalk.gray(`      ${cliState.path}`));
      }
      // Profile rows under a globally-installed harness. Use a simpler
      // alignment here since this section doesn't share column state with
      // the version-managed block.
      const profilesHere = profilesByAgent.get(agentId) ?? [];
      if (profilesHere.length > 0) {
        const nameWidth = Math.max(globalMaxVerLabel, ...profilesHere.map((p) => p.name.length));
        const authWidth = Math.max(...profilesHere.map((p) => p.auth.length));
        for (const profile of profilesHere) {
          console.log(
            `    ${chalk.cyan(profile.name.padEnd(nameWidth))}  ` +
              `${chalk.gray(profile.auth.padEnd(authWidth))}  ` +
              `${chalk.gray('profile')}  ` +
              chalk.gray(profile.model),
          );
          if (showPaths) {
            console.log(chalk.gray(`      ${profile.path}`));
          }
        }
      }
      if (agent.npmPackage && cliState?.version) {
        console.log(chalk.gray(`    Manage: agents add ${agentId}@${cliState.version} -y`));
      }
      console.log();
    }
  }

  // Agents with no install but with profiles defined — render under the same
  // harness header so users find them where they look.
  if (profileOnly.length > 0) {
    if (versionManaged.length === 0 && globallyInstalled.length === 0) {
      console.log(chalk.bold('Profile-only Agents\n'));
    }
    for (const agentId of profileOnly) {
      const profilesHere = profilesByAgent.get(agentId) ?? [];
      console.log(`  ${chalk.bold(agentLabel(agentId))}${chalk.yellow(' (profile only)')}`);
      const nameWidth = Math.max(...profilesHere.map((p) => p.name.length));
      const authWidth = Math.max(...profilesHere.map((p) => p.auth.length));
      for (const profile of profilesHere) {
        console.log(
          `    ${chalk.cyan(profile.name.padEnd(nameWidth))}  ` +
            `${chalk.gray(profile.auth.padEnd(authWidth))}  ` +
            `${chalk.gray('profile')}  ` +
            chalk.gray(profile.model),
        );
        if (showPaths) {
          console.log(chalk.gray(`      ${profile.path}`));
        }
      }
      console.log();
    }
  }

  // If filtering to a specific agent and not found
  if (
    filterAgentId &&
    versionManaged.length === 0 &&
    globallyInstalled.length === 0 &&
    profileOnly.length === 0
  ) {
    console.log(`  ${chalk.bold(agentLabel(filterAgentId))}: ${chalk.gray('not installed')}`);
    console.log();
  }

  // No agents installed at all
  if (
    versionManaged.length === 0 &&
    globallyInstalled.length === 0 &&
    profileOnly.length === 0 &&
    profileSummaries.length === 0 &&
    !filterAgentId
  ) {
    console.log(chalk.gray('  No agent CLIs installed.'));
    console.log(chalk.gray('  Run: agents add claude@latest'));
    console.log();
  }

  // Show shims path status at the end (only for full list with managed versions)
  if (versionManaged.length > 0 && !filterAgentId) {
    const shimsDir = getShimsDir();
    if (isShimsInPath()) {
      console.log(chalk.gray(`Shims: ${shimsDir} (in PATH)`));
    } else {
      console.log(chalk.yellow(`Shims: ${shimsDir} (not in PATH)`));
      console.log(chalk.gray('Add to PATH for automatic version switching'));
    }
  }

  // Check for new resources when viewing a specific agent
  if (filterAgentId && versionManaged.length > 0) {
    const defaultVersion = getGlobalDefault(filterAgentId);
    if (defaultVersion) {
      const available = getAvailableResources();
      const synced = getActuallySyncedResources(filterAgentId, defaultVersion);
      const projectOnly = getProjectOnlyResources();
      const newResources = getNewResources(available, synced, projectOnly);

      if (hasNewResources(newResources, filterAgentId, defaultVersion)) {
        try {
          const selection = await promptNewResourceSelection(filterAgentId, newResources, defaultVersion);
          if (selection && Object.keys(selection).length > 0) {
            const result = syncResourcesToVersion(filterAgentId, defaultVersion, selection);
            const synced: string[] = [];
            if (result.commands) synced.push('commands');
            if (result.skills) synced.push('skills');
            if (result.hooks) synced.push('hooks');
            if (result.memory.length > 0) synced.push('memory');
            if (result.permissions) synced.push('permissions');
            if (result.mcp.length > 0) synced.push('mcp');
            if (result.plugins.length > 0) synced.push('plugins');
            if (result.workflows.length > 0) synced.push('workflows');

            if (synced.length > 0) {
              console.log(chalk.green(`\nSynced to ${agentLabel(filterAgentId)}@${defaultVersion}: ${synced.join(', ')}`));
            }
          }
        } catch (err) {
          if (isPromptCancelled(err)) return;
          throw err;
        }
      }
    }
  }
}

/**
 * Show detailed resources for a specific agent version.
 * Called when: `agents view claude@2.0.65` or `agents view claude@default`
 */
async function showAgentResources(agentId: AgentId, requestedVersion: string): Promise<void> {
  const spinner = ora({ text: 'Loading...', isSilent: !process.stdout.isTTY }).start();

  const cwd = process.cwd();
  const agentsDir = getAgentsDir();
  const cliStates = await getAllCliStates();

  // Resolve 'default' to actual version
  let version: string | null = null;
  if (requestedVersion === 'default') {
    version = getGlobalDefault(agentId);
    if (!version) {
      spinner.stop();
      console.log(chalk.yellow(`No default version set for ${agentLabel(agentId)}`));
      console.log(chalk.gray(`Run: agents use ${agentId}@<version>`));
      return;
    }
  } else {
    const versions = listInstalledVersions(agentId);
    if (versions.includes(requestedVersion)) {
      version = requestedVersion;
    } else {
      spinner.stop();
      console.log(chalk.red(`Version ${requestedVersion} not installed for ${agentLabel(agentId)}`));
      console.log(chalk.gray(`Installed versions: ${versions.join(', ') || 'none'}`));
      return;
    }
  }
  const home = getVersionHomePath(agentId, version);

  // Get git sync status if ~/.agents/ is a git repo
  const userAgentsDir = getUserAgentsDir();
  const hasGitRepo = isGitRepo(userAgentsDir);
  const commandsSync = hasGitRepo ? await getGitSyncStatus(userAgentsDir, 'commands') : null;
  const skillsSync = hasGitRepo ? await getGitSyncStatus(userAgentsDir, 'skills') : null;
  const hooksSync = hasGitRepo ? await getGitSyncStatus(userAgentsDir, 'hooks') : null;
  const memorySync = hasGitRepo ? await getGitSyncStatus(userAgentsDir, 'rules') : null;

  // Helper to determine sync state for a resource
  const getSyncState = (
    resourceName: string,
    resourceType: 'commands' | 'skills' | 'hooks' | 'memory',
    syncStatus: Awaited<ReturnType<typeof getGitSyncStatus>>
  ): SyncState | undefined => {
    if (!syncStatus) return undefined;

    let relativePath: string;
    if (resourceType === 'commands') {
      relativePath = `commands/${resourceName}.md`;
    } else if (resourceType === 'skills') {
      relativePath = `skills/${resourceName}`;
    } else if (resourceType === 'hooks') {
      relativePath = `hooks/${resourceName}`;
    } else {
      // Rules files: map agent-specific name (CLAUDE.md) back to canonical (AGENTS.md)
      const centralName = getCentralRulesFileName(agentId);
      relativePath = `rules/${centralName}`;
    }

    const matchesPath = (f: string) => f === relativePath || f.startsWith(relativePath + '/');

    const isNew = syncStatus.new.some(matchesPath);
    const isStaged = syncStatus.staged.some(matchesPath);
    const isModified = syncStatus.modified.some(matchesPath);
    const isDeleted = syncStatus.deleted.some(matchesPath);
    const isSynced = syncStatus.synced.some(matchesPath);

    if (isNew || isStaged) {
      return 'new';
    }
    if (isModified) {
      return 'modified';
    }
    if (isDeleted) {
      return 'deleted';
    }
    if (isSynced) {
      return 'synced';
    }
    // Not in any array = local-only (untracked with no files)
    return 'new';
  };

  // Collect resources for the specific version
  interface SkillError {
    name: string;
    path: string;
    error: string;
  }

  interface AgentResourceDisplay {
    agentId: AgentId;
    agentName: string;
    version: string | null;
    commands: ResourceWithSync[];
    skills: ResourceWithSync[];
    skillErrors: SkillError[];
    mcp: ResourceWithSync[];
    memory: ResourceWithSync[];
    hooks: ResourceWithSync[];
    workflows: ResourceWithSync[];
  }

  const resources = getAgentResources(agentId, {
    cwd,
    scope: 'all',
    cliInstalled: cliStates[agentId]?.installed ?? false,
    home,
  });

  const agentData: AgentResourceDisplay = {
    agentId,
    agentName: agentLabel(agentId),
    version,
    commands: resources.commands.map(r => ({
      ...r,
      syncState: r.scope === 'project' ? undefined : getSyncState(r.name, 'commands', commandsSync),
    })),
    skills: resources.skills.map(r => ({
      ...r,
      syncState: r.scope === 'project' ? undefined : getSyncState(r.name, 'skills', skillsSync),
    })),
    skillErrors: resources.skillErrors,
    mcp: resources.mcp.map(r => ({ name: r.name, scope: r.scope, syncState: r.scope === 'project' ? undefined : 'synced' as SyncState })),
    memory: resources.memory.map(r => ({
      ...r,
      syncState: r.scope === 'project' ? undefined : getSyncState(r.name, 'memory', memorySync),
    })),
    hooks: resources.hooks.map(r => ({
      ...r,
      syncState: r.scope === 'project' ? undefined : getSyncState(r.name, 'hooks', hooksSync),
    })),
    workflows: resources.workflows.map(r => ({ name: r.name, path: r.path, scope: r.scope })),
  };

  spinner.stop();

  // Render helper for resources
  function renderSection(
    title: string,
    items: ResourceWithSync[]
  ): void {
    console.log(chalk.bold(`\n${title}\n`));

    if (items.length === 0) {
      console.log(`  ${chalk.gray('none')}`);
      return;
    }

    const versionStr = agentData.version ? ` (${agentData.version})` : '';
    const agentHeader = home ? termLink(agentData.agentName, home) : agentData.agentName;
    console.log(`  ${chalk.bold(agentHeader)}${chalk.gray(versionStr)}:`);

    for (const r of items) {
      let nameColor = chalk.cyan;
      if (r.syncState === 'synced') nameColor = chalk.green;
      else if (r.syncState === 'new') nameColor = chalk.blue;
      else if (r.syncState === 'modified') nameColor = chalk.yellow;
      else if (r.syncState === 'deleted') nameColor = chalk.red;

      const linkedName = r.path ? termLink(r.name, linkTarget(r.path)) : r.name;
      let display = nameColor(linkedName);
      if (r.ruleCount !== undefined) display += chalk.gray(` (${r.ruleCount} rules)`);
      // Source annotation: project overrides user, user overrides system
      const sourceTag = r.scope === 'project' ? chalk.blue('[project]')
        : r.scope === 'user' ? chalk.cyan('[user]')
        : chalk.gray('[system]');
      display += ` ${sourceTag}`;
      const syncStr = r.syncState ? chalk.gray(` [${r.syncState}]`) : '';
      console.log(`    ${display}${syncStr}`);
    }
  }

  // Render promptcuts (cross-agent, not per-version). Shortcuts are layered
  // across system + user files with user precedence; the displayed file path
  // is whichever is "live" — user if it exists, else system.
  function renderPromptcuts(): void {
    console.log(chalk.bold(`\nPromptcuts\n`));
    const merged = readMergedPromptcuts();
    const count = Object.keys(merged).length;
    if (count === 0) {
      console.log(`  ${chalk.gray('none')}`);
      return;
    }
    const label = `${count} shortcut${count === 1 ? '' : 's'}`;
    console.log(`  ${chalk.green(label).padEnd(24)} ${chalk.gray(formatPath(getEffectivePromptcutsPath(), cwd))}`);
  }

  // 1. Agent CLI info
  console.log(chalk.bold('Agent CLIs\n'));
  const accountInfo = await getAccountInfo(agentId, home);
  const usageInfo = await getUsageInfoForIdentity({
    agentId,
    home,
    cliVersion: version,
    info: accountInfo,
  });
  const emailStr = accountInfo.email ? chalk.cyan(`  ${accountInfo.email}`) : '';
  const status = chalk.green(version);
  const usageStr = formatUsageSummary(accountInfo.plan, null);
  const usagePart = usageStr ? `  ${usageStr}` : '';
  console.log(`  ${colorAgent(agentId)(AGENTS[agentId].name.padEnd(14))} ${status}${emailStr}${usagePart}`);

  const usageLines = formatUsageSection(usageInfo);
  if (usageLines.length > 0) {
    console.log();
    for (const line of usageLines) {
      console.log(line);
    }
  }

  // 2. Resources
  renderSection('Commands', agentData.commands);
  renderSection('Skills', agentData.skills);

  // Show skill parse errors if any
  if (agentData.skillErrors.length > 0) {
    console.log(`\n  ${chalk.red('Skill Errors')}:`);
    for (const err of agentData.skillErrors) {
      console.log(`    ${chalk.red(err.name.padEnd(20))} ${chalk.gray(err.error)}`);
      console.log(`      ${chalk.gray(formatPath(err.path, cwd))}`);
    }
  }

  renderSection('MCP Servers', agentData.mcp);

  if (WORKFLOW_CAPABLE_AGENTS.includes(agentId)) {
    renderSection('Workflows', agentData.workflows);
  }

  if (PLUGINS_CAPABLE_AGENTS.includes(agentId)) {
    const plugins = discoverPlugins().filter(p => pluginSupportsAgent(p, agentId));
    console.log(chalk.bold('\nPlugins\n'));
    if (plugins.length === 0) {
      console.log(`  ${chalk.gray('none')}`);
    } else {
      const versionStr = agentData.version ? ` (${agentData.version})` : '';
      const agentHeader = home ? termLink(agentData.agentName, home) : agentData.agentName;
      console.log(`  ${chalk.bold(agentHeader)}${chalk.gray(versionStr)}:`);
      const pluralize = (n: number, singular: string) => `${n} ${singular}${n === 1 ? '' : 's'}`;
      for (const p of plugins) {
        const linkedName = termLink(p.name, linkTarget(p.root));
        const parts: string[] = [];
        if (p.skills.length > 0) parts.push(pluralize(p.skills.length, 'skill'));
        if (p.commands.length > 0) parts.push(pluralize(p.commands.length, 'command'));
        if (p.agentDefs.length > 0) parts.push(pluralize(p.agentDefs.length, 'subagent'));
        if (p.hooks.length > 0) parts.push(pluralize(p.hooks.length, 'hook'));
        if (p.mcpServers.length > 0) parts.push(`${p.mcpServers.length} MCP`);
        if (p.lspServers.length > 0) parts.push(`${p.lspServers.length} LSP`);
        if (p.monitors.length > 0) parts.push(pluralize(p.monitors.length, 'monitor'));
        if (p.bin.length > 0) parts.push(pluralize(p.bin.length, 'bin'));
        if (p.hasSettings) parts.push('settings');
        const contents = parts.length > 0 ? chalk.gray(` (${parts.join(', ')})`) : '';
        console.log(`    ${chalk.cyan(linkedName)}${contents} ${chalk.cyan('[user]')}`);
      }
    }
  }

  // Rules section with subrules breakdown
  function renderRulesSection(): void {
    console.log(chalk.bold('\nRules\n'));
    const items = agentData.memory;

    if (items.length === 0) {
      console.log(`  ${chalk.gray('none')}`);
      return;
    }

    const versionStr = agentData.version ? ` (${agentData.version})` : '';
    console.log(`  ${chalk.bold(agentData.agentName)}${chalk.gray(versionStr)}:`);

    // Get composed subrules for the user scope
    let composedSubrules: ComposedSubrule[] = [];
    try {
      const composed = composeRulesFromState({ cwd });
      composedSubrules = composed.subrules;
    } catch {
      // No preset configured or rules.yaml missing — show rules without subrule breakdown
    }

    for (const r of items) {
      let nameColor = chalk.cyan;
      if (r.syncState === 'synced') nameColor = chalk.green;
      else if (r.syncState === 'new') nameColor = chalk.blue;
      else if (r.syncState === 'modified') nameColor = chalk.yellow;
      else if (r.syncState === 'deleted') nameColor = chalk.red;

      const linkedName = r.path ? termLink(r.name, linkTarget(r.path)) : r.name;
      let display = nameColor(linkedName);
      if (r.ruleCount !== undefined) display += chalk.gray(` (${r.ruleCount} rules)`);
      const sourceTag = r.scope === 'project' ? chalk.blue('[project]')
        : r.scope === 'user' ? chalk.cyan('[user]')
        : chalk.gray('[system]');
      display += ` ${sourceTag}`;
      const syncStr = r.syncState ? chalk.gray(` [${r.syncState}]`) : '';
      console.log(`    ${display}${syncStr}`);

      // Show subrules for user-scope rules (the compiled CLAUDE.md)
      if (r.scope === 'user' && composedSubrules.length > 0) {
        for (const sub of composedSubrules) {
          const scopeLabel = sub.layerScope === 'project' ? chalk.blue('[project]')
            : sub.layerScope === 'user' ? chalk.cyan('[user]')
            : sub.layerScope === 'extra' ? chalk.magenta(`[${sub.layerAlias || 'extra'}]`)
            : chalk.gray('[system]');
          const linkedSubName = termLink(sub.name, sub.sourcePath);
          console.log(`      ${chalk.gray('-')} ${linkedSubName} ${scopeLabel}`);
        }
      }
    }
  }
  renderRulesSection();

  renderSection('Hooks', agentData.hooks);
  renderPromptcuts();

  // Show legend at the end if git repo exists
  if (hasGitRepo) {
    console.log();
    console.log(chalk.gray('Legend:'), chalk.green('Tracked'), chalk.blue('Local-only'), chalk.yellow('Modified'), chalk.red('Deleted'));
  }
}

/** Machine-readable entry for a single installed version. */
export interface ViewJsonVersion {
  version: string;
  isDefault: boolean;
  signedIn: boolean;
  email: string | null;
  plan: string | null;
  usageStatus: 'available' | 'rate_limited' | 'out_of_credits' | null;
  // Optional so existing TypeScript consumers compiled against the prior
  // interface don't error on the new field; null means we know there are no
  // outstanding overage credits, undefined means we haven't fetched / can't say.
  overageCredits?: { amount: number; currency: string } | null;
  windows: Array<{
    key: 'session' | 'week' | 'sonnet_week';
    usedPercent: number;
    resetsAt: string | null;
  }>;
  lastActive: string | null;
  path: string;
}

/** Machine-readable entry for one agent's installed versions. */
export interface ViewJsonAgent {
  agent: AgentId;
  versions: ViewJsonVersion[];
  profiles: ProfileSummary[];
}

/**
 * Collect structured info for one or more agents without rendering to the
 * terminal. Used by `--json` output and any programmatic consumer (e.g. the
 * agents-cli extension's "resume current session in best available version"
 * command).
 */
async function collectAgentsJson(filterAgentId?: AgentId): Promise<ViewJsonAgent[]> {
  const agentsToShow = filterAgentId ? [filterAgentId] : ALL_AGENT_IDS;

  const infoFetches: Promise<{ agentId: AgentId; version: string; home: string; info: AccountInfo }>[] = [];
  for (const agentId of agentsToShow) {
    for (const ver of listInstalledVersions(agentId)) {
      const home = getVersionHomePath(agentId, ver);
      infoFetches.push(
        getAccountInfo(agentId, home).then((info) => ({ agentId, version: ver, home, info }))
      );
    }
  }
  const infoResults = await Promise.all(infoFetches);

  const { canonicalByUsageKey, usageByKey } = await getUsageInfoByIdentity(
    infoResults.map(({ agentId, home, version, info }) => ({
      agentId,
      home,
      cliVersion: version,
      info,
    }))
  );

  const mergeCanonical = (info: AccountInfo): AccountInfo => {
    const key = getUsageLookupKey(info);
    if (!key) return info;
    const canon = canonicalByUsageKey.get(key);
    if (!canon) return info;
    return {
      ...info,
      plan: canon.plan,
      usageStatus: canon.usageStatus,
      overageCredits: canon.overageCredits,
    };
  };

  const byAgent = new Map<AgentId, ViewJsonVersion[]>();
  for (const { agentId, version, info: rawInfo } of infoResults) {
    const info = mergeCanonical(rawInfo);
    const globalDefault = getGlobalDefault(agentId);
    const usageKey = getUsageLookupKey(info);
    const usageInfo = usageKey ? usageByKey.get(usageKey) : undefined;
    const snapshot = usageInfo?.snapshot ?? null;

    const entry: ViewJsonVersion = {
      version,
      isDefault: version === globalDefault,
      signedIn: !!info.email,
      email: info.email,
      plan: info.plan,
      usageStatus: info.usageStatus,
      overageCredits: info.overageCredits,
      windows: snapshot
        ? snapshot.windows.map((w) => ({
            key: w.key,
            usedPercent: w.usedPercent,
            resetsAt: w.resetsAt ? w.resetsAt.toISOString() : null,
          }))
        : [],
      lastActive: info.lastActive ? info.lastActive.toISOString() : null,
      path: getVersionDir(agentId, version),
    };

    const existing = byAgent.get(agentId);
    if (existing) existing.push(entry);
    else byAgent.set(agentId, [entry]);
  }

  const profilesByAgent = getProfilesByAgent(filterAgentId);
  const out: ViewJsonAgent[] = [];
  for (const agentId of agentsToShow) {
    const versions = byAgent.get(agentId) ?? [];
    versions.sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return compareVersions(b.version, a.version);
    });
    out.push({ agent: agentId, versions, profiles: profilesByAgent.get(agentId) ?? [] });
  }
  return out;
}

interface PrunePlanEntry {
  agentId: AgentId;
  version: string;
  email: string;
  keeper: string;
  isDefault: boolean;
  /**
   * 'duplicate'    — older version sharing an email with a newer install.
   * 'home-leftover' — home-only dir left over after a previous removeVersion;
   *                   no binary, but transcripts may still live here.
   */
  reason: 'duplicate' | 'home-leftover';
}

interface AgentPrunePlan {
  agentId: AgentId;
  toPrune: PrunePlanEntry[];
  skippedDefaults: PrunePlanEntry[];
}

async function buildAgentPrunePlan(agentId: AgentId): Promise<AgentPrunePlan> {
  const dirInfos = listInstalledVersionDirs(agentId);
  const entries = await Promise.all(
    dirInfos.map(async ({ version, hasBinary }) => {
      const home = getVersionHomePath(agentId, version);
      const info = await getAccountInfo(agentId, home);
      return { version, info, hasBinary };
    })
  );

  const globalDefault = getGlobalDefault(agentId);
  const toPrune: PrunePlanEntry[] = [];
  const skippedDefaults: PrunePlanEntry[] = [];

  // Duplicate-account detection runs only over installs that actually have a
  // working binary — those are the things that compete for "the live install
  // for this account."
  const installed = entries.filter((e) => e.hasBinary);
  const byEmail = new Map<string, typeof installed>();
  for (const e of installed) {
    if (!e.info.email) continue;
    const key = e.info.email.toLowerCase();
    const list = byEmail.get(key) ?? [];
    list.push(e);
    byEmail.set(key, list);
  }

  for (const [, group] of byEmail) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => compareVersions(b.version, a.version));
    const keeper = sorted[0].version;
    for (const older of sorted.slice(1)) {
      const plan: PrunePlanEntry = {
        agentId,
        version: older.version,
        email: older.info.email as string,
        keeper,
        isDefault: older.version === globalDefault,
        reason: 'duplicate',
      };
      if (plan.isDefault) skippedDefaults.push(plan);
      else toPrune.push(plan);
    }
  }

  // Home-only leftovers: dirs without a binary. These are residue from a
  // prior removeVersion before the soft-delete migration, plus any hand-edited
  // installs. Surface them so the user can move them to trash.
  for (const e of entries) {
    if (e.hasBinary) continue;
    if (e.version === globalDefault) continue; // never auto-suggest the default
    toPrune.push({
      agentId,
      version: e.version,
      email: e.info.email || '',
      keeper: '',
      isDefault: false,
      reason: 'home-leftover',
    });
  }

  return { agentId, toPrune, skippedDefaults };
}

async function executePrunePlan(plan: AgentPrunePlan): Promise<Array<{ agent: AgentId; version: string }>> {
  const moved: Array<{ agent: AgentId; version: string }> = [];
  for (const p of plan.toPrune) {
    const ok = removeVersion(p.agentId, p.version);
    if (ok) {
      console.log(chalk.green(`Moved ${agentLabel(p.agentId)}@${p.version} to trash`));
      moved.push({ agent: p.agentId, version: p.version });
    } else {
      console.log(chalk.yellow(`Already gone: ${agentLabel(p.agentId)}@${p.version}`));
    }
  }
  if (listInstalledVersions(plan.agentId).length === 0) {
    removeShim(plan.agentId);
  }
  return moved;
}

function printPrunePlan(plan: AgentPrunePlan, isFirst: boolean): void {
  if (plan.skippedDefaults.length > 0) {
    console.log(chalk.yellow(`Skipping default versions for ${agentLabel(plan.agentId)} (switch default first):`));
    for (const s of plan.skippedDefaults) {
      console.log(
        `  ${agentLabel(s.agentId)}@${s.version}  ${chalk.cyan(s.email)}  ` +
        chalk.gray(`— duplicate of ${s.agentId}@${s.keeper}. Run: agents use ${s.agentId}@${s.keeper}`)
      );
    }
    console.log();
  }
  if (plan.toPrune.length === 0) return;
  const heading = isFirst ? `Will move to trash for ${agentLabel(plan.agentId)}:` : `Also found candidates for ${agentLabel(plan.agentId)}:`;
  console.log(chalk.bold(heading));
  for (const p of plan.toPrune) {
    if (p.reason === 'duplicate') {
      console.log(
        `  ${agentLabel(p.agentId)}@${p.version}  ${chalk.cyan(p.email)}  ` +
        chalk.gray(`— duplicate, keeping ${p.agentId}@${p.keeper}`)
      );
    } else {
      console.log(
        `  ${agentLabel(p.agentId)}@${p.version}  ` +
        chalk.gray(`— home-only leftover (no binary; transcripts preserved in trash)`)
      );
    }
  }
  console.log();
}

/**
 * Prune older installed versions that share an email with a newer installed
 * version. Keeps the highest semver per email, skips the global default (with
 * a warning so the user can switch first).
 *
 * When filterAgentId is set, prunes that agent first, then cascades: after
 * each agent, offers the next agent with duplicates. User answering "no"
 * stops the chain.
 */
export async function pruneDuplicates(
  filterAgentId: AgentId | undefined,
  yes: boolean,
  dryRun: boolean
): Promise<void> {
  const ordered: AgentId[] = filterAgentId
    ? [filterAgentId, ...ALL_AGENT_IDS.filter((a) => a !== filterAgentId)]
    : [...ALL_AGENT_IDS];

  const spinner = ora({ text: 'Scanning installed versions...', isSilent: !process.stdout.isTTY }).start();
  const plans = await Promise.all(ordered.map((a) => buildAgentPrunePlan(a)));
  spinner.stop();

  const actionable = plans.filter((p) => p.toPrune.length > 0 || p.skippedDefaults.length > 0);

  if (actionable.length === 0) {
    console.log(chalk.gray('Nothing to prune — no duplicate-account installs and no home-only leftovers.'));
    return;
  }

  const totalCandidates = actionable.reduce((n, plan) => n + plan.toPrune.length, 0);
  const allMoved: Array<{ agent: AgentId; version: string }> = [];
  let isFirst = true;
  let processedAny = false;

  for (const plan of actionable) {
    printPrunePlan(plan, isFirst);

    if (plan.toPrune.length === 0) {
      // Only skippedDefaults for this agent; move on.
      isFirst = false;
      continue;
    }

    if (dryRun) {
      processedAny = true;
      isFirst = false;
      continue;
    }

    if (!yes) {
      if (!isInteractiveTerminal()) {
        console.log(chalk.red('Refusing to prune in a non-interactive shell without --yes.'));
        if (filterAgentId) {
          console.log(chalk.gray(`Re-run with: agents prune cleanup ${filterAgentId} --dry-run`));
        } else {
          console.log(chalk.gray('Re-run with: agents prune cleanup --dry-run'));
        }
        process.exit(1);
      }
      const n = plan.toPrune.length;
      const message = isFirst
        ? `Prune ${n} ${agentLabel(plan.agentId)} version${n === 1 ? '' : 's'}?`
        : `Also prune ${n} ${agentLabel(plan.agentId)} version${n === 1 ? '' : 's'}?`;
      let proceed = false;
      try {
        proceed = await confirm({ message, default: false });
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('Cancelled'));
          break;
        }
        throw err;
      }
      if (!proceed) {
        console.log(chalk.gray('Stopping here.'));
        break;
      }
    }

    allMoved.push(...(await executePrunePlan(plan)));
    processedAny = true;
    isFirst = false;
    console.log();
  }

  if (dryRun) {
    console.log(chalk.gray(`${totalCandidates} version${totalCandidates === 1 ? '' : 's'} would be pruned. Run without --dry-run to delete.`));
    return;
  }

  if (processedAny) {
    console.log(chalk.bold(`Pruned ${allMoved.length} version${allMoved.length === 1 ? '' : 's'}.`));
    printTrashFooter(allMoved);
  }
}

/**
 * Main view action handler.
 * Exported for use by deprecated aliases.
 */
export async function viewAction(
  agentArg?: string,
  options?: { json?: boolean; prune?: boolean; yes?: boolean; dryRun?: boolean }
): Promise<void> {
  const json = options?.json === true;
  const prune = options?.prune === true;
  const yes = options?.yes === true;
  const dryRun = options?.dryRun === true;

  if (!agentArg) {
    if (prune) {
      await pruneDuplicates(undefined, yes, dryRun);
      return;
    }
    if (json) {
      const data = await collectAgentsJson();
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    // No argument: show all installed versions
    await showInstalledVersions();
    return;
  }

  // Parse agent@version syntax
  const parts = agentArg.split('@');
  const agentName = parts[0];

  const agentId = resolveAgentName(agentName);
  if (!agentId) {
    if (json) {
      console.log(JSON.stringify({ error: formatAgentError(agentName) }));
      process.exit(1);
    }
    console.log(chalk.red(formatAgentError(agentName)));
    process.exit(1);
  }
  // Keep 'default' as-is since showAgentResources handles it; resolveVersionAlias
  // returns undefined for 'default' which would skip the detailed view.
  const requestedVersion = parts[1] === 'default'
    ? 'default'
    : (resolveVersionAlias(agentId, parts[1]) ?? null);

  if (prune) {
    if (requestedVersion) {
      console.log(chalk.red('--prune does not take a @version suffix.'));
      console.log(chalk.gray(`Run: agents view ${agentId} --prune`));
      process.exit(1);
    }
    await pruneDuplicates(agentId, yes, dryRun);
    return;
  }

  if (json) {
    // --json ignores the @version suffix (detailed resource view is not yet
    // exposed as structured data). Emit the version list for the agent.
    const data = await collectAgentsJson(agentId);
    console.log(JSON.stringify(data[0] ?? { agent: agentId, versions: [], profiles: [] }, null, 2));
    return;
  }

  if (requestedVersion) {
    // Specific version requested: show detailed resources
    await showAgentResources(agentId, requestedVersion);
  } else {
    // Just agent name: show versions for that agent
    await showInstalledVersions(agentId);
  }
}

/** Register the `agents view` command. */
export function registerViewCommand(program: Command): void {
  program
    .command('view [agent]')
    .description('Show what agent CLIs are installed and which versions you have. Inspect resources when you pass agent@version.')
    .option('--json', 'Emit machine-readable JSON (version list, usage, signed-in status).')
    .option('--prune', 'Remove older installed versions that share an account with a newer installed version. Skips the global default.')
    .option('--dry-run', 'With --prune, show duplicate versions without deleting')
    .option('-y, --yes', 'Skip the prune confirmation prompt.')
    .addHelpText('after', `
Examples:
  # Show all installed agents with versions, accounts, and usage
  agents view

  # Show versions for one agent
  agents view claude

  # Detailed view: resources, commands, skills, MCP servers for a specific version
  agents view claude@2.1.112
  agents view claude@default

  # Machine-readable output (used by tools that pick a version programmatically)
  agents view claude --json

  # Prune older versions that duplicate an account already used by a newer version
  agents view --prune --dry-run
  agents view claude --prune
  agents view claude --prune -y

When to use:
  - Checking which agents are installed and what their default versions are
  - Seeing which account each version is logged into (useful for multi-account setups)
  - Inspecting commands, skills, hooks, and MCP servers synced to a version
  - Verifying a version is installed before running it
  - Cleaning up stale versions left behind after upgrading (--prune)

Output:
  - Without arguments: table of all agents with versions, emails, usage stats
  - With agent name: versions for that agent, showing which is the default
  - With agent@version: detailed breakdown of resources synced to that version
  - With --json: structured JSON with version, isDefault, signedIn, email, plan,
    usageStatus, per-window usedPercent, lastActive, and path
  - With --prune: plan of which older versions will be removed, then confirm
  - With --prune --dry-run: preview only, no deletions
`)
    .action((agentArg: string | undefined, options: { json?: boolean; prune?: boolean; yes?: boolean; dryRun?: boolean }) => viewAction(agentArg, options));
}
