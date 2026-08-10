/**
 * RUSH-2216: `agents sync --host all` fans out with an injected `--json` flag
 * (see lib/hosts/passthrough.ts `buildFleetForwardedArgs`). Remotes that do not
 * accept `--json` fail every peer with `error: unknown option '--json'`.
 *
 * These tests drive the real command tree (no mocks): commander must accept
 * the flag, and the umbrella path must emit parseable JSON on stdout so the
 * fleet roster's `safeJsonParse` succeeds.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { registerSyncCommand } from './sync.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome: string | undefined;

afterEach(() => {
  if (testHome) {
    fs.rmSync(testHome, { recursive: true, force: true });
    testHome = undefined;
  }
});

/** Temp HOME with update-check probes silenced so the CLI stays offline. */
function guardedHome(): string {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sync-json-'));
  const systemDir = path.join(testHome, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
  return testHome;
}

function run(args: string[], home: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('bun', [INDEX, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      AGENTS_NO_UPDATE_CHECK: '1',
      // No interactive pickers, no secrets passphrase required for --local.
      AGENTS_SECRETS_PASSPHRASE: '',
    },
  });
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    status: r.status,
  };
}

// ---------------------------------------------------------------------------
// Helpers shared across per-kind flag tests
// ---------------------------------------------------------------------------

/**
 * Build a disposable commander probe that re-declares every option from the
 * registered sync command. Parsing flags against this probe never fires the
 * sync action — it only exercises flag registration and option collection.
 */
function buildSyncProbe(): Command {
  const program = new Command();
  program.exitOverride();
  registerSyncCommand(program);
  const sync = program.commands.find((c) => c.name() === 'sync')!;
  const probe = new Command('sync').exitOverride();
  for (const o of sync.options) {
    if (o.flags) probe.option(o.flags, o.description ?? '');
  }
  return probe;
}

// ---------------------------------------------------------------------------
// Per-kind selector flags — commander registration and option parsing
// ---------------------------------------------------------------------------

describe('agents sync per-kind selector flags', () => {
  it('all per-kind flags are registered on the sync command', () => {
    const program = new Command();
    program.exitOverride();
    registerSyncCommand(program);
    const sync = program.commands.find((c) => c.name() === 'sync')!;
    const longs = (sync!.options ?? []).map((o) => o.long);
    // Every kind pair (singular + plural alias)
    for (const flag of [
      '--plugin', '--plugins',
      '--command', '--commands',
      '--skill', '--skills',
      '--hook', '--hooks',
      '--subagent', '--subagents',
      '--permission', '--permissions',
      '--mcp', '--mcps',
      '--workflow', '--workflows',
      '--rule', '--rules',
      '--memory',
    ]) {
      expect(longs, `missing flag ${flag}`).toContain(flag);
    }
  });

  it('singular and plural flags accumulate the same value (--plugin fleet == --plugins fleet)', () => {
    const a = buildSyncProbe();
    a.parse(['--plugin', 'fleet'], { from: 'user' });
    const b = buildSyncProbe();
    b.parse(['--plugins', 'fleet'], { from: 'user' });
    // kindCollector normalises both into an array via the same argParser
    expect(a.opts().plugin).toEqual(['fleet']);
    expect(b.opts().plugins).toEqual(['fleet']);
  });

  it('bare flag (no value) yields true → "all of that kind"', () => {
    const probe = buildSyncProbe();
    probe.parse(['--plugins'], { from: 'user' });
    expect(probe.opts().plugins).toBe(true);
  });

  it('bare --skills sets skills only, leaves other kinds undefined', () => {
    const probe = buildSyncProbe();
    probe.parse(['--skills'], { from: 'user' });
    const opts = probe.opts();
    expect(opts.skills).toBe(true);
    expect(opts.plugins).toBeUndefined();
    expect(opts.hooks).toBeUndefined();
    expect(opts.commands).toBeUndefined();
  });

  it('kind flags are additive: --plugins --hooks sets both, leaves others undefined', () => {
    const probe = buildSyncProbe();
    probe.parse(['--plugins', '--hooks'], { from: 'user' });
    const opts = probe.opts();
    expect(opts.plugins).toBe(true);
    expect(opts.hooks).toBe(true);
    expect(opts.skills).toBeUndefined();
    expect(opts.commands).toBeUndefined();
    expect(opts.subagents).toBeUndefined();
  });

  it('repeated flags accumulate: --plugin fleet --plugin code → [fleet, code]', () => {
    const probe = buildSyncProbe();
    probe.parse(['--plugin', 'fleet', '--plugin', 'code'], { from: 'user' });
    expect(probe.opts().plugin).toEqual(['fleet', 'code']);
  });

  it('comma-separated value accumulates: --plugin fleet,code → [fleet, code]', () => {
    const probe = buildSyncProbe();
    probe.parse(['--plugin', 'fleet,code'], { from: 'user' });
    expect(probe.opts().plugin).toEqual(['fleet', 'code']);
  });

  it('--rule and --rules are registered as kind flags for the memory kind', () => {
    const probe = buildSyncProbe();
    probe.parse(['--rule'], { from: 'user' });
    // --rule is a bare flag (no required value); truthy when present
    expect(probe.opts().rule).toBeTruthy();
  });

  it('--memory is registered as a boolean flag aliasing the rule kind', () => {
    const probe = buildSyncProbe();
    probe.parse(['--memory'], { from: 'user' });
    expect(probe.opts().memory).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auto-promotion: bare `agents sync --agent claude` with multiple versions
// ---------------------------------------------------------------------------

/** Populate a test home with N fake claude version dirs that pass isVersionInstalled. */
function seedFakeClaudeVersions(home: string, versions: string[]): void {
  for (const ver of versions) {
    // getPackageBinaryPath reads package.json → bin field then checks the file
    const pkgDir = path.join(
      home, '.agents', '.history', 'versions', 'claude', ver,
      'node_modules', '@anthropic-ai', 'claude-code',
    );
    const binDir = path.join(pkgDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@anthropic-ai/claude-code', version: ver, bin: { claude: 'bin/claude' } }),
    );
    // The binary only needs to exist as a file; we never launch it in tests.
    fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\n');
    fs.chmodSync(path.join(binDir, 'claude'), 0o755);
  }
}

describe('agents sync auto-promotion to @all', () => {
  it('targets all versions when multiple are installed and no default is pinned', () => {
    const home = guardedHome();
    seedFakeClaudeVersions(home, ['1.0.0', '1.1.0']);
    // --dry-run avoids actually writing to the fake version homes;
    // --json guarantees machine-readable output we can parse.
    const { stdout, status } = run(['sync', '--agent', 'claude', '--dry-run', '--json'], home);
    // Old code: exits with { mode: 'agent', error: 'No default Claude version pinned.' }
    // New code: auto-promotes to @all → { mode: 'dry-run', versions: ['1.0.0', '1.1.0'] }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      throw new Error(`stdout was not valid JSON:\n${stdout}\nstderr:\n${(run(['sync', '--agent', 'claude', '--dry-run', '--json'], home)).stderr}`);
    }
    expect(parsed.mode).toBe('dry-run');
    expect(parsed.agent).toBe('claude');
    expect(Array.isArray(parsed.versions)).toBe(true);
    expect((parsed.versions as string[]).sort()).toEqual(['1.0.0', '1.1.0']);
  });
});

// ---------------------------------------------------------------------------
// Retired per-resource sync verbs (agents/retire branch)
// ---------------------------------------------------------------------------

describe('agents sync retired per-resource verbs', () => {
  it('agents hooks sync returns commander unknown-command error', () => {
    const home = guardedHome();
    const { stderr, status } = run(['hooks', 'sync'], home);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/unknown command|error.*unknown/i);
  });

  it('agents skills sync returns commander unknown-command error', () => {
    const home = guardedHome();
    const { stderr, status } = run(['skills', 'sync'], home);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/unknown command|error.*unknown/i);
  });

  it('agents commands sync returns commander unknown-command error', () => {
    const home = guardedHome();
    const { stderr, status } = run(['commands', 'sync'], home);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/unknown command|error.*unknown/i);
  });
});

// ---------------------------------------------------------------------------
// Original RUSH-2216 fleet fan-out tests
// ---------------------------------------------------------------------------

describe('agents sync --json (RUSH-2216 fleet fan-out)', () => {
  it('commander registers --json (no unknown option on parse)', () => {
    // Unit-level guard: the option must be registered on the sync command so a
    // peer that receives the fleet-injected flag does not exit with
    // "unknown option '--json'". Check the option table without firing the
    // action (which would start a real umbrella sync).
    const program = new Command();
    program.exitOverride();
    registerSyncCommand(program);
    const sync = program.commands.find((c) => c.name() === 'sync');
    expect(sync).toBeDefined();
    const longs = (sync!.options ?? []).map((o) => o.long);
    expect(longs).toContain('--json');
    // Commander throws CommanderError on unknown options under exitOverride.
    // Parse flags only via a disposable clone that has no action side effects.
    const probe = new Command('sync').exitOverride();
    for (const o of sync!.options) {
      // Re-declare the same flags so unknown-option checking matches production.
      if (o.flags) probe.option(o.flags, o.description ?? '');
    }
    expect(() => probe.parse(['--json', '--local', '--yes'], { from: 'user' })).not.toThrow();
    expect(probe.opts().json).toBe(true);
  });

  it('umbrella --json --local emits parseable JSON (not "unknown option")', () => {
    // Real path: the fleet fan-out runs exactly `agents sync --json` on each
    // peer. --local keeps the test offline (no git pull of config repos).
    const home = guardedHome();
    const { stdout, stderr, status } = run(['sync', '--json', '--local', '--yes'], home);

    // The regression this catches: before the fix, commander rejected the flag
    // with status 1 and "unknown option '--json'" on stderr, and empty/non-JSON
    // stdout — which is what every remote showed under `agents sync --host all`.
    expect(stderr).not.toMatch(/unknown option ['"]--json['"]/);
    expect(stdout.trim().length).toBeGreaterThan(0);
    // Must not leak human reconcile chatter — fleet parses the entire stdout
    // (safeJsonParse), not the last line.
    expect(stdout).not.toMatch(/Synced:/);
    expect(stdout).not.toMatch(/Registered \d+ hook/);
    expect(stdout).not.toMatch(/Declared CLIs missing/);

    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('umbrella');
    expect(parsed.plan).toEqual({
      fetchRepos: false,
      fetchSecrets: false,
      reconcile: true,
    });
    expect(parsed.reconciled).toBe(true);
    // Exit may be 0 even with no agents installed — reconcile is a soft pass.
    expect(status === 0 || status === 1).toBe(true);
  });

  it('bare --json (the exact fleet-forwarded argv shape) is accepted', () => {
    // buildFleetForwardedArgs strips routing flags and appends --json, so the
    // remote argv is exactly `agents sync --json`. Mirror that here.
    const home = guardedHome();
    const { stdout, stderr } = run(['sync', '--json'], home);
    expect(stderr).not.toMatch(/unknown option ['"]--json['"]/);
    expect(stdout).not.toMatch(/Synced:/);
    expect(stdout).not.toMatch(/Registered \d+ hook/);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.mode).toBe('umbrella');
    expect(typeof parsed.ok).toBe('boolean');
  });
});
