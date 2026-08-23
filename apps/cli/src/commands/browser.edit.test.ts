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

    expect(error).toHaveBeenCalledWith(expect.stringContaining('profiles delete work'));
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

  it("edit's surface is create's minus --fleet, and adds no flag create lacks", async () => {
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
      if (flag === '--fleet') continue;
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

describe('agents browser profiles scope', () => {
  it('moves a fleet profile to this machine and drops the fleet copy', async () => {
    const { createProfile, listProfilesWithScope } = await freshBrowserModules();
    await createProfile(TEST_PROFILE, { fleet: true });
    expect((await listProfilesWithScope()).find((p) => p.profile.name === 'work')?.scope).toBe('fleet');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await run(['profiles', 'scope', 'work', 'local']);

    const { listProfilesWithScope: read } = await freshBrowserModules();
    const { readMeta } = await import('../lib/state.js');
    expect((await read()).find((p) => p.profile.name === 'work')?.scope).toBe('local');
    // listProfilesWithScope reports `local` whenever a local entry exists, because
    // local wins the collision — so it passes even if the fleet copy was never
    // dropped. Assert the source store directly, which is the actual contract.
    const meta = readMeta();
    expect(meta.deviceBrowser?.work).toBeDefined();
    expect(meta.browser?.work).toBeUndefined();
  });

  it('rejects a scope that is neither local nor fleet', async () => {
    const { createProfile } = await freshBrowserModules();
    await createProfile(TEST_PROFILE);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited');
    }) as never);

    await expect(run(['profiles', 'scope', 'work', 'global'])).rejects.toThrow();
    expect(error).toHaveBeenCalledWith('scope must be `local` or `fleet`');
  });
});

describe('agents browser profiles prune — misfiled reporting', () => {
  // reportMisfiled() is the PRIMARY surface for this finding: a misfiled profile
  // is never a prune candidate, and the `kept` loop only prints when there is
  // nothing to prune at all.
  //
  // The subtlety these assertions are built around: misfiledFleetProfile's `why`
  // ALREADY ends with "…agents browser profiles scope <name> local", and that
  // `why` is echoed by the kept loop. So a bare `toContain(<repair command>)`
  // passes off the kept reason even when reportMisfiled is gutted, and a
  // `/misfiled/i` match passes off the fixture's own name. Hence: a fixture name
  // with no "misfiled" in it, and a line-anchored match on reportMisfiled's own
  // two-space-indented format, which the kept line ("  kept <name> …") cannot
  // satisfy.
  const FLEET_MISFILED = {
    name: 'work-fleet',
    browser: 'custom' as const,
    binary: process.execPath,
    endpoints: ['cdp://localhost:9401'],
  };

  it('names each misfiled profile with its repair, in reportMisfiled own format', async () => {
    const { createProfile } = await freshBrowserModules();
    await createProfile(FLEET_MISFILED, { fleet: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run(['profiles', 'prune', '--dry-run']);

    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/^1 fleet profile is misfiled —/m);
    expect(out).toMatch(/^ {2}work-fleet — agents browser profiles scope work-fleet local$/m);
    expect(out).toMatch(/never deletes these/i);
  });

  it('offers no misfiled profile for deletion, even with --fleet', async () => {
    // --fleet is the path that used to reach `binary-missing` and delete it
    // fleet-wide. Asserting it without --fleet would be trivially true.
    const { createProfile } = await freshBrowserModules();
    await createProfile(FLEET_MISFILED, { fleet: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run(['profiles', 'prune', '--dry-run', '--fleet']);

    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).not.toMatch(/Would remove[\s\S]*work-fleet/);
    expect(out).toMatch(/^ {2}work-fleet — agents browser profiles scope work-fleet local$/m);
  });

  it('says nothing about misfiling when every fleet profile is correctly scoped', async () => {
    const { createProfile } = await freshBrowserModules();
    await createProfile(
      { name: 'remote-ok', browser: 'custom', binary: process.execPath, endpoints: ['ssh://muqsit@mac-mini?port=9300'] },
      { fleet: true },
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run(['profiles', 'prune', '--dry-run']);

    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/misfiled/i);
  });
});
