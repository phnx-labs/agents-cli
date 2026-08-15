/**
 * RUSH-2022 — `KNOWN_TOP_LEVEL_COMMANDS` is the "does this command exist?"
 * predicate the `--host`/`--device` router consults before it can claim a
 * command has no remote semantics. A name that drifts out of it turns a real
 * command into a phantom `unknown command`, so this pins the set against the
 * command tree the CLI actually registers — the real modules, no mocks.
 */
import { describe, it, expect } from 'vitest';
import {
  KNOWN_TOP_LEVEL_COMMANDS,
  isKnownTopLevelCommand,
} from './command-registry.js';
import {
  LAZY_COMMAND_NAMES,
  buildFullCommandTree,
} from '../../cli/command-registry.js';

describe('KNOWN_TOP_LEVEL_COMMANDS', () => {
  it('covers every top-level name and alias the real command modules register', async () => {
    const program = await buildFullCommandTree();
    const registered = program.commands.flatMap((c) => [c.name(), ...c.aliases()]);
    expect(registered.length).toBeGreaterThan(50); // the tree really did load
    const missing = registered.filter((name) => !KNOWN_TOP_LEVEL_COMMANDS.has(name));
    expect(missing).toEqual([]);
  });

  it('includes the lazily-registered groups (sessions/teams/cloud/…)', () => {
    for (const name of LAZY_COMMAND_NAMES) {
      expect(isKnownTopLevelCommand(name)).toBe(true);
    }
  });

  it('includes the aliases and tombstones src/index.ts registers inline', () => {
    // Not in COMMAND_LOADERS — they are closures over entry-point state — but
    // they are real commands, so the router must not treat them as unknown.
    for (const name of ['perms', 'exec', 'jobs', 'cron', 'check', 'resources', 'hq', 'upgrade', '_internal']) {
      expect(isKnownTopLevelCommand(name)).toBe(true);
    }
  });

  it('rejects a name the CLI does not register', () => {
    expect(isKnownTopLevelCommand('session')).toBe(false); // the RUSH-2022 typo
    expect(isKnownTopLevelCommand('profile')).toBe(false);
    expect(isKnownTopLevelCommand('publish')).toBe(false);
    expect(isKnownTopLevelCommand('webhook')).toBe(false);
    expect(isKnownTopLevelCommand('wallet')).toBe(false);
    expect(isKnownTopLevelCommand('hosts')).toBe(false);
    expect(isKnownTopLevelCommand('lock')).toBe(false);
    expect(isKnownTopLevelCommand('helper')).toBe(false);
    expect(isKnownTopLevelCommand('whoami')).toBe(false);
    expect(isKnownTopLevelCommand('zzzznotacommand')).toBe(false);
    expect(isKnownTopLevelCommand('')).toBe(false);
  });

  it('keeps provider profiles while removing the resource-profile tree', async () => {
    const program = await buildFullCommandTree();
    expect(program.commands.some((command) => command.name() === 'profile')).toBe(false);

    const profiles = program.commands.find((command) => command.name() === 'profiles');
    expect(profiles).toBeDefined();
    expect(profiles!.commands.map((command) => command.name())).toContain('list');
    expect(profiles!.commands.map((command) => command.name())).not.toContain('use');
    expect(profiles!.commands.map((command) => command.name())).not.toContain('status');
  });

  it('does not recognize the removed defaults and export commands', () => {
    expect(isKnownTopLevelCommand('defaults')).toBe(false);
    expect(isKnownTopLevelCommand('export')).toBe(false);
  });

  it('registers the plural webhooks command without a singular alias', async () => {
    const program = await buildFullCommandTree();
    const names = program.commands.flatMap((command) => [command.name(), ...command.aliases()]);

    expect(names).toContain('webhooks');
    expect(names).not.toContain('webhook');
  });
});
