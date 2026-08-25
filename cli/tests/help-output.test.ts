import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { applyGlobalHelpConventions } from '../src/lib/help.js';

function buildProgram(): Command {
  const program = new Command();
  program.name('agents').description('Manage AI coding agents');

  const commandsCmd = program.command('commands').description('Manage slash commands');
  commandsCmd.command('list [agent]').description('List installed commands');
  commandsCmd.command('add <source>').description('Install commands from source');

  const memoryCmd = program.command('memory').description('Manage agent memory files');
  memoryCmd.command('list [agent]').description('List installed memory files');
  memoryCmd.command('add <source>').description('Install memory files');

  const permissionsCmd = program.command('permissions').description('Manage agent permissions');
  permissionsCmd.command('list [agent]').description('List permissions');
  permissionsCmd.command('show <name>').description('Show a permission set');

  applyGlobalHelpConventions(program);
  return program;
}

function expectCommandsBeforeOptions(helpText: string): void {
  const commandsIndex = helpText.indexOf('Commands:');
  const optionsIndex = helpText.indexOf('Options:');
  expect(commandsIndex).toBeGreaterThan(-1);
  expect(optionsIndex).toBeGreaterThan(-1);
  expect(commandsIndex).toBeLessThan(optionsIndex);
}

describe('help output conventions', () => {
  it('removes implicit help subcommand and prioritizes commands for commands group', () => {
    const program = buildProgram();
    const helpText = program.commands.find((c) => c.name() === 'commands')!.helpInformation();

    expect(helpText).not.toContain('help [command]');
    expectCommandsBeforeOptions(helpText);
  });

  it('removes implicit help subcommand and prioritizes commands for memory group', () => {
    const program = buildProgram();
    const helpText = program.commands.find((c) => c.name() === 'memory')!.helpInformation();

    expect(helpText).not.toContain('help [command]');
    expectCommandsBeforeOptions(helpText);
  });

  it('removes implicit help subcommand and prioritizes commands for permissions group', () => {
    const program = buildProgram();
    const helpText = program.commands.find((c) => c.name() === 'permissions')!.helpInformation();

    expect(helpText).not.toContain('help [command]');
    expectCommandsBeforeOptions(helpText);
  });
});
