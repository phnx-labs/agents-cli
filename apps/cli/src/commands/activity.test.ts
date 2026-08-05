import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerActivityCommand } from './activity.js';

describe('activity tombstone', () => {
  it('registers a command named activity', () => {
    const program = new Command();
    registerActivityCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'activity');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toMatch(/Removed/i);
  });
});
