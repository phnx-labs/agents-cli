/**
 * `agents import` — adopt an existing unmanaged agent install into agents-cli.
 *
 * Three forms:
 *
 *   agents import openclaw
 *     Auto-detect via the binary on PATH. Resolves the npm package directory,
 *     reads its version, and registers it under
 *     ~/.agents/.history/versions/<agent>/<version>/.
 *
 *   agents import openclaw --version 2026.3.8
 *     Same auto-detect, but pin the version label rather than reading it from
 *     the package. Useful when the package metadata is stale or you want a
 *     canonical name.
 *
 *   agents import openclaw --from-path /opt/homebrew/lib/node_modules/openclaw
 *     Skip detection entirely. The given path must be a directory containing
 *     a valid package.json with a `bin` entry.
 *
 * In all forms, the agent's config dir (e.g. ~/.openclaw) is also moved under
 * management — same behavior as the first-run `agents setup` import flow.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { confirm } from '@inquirer/prompts';

import type { AgentId } from '../lib/types.js';
import { ALL_AGENT_IDS } from '../lib/agents.js';
import { AGENTS, getCliPath, getCliVersion, agentLabel } from '../lib/agents.js';
import {
  importAgentBinary,
  importAgentConfig,
  resolvePackageDirFromBinary,
} from '../lib/import.js';
import { isPromptCancelled, isInteractiveTerminal } from './utils.js';

interface ImportOptions {
  version?: string;
  fromPath?: string;
  yes?: boolean;
}

function isValidAgentId(value: string): value is AgentId {
  return (ALL_AGENT_IDS as string[]).includes(value);
}

async function runImport(agentArg: string, opts: ImportOptions): Promise<void> {
  if (!isValidAgentId(agentArg)) {
    console.error(chalk.red(`Unknown agent: ${agentArg}`));
    console.error(chalk.gray(`Known agents: ${ALL_AGENT_IDS.join(', ')}`));
    process.exit(1);
  }
  const agentId = agentArg;
  const agent = AGENTS[agentId];

  let globalPath: string | null = null;

  if (opts.fromPath) {
    globalPath = path.resolve(opts.fromPath);
    if (!fs.existsSync(globalPath)) {
      console.error(chalk.red(`Path does not exist: ${globalPath}`));
      process.exit(1);
    }
  } else {
    const binary = await getCliPath(agentId);
    if (!binary) {
      console.error(chalk.red(`No "${agent.cliCommand}" found on PATH.`));
      console.error(chalk.gray(`Install it first (e.g. \`npm i -g ${agent.npmPackage ?? agent.cliCommand}\`) or pass --from-path.`));
      process.exit(1);
    }
    globalPath = resolvePackageDirFromBinary(binary);
    if (!globalPath) {
      console.error(chalk.red(`Could not resolve npm package for binary: ${binary}`));
      console.error(chalk.gray('Pass --from-path <dir> with the package directory explicitly.'));
      process.exit(1);
    }
  }

  let version = opts.version;
  if (!version) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(globalPath, 'package.json'), 'utf8'));
      version = typeof pkg.version === 'string' ? pkg.version : undefined;
    } catch {
      /* fall through */
    }
    if (!version) {
      const detected = await getCliVersion(agentId);
      version = detected ?? undefined;
    }
  }

  if (!version) {
    console.error(chalk.red(`Could not determine version for ${agentLabel(agentId)}.`));
    console.error(chalk.gray('Pass --version <version> explicitly.'));
    process.exit(1);
  }

  console.log(chalk.bold(`\nImport ${agentLabel(agentId)} v${version}`));
  console.log(`  from: ${chalk.gray(globalPath)}`);
  console.log(`  into: ${chalk.gray(`~/.agents/.history/versions/${agentId}/${version}/`)}`);

  const configDirExists = fs.existsSync(agent.configDir);
  if (configDirExists) {
    const stat = fs.lstatSync(agent.configDir);
    if (stat.isSymbolicLink()) {
      console.log(`  config: ${chalk.gray(`${agent.configDir} (already managed — will skip)`)}`);
    } else {
      console.log(`  config: ${chalk.gray(`${agent.configDir} (will be moved into version home)`)}`);
    }
  } else {
    console.log(`  config: ${chalk.gray(`${agent.configDir} (does not exist — will skip)`)}`);
  }

  if (!opts.yes && isInteractiveTerminal()) {
    console.log();
    const proceed = await confirm({ message: 'Proceed?', default: true }).catch((err) => {
      if (isPromptCancelled(err)) return false;
      throw err;
    });
    if (!proceed) {
      console.log(chalk.gray('Aborted.'));
      return;
    }
  }

  const binSpinner = ora('Registering binary...').start();
  const binResult = importAgentBinary(agentId, version, globalPath);
  if (binResult.success) {
    binSpinner.succeed('Binary registered');
  } else if (binResult.skipped) {
    binSpinner.warn(`Binary: ${binResult.error}`);
  } else {
    binSpinner.fail(`Binary: ${binResult.error}`);
    process.exit(1);
  }

  if (configDirExists) {
    const stat = fs.lstatSync(agent.configDir);
    if (!stat.isSymbolicLink()) {
      const cfgSpinner = ora('Importing config dir...').start();
      const cfgResult = await importAgentConfig(agentId, version);
      if (cfgResult.success) {
        cfgSpinner.succeed('Config imported');
      } else if (cfgResult.skipped) {
        cfgSpinner.warn(`Config: ${cfgResult.error}`);
      } else {
        cfgSpinner.fail(`Config: ${cfgResult.error}`);
        process.exit(1);
      }
    }
  }

  console.log();
  console.log(chalk.green(`${agentLabel(agentId)} v${version} is now managed.`));
  console.log(chalk.gray(`Verify: agents view ${agentId}`));
}

export function registerImportCommand(program: Command): void {
  program
    .command('import')
    .argument('<agent>', 'Agent id (e.g. openclaw, claude, codex)')
    .description('Import an existing unmanaged agent install into agents-cli')
    .option('--version <version>', 'Pin a version label (otherwise read from package.json or --version output)')
    .option('--from-path <path>', 'Path to the npm package dir (otherwise auto-detected from PATH)')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .action(runImport);
}
