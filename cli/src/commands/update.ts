import type { Command } from 'commander';
import chalk from 'chalk';
import { AGENTS, formatAgentError, resolveAgentName } from '../lib/agents.js';
import { setHelpSections } from '../lib/help.js';
import {
  describeInstallation,
  effectiveUpdatePolicy,
  listInstallations,
  planAutoUpdates,
  resolveInstallation,
  runAutoUpdatePass,
  selectUpdateStrategy,
  supportsPinnedUpdate,
  updateInstallation,
  type AutoUpdatePlanEntry,
  type Installation,
  type UpdateOutcome,
} from '../lib/installations/index.js';
import type { AgentId } from '../lib/types.js';

interface UpdateOptions {
  to?: string;
  json?: boolean;
  check?: boolean;
  auto?: boolean;
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
      deferred: outcome.deferred,
      alsoUpdated: outcome.alsoUpdated.map(serialize),
    }, null, 2));
    return;
  }
  const name = `${outcome.installation.agent}@${outcome.installation.label}`;
  if (outcome.deferred) {
    console.log(chalk.yellow(`${name}: ${outcome.deferred} Still on release ${outcome.installation.releaseVersion}.`));
    return;
  }
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

function serializePlanEntry(entry: AutoUpdatePlanEntry) {
  const wouldUpdate = entry.eligible && !entry.deferred
    && !!entry.targetRelease && entry.targetRelease !== entry.currentRelease;
  return {
    agent: entry.agent,
    label: entry.installation.label,
    currentRelease: entry.currentRelease,
    targetRelease: entry.targetRelease,
    policy: entry.policy,
    eligible: entry.eligible,
    deferred: entry.deferred,
    wouldUpdate,
    reason: entry.reason,
  };
}

/** `--check`'s dry-run output: eligibility/current/target/policy/deferral, machine-readable with `--json`. */
function printPlan(plan: AutoUpdatePlanEntry[], json: boolean): void {
  const rows = plan.map(serializePlanEntry);
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(chalk.gray('No managed installations to check.'));
    return;
  }
  console.log(chalk.bold('Automatic-update plan\n'));
  for (const row of rows) {
    const name = `${row.agent}@${row.label}`;
    const status = row.wouldUpdate
      ? chalk.green(`would update ${row.currentRelease} -> ${row.targetRelease}`)
      : row.deferred
        ? chalk.yellow(`deferred — ${row.reason}`)
        : !row.eligible
          ? chalk.gray(`not eligible — ${row.reason}`)
          : chalk.gray('already current');
    console.log(`  ${chalk.cyan(name.padEnd(28))} policy=${row.policy.padEnd(7)} ${status}`);
  }
}

/**
 * `--to` also decides the installation's update policy going forward: a
 * concrete release is a manual pin (excluded from the automatic pass until
 * explicitly unpinned), `latest` (the default) unpins it. Returns `null` when
 * `--to` was not passed at all, meaning: don't touch the stored policy.
 */
function policyForTo(to: string | undefined): 'latest' | 'pinned' | null {
  if (to === undefined) return null;
  return to === 'latest' ? 'latest' : 'pinned';
}

async function updateOne(
  agent: AgentId,
  installation: Installation,
  options: UpdateOptions,
): Promise<UpdateOutcome> {
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
    updatePolicy: policyForTo(options.to) ?? undefined,
    onProgress: options.json ? undefined : (message) => console.log(chalk.gray(`  ${message}`)),
  });
  return outcome;
}

export function registerUpdateCommand(program: Command): void {
  const update = program
    .command('update [target]')
    .description('Move a frozen agent installation to a new release, keeping its name and every reference to it')
    .option('--to <release>', 'Release to move to: latest (default, and unpins), oldest, or an exact version (pins)')
    .option('--json', 'Machine-readable result')
    .option('--check', 'Dry run: report eligibility/current/target/policy/deferral without changing anything')
    .option('--auto', 'Run the same automatic-update pass the daemon runs, across every managed harness (ignores <target>)')
    .action(async (target: string | undefined, options: UpdateOptions) => {
      try {
        if (options.auto || (options.check && !target)) {
          if (options.check) {
            printPlan(await planAutoUpdates(), !!options.json);
            return;
          }
          const result = await runAutoUpdatePass({
            onProgress: options.json ? undefined : (message) => console.log(chalk.gray(`  ${message}`)),
          });
          if (options.json) {
            console.log(JSON.stringify({
              plan: result.plan.map(serializePlanEntry),
              outcomes: result.outcomes.map((o) => ({
                agent: o.entry.agent,
                label: o.entry.installation.label,
                outcome: o.outcome && {
                  fromRelease: o.outcome.fromRelease,
                  toRelease: o.outcome.toRelease,
                  unchanged: o.outcome.unchanged,
                  deferred: o.outcome.deferred,
                },
                error: o.error,
              })),
            }, null, 2));
          } else if (result.outcomes.length === 0) {
            console.log(chalk.gray('Nothing eligible to update this pass.'));
          } else {
            for (const o of result.outcomes) {
              const name = `${o.entry.agent}@${o.entry.installation.label}`;
              if (o.error) console.error(chalk.red(`${name}: ${o.error}`));
              else if (o.outcome) printOutcome(o.outcome, false);
            }
          }
          if (result.outcomes.some((o) => o.error)) process.exitCode = 1;
          return;
        }

        if (!target) {
          throw new Error('Which agent? Use: agents update <agent>[@<installed-version>], or agents update --auto.');
        }
        const { agent, selector } = parseTarget(target);

        if (options.check) {
          const plan = (await planAutoUpdates({ agents: [agent] })).filter(
            (entry) => !selector || entry.installation.label === selector || entry.installation.releaseVersion === selector,
          );
          if (selector && plan.length === 0) {
            throw new Error(`No ${AGENTS[agent].name} installation matches '${selector}'.`);
          }
          printPlan(plan, !!options.json);
          return;
        }

        if (options.to && options.to !== 'latest' && !supportsPinnedUpdate(agent)) {
          // Fail loud at the boundary rather than installing the current release
          // and reporting it as the pin that was asked for.
          throw new Error(
            `${agent} is a single self-updating binary with no pinnable releases — drop --to, or pass --to latest.`
          );
        }

        if (selector) {
          const installation = await resolveInstallation(agent, selector);
          const outcome = await updateOne(agent, installation, options);
          printOutcome(outcome, !!options.json);
          return;
        }

        // Bare `<agent>`, no `@label`: act on every installation of that agent
        // that isn't explicitly pinned — the bulk case. A single installation
        // keeps the old single-target behavior even if it happens to be pinned,
        // since naming the agent with only one installed copy is unambiguous
        // about which one is meant; `--to` still applies to it either way.
        const installations = listInstallations(agent);
        if (installations.length === 0) {
          throw new Error(`No ${AGENTS[agent].name} installations are managed by agents-cli. Install one with: agents add ${agent}@latest`);
        }
        const targets = installations.length === 1
          ? installations
          : installations.filter((i) => effectiveUpdatePolicy(i) !== 'pinned');
        if (installations.length > 1 && targets.length === 0) {
          throw new Error(
            `Every ${AGENTS[agent].name} installation is pinned to a concrete release. `
            + `Select one explicitly: agents update ${agent}@<label> --to latest`
          );
        }

        let anyError = false;
        for (const installation of targets) {
          try {
            const outcome = await updateOne(agent, installation, options);
            printOutcome(outcome, !!options.json);
          } catch (err) {
            anyError = true;
            fail(err);
          }
        }
        if (anyError) process.exitCode = 1;
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
agents update claude@2.0.65 --to latest
agents update claude
agents update --check
agents update claude --check --json
agents update --auto`,
    notes:
      'An installation keeps its name for life; only the release inside it moves. That is why a default, a project pin, '
      + 'a routine version, or a profile that names claude@2.0.65 keeps working after you update it. '
      + 'The selector matches either the installation name or the release it currently carries — when two installations '
      + 'share a release, select one by its installation name. '
      + 'The new release is fetched and launched before it replaces the working one, so a bad release leaves your agent running. '
      + 'A bare `<agent>` (no @label) updates every one of its installations that is not pinned; `--to <release>` pins the '
      + 'installations it touches, `--to latest` unpins them. Pinned and manual/vendor-managed installations are also skipped '
      + 'by the automatic background pass (agents config set updates.auto / updates.<agent>.auto). `--check` reports what '
      + '`--auto` would do without changing anything; `--auto` (no target) runs the exact pass the daemon runs, across every '
      + 'harness.',
  });
}
