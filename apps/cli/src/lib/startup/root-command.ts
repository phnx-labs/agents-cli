import type { Command } from 'commander';

/** Configure the public root surface shared by the live CLI and reference generator. */
export function configureRootCommand(program: Command, name: string, version: string): Command {
  return program
    .name(name)
    .description('Environment manager for AI agents')
    .version(version)
    .option('--verbose', 'Show startup self-heal details on stderr')
    .helpOption('-h, --help', 'Show help')
    .addHelpCommand(false);
}
