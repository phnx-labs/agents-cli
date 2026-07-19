/**
 * Usage command -- show rate-limit / quota status for each installed agent.
 *
 * Lists every installed agent with the best available usage snapshot:
 *   - claude: live OAuth API call (cached for 2 minutes)
 *   - codex:  parsed from latest session log's rate_limits event
 *   - kimi:   live Kimi Code /usages API call (cached for 2 minutes)
 *   - droid:  live Factory billing/limits API call (cached for 2 minutes)
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

/**
 * Agents whose CLI surfaces usage data we can read today. Kept in sync with the
 * live/last-seen sources `getUsageInfo` dispatches on in `../lib/usage.js`
 * (claude, codex, kimi, droid) — an agent with a usage source but missing here
 * would wrongly print "does not publish usage data" for a signed-in account.
 */
const USAGE_SUPPORTED: ReadonlySet<AgentId> = new Set<AgentId>(['claude', 'codex', 'kimi', 'droid']);

/** One agent's usage snapshot — the unit the text and --json renderers share. */
interface AgentUsageRecord {
  agent: AgentId;
  label: string;
  status: 'unsupported' | 'no-version' | 'not-signed-in' | 'ok';
  email?: string;
  usage?: Awaited<ReturnType<typeof getUsageInfoForIdentity>>;
}

export function registerUsageCommand(program: Command): void {
  addHostOption(program.command('usage [agent]'))
    .description('Show rate-limit / quota usage per agent')
    .option('--json', 'Emit machine-readable JSON (per-agent usage snapshot) instead of the table')
    .addHelpText('after', `
Examples:
  agents usage              Show usage for all installed agents
  agents usage claude       Show usage for Claude only
  agents usage codex        Show usage for Codex only
  agents usage --json       Machine-readable snapshot for scripts
`)
    .action(async (agentFilter: string | undefined, options: { json?: boolean }) => {
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
        if (options.json) {
          console.log('[]');
          return;
        }
        console.log(chalk.gray('No agents installed. Run `agents add <agent>` first.'));
        return;
      }

      const records = await Promise.all(
        targets.map((agentId) => collectAgentUsage(agentId as AgentId))
      );

      if (options.json) {
        console.log(JSON.stringify(records, null, 2));
        return;
      }

      console.log(records.map(formatAgentUsage).filter(Boolean).join('\n\n'));
    });
}

/** Gather one agent's usage snapshot as structured data (shared by both renderers). */
async function collectAgentUsage(agentId: AgentId): Promise<AgentUsageRecord> {
  const label = agentLabel(agentId);

  if (!USAGE_SUPPORTED.has(agentId)) {
    return { agent: agentId, label, status: 'unsupported' };
  }

  const versions = listInstalledVersions(agentId);
  const version = getGlobalDefault(agentId) || versions[0];
  if (!version) {
    return { agent: agentId, label, status: 'no-version' };
  }
  const home = getVersionHomePath(agentId, version);

  const info = await getAccountInfo(agentId, home);
  if (!info.usageKey && !info.accountKey) {
    return { agent: agentId, label, status: 'not-signed-in' };
  }

  const usage = await getUsageInfoForIdentity({ agentId, home, info, cliVersion: null });
  return { agent: agentId, label, status: 'ok', email: info.email ?? undefined, usage };
}

/** Render one usage record as the human table section. */
function formatAgentUsage(rec: AgentUsageRecord): string {
  const cfg = AGENTS[rec.agent];
  switch (rec.status) {
    case 'unsupported':
      return [rec.label, `  ${chalk.dim(`${cfg.name} CLI does not publish usage data.`)}`].join('\n');
    case 'no-version':
      return [rec.label, `  ${chalk.dim('No version installed.')}`].join('\n');
    case 'not-signed-in':
      return [rec.label, `  ${chalk.dim('Not signed in.')}`].join('\n');
    case 'ok': {
      const lines = [rec.label];
      if (rec.email) lines.push(`  ${chalk.dim(rec.email)}`);
      const section = formatUsageSection(rec.usage!);
      if (section.length === 0) {
        lines.push(`  ${chalk.dim('No usage data available right now.')}`);
      } else {
        lines.push(...section);
      }
      return lines.join('\n');
    }
  }
}
