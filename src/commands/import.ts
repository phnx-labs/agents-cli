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
import * as os from 'os';
import * as path from 'path';
import { confirm } from '@inquirer/prompts';

import type { AgentId } from '../lib/types.js';
import { ALL_AGENT_IDS } from '../lib/agents.js';
import { AGENTS, getCliPath, getCliVersion, agentLabel } from '../lib/agents.js';
import { getVersionDir } from '../lib/versions.js';
import {
  finalizeImport,
  importAgentBinary,
  importAgentConfig,
  importInstallScriptBinary,
  isValidImportVersion,
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

  // installScript-based agents (Grok, Antigravity, Cursor, Kiro, Goose, Roo)
  // don't have an npm package; their binary lives wherever the curl/brew
  // installer dropped it. We adopt by symlinking that PATH binary directly
  // into the version's `node_modules/.bin/`. No package.json walk.
  const isInstallScriptAgent = !agent.npmPackage;

  let globalPath: string | null = null;
  let installScriptBinary: string | null = null;

  if (opts.fromPath) {
    globalPath = path.resolve(opts.fromPath);
    if (!fs.existsSync(globalPath)) {
      console.error(chalk.red(`Path does not exist: ${globalPath}`));
      process.exit(1);
    }
    if (isInstallScriptAgent) {
      // With --from-path on an installScript agent, the path is the binary
      // itself (or a directory containing it). Accept either.
      if (fs.statSync(globalPath).isDirectory()) {
        const candidate = path.join(globalPath, agent.cliCommand);
        if (!fs.existsSync(candidate)) {
          console.error(chalk.red(`No "${agent.cliCommand}" in ${globalPath}`));
          process.exit(1);
        }
        installScriptBinary = candidate;
      } else {
        installScriptBinary = globalPath;
      }
    }
  } else {
    const binary = await getCliPath(agentId);
    if (!binary) {
      const installHint = isInstallScriptAgent
        ? `Run \`agents add ${agentId}\` to install via the official script, or pass --from-path.`
        : `Install it first (e.g. \`npm i -g ${agent.npmPackage || agent.cliCommand}\`) or pass --from-path.`;
      console.error(chalk.red(`No "${agent.cliCommand}" found on PATH.`));
      console.error(chalk.gray(installHint));
      process.exit(1);
    }
    if (isInstallScriptAgent) {
      installScriptBinary = binary;
    } else {
      globalPath = resolvePackageDirFromBinary(binary);
      if (!globalPath) {
        console.error(chalk.red(`Could not resolve npm package for binary: ${binary}`));
        console.error(chalk.gray('Pass --from-path <dir> with the package directory explicitly.'));
        process.exit(1);
      }
    }
  }

  // For Grok, the binary on PATH is typically `~/.grok/bin/grok` (a moving
  // pointer to the latest install). Prefer the exact versioned file in
  // `~/.grok/downloads/` so the v<x.y.z> alias is pinned to that file and
  // doesn't drift when the user upgrades externally.
  if (isInstallScriptAgent && agentId === 'grok' && !opts.fromPath) {
    const detected = await getCliVersion(agentId);
    if (detected) {
      const downloads = path.join(os.homedir(), '.grok', 'downloads');
      try {
        const entries = fs.readdirSync(downloads);
        const exact = entries.find((e) => e.startsWith('grok-') && e.includes(detected));
        if (exact) {
          installScriptBinary = path.join(downloads, exact);
        }
      } catch {
        /* fall back to PATH binary already set above */
      }
    }
  }

  let version = opts.version;
  if (!version) {
    if (!isInstallScriptAgent && globalPath) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(globalPath, 'package.json'), 'utf8'));
        version = typeof pkg.version === 'string' ? pkg.version : undefined;
      } catch {
        /* fall through */
      }
    }
    // Only fall back to running the PATH binary's --version when we're
    // auto-detecting. With --from-path on an npm agent, the PATH binary may
    // belong to a different install entirely; reporting its version here
    // would silently mis-attribute the imported version. installScript agents
    // always use `<bin> --version` since they have no package.json to read.
    if (!version && (isInstallScriptAgent || !opts.fromPath)) {
      const detected = await getCliVersion(agentId);
      version = detected ?? undefined;
    }
  }

  if (!version) {
    console.error(chalk.red(`Could not determine version for ${agentLabel(agentId)}.`));
    console.error(chalk.gray('Pass --version <version> explicitly.'));
    process.exit(1);
  }
  if (!isValidImportVersion(version)) {
    console.error(chalk.red(`Invalid version: ${version}`));
    console.error(chalk.gray('Version must be "latest" or 1-64 letters, numbers, dots, underscores, plus signs, or hyphens.'));
    process.exit(1);
  }

  const versionDir = getVersionDir(agentId, version);
  const fromLabel = isInstallScriptAgent ? (installScriptBinary as string) : (globalPath as string);

  console.log(chalk.bold(`\nImport ${agentLabel(agentId)} v${version}`));
  console.log(`  from: ${chalk.gray(fromLabel)}`);
  console.log(`  into: ${chalk.gray(versionDir)}`);

  const configDirExists = fs.existsSync(agent.configDir);
  let configAlreadyManaged = false;
  if (configDirExists) {
    const stat = fs.lstatSync(agent.configDir);
    if (stat.isSymbolicLink()) {
      configAlreadyManaged = true;
      console.log(`  config: ${chalk.gray(`${agent.configDir} (already managed — will skip)`)}`);
    } else {
      console.log(`  config: ${chalk.gray(`${agent.configDir} (will be moved into version home)`)}`);
    }
  } else {
    console.log(`  config: ${chalk.gray(`${agent.configDir} (does not exist — will skip)`)}`);
  }

  if (!opts.yes && isInteractiveTerminal()) {
    console.log();
    const proceed = await confirm({
      message: `Import ${agentLabel(agentId)} v${version} into agents-cli?`,
      default: true,
    }).catch((err) => {
      if (isPromptCancelled(err)) return false;
      throw err;
    });
    if (!proceed) {
      console.log(chalk.gray('Aborted.'));
      return;
    }
  }

  // Order: config first, then binary, then finalize. Config does the
  // user-visible side effect (renaming ~/.<agent>/), so if it fails we don't
  // want a stranded symlink farm. Binary registration is cheap and reversible
  // — if it fails after config, the next `agents import` call retries cleanly.
  const willImportConfig = configDirExists && !configAlreadyManaged;
  if (willImportConfig) {
    const cfgSpinner = ora(`Importing config dir for ${agentLabel(agentId)} v${version}...`).start();
    const cfgResult = await importAgentConfig(agentId, version);
    if (cfgResult.success) {
      const relConfig = path.relative(os.homedir(), agent.configDir);
      cfgSpinner.succeed(`Config imported (${agent.configDir} -> ${versionDir}/home/${relConfig})`);
    } else if (cfgResult.skipped) {
      cfgSpinner.warn(`Config: ${cfgResult.error}`);
    } else {
      cfgSpinner.fail(`Config: ${cfgResult.error}`);
      process.exit(1);
    }
  }

  const binSpinner = ora(`Registering ${agentLabel(agentId)} v${version} binary...`).start();
  const binResult = isInstallScriptAgent
    ? importInstallScriptBinary(
        { agentId, npmPackage: agent.npmPackage, cliCommand: agent.cliCommand },
        version,
        installScriptBinary as string,
        versionDir
      )
    : importAgentBinary(
        { agentId, npmPackage: agent.npmPackage, cliCommand: agent.cliCommand },
        version,
        globalPath as string,
        versionDir
      );
  if (binResult.success) {
    binSpinner.succeed(`Binary registered (${agent.cliCommand} -> ${binResult.resolvedFromPath})`);
  } else if (binResult.skipped) {
    binSpinner.warn(`Binary: ${binResult.error}`);
  } else {
    binSpinner.fail(`Binary: ${binResult.error}`);
    process.exit(1);
  }

  // Wire the imported version into the resolver: global default, main shim,
  // versioned alias, home-file symlinks. Idempotent — safe to call even if
  // importAgentConfig already set the global default.
  const finalizeSpinner = ora(`Wiring ${agentLabel(agentId)} v${version} as the active version...`).start();
  try {
    finalizeImport(agentId, version);
    finalizeSpinner.succeed(`${agentLabel(agentId)} v${version} set as default with shim + alias`);
  } catch (err) {
    finalizeSpinner.fail(`Finalize: ${(err as Error).message}`);
    process.exit(1);
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
    .option('--version <version>', 'Pin a version label (otherwise read from package.json)')
    .option('--from-path <path>', 'Path to the npm package dir (otherwise auto-detected from PATH)')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .addHelpText('after', `
Examples:
  $ agents import openclaw                          Auto-detect via PATH
  $ agents import openclaw --version 2026.3.8       Pin a version label
  $ agents import openclaw --from-path /opt/homebrew/lib/node_modules/openclaw

  # installScript-based agents (curl/brew installers, no npm package):
  $ agents import grok                              Adopt ~/.grok/downloads/grok-<ver>
  $ agents import antigravity                       Adopt ~/.local/bin/agy
  $ agents import cursor                            Adopt ~/.local/bin/cursor-agent
  $ agents import antigravity --from-path ~/.local/bin/agy

When to use:
  When an agent CLI is already installed globally and you want to bring it
  under agents-cli management without reinstalling. Creates a symlink farm
  pointing at the existing install — nothing is copied or moved (except the
  agent's config dir, which is moved into the version's home). Works for both
  npm-style packages (claude, codex, gemini, opencode, openclaw) and
  installScript-based agents (grok, antigravity, cursor, kiro, goose, roo).
`)
    .action(runImport);
}
