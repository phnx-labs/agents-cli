/**
 * RUSH-2580 — `agents share` moved under a new `agents artifacts` group and the
 * top-level name was dropped. These pin the surface both ways: the new paths
 * exist with the same subcommands and flags, and the old paths are genuinely
 * gone rather than silently auto-correcting into something else.
 *
 * Built from the REAL command tree (`buildFullCommandTree`), no mocks, so a
 * registration that regresses in the loader table fails here.
 */
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerArtifactsCommands } from './artifacts.js';
import { isDirectProvisionRequest } from './artifacts-setup.js';
import {
  buildFullCommandTree,
  isKnownTopLevelCommand,
  RETIRED_TOP_LEVEL_COMMANDS,
} from '../lib/startup/command-registry.js';
import { closestTopLevelCommand, levenshtein } from '../lib/startup/spellcheck.js';

function artifactsGroup(): Command {
  const program = new Command();
  program.exitOverride();
  registerArtifactsCommands(program);
  const artifacts = program.commands.find((c) => c.name() === 'artifacts');
  if (!artifacts) throw new Error('artifacts group was not registered');
  return artifacts;
}

describe('agents artifacts group', () => {
  it('nests the whole share subtree under `artifacts share`', () => {
    const share = artifactsGroup().commands.find((c) => c.name() === 'share');
    expect(share).toBeDefined();
    // The publish command still takes the file positionally.
    expect(share?.registeredArguments.map((a) => a.name())).toEqual(['file']);
    expect(share?.commands.map((c) => c.name()).sort()).toEqual(
      ['analytics', 'delete', 'join', 'list', 'status', 'update'],
    );
  });

  it('keeps the publish flags on `artifacts share <file>`', () => {
    const share = artifactsGroup().commands.find((c) => c.name() === 'share');
    expect(share?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining([
        '--slug',
        '--github-user',
        '--expire',
        '--unlisted',
        '--private',
        '--force',
        '--no-cover',
        '--no-analytics',
        '--json',
      ]),
    );
  });

  it('exposes provisioning as `artifacts setup`, not `artifacts share setup`', () => {
    const artifacts = artifactsGroup();
    const setup = artifacts.commands.find((c) => c.name() === 'setup');
    expect(setup).toBeDefined();
    // Every flag the retired `agents share setup` carried is still reachable.
    expect(setup?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--bundle', '--worker', '--bucket', '--account', '--token', '--domain', '--analytics-token']),
    );
    const share = artifacts.commands.find((c) => c.name() === 'share');
    expect(share?.commands.map((c) => c.name())).not.toContain('setup');
  });

  it('routes `artifacts setup` to the direct provisioner only when endpoint details were named', () => {
    // --bundle/--worker/--bucket carry commander defaults, so they are always
    // present and must never by themselves mean "skip the wizard".
    const defaults = { bundle: 'cloudflare.com', worker: 'agents-share', bucket: 'agents-share' };
    expect(isDirectProvisionRequest(defaults)).toBe(false);
    expect(isDirectProvisionRequest({ ...defaults, account: 'acct_1' })).toBe(true);
    expect(isDirectProvisionRequest({ ...defaults, token: 'cf-token' })).toBe(true);
    expect(isDirectProvisionRequest({ ...defaults, domain: 'share.example.com' })).toBe(true);
    expect(isDirectProvisionRequest({ ...defaults, analyticsToken: 'tok' })).toBe(true);
  });

  it('keeps `unshare` a TOP-LEVEL alias, not a member of the artifacts group', () => {
    const program = new Command();
    program.exitOverride();
    registerArtifactsCommands(program);
    expect(program.commands.map((c) => c.name()).sort()).toEqual(['artifacts', 'unshare']);
    const unshare = program.commands.find((c) => c.name() === 'unshare');
    expect(unshare?.registeredArguments.map((a) => a.name())).toEqual(['targets']);
  });
});

describe('the retired `agents share` top-level surface', () => {
  it('is no longer registered on the real command tree', async () => {
    const program = await buildFullCommandTree();
    const names = program.commands.flatMap((c) => [c.name(), ...c.aliases()]);
    expect(names).not.toContain('share');
    expect(names).toContain('artifacts');
    expect(names).toContain('unshare');
    expect(isKnownTopLevelCommand('share')).toBe(false);
    expect(isKnownTopLevelCommand('artifacts')).toBe(true);
  });

  it('is RETIRED, so a bare `agents share` can never auto-correct into a live command', () => {
    expect(RETIRED_TOP_LEVEL_COMMANDS.has('share')).toBe(true);
    // Guard the exact hazard the set exists for: whatever the spellchecker
    // picks as nearest, the retirement is what stops it from being run.
    const { minDist } = closestTopLevelCommand('share', ['unshare', 'search', 'artifacts']);
    expect(minDist).toBeGreaterThan(0);
  });
});

describe('the retired `agents setup share` subcommand', () => {
  it('is gone from the setup group', async () => {
    const program = await buildFullCommandTree();
    const setup = program.commands.find((c) => c.name() === 'setup');
    expect(setup).toBeDefined();
    expect(setup?.commands.map((c) => c.name())).not.toContain('share');
  });

  it('has no distance-1 neighbour among the surviving setup subcommands', async () => {
    // RETIRED_TOP_LEVEL_COMMANDS only guards the ROOT. For a subcommand the
    // equivalent protection is that nothing is close enough to be corrected
    // into — assert that rather than assuming it.
    const program = await buildFullCommandTree();
    const setup = program.commands.find((c) => c.name() === 'setup');
    const near = (setup?.commands ?? [])
      .flatMap((c) => [c.name(), ...c.aliases()])
      .filter((name) => levenshtein('share', name) <= 1);
    expect(near).toEqual([]);
  });
});
