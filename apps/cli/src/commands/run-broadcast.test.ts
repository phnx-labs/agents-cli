import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerRunCommand } from './exec.js';

describe('agents run --broadcast', () => {
  it('registers broadcast flags on run (replacing agents bench)', () => {
    const program = new Command();
    registerRunCommand(program);
    const run = program.commands.find((command) => command.name() === 'run');
    expect(run).toBeTruthy();
    const longs = run!.options.map((option) => option.long);
    expect(longs).toContain('--broadcast');
    expect(longs).toContain('--list-tasks');
    expect(longs).toContain('--results');
    expect(longs).toContain('--task');
    expect(longs).toContain('--concurrency');
  });
});
