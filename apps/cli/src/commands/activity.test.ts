import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerActivityCommand } from './activity.js';

function activityCmd(): Command {
  const program = new Command();
  registerActivityCommand(program);
  const cmd = program.commands.find((c) => c.name() === 'activity');
  if (!cmd) throw new Error('activity command not registered');
  return cmd;
}

describe('activity command option/alias wiring', () => {
  it('registers the fleet + grouping flags and their aliases', () => {
    const longs = activityCmd().options.map((o) => o.long);
    for (const flag of [
      '--local', '--host', '--device', '--devices-all', '--hosts-all',
      '--group-by', '--filter', '--milestones', '--all', '--json', '--since', '--limit',
    ]) {
      expect(longs).toContain(flag);
    }
  });

  it('parses --devices-all --group-by --filter --local without an unknown-option error', () => {
    const cmd = activityCmd();
    cmd.exitOverride(); // never process.exit; the async action is not reached here
    expect(() =>
      cmd.parseOptions(['--devices-all', '--group-by', 'project', '--filter', 'RUSH-1', '--local']),
    ).not.toThrow();
    const parsed = cmd.opts();
    expect(parsed.devicesAll).toBe(true);
    expect(parsed.groupBy).toBe('project');
    expect(parsed.filter).toBe('RUSH-1');
    expect(parsed.local).toBe(true);
  });

  it('accepts --hosts-all and repeatable --device', () => {
    const cmd = activityCmd();
    cmd.exitOverride();
    expect(() => cmd.parseOptions(['--hosts-all'])).not.toThrow();
    expect(cmd.opts().hostsAll).toBe(true);

    const cmd2 = activityCmd();
    cmd2.exitOverride();
    cmd2.parseOptions(['--device', 'zion', '--device', 'mac-mini']);
    expect(cmd2.opts().device).toEqual(['zion', 'mac-mini']);
  });
});
