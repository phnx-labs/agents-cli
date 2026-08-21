import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { parseRole, registerAuthSpaceCommand, registerOrgCommand, resolveInviteRole } from './org.js';
import { getHelpSections } from '../lib/help.js';

describe('parseRole', () => {
  it('accepts admin and member', () => {
    expect(parseRole('admin')).toBe('admin');
    expect(parseRole('member')).toBe('member');
  });

  it('rejects anything else, naming the bad value', () => {
    expect(() => parseRole('owner')).toThrow(/owner/);
    expect(() => parseRole('')).toThrow(/role must be/);
  });
});

describe('resolveInviteRole', () => {
  it('defaults to member when --role is omitted', () => {
    expect(resolveInviteRole(undefined)).toBe('member');
  });

  it('accepts an explicit admin or member', () => {
    expect(resolveInviteRole('admin')).toBe('admin');
    expect(resolveInviteRole('member')).toBe('member');
  });

  it('rejects an invalid --role instead of silently downgrading to member (regression: PR #2821 review)', () => {
    expect(() => resolveInviteRole('owner')).toThrow(/role must be/);
    expect(() => resolveInviteRole('Admin')).toThrow(/role must be/); // case-sensitive, matches the backend's literal check
    expect(() => resolveInviteRole('')).toThrow(/role must be/);
  });
});

describe('registerOrgCommand', () => {
  const program = new Command();
  registerOrgCommand(program);
  const org = program.commands.find(c => c.name() === 'org');

  it('registers the org group with every documented subcommand', () => {
    expect(org).toBeDefined();
    const names = org!.commands.map(c => c.name());
    expect(names).toEqual(['create', 'list', 'view', 'invite', 'members', 'role', 'remove', 'leave']);
  });

  it('maps to spaces, not orgs, in its own help text', () => {
    expect(org!.description()).toMatch(/deprecated alias of `agents auth space`/i);
    const sections = getHelpSections(org!);
    expect(sections.notes).toMatch(/Deprecated alias of `agents auth space`/);
    expect(sections.notes).toMatch(/Maps to the Rush backend's \/api\/v1\/spaces/);
  });

  it('leads help with a real workflow, not a flag dump', () => {
    const sections = getHelpSections(org!);
    expect(sections.examples).toContain('agents org create');
    expect(sections.examples).toContain('agents org invite');
  });

  it('every data-emitting subcommand carries --json', () => {
    for (const sub of org!.commands) {
      const hasJson = sub.options.some(o => o.long === '--json');
      expect(hasJson, `${sub.name()} is missing --json`).toBe(true);
    }
  });
});

describe('registerAuthSpaceCommand', () => {
  const program = new Command();
  const auth = program.command('auth');
  registerAuthSpaceCommand(auth);
  const space = auth.commands.find(c => c.name() === 'space');

  it('nests the same space tree under auth, without a deprecation note', () => {
    expect(space).toBeDefined();
    expect(space!.commands.map(c => c.name())).toEqual(['create', 'list', 'view', 'invite', 'members', 'role', 'remove', 'leave']);
    const sections = getHelpSections(space!);
    expect(sections.examples).toContain('agents auth space create');
    expect(sections.notes).not.toMatch(/Deprecated/);
  });
});
