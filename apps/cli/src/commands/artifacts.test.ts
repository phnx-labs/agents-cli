/**
 * RUSH-2580 — `agents share` moved under a new `agents artifacts` group and the
 * top-level name was dropped. These pin the surface both ways: the new paths
 * exist with the same subcommands and flags, and the old paths are genuinely
 * gone rather than silently auto-correcting into something else.
 *
 * Built from the REAL command tree (`buildFullCommandTree`), no mocks, so a
 * registration that regresses in the loader table fails here.
 */
import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerArtifactsCommands } from './artifacts.js';
import { isDirectProvisionRequest } from './artifacts-setup.js';
import { DEFAULT_CF_BUNDLE } from '../lib/share/config.js';
import { buildFullCommandTree } from '../cli/command-registry.js';
import {
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
      ['analytics', 'delete', 'join', 'list', 'revisions', 'status', 'update'],
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
        '--label',
        '--title',
        '--meta',
        '--no-revision',
        '--json',
      ]),
    );
  });

  it('exposes provisioning as `artifacts setup`, not `artifacts share setup`', () => {
    const artifacts = artifactsGroup();
    const setup = artifacts.commands.find((c) => c.name() === 'setup');
    expect(setup).toBeDefined();
    // Every flag the retired `agents share setup` carried is still registered.
    // That it is HONOURED (not just present) is the next two tests.
    expect(setup?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--bundle', '--worker', '--bucket', '--account', '--token', '--domain', '--analytics-token']),
    );
    const share = artifacts.commands.find((c) => c.name() === 'share');
    expect(share?.commands.map((c) => c.name())).not.toContain('setup');
  });

  it('routes `artifacts setup` to the direct provisioner whenever an endpoint detail was TYPED', () => {
    // --bundle/--worker/--bucket carry commander defaults, so their presence is
    // never the signal — only whether the user typed them is. Reading presence
    // would send `--bundle cloudflare-work` down the wizard, which provisions
    // against the DEFAULT bundle and silently uses the wrong Cloudflare account.
    const defaults = { bundle: DEFAULT_CF_BUNDLE, worker: 'agents-share', bucket: 'agents-share' };
    const typed = (...flags: string[]) => (flag: string) => flags.includes(flag);

    expect(isDirectProvisionRequest(defaults)).toBe(false);
    expect(isDirectProvisionRequest(defaults, typed())).toBe(false);

    for (const flag of ['bundle', 'worker', 'bucket'] as const) {
      expect(isDirectProvisionRequest(defaults, typed(flag))).toBe(true);
    }
    expect(isDirectProvisionRequest({ ...defaults, account: 'acct_1' })).toBe(true);
    expect(isDirectProvisionRequest({ ...defaults, token: 'cf-token' })).toBe(true);
    expect(isDirectProvisionRequest({ ...defaults, domain: 'share.example.com' })).toBe(true);
    expect(isDirectProvisionRequest({ ...defaults, analyticsToken: 'tok' })).toBe(true);
  });

  it('carries a typed --bundle all the way into provisioning, not the default bundle', async () => {
    // The real action, through real commander — no mocks. Provisioning fails
    // here (no such bundle), and the failure NAMES the bundle it read, which is
    // the observable proof the flag reaches runShareProvision.
    //
    // Scope, stated honestly: vitest is not a TTY, so this exercises the
    // non-interactive arm. The arm that actually regressed — a TTY run falling
    // into the wizard, which provisions with its own hardcoded defaults — is
    // pinned by the isDirectProvisionRequest test above, which fails against a
    // presence-only implementation.
    const program = new Command();
    program.exitOverride();
    registerArtifactsCommands(program);
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    });
    try {
      await program.parseAsync(['node', 'agents', 'artifacts', 'setup', '--bundle', 'cloudflare-typed-by-user']);
    } finally {
      spy.mockRestore();
    }
    const out = errors.join('\n');
    expect(out).toContain('cloudflare-typed-by-user');
    expect(out).not.toContain(`'${DEFAULT_CF_BUNDLE}' bundle`);
  });

  it('nests `unshare` under the artifacts group (RUSH-2989)', () => {
    const program = new Command();
    program.exitOverride();
    registerArtifactsCommands(program);
    expect(program.commands.map((c) => c.name())).toEqual(['artifacts']);
    const artifacts = program.commands.find((c) => c.name() === 'artifacts');
    const unshare = artifacts?.commands.find((c) => c.name() === 'unshare');
    expect(unshare?.registeredArguments.map((a) => a.name())).toEqual(['targets']);
  });
});

describe('the retired `agents share` top-level surface', () => {
  it('is no longer registered on the real command tree', async () => {
    const program = await buildFullCommandTree();
    const names = program.commands.flatMap((c) => [c.name(), ...c.aliases()]);
    expect(names).not.toContain('share');
    expect(names).not.toContain('unshare');
    expect(names).toContain('artifacts');
    expect(isKnownTopLevelCommand('share')).toBe(false);
    expect(isKnownTopLevelCommand('unshare')).toBe(false);
    expect(isKnownTopLevelCommand('artifacts')).toBe(true);
  });

  it('is RETIRED, so a bare `agents share` can never auto-correct into a live command', () => {
    expect(RETIRED_TOP_LEVEL_COMMANDS.has('share')).toBe(true);
    // Guard the exact hazard the set exists for: whatever the spellchecker
    // picks as nearest, the retirement is what stops it from being run.
    const { minDist } = closestTopLevelCommand('share', ['search', 'artifacts']);
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
