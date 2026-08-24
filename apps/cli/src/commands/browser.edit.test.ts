import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';

// Drives `agents browser profiles edit` / `scope` through the REAL commander
// registration and the REAL profile store under a temp HOME. The flag -> patch
// mapping in the action had no coverage at all, and that is exactly where the
// commander negated-option semantics bite.

let testHome = '';

const TEST_PROFILE = {
  name: 'work',
  browser: 'custom' as const,
  binary: process.execPath,
  endpoints: ['cdp://127.0.0.1:9222'],
};

async function freshBrowserModules() {
  vi.resetModules();
  const browser = await import('./browser.js');
  const profiles = await import('../lib/browser/profiles.js');
  return { ...browser, ...profiles };
}

async function run(args: string[]) {
  const { registerBrowserCommand } = await freshBrowserModules();
  const program = new Command();
  program.exitOverride();
  registerBrowserCommand(program);
  await program.parseAsync(['node', 'agents', 'browser', ...args]);
}

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-browser-edit-'));
  process.env.HOME = testHome;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
});

afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  vi.restoreAllMocks();
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('agents browser profiles edit', () => {
  it('sets a description on an existing profile', async () => {
    const { createProfile, getProfile } = await freshBrowserModules();
    await createProfile(TEST_PROFILE);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run(['profiles', 'edit', 'work', '-d', 'the work browser']);

    const { getProfile: read } = await freshBrowserModules();
    expect((await read('work'))?.description).toBe('the work browser');
  });

  it('leaves chrome unset when neither --headless nor --no-headless is passed', async () => {
    // commander's negated-option default is the trap here: if `--no-headless`
    // silently defaulted `opts.headless` to true, every edit would write a
    // headless flag nobody asked for.
    const { createProfile } = await freshBrowserModules();
    await createProfile(TEST_PROFILE);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run(['profiles', 'edit', 'work', '-d', 'untouched']);

    const { getProfile } = await freshBrowserModules();
    expect((await getProfile('work'))?.chrome).toBeUndefined();
  });

  it('--no-headless drops the key instead of persisting an empty chrome object', async () => {
    const { createProfile } = await freshBrowserModules();
    await createProfile({ ...TEST_PROFILE, chrome: { headless: true } });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run(['profiles', 'edit', 'work', '--no-headless']);

    const { getProfile } = await freshBrowserModules();
    // Strictly undefined, not `{}`. `{ headless: undefined }` is truthy, so
    // profileToConfig's `if (profile.chrome)` would persist a bare `chrome: {}`
    // into the YAML — garbage that also defeats the no-op change detector.
    expect((await getProfile('work'))?.chrome).toBeUndefined();
  });

  it('--no-headless on an already-headed profile reports no change, not a phantom edit', async () => {
    const { createProfile } = await freshBrowserModules();
    await createProfile(TEST_PROFILE); // no chrome block at all
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run(['profiles', 'edit', 'work', '--no-headless']);

    // Persisting `{}` here would make the change-detector diff `undefined` vs
    // `"{}"` and print `Updated work (local): chrome` for a no-op.
    expect(log).toHaveBeenCalledWith(expect.stringContaining('No change'));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('chrome'));
  });

  it('--headless turns it on', async () => {
    const { createProfile } = await freshBrowserModules();
    await createProfile(TEST_PROFILE);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run(['profiles', 'edit', 'work', '--headless']);

    const { getProfile } = await freshBrowserModules();
    expect((await getProfile('work'))?.chrome?.headless).toBe(true);
  });

  it('refuses -b with the delete-and-recreate path, not "unknown option"', async () => {
    // The guard is only reachable because `-b` is declared on `edit`. Without
    // the declaration commander rejects it first and the guidance never lands.
    const { createProfile } = await freshBrowserModules();
    await createProfile(TEST_PROFILE);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited');
    }) as never);

    await expect(run(['profiles', 'edit', 'work', '-b', 'chrome'])).rejects.toThrow();

    expect(error).toHaveBeenCalledWith(expect.stringContaining('profiles remove work'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('refuses an edit that names no field', async () => {
    const { createProfile } = await freshBrowserModules();
    await createProfile(TEST_PROFILE);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited');
    }) as never);

    await expect(run(['profiles', 'edit', 'work'])).rejects.toThrow();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Nothing to edit'));
  });

  it("edit's surface is create's, and adds no flag create lacks", async () => {
    const { registerBrowserCommand } = await freshBrowserModules();
    const program = new Command();
    program.exitOverride();
    registerBrowserCommand(program);
    const profiles = program.commands
      .find((c) => c.name() === 'browser')!
      .commands.find((c) => c.name() === 'profiles')!;
    const longs = (name: string) =>
      new Set(
        profiles.commands
          .find((c) => c.name() === name)!
          .options.map((o) => o.long)
          .filter((l): l is string => !!l)
      );

    const create = longs('create');
    const edit = longs('edit');
    // Everything create teaches, edit accepts — so an agent that learned create
    // can edit with zero new tokens.
    for (const flag of create) {
      expect(edit.has(flag), `edit is missing ${flag}`).toBe(true);
    }
    expect(edit.has('--fleet')).toBe(false);
    // And nothing NEW: a flag on edit that create never taught is drift in the
    // other direction, which the one-directional check above cannot see.
    const editOnly = [...edit].filter(
      (f) => !create.has(f) && !['--json', '--no-headless', '--no-electron', '--help'].includes(f)
    );
    expect(editOnly, `edit has flags create lacks: ${editOnly.join(', ')}`).toEqual([]);
  });
});

describe('agents browser profiles command surface', () => {
  it('does not register a scope subcommand — the concept is gone, not deprecated', async () => {
    // `scope` described where a profile's CONFIG was stored. Storage is no longer
    // a user-visible concept: a device declares its own browsers in its own file,
    // and how many devices declare a name IS the kind. A no-op or deprecation
    // stub would be a stub, which the repo's review conventions block.
    const { registerBrowserCommand } = await freshBrowserModules();
    const program = new Command();
    registerBrowserCommand(program);
    const profiles = program.commands
      .find((command) => command.name() === 'browser')!
      .commands.find((command) => command.name() === 'profiles')!;

    const names = profiles.commands.map((command) => command.name());
    expect(names).not.toContain('scope');
    expect(names).toContain('claim');
  });
});

describe('agents browser profiles prune — misfiled reporting', () => {
  // reportMisfiled() is the PRIMARY surface for this finding: a misfiled profile
  // is never a prune candidate, and the `kept` loop only prints when there is
  // nothing to prune at all.
  //
  // "Misfiled" now means: exactly one device declares the name (so it is
  // identity-bearing), that device is NOT this one, and the endpoint is loopback
  // — so here the name resolves to this box's own browser instead of the
  // declaring device's. That is the `comet-local` bug in miniature.
  //
  // The subtlety these assertions are built around: the `why` string is echoed by
  // the kept loop too, so a bare toContain() would pass off the kept reason even
  // with reportMisfiled gutted, and a /misfiled/i match would pass off the
  // fixture's own name. Hence a fixture name containing no "misfiled", and a
  // line-anchored match on reportMisfiled's own two-space-indented format, which
  // the kept line ("  kept <name> …") cannot satisfy.
  const PEER = 'peerbox';

  function declareOnPeer(name: string, endpoints: string[]): void {
    const file = path.join(testHome, '.agents', 'devices', PEER, 'agents.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `browser:\n  ${name}:\n    browser: custom\n    binary: ${process.execPath}\n` +
        `    endpoints:\n${endpoints.map((e) => `      - ${e}`).join('\n')}\n`
    );
  }

  it('names each misfiled profile with its repair, in reportMisfiled own format', async () => {
    declareOnPeer('work-peer', ['cdp://localhost:9401']);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run(['profiles', 'prune', '--dry-run']);

    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/^1 profile is misfiled —/m);
    expect(out).toMatch(/^ {2}work-peer — .*declared on peerbox/m);
    expect(out).toMatch(/never deletes these/i);
  });

  it('offers no misfiled profile for deletion', async () => {
    declareOnPeer('work-peer', ['cdp://localhost:9401']);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run(['profiles', 'prune', '--dry-run']);

    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).not.toMatch(/Would remove[\s\S]*work-peer/);
    expect(out).toMatch(/^ {2}work-peer — .*declared on peerbox/m);
  });

  it('does not prune a peer ssh profile, and does not call it misfiled', async () => {
    // An ssh:// endpoint names the machine it means. It is not misfiled, and
    // prune must not offer it for deletion — deleteProfile would throw
    // "not declared on this device".
    declareOnPeer('remote-ok', ['ssh://muqsit@mac-mini?port=9300']);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run(['profiles', 'prune', '--dry-run']);

    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).not.toMatch(/misfiled/i);
    expect(out).not.toMatch(/Would remove[\s\S]*remote-ok/);
    expect(out).toMatch(/remote-ok/);
  });

  it('does not register prune --fleet — deleteProfile cannot remove another device\'s declaration', async () => {
    const { registerBrowserCommand } = await freshBrowserModules();
    const program = new Command();
    registerBrowserCommand(program);
    const prune = program.commands
      .find((command) => command.name() === 'browser')!
      .commands.find((command) => command.name() === 'profiles')!
      .commands.find((command) => command.name() === 'prune')!;
    expect(prune.options.map((option) => option.long)).not.toContain('--fleet');
  });
});
