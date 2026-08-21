import type { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import { runOrDie } from '../lib/format.js';
import {
  createSpace,
  createSpaceInvite,
  fetchWhoAmI,
  listSpaceMembers,
  listSpaces,
  removeSpaceMember,
  resolveMemberFromList,
  resolvePrixToken,
  resolveSpaceFromList,
  slugify,
  updateSpaceMemberRole,
  type SpaceMember,
  type SpaceSummary,
} from '../lib/prix-account.js';

/** Every `agents org` subcommand needs a token up front — one place to say so. */
function requireToken(): void {
  if (!resolvePrixToken()) throw new Error("Not signed in. Run 'agents auth login' first.");
}

async function resolveSpace(explicit: string | undefined): Promise<SpaceSummary> {
  const spaces = await listSpaces();
  return resolveSpaceFromList(spaces, explicit);
}

function printSpace(space: SpaceSummary): void {
  console.log(`${chalk.bold(space.name)}  ${chalk.gray(space.slug)}  ${chalk.gray(space.id)}`);
  console.log(`  role: ${space.user_role}${space.organization_id ? `  org: ${space.organization_id}` : ''}`);
}

function printMembers(members: SpaceMember[]): void {
  if (!members.length) { console.log(chalk.gray('  No members.')); return; }
  for (const m of members) console.log(`  ${chalk.cyan(m.email)}  ${m.role}  ${chalk.gray(m.user_id)}`);
}

async function runCreate(name: string, o: { slug?: string; description?: string; json?: boolean }): Promise<void> {
  requireToken();
  const space = await createSpace({ name, slug: o.slug ?? slugify(name), description: o.description });
  if (o.json) { console.log(JSON.stringify(space, null, 2)); return; }
  console.log(chalk.green(`Created space '${space.name}' (${space.slug}).`));
  printSpace(space);
}

async function runList(o: { json?: boolean }): Promise<void> {
  requireToken();
  const spaces = await listSpaces();
  if (o.json) { console.log(JSON.stringify(spaces, null, 2)); return; }
  if (!spaces.length) { console.log(chalk.gray("No spaces. Create one with 'agents auth space create <name>'.")); return; }
  for (const space of spaces) printSpace(space);
}

async function runView(spaceArg: string | undefined, o: { json?: boolean }): Promise<void> {
  requireToken();
  const space = await resolveSpace(spaceArg);
  if (o.json) { console.log(JSON.stringify(space, null, 2)); return; }
  printSpace(space);
}

/** `--role` defaults to member when omitted; anything present must be a real role — never silently coerced. */
export function resolveInviteRole(raw: string | undefined): 'admin' | 'member' {
  return raw === undefined ? 'member' : parseRole(raw);
}

async function runInvite(email: string, o: { role?: string; space?: string; json?: boolean }): Promise<void> {
  requireToken();
  const role = resolveInviteRole(o.role);
  const space = await resolveSpace(o.space);
  const result = await createSpaceInvite(space.id, email, role);
  if (o.json) { console.log(JSON.stringify(result, null, 2)); return; }
  if (result.member_added) console.log(chalk.green(`Added ${email} to '${space.name}' as ${role}.`));
  else console.log(chalk.green(`Invited ${email} to '${space.name}' as ${role}. They'll get an email.`));
}

async function runMembers(spaceArg: string | undefined, o: { json?: boolean }): Promise<void> {
  requireToken();
  const space = await resolveSpace(spaceArg);
  const members = await listSpaceMembers(space.id);
  if (o.json) { console.log(JSON.stringify(members, null, 2)); return; }
  console.log(chalk.bold(`${space.name} (${members.length} member${members.length === 1 ? '' : 's'})`));
  printMembers(members);
}

/** Validate a role argument before any network call — same rule the backend enforces server-side. */
export function parseRole(raw: string): 'admin' | 'member' {
  if (raw === 'admin' || raw === 'member') return raw;
  throw new Error(`role must be 'admin' or 'member', got '${raw}'.`);
}

async function runRole(email: string, roleRaw: string, o: { space?: string; json?: boolean }): Promise<void> {
  requireToken();
  const role = parseRole(roleRaw);
  const space = await resolveSpace(o.space);
  const members = await listSpaceMembers(space.id);
  const member = resolveMemberFromList(members, email);
  const result = await updateSpaceMemberRole(space.id, member.user_id, role);
  if (o.json) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(chalk.green(`${email} is now ${role} in '${space.name}'.`));
}

async function runRemove(email: string, o: { space?: string; json?: boolean }): Promise<void> {
  requireToken();
  const space = await resolveSpace(o.space);
  const members = await listSpaceMembers(space.id);
  const member = resolveMemberFromList(members, email);
  await removeSpaceMember(space.id, member.user_id);
  if (o.json) { console.log(JSON.stringify({ removed: email, space: space.slug }, null, 2)); return; }
  console.log(chalk.green(`Removed ${email} from '${space.name}'.`));
}

async function runLeave(spaceArg: string | undefined, o: { json?: boolean }): Promise<void> {
  requireToken();
  const resolved = resolvePrixToken();
  if (!resolved) throw new Error("Not signed in. Run 'agents auth login' first.");
  const who = await fetchWhoAmI(resolved.token);
  const space = await resolveSpace(spaceArg);
  if (space.owner_user_id === who.userId) {
    throw new Error(`You own '${space.name}'. Transfer ownership or delete the space instead of leaving it.`);
  }
  await removeSpaceMember(space.id, who.userId);
  if (o.json) { console.log(JSON.stringify({ left: space.slug }, null, 2)); return; }
  console.log(chalk.green(`Left '${space.name}'.`));
}

/** One-line deprecation for the leftover top-level `agents org` spelling. */
export function printOrgDeprecation(): void {
  console.error(chalk.yellow(
    'agents org is deprecated — use `agents auth space`.',
  ));
}

interface SpaceTreeOptions {
  /** Help-example prefix (`agents auth space` or `agents org`). */
  prefix: string;
  /** When true, every action prints the org deprecation line first (stderr). */
  deprecated?: boolean;
}

/** Shared space CRUD tree — canonical under `auth space`, leftover under `org`. */
function attachSpaceCommands(parent: Command, opts: SpaceTreeOptions): void {
  const before = (): void => {
    if (opts.deprecated) printOrgDeprecation();
  };
  const jsonFlag = (o: { json?: boolean }, command: Command): boolean =>
    !!(o.json || command.optsWithGlobals().json);

  parent.command('create <name>').description('Create a space (free tier: 1 owned space)')
    .option('--slug <slug>', 'Override the derived slug')
    .option('--description <text>', 'Optional description')
    .option('--json', 'Machine-readable output')
    .action((name: string, o: { slug?: string; description?: string; json?: boolean }, command: Command) => {
      before();
      const json = jsonFlag(o, command);
      return runOrDie(() => runCreate(name, { ...o, json }), { json });
    });

  parent.command('list').description('List spaces you own or belong to').option('--json', 'Machine-readable output')
    .action((o: { json?: boolean }, command: Command) => {
      before();
      const json = jsonFlag(o, command);
      return runOrDie(() => runList({ json }), { json });
    });

  parent.command('view [space]').description('Show one space (defaults to your only space)').option('--json', 'Machine-readable output')
    .action((space: string | undefined, o: { json?: boolean }, command: Command) => {
      before();
      const json = jsonFlag(o, command);
      return runOrDie(() => runView(space, { json }), { json });
    });

  parent.command('invite <email>').description('Invite (or directly add) a member')
    .option('--role <role>', 'admin | member', 'member')
    .option('--space <id-or-slug>', 'Space to invite into (defaults to your only space)')
    .option('--json', 'Machine-readable output')
    .action((email: string, o: { role?: string; space?: string; json?: boolean }, command: Command) => {
      before();
      const json = jsonFlag(o, command);
      return runOrDie(() => runInvite(email, { ...o, json }), { json });
    });

  parent.command('members [space]').description("List a space's members").option('--json', 'Machine-readable output')
    .action((space: string | undefined, o: { json?: boolean }, command: Command) => {
      before();
      const json = jsonFlag(o, command);
      return runOrDie(() => runMembers(space, { json }), { json });
    });

  parent.command('role <email> <role>').description("Change a member's role (owner-only for admin)")
    .option('--space <id-or-slug>', 'Space to change (defaults to your only space)')
    .option('--json', 'Machine-readable output')
    .action((email: string, role: string, o: { space?: string; json?: boolean }, command: Command) => {
      before();
      const json = jsonFlag(o, command);
      return runOrDie(() => runRole(email, role, { ...o, json }), { json });
    });

  parent.command('remove <email>').description('Remove a member from a space')
    .option('--space <id-or-slug>', 'Space to remove from (defaults to your only space)')
    .option('--json', 'Machine-readable output')
    .action((email: string, o: { space?: string; json?: boolean }, command: Command) => {
      before();
      const json = jsonFlag(o, command);
      return runOrDie(() => runRemove(email, { ...o, json }), { json });
    });

  parent.command('leave [space]').description('Leave a space you do not own').option('--json', 'Machine-readable output')
    .action((space: string | undefined, o: { json?: boolean }, command: Command) => {
      before();
      const json = jsonFlag(o, command);
      return runOrDie(() => runLeave(space, { json }), { json });
    });

  setHelpSections(parent, {
    examples: `${opts.prefix} create acme-team
${opts.prefix} list
${opts.prefix} view acme-team
${opts.prefix} invite dev@example.com --role admin
${opts.prefix} members
${opts.prefix} role dev@example.com admin
${opts.prefix} remove dev@example.com
${opts.prefix} leave acme-team`,
    notes: opts.deprecated
      ? 'Deprecated alias of `agents auth space`. Maps to the Rush backend\'s /api/v1/spaces (the free-tier team primitive), not /api/v1/orgs. Free tier: 1 owned space, 3 members per space. Every command needs `agents auth login` (or a `rush login` session) first. `--space` is only needed once you belong to more than one space.'
      : 'Maps to the Rush backend\'s /api/v1/spaces (the free-tier team primitive), not /api/v1/orgs. Free tier: 1 owned space, 3 members per space. Every command needs `agents auth login` (or a `rush login` session) first. `--space` is only needed once you belong to more than one space. The leftover `agents org` spelling still works and prints a deprecation line.',
  });
}

/** Canonical home: `agents auth space …`. */
export function registerAuthSpaceCommand(auth: Command): void {
  const space = auth.command('space').description('Create and manage a Prix space (invite collaborators)');
  attachSpaceCommands(space, { prefix: 'agents auth space' });
}

/** Leftover top-level spelling — same tree, deprecation on every path. */
export function registerOrgCommand(program: Command): void {
  const org = program.command('org').description('Deprecated alias of `agents auth space` — create and manage a Prix space');
  attachSpaceCommands(org, { prefix: 'agents org', deprecated: true });
}
