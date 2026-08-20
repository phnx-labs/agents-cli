import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerAuthCommand } from './auth.js';
import { getHelpSections } from '../lib/help.js';

describe('registerAuthCommand', () => {
  const program = new Command();
  registerAuthCommand(program);
  const auth = program.commands.find(c => c.name() === 'auth');

  it('registers login/whoami/logout, never top-level login/logout (RETIRED_TOP_LEVEL_COMMANDS)', () => {
    expect(auth).toBeDefined();
    const names = auth!.commands.map(c => c.name());
    expect(names).toEqual(['login', 'whoami', 'logout']);
    // These must be nested under `auth`, never registered as bare top-level names —
    // 'login'/'logout' are in RETIRED_TOP_LEVEL_COMMANDS and must not resurrect.
    expect(program.commands.some(c => c.name() === 'login')).toBe(false);
    expect(program.commands.some(c => c.name() === 'logout')).toBe(false);
  });

  it('whoami takes --json', () => {
    const whoami = auth!.commands.find(c => c.name() === 'whoami');
    expect(whoami!.options.some(o => o.long === '--json')).toBe(true);
  });

  it('help documents that logout never signs the user out of rush', () => {
    const sections = getHelpSections(auth!);
    expect(sections.notes).toMatch(/never signs you out of `rush`/);
  });
});
