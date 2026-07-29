import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const repoRoot = process.cwd();
const entrypoint = path.join(repoRoot, 'src/index.ts');

/** Run the CLI (optionally under a brand via AGENTS_BRAND). Returns stdout+stderr. */
function run(home: string, args: string[], brand?: string): { out: string; code: number } {
  try {
    const out = execFileSync('bun', [entrypoint, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        ...(brand ? { AGENTS_BRAND: brand } : {}),
        AGENTS_NO_AUTOPULL: '1',
        AGENTS_SKIP_MIGRATION: '1',
        AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
      },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
}

function readYaml(home: string): string {
  return fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
}

describe('mine command (white-label)', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mine-test-'));
    fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
    fs.mkdirSync(path.join(home, '.agents', '.cache', 'shims'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('init mints a 755 pass-through shim + brand config + resource preset', () => {
    const { out } = run(home, ['mine', 'init', 'jack', '--disable', 'teams']);
    expect(out).toContain('Minted');

    const shim = path.join(home, '.agents', '.cache', 'shims', 'jack');
    expect(fs.existsSync(shim)).toBe(true);
    // Executable bit set.
    expect(fs.statSync(shim).mode & 0o111).not.toBe(0);
    const body = fs.readFileSync(shim, 'utf-8');
    // Pure pass-through: sets the brand and forwards argv with no injected verb.
    expect(body).toContain('export AGENTS_BRAND=jack');
    expect(body).toContain('exec "$AGENTS_BIN" "$@"');

    const yaml = readYaml(home);
    expect(yaml).toContain('brands:');
    expect(yaml).toContain('name: jack');
    expect(yaml).toContain('- teams');
    expect(yaml).toContain('mine-jack');
  });

  it('rejects reserved and invalid names', () => {
    expect(run(home, ['mine', 'init', 'agents']).code).toBe(1);
    expect(run(home, ['mine', 'init', 'claude']).code).toBe(1);
    expect(run(home, ['mine', 'init', '1bad']).code).toBe(1);
  });

  it('renders the brand name in help and hides disabled commands under the brand only', () => {
    run(home, ['mine', 'init', 'jack', '--disable', 'teams']);

    const branded = run(home, ['--help'], 'jack').out;
    expect(branded).toContain('Usage: jack');
    expect(branded).toContain('jack setup');
    // The disabled command's own listing line is gone under the brand…
    expect(branded).not.toMatch(/^ {2}teams /m);

    // …but the plain `agents` CLI is unaffected.
    const plain = run(home, ['--help']).out;
    expect(plain).toContain('Usage: agents');
    expect(plain).toMatch(/^ {2}teams /m);
  });

  it('a disabled command resolves as unknown under the brand but works under agents', () => {
    run(home, ['mine', 'init', 'jack', '--disable', 'teams']);

    const branded = run(home, ['teams'], 'jack');
    expect(branded.code).toBe(1);
    expect(branded.out).toContain("unknown command 'teams'");

    // Under the real CLI, `teams` is a known command group (prints its usage).
    const plain = run(home, ['teams']);
    expect(plain.out).toContain('teams');
    expect(plain.out).not.toContain("unknown command 'teams'");
  });

  it('toggle enables/disables commands and writes plugin/skill excludes to the preset', () => {
    run(home, ['mine', 'init', 'jack', '--disable', 'teams']);
    run(home, ['mine', 'toggle', 'jack', '--enable', 'teams', '--disable-plugin', 'rush', '--disable-skill', 'deploy']);

    const yaml = readYaml(home);
    // Command re-enabled → no disabledCommands list.
    expect(yaml).not.toMatch(/- teams/);
    // Plugin/skill disables land as `['*', '!name']` excludes on the brand preset.
    expect(yaml).toContain('mine-jack');
    expect(yaml).toContain("!rush");
    expect(yaml).toContain("!deploy");

    // The re-enabled command now resolves (branded usage, not "unknown").
    const branded = run(home, ['teams'], 'jack');
    expect(branded.out).not.toContain("unknown command 'teams'");
  });

  it('keeps brands isolated and removes cleanly', () => {
    run(home, ['mine', 'init', 'jack']);
    run(home, ['mine', 'init', 'pranjal', '--disable', 'cloud']);

    const list = run(home, ['mine', 'list']).out;
    expect(list).toContain('jack');
    expect(list).toContain('pranjal');

    // pranjal's disable does not leak into jack.
    expect(run(home, ['cloud'], 'jack').out).not.toContain("unknown command 'cloud'");
    expect(run(home, ['cloud'], 'pranjal').out).toContain("unknown command 'cloud'");

    run(home, ['mine', 'remove', 'jack', '--purge']);
    expect(fs.existsSync(path.join(home, '.agents', '.cache', 'shims', 'jack'))).toBe(false);
    expect(readYaml(home)).not.toContain('mine-jack');
    // pranjal survives.
    expect(run(home, ['mine', 'list']).out).toContain('pranjal');
  });
});
