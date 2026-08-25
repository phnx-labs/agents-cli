import type { Command } from 'commander';
import chalk from 'chalk';
import { formatAgentError, resolveAgentName } from '../lib/agents.js';
import { setHelpSections } from '../lib/help.js';
import {
  describeInstallation,
  listInstallations,
  resolveInstallation,
  selectUpdateStrategy,
  supportsPinnedUpdate,
  updateInstallation,
  type Installation,
  type UpdateOutcome,
} from '../lib/installations/index.js';
import type { AgentId } from '../lib/types.js';

interface UpdateOptions {
  to?: string;
  json?: boolean;
}

/**
 * Split `<agent>[@<selector>]`. The selector names an INSTALLATION — its frozen
 * label, or the release it currently carries — never a release to install; that
 * is `--to`. Keeping them separate is what lets `agents update claude@2.0.65
 * --to 2.0.71` read unambiguously.
 */
function parseTarget(raw: string): { agent: AgentId; selector?: string } {
  const at = raw.indexOf('@');
  const name = at === -1 ? raw : raw.slice(0, at);
  const selector = at === -1 ? undefined : raw.slice(at + 1).trim();
  if (at !== -1 && !selector) {
    throw new Error(`Missing installation in '${raw}'. Use <agent>@<installed-version>, or just <agent>.`);
  }
  const agent = resolveAgentName(name);
  if (!agent) throw new Error(formatAgentError(name));
  return { agent, selector };
}

function serialize(installation: Installation) {
  return {
    id: installation.id,
    agent: installation.agent,
    label: installation.label,
    releaseVersion: installation.releaseVersion,
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt,
  };
}

function printOutcome(outcome: UpdateOutcome, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({
      installation: serialize(outcome.installation),
      strategy: outcome.strategy,
      fromRelease: outcome.fromRelease,
      toRelease: outcome.toRelease,
      unchanged: outcome.unchanged,
      alsoUpdated: outcome.alsoUpdated.map(serialize),
    }, null, 2));
    return;
  }
  const name = `${outcome.installation.agent}@${outcome.installation.label}`;
  if (outcome.unchanged) {
    console.log(chalk.gray(`${name} is already on release ${outcome.toRelease}.`));
    return;
  }
  console.log(chalk.green(`Updated ${name}: release ${outcome.fromRelease} -> ${outcome.toRelease}`));
  console.log(chalk.gray(`Its name is unchanged, so every default, project pin, and routine that names ${name} still resolves to it.`));
  for (const other of outcome.alsoUpdated) {
    console.log(chalk.gray(`  ${other.agent}@${other.label} shares the same binary and now also reports release ${other.releaseVersion}.`));
  }
}

function printInstallations(agent: AgentId, json: boolean): void {
  const installations = listInstallations(agent);
  if (json) {
    console.log(JSON.stringify(installations.map(serialize), null, 2));
    return;
  }
  if (!installations.length) {
    console.log(chalk.gray(`No managed ${agent} installations. Install one with: agents add ${agent}@latest`));
    return;
  }
  console.log(chalk.bold(`${agent} installations\n`));
  for (const installation of installations) {
    console.log(`  ${chalk.cyan(installation.label)}  release ${installation.releaseVersion}  ${chalk.gray(installation.id)}`);
  }
}

/**
 * Surface a failure as one red line, not a stack trace. Everything this command
 * can fail on — an unknown agent, an ambiguous selector, an unpinnable harness,
 * a release that would not launch — is a message the user acts on, and a
 * commander async action rejection otherwise reaches the user as a raw Node dump.
 */
function fail(err: unknown): void {
  console.error(chalk.red((err as Error).message));
  process.exitCode = 1;
}

export function registerUpdateCommand(program: Command): void {
  const update = program
    .command('update [target]')
    .description('Move a frozen agent installation to a new release, keeping its name and every reference to it')
    .option('--to <release>', 'Release to move to: latest (default), oldest, or an exact version')
    .option('--json', 'Machine-readable result')
    .action(async (target: string | undefined, options: UpdateOptions) => {
      try {
        if (!target) {
          throw new Error('Which agent? Use: agents update <agent>[@<installed-version>]');
        }
        const { agent, selector } = parseTarget(target);

        if (options.to && options.to !== 'latest' && !supportsPinnedUpdate(agent)) {
          // Fail loud at the boundary rather than installing the current release
          // and reporting it as the pin that was asked for.
          throw new Error(
            `${agent} is a single self-updating binary with no pinnable releases — drop --to, or pass --to latest.`
          );
        }

        const installation = await resolveInstallation(agent, selector);
        const strategy = selectUpdateStrategy(agent);
        if (!options.json && !strategy.transactional) {
          console.log(chalk.yellow(
            `${agent} installs one vendor-managed binary, so this update cannot be staged or rolled back; `
            + `a failure leaves whatever its installer wrote.`
          ));
        }
        if (!options.json) {
          console.log(chalk.gray(`Updating ${agent}@${describeInstallation(installation)} via the ${strategy.id} strategy...`));
        }

        const outcome = await updateInstallation(installation, {
          to: options.to,
          onProgress: options.json ? undefined : (message) => console.log(chalk.gray(`  ${message}`)),
        });
        printOutcome(outcome, !!options.json);
      } catch (err) {
        fail(err);
      }
    });

  update
    .command('list <agent>')
    .description('Show every frozen installation of an agent and the release each carries')
    .option('--json', 'Machine-readable listing')
    // `--json` is declared on both `update` and `update list`, and commander
    // binds a flag the parent also declares to the PARENT's option store — so
    // reading this subcommand's own opts alone silently drops it. Merge them.
    .action((rawAgent: string, _options: { json?: boolean }, command: Command) => {
      try {
        const agent = resolveAgentName(rawAgent);
        if (!agent) throw new Error(formatAgentError(rawAgent));
        printInstallations(agent, !!command.optsWithGlobals().json);
      } catch (err) {
        fail(err);
      }
    });

  setHelpSections(update, {
    examples: `agents update list claude
agents update claude@2.0.65
agents update claude@2.0.65 --to 2.1.220
agents update claude@2.0.65 --json`,
    notes:
      'An installation keeps its name for life; only the release inside it moves. That is why a default, a project pin, '
      + 'a routine version, or a profile that names claude@2.0.65 keeps working after you update it. '
      + 'The selector matches either the installation name or the release it currently carries — when two installations '
      + 'share a release, select one by its installation name. '
      + 'The new release is fetched and launched before it replaces the working one, so a bad release leaves your agent running.',
  });
}
