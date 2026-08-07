import { describe, it, expect } from 'vitest';
import { Command } from 'commander';

import { registerSecretsCommands } from './secrets.js';

/**
 * `--for` was a vague name doing two unrelated jobs on sibling commands:
 * `unlock --for <agent>` meant a HARNESS while `lease --for <duration>` meant a
 * DURATION. An agent that learned one passed it wrongly to the other, and
 * `unlock --for 8h` silently read `8h` as a harness name. Duration is now
 * `--ttl`/`--until` and harness narrowing is `--agent`, everywhere.
 *
 * These assert Commander's real registered option tree, so reintroducing `--for`
 * anywhere under `secrets` fails here rather than in someone's shell.
 */
function secretsGroup(): Command {
  const program = new Command();
  program.exitOverride();
  registerSecretsCommands(program);
  const secrets = program.commands.find((c) => c.name() === 'secrets');
  if (!secrets) throw new Error('secrets command group should be registered');
  return secrets;
}

function sub(name: string): Command {
  const found = secretsGroup().commands.find((c) => c.name() === name);
  if (!found) throw new Error(`secrets ${name} subcommand should be registered`);
  return found;
}

const longFlags = (cmd: Command): string[] =>
  cmd.options.map((o) => o.long).filter((l): l is string => typeof l === 'string');

describe('agents secrets — duration is --ttl, harness is --agent', () => {
  it('unlock narrows harness with --agent', () => {
    expect(longFlags(sub('unlock'))).toContain('--agent');
  });

  it('unlock still bounds duration with --ttl and --until', () => {
    const flags = longFlags(sub('unlock'));
    expect(flags).toContain('--ttl');
    expect(flags).toContain('--until');
  });

  it('lease bounds duration with --ttl, matching unlock', () => {
    expect(longFlags(sub('lease'))).toContain('--ttl');
  });

  it('lease narrows harness with --agent, matching unlock', () => {
    expect(longFlags(sub('lease'))).toContain('--agent');
  });

  it('NO subcommand under secrets exposes --for — it meant two different things', () => {
    const offenders = secretsGroup()
      .commands.filter((c) => longFlags(c).includes('--for'))
      .map((c) => c.name());
    expect(offenders, 'use --ttl for a duration and --agent for a harness').toEqual([]);
  });
});
