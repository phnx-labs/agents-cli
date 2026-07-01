/**
 * Model catalog inspection command.
 *
 * Registers the hidden `agents models` command for listing models
 * supported by installed agent versions. Extracts model catalogs from
 * each agent's CLI bundle and displays IDs, aliases, and metadata.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import { homeDir } from '../lib/platform/index.js';
import {
  AGENTS,
  ALL_AGENT_IDS,
  resolveAgentName,
  formatAgentError,
  agentLabel,
} from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { listInstalledVersions, getGlobalDefault, resolveVersion, resolveVersionAlias } from '../lib/versions.js';
import { getModelCatalog, locateModelSource } from '../lib/models.js';

const MODEL_CAPABLE_AGENTS: AgentId[] = ['claude', 'codex', 'gemini', 'opencode', 'cursor', 'openclaw', 'antigravity', 'kimi'];

/**
 * Agents that don't necessarily install under ~/.agents/versions (cursor ships
 * via a curl script). For these, fall back to the PATH binary and synthesize
 * a version label from the install path so cache keys stay stable.
 */
const PATH_ONLY_AGENTS: ReadonlySet<AgentId> = new Set<AgentId>(['cursor']);

/** Derive a version label from the PATH-installed binary location for agents without managed versions. */
function fallbackPathVersion(agent: AgentId): string | null {
  const src = locateModelSource(agent, 'unresolved');
  if (!src) return null;
  let real = src.path;
  try {
    real = fs.realpathSync(src.path);
  } catch {
    /* keep symlink path */
  }
  const m = real.match(/\/versions\/([^/]+)\//);
  return m ? m[1] : 'installed';
}

/** Register the hidden `agents models` command. */
export function registerModelsCommand(program: Command): void {
  program
    .command('models [agentSpec]', { hidden: true })
    .description('List models supported by an installed agent version (internal/debug)')
    .option('--cloud', 'Show per-cloud IDs (Claude only)')
    .option('--reasoning', 'Show reasoning levels per model (Codex only)')
    .option('--json', 'Output catalog as JSON')
    .action(async (agentSpec: string | undefined, options: { cloud?: boolean; reasoning?: boolean; json?: boolean }) => {
      const targets = await resolveTargets(agentSpec);
      if (targets.length === 0) process.exit(1);

      if (options.json) {
        const out = targets.map(({ agent, version }) => ({
          agent,
          version,
          catalog: getModelCatalog(agent, version),
        }));
        console.log(JSON.stringify(out, null, 2));
        return;
      }

      let printed = 0;
      for (const { agent, version, isDefault } of targets) {
        if (printed > 0) console.log();
        printCatalog(agent, version, isDefault, options);
        printed++;
      }
    });
}

interface Target {
  agent: AgentId;
  version: string;
  isDefault: boolean;
}

/** Resolve the agent spec into one or more (agent, version) pairs to inspect. */
async function resolveTargets(agentSpec: string | undefined): Promise<Target[]> {
  if (!agentSpec) {
    const targets: Target[] = [];
    for (const agent of MODEL_CAPABLE_AGENTS) {
      let version: string | null = getGlobalDefault(agent) || (listInstalledVersions(agent)[0] ?? null);
      if (!version && PATH_ONLY_AGENTS.has(agent)) {
        version = fallbackPathVersion(agent);
      }
      if (version) {
        targets.push({ agent, version, isDefault: true });
      } else {
        // Surface the gap instead of silently dropping the agent -- an
        // uninstalled model-capable agent should tell the user how to add it.
        console.error(chalk.gray(`${agentLabel(agent)}: not installed (run 'agents add ${agent}@latest')`));
      }
    }
    if (targets.length === 0) {
      console.error(chalk.yellow('No installed agent versions found. Run `agents add claude@latest` to install one.'));
    }
    return targets;
  }

  const [agentName, versionSpec] = agentSpec.split('@');
  const agent = resolveAgentName(agentName);
  if (!agent) {
    console.error(chalk.red(formatAgentError(agentName, MODEL_CAPABLE_AGENTS)));
    return [];
  }
  if (!MODEL_CAPABLE_AGENTS.includes(agent)) {
    console.error(chalk.yellow(`Model catalog extraction is only supported for: ${MODEL_CAPABLE_AGENTS.join(', ')}`));
    console.error(chalk.gray(`Other agents pass --model through without validation.`));
    return [];
  }

  if (versionSpec === 'all') {
    return listInstalledVersions(agent).map((v) => ({
      agent,
      version: v,
      isDefault: v === getGlobalDefault(agent),
    }));
  }

  const aliasedVersion = resolveVersionAlias(agent, versionSpec);
  let version: string | null = aliasedVersion || resolveVersion(agent, process.cwd()) || getGlobalDefault(agent);
  if (!version && PATH_ONLY_AGENTS.has(agent)) {
    version = fallbackPathVersion(agent);
  }
  if (!version) {
    console.error(chalk.red(`No version of ${agent} is installed. Try \`agents add ${agent}@latest\`.`));
    return [];
  }
  return [{ agent, version, isDefault: version === getGlobalDefault(agent) }];
}

/** Print the model catalog for a single agent version with optional cloud/reasoning details. */
function printCatalog(agent: AgentId, version: string, isDefault: boolean, options: { cloud?: boolean; reasoning?: boolean }): void {
  const tag = isDefault ? chalk.gray(' (default)') : '';
  const header = `${agentLabel(agent)} ${chalk.bold(version)}${tag}`;
  console.log(header);

  const src = locateModelSource(agent, version);
  if (!src) {
    console.log(chalk.yellow(`  Could not locate model source for ${agent}@${version}.`));
        console.log(chalk.gray(`  Expected the agent's CLI bundle or native binary under ~/.agents/.history/versions/${agent}/${version}/.`));
    return;
  }

  const catalog = getModelCatalog(agent, version);
  if (!catalog || catalog.models.length === 0) {
    console.log(chalk.yellow(`  No models extracted from ${src.kind} at ${src.path}.`));
    return;
  }

  console.log(chalk.gray(`  source: ${src.kind} (${shortPath(src.path)})`));

  if (Object.keys(catalog.aliases).length > 0) {
    const parts = Object.entries(catalog.aliases).map(([alias, id]) => `${chalk.cyan(alias)}=${id}`);
    console.log(chalk.gray(`  aliases: `) + parts.join(', '));
  }

  console.log();

  for (const model of catalog.models) {
    const star = model.isDefault ? chalk.green('*') : ' ';
    const display = model.displayName && model.displayName !== model.id
      ? chalk.gray(` (${model.displayName})`)
      : '';
    const aliasTag = model.alias ? chalk.cyan(` [${model.alias}]`) : '';
    console.log(`  ${star} ${chalk.bold(model.id)}${display}${aliasTag}`);

    if (model.description) {
      console.log(chalk.gray(`      ${model.description}`));
    }

    if (options.cloud && model.perCloud) {
      const c = model.perCloud;
      const fields: string[] = [];
      if (c.bedrock) fields.push(`bedrock=${c.bedrock}`);
      if (c.vertex) fields.push(`vertex=${c.vertex}`);
      if (c.foundry) fields.push(`foundry=${c.foundry}`);
      if (c.anthropicAws && c.anthropicAws !== c.firstParty) fields.push(`anthropicAws=${c.anthropicAws}`);
      if (c.mantle) fields.push(`mantle=${c.mantle}`);
      if (fields.length > 0) {
        for (const f of fields) console.log(chalk.gray(`      ${f}`));
      }
    }

    if (options.reasoning && model.reasoningLevels && model.reasoningLevels.length > 0) {
      const levels = model.reasoningLevels.map((l) =>
        l.effort === model.defaultReasoningLevel ? chalk.cyan(`${l.effort}*`) : l.effort
      );
      console.log(chalk.gray(`      reasoning: `) + levels.join(', '));
    }
  }
}

/** Abbreviate a path by replacing the home directory with ~. */
function shortPath(p: string): string {
  return p.replace(homeDir(), '~');
}
