import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerUpgradeCommand } from './upgrade.js';

describe('registerUpgradeCommand', () => {
  it('shares the visible upgrade surface with the runtime and reference tree', () => {
    const root = new Command();
    const upgrade = registerUpgradeCommand(root);
    expect(upgrade.description()).toContain('Upgrade agents-cli');
    expect(upgrade.registeredArguments.map((argument) => argument.name())).toEqual(['version']);
    expect(upgrade.options.map((option) => option.flags)).toEqual(['-y, --yes']);
  });
});
