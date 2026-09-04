import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { CANONICAL_ALIASES, withAliases } from './verbs.js';

describe('CANONICAL_ALIASES', () => {
  it('defines exactly the standard short-form verbs', () => {
    expect(Object.keys(CANONICAL_ALIASES).sort()).toEqual(
      ['add', 'edit', 'list', 'remove', 'rename', 'view'].sort()
    );
  });

  it('maps each verb to its canonical short forms', () => {
    expect(CANONICAL_ALIASES.list).toEqual(['ls']);
    expect(CANONICAL_ALIASES.view).toEqual(['show']);
    expect(CANONICAL_ALIASES.remove).toEqual(['rm']);
    expect(CANONICAL_ALIASES.rename).toEqual(['mv']);
    expect(CANONICAL_ALIASES.add).toEqual([]);
    expect(CANONICAL_ALIASES.edit).toEqual([]);
  });
});

describe('withAliases', () => {
  it('attaches the ls alias to a list subcommand', () => {
    const cmd = new Command('list');
    expect(withAliases(cmd, 'list').aliases()).toEqual(['ls']);
  });

  it('attaches the rm alias to a remove subcommand', () => {
    const cmd = new Command('remove');
    expect(withAliases(cmd, 'remove').aliases()).toEqual(['rm']);
  });

  it('attaches the show alias to a view subcommand', () => {
    const cmd = new Command('view');
    expect(withAliases(cmd, 'view').aliases()).toEqual(['show']);
  });

  it('leaves an alias-less verb untouched', () => {
    const cmd = new Command('add');
    expect(withAliases(cmd, 'add').aliases()).toEqual([]);
  });

  it('returns the same command instance for chaining', () => {
    const cmd = new Command('list');
    expect(withAliases(cmd, 'list')).toBe(cmd);
  });
});
