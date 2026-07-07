/**
 * Usage command -- show rate-limit / quota status for each installed agent.
 *
 * Lists every installed agent with the best available usage snapshot:
 *   - claude: live OAuth API call (cached for 2 minutes)
 *   - codex:  parsed from latest session log's rate_limits event
 *   - others: marked as "not exposed by CLI" (Gemini, OpenCode, Cursor, etc.
 *     don't publish per-account usage today)
 */
import type { Command } from 'commander';
import { addHostOption } from '../lib/hosts/option.js';
import chalk from 'chalk';

import {
  ALL_AGENT_IDS,
  AGENTS,
  getAccountInfo,
  agentLabel,
  resolveAgentName,
  formatAgentError,
} from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { listInstalledVersions, getGlobalDefault, getVersionHomePath } from '../lib/versions.js';
import { formatUsageSection, getUsageInfoForIdentity } from '../lib/usage.js';

/** Agents whose CLI surfaces usage data we can read today. */
const USAGE_SUPPORTED: ReadonlySet<AgentId> = new Set<AgentId>(['claude', 'codex']);

export function registerUsageCommand(program: Command): void {
  addHostOption(program.command('usage [agent]'))
    .description('Show rate-limit / quota usage per agent')
    .addHelpText('after', `
Examples:
  agents usage              Show usage for all installed agents
  agents usage claude       Show usage for Claude only
  agents usage codex        Show usage for Codex only
`)
    .action(async (agentFilter?: string) => {
      let filter: AgentId | undefined;
      if (agentFilter) {
        const resolved = resolveAgentName(agentFilter);
        if (!resolved) {
          console.error(chalk.red(formatAgentError(agentFilter)));
          process.exit(1);
        }
        filter = resolved;
      }
      const targets = filter
        ? [filter]
        : ALL_AGENT_IDS.filter((id) => listInstalledVersions(id).length > 0);

      if (targets.length === 0) {
        console.log(chalk.gray('No agents installed. Run `agents add <agent>` first.'));
        return;
      }

      const sections = await Promise.all(
        targets.map(async (agentId) => renderAgentUsage(agentId as AgentId))
      );

      console.log(sections.filter(Boolean).join('\n\n'));
    });
}

async function renderAgentUsage(agentId: AgentId): Promise<string> {
  const cfg = AGENTS[agentId];
  const heading = agentLabel(agentId);

  if (!USAGE_SUPPORTED.has(agentId)) {
    return [
      `${heading}`,
      `  ${chalk.dim(`${cfg.name} CLI does not publish usage data.`)}`,
    ].join('\n');
  }

  const versions = listInstalledVersions(agentId);
  const version = getGlobalDefault(agentId) || versions[0];
  if (!version) {
    return [`${heading}`, `  ${chalk.dim('No version installed.')}`].join('\n');
  }
  const home = getVersionHomePath(agentId, version);

  const info = await getAccountInfo(agentId, home);
  if (!info.usageKey && !info.accountKey) {
    return [`${heading}`, `  ${chalk.dim('Not signed in.')}`].join('\n');
  }

  const usage = await getUsageInfoForIdentity({
    agentId,
    home,
    info,
    cliVersion: null,
  });

  const lines = [heading];
  if (info.email) lines.push(`  ${chalk.dim(info.email)}`);
  const section = formatUsageSection(usage);
  if (section.length === 0) {
    lines.push(`  ${chalk.dim('No usage data available right now.')}`);
  } else {
    lines.push(...section);
  }
  return lines.join('\n');
}
