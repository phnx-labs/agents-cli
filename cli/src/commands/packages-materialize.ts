/**
 * `agents packages materialize` — user-facing contract for portable-agent
 * materialization (PHNX-3838). One execution path: this command calls
 * {@link materializePortableAgent} and prints the receipt.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { die, isJsonMode } from '../lib/format.js';
import { setHelpSections } from '../lib/help.js';
import {
  materializePortableAgent,
  MaterializeError,
  PORTABLE_HARNESSES,
  type MaterializeReceipt,
} from '../lib/packages/materialize.js';

export { materializePortableAgent, MaterializeError, PORTABLE_HARNESSES };
export type { MaterializeReceipt };

function printReceipt(receipt: MaterializeReceipt): void {
  console.log(chalk.bold(`Materialized ${receipt.package} → ${receipt.harness}@${receipt.version}`));
  console.log(`  package      ${receipt.packagePath}`);
  console.log(`  output home  ${receipt.outputHome}`);
  for (const target of receipt.targets) {
    console.log(`  ${target.kind.padEnd(12)} ${target.path}`);
  }
  if (receipt.warnings.length > 0) {
    console.log(chalk.yellow('  warnings'));
    for (const warning of receipt.warnings) console.log(chalk.yellow(`    ${warning}`));
  }
}

function fail(err: unknown, json: boolean): never {
  if (err instanceof MaterializeError) {
    die(err.message, 1, { json });
  }
  die(err instanceof Error ? err.message : String(err), 1, { json });
}

/** Register `agents packages materialize`. */
export function registerPortablePackageCommands(program: Command): void {
  const packagesCmd = program
    .command('packages')
    .description('Portable agent packages — materialize schema-v3 agent.yaml into an ephemeral harness home');

  setHelpSections(packagesCmd, {
    examples: `
      # Materialize a package into an ephemeral Claude home
      agents packages materialize ./reviewer --harness claude --harness-version 2.1.0 --output-home /tmp/reviewer-claude

      # Machine-readable receipt for Factory / Prix Cloud
      agents packages materialize ./reviewer --harness codex --harness-version 0.42.0 --output-home "$OUTPUT_HOME" --json

      # OpenCode worker on a Factory box
      agents packages materialize ./reviewer --harness opencode --harness-version 1.0.0 --output-home "$OUTPUT_HOME" --json
    `,
    notes: `
      Materialize writes only under --output-home. It never mutates ~/.claude,
      ~/.codex, or ~/.opencode, never copies secrets, and never execs a harness.

      Factory usage: point --output-home at the worker's ephemeral home and pass
      --json so the orchestrator can read the receipt (package, harness, version,
      targets, resource hashes, warnings).
    `,
  });

  const materializeCmd = packagesCmd
    .command('materialize <package>')
    .description('Materialize a schema-v3 agent.yaml package into an ephemeral Claude, Codex, or OpenCode home')
    .requiredOption('--harness <id>', `Target harness: ${PORTABLE_HARNESSES.join(', ')}`)
    .requiredOption(
      '--harness-version <version>',
      'Exact harness version to stamp on the receipt (not --version: that is the CLI version flag)',
    )
    .requiredOption('--output-home <dir>', 'Ephemeral home to write into (must not escape or target the live user home)')
    .option('--json', 'Emit the materialization receipt as JSON')
    .action((pkg: string, opts: { harness: string; harnessVersion: string; outputHome: string; json?: boolean }) => {
      const json = isJsonMode(opts);
      try {
        const receipt = materializePortableAgent({
          package: pkg,
          harness: opts.harness,
          version: opts.harnessVersion,
          outputHome: opts.outputHome,
        });
        if (json) {
          console.log(JSON.stringify(receipt, null, 2));
          return;
        }
        printReceipt(receipt);
      } catch (err) {
        fail(err, json);
      }
    });

  setHelpSections(materializeCmd, {
    examples: `
      agents packages materialize ./reviewer --harness claude --harness-version 2.1.0 --output-home /tmp/reviewer-claude
      agents packages materialize ./reviewer --harness codex --harness-version 0.42.0 --output-home "$OUTPUT_HOME" --json
      agents packages materialize ./reviewer --harness opencode --harness-version 1.0.0 --output-home "$OUTPUT_HOME" --json
    `,
    notes: `
      Factory / Prix Cloud: materialize into the worker's ephemeral home, then
      exec the harness with HOME=$OUTPUT_HOME. The --json receipt is the handoff.

      Supported harnesses: claude, codex, opencode. Any other id fails as an
      unsupported capability. A package must be a directory containing
      agent.yaml with schemaVersion: 3.
    `,
  });
}
