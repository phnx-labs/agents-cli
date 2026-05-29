import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerBrowserSubcommands } from './browser.js';

describe('browser command help', () => {
  it('documents start profile as optional positional with --profile alternative', () => {
    const program = new Command();
    registerBrowserSubcommands(program);

    const start = program.commands.find((cmd) => cmd.name() === 'start');
    expect(start).toBeDefined();
    const help = start!.helpInformation();

    expect(help).toContain('Usage:  start [options] [profile]');
    expect(help).toContain('-p, --profile <name>');
    expect(help).toContain('defaults to bundled Chromium profile');
    expect(help).toContain('"default"');
  });
});
