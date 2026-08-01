/**
 * The session-lifecycle verbs (`focus`/`resume`/`detach`/`attach`/`migrate`) all
 * live under the `sessions` group, not as top-level commands. This pins the
 * grouping introduced when `detach`/`attach` (background/foreground) moved off the
 * top level — and the `migrate` alias rename that freed the `detach` name.
 */
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerSessionsCommands } from './sessions.js';

function sessionsGroup(): Command {
  const program = new Command();
  program.exitOverride();
  registerSessionsCommands(program);
  const sessions = program.commands.find((c) => c.name() === 'sessions');
  if (!sessions) throw new Error('sessions command not registered');
  return sessions;
}

describe('sessions lifecycle verbs are grouped under `sessions`', () => {
  const sessions = sessionsGroup();
  const names = sessions.commands.map((c) => c.name());

  it('hosts detach and attach as `sessions` subcommands (not top-level)', () => {
    expect(names).toContain('detach');
    expect(names).toContain('attach');
  });

  it('keeps them alongside the sibling lifecycle verbs', () => {
    expect(names).toContain('focus');
    expect(names).toContain('resume');
    expect(names).toContain('migrate');
  });

  it("renames migrate's old `detach` alias to `relocate` so it can't collide with the new verb", () => {
    const migrate = sessions.commands.find((c) => c.name() === 'migrate');
    expect(migrate).toBeDefined();
    expect(migrate!.aliases()).toContain('relocate');
    expect(migrate!.aliases()).not.toContain('detach');
  });
});
