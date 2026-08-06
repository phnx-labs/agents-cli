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

    const parsed = JSON.parse(stdout.trim().split('\n').pop()!);
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
    const parsed = JSON.parse(stdout.trim().split('\n').pop()!);
    expect(parsed.mode).toBe('umbrella');
    expect(typeof parsed.ok).toBe('boolean');
  });
});
