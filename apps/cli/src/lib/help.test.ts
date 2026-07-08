import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { applyGlobalHelpConventions, setHelpSections } from './help.js';

function buildTestCommand(opts: { examples?: string; notes?: string } = {}): Command {
  const root = new Command('agents');
  const sub = root
    .command('demo')
    .description('Run a demo of the help formatter.')
    .option('--flag', 'a flag');

  applyGlobalHelpConventions(root);
  setHelpSections(sub, opts);
  return sub;
}

describe('setHelpSections + formatHelpCommandsFirst', () => {
  it('renders Examples between the description and Options', () => {
    const sub = buildTestCommand({
      examples: `
        # do the thing
        agents demo
      `,
    });
    const help = sub.helpInformation();

    const descIdx = help.indexOf('Run a demo of the help formatter.');
    const examplesIdx = help.indexOf('Examples:');
    const optionsIdx = help.indexOf('Options:');

    expect(descIdx).toBeGreaterThanOrEqual(0);
    expect(examplesIdx).toBeGreaterThan(descIdx);
    expect(optionsIdx).toBeGreaterThan(examplesIdx);
  });

  it('renders Notes after Options at the very end', () => {
    const sub = buildTestCommand({
      examples: '# x\nagents demo',
      notes: '- a caveat',
    });
    const help = sub.helpInformation();

    const optionsIdx = help.indexOf('Options:');
    const notesIdx = help.indexOf('Notes:');

    expect(optionsIdx).toBeGreaterThanOrEqual(0);
    expect(notesIdx).toBeGreaterThan(optionsIdx);
    expect(help.slice(notesIdx)).toContain('- a caveat');
  });

  it('omits Examples and Notes headings when no sections are set', () => {
    const sub = buildTestCommand();
    const help = sub.helpInformation();

    expect(help).not.toContain('Examples:');
    expect(help).not.toContain('Notes:');
  });

  it('dedents bodies so callers can pass natural indented template literals', () => {
    const sub = buildTestCommand({
      examples: `
            # comment
            agents demo --flag
      `,
    });
    const help = sub.helpInformation();

    // After dedent + 2-space reindent, both comment and command sit at column 2.
    expect(help).toContain('\n  # comment\n');
    expect(help).toContain('\n  agents demo --flag\n');
  });

  it('preserves internal indentation inside dedented blocks', () => {
    const sub = buildTestCommand({
      notes: `
        Modes:
          plan  read-only
          edit  can write
      `,
    });
    const help = sub.helpInformation();
    expect(help).toContain('  Modes:');
    expect(help).toContain('    plan  read-only');
    expect(help).toContain('    edit  can write');
  });
});
