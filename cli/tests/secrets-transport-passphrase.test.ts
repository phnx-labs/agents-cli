/**
 * End-to-end: the portable `export --to-file` / `import --from-file` envelope
 * reads the TRANSPORT passphrase (`AGENTS_SYNC_PASSPHRASE`), not the file
 * store's master key (RUSH-1968).
 *
 * These two are the third consumer of the old overloaded variable. The unit
 * tests in src/lib/secrets/sync-passphrase.test.ts cover the resolver; this
 * suite proves the two command call sites are actually wired to it, by driving
 * the REAL CLI entry under a temp HOME and round-tripping a bundle through an
 * encrypted file. No mocking — the same path a real invocation takes.
 *
 * The store itself stays on its auto-provisioned machine-local key throughout,
 * which is the whole point: a box can seal a bundle for transport without ever
 * holding the master key to its own store.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_VERSION = (JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
) as { version: string }).version;

// A source checkout on a GitHub macOS runner does not carry the signed
// `Agents CLI.app`. Even `import --backend file` must probe the Keychain first
// to reject an existing keychain-backed bundle with the same name, so the real
// CLI subprocess cannot seed this fixture there. Keep the end-to-end coverage
// on Linux and on macOS installs that have the shipped helper, matching the
// established subprocess guards in commands/secrets.test.ts and ssh.test.ts.
const keychainHelperAvailable =
  process.platform !== 'darwin' ||
  fs.existsSync(path.join(REPO_ROOT, 'src', 'lib', 'secrets', 'Agents CLI.app')) ||
  fs.existsSync(path.join(REPO_ROOT, 'bin', 'Agents CLI.app')) ||
  fs.existsSync(path.join(REPO_ROOT, 'dist', 'lib', 'secrets', 'Agents CLI.app'));
const helperDependentIt = keychainHelperAvailable ? it : it.skip;

// win32: export/import envelope + file-store decrypt path is POSIX-process oriented (RUSH-2215).
const describeSecrets = process.platform === 'win32' ? describe.skip : describe;


const SYNC_ENV = 'AGENTS_SYNC_PASSPHRASE';
const LEGACY_ENV = 'AGENTS_SECRETS_PASSPHRASE';
/** Not a real credential — a literal used only to key a throwaway temp bundle. */
const TRANSPORT_PASS = 'transport-pass-not-a-real-key';

const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-transport-'));
  tempHomes.push(home);
  const systemDir = path.join(home, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: PACKAGE_VERSION }),
  );
  return home;
}

/** Drive the real CLI. `env` REPLACES both passphrase vars so a value leaking
 *  in from the developer's own shell can never make a negative case pass. */
function runCli(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: home, SHELL: '/bin/zsh' };
  delete env[SYNC_ENV];
  delete env[LEGACY_ENV];
  return spawnSync('node', ['--import', 'tsx', 'src/index.ts', ...args], {
    cwd: REPO_ROOT,
    env: { ...env, ...extraEnv },
    encoding: 'utf-8',
  });
}

/**
 * Seed a file-backed bundle with one key, headlessly.
 *
 * `storeEnv` keys the store: pass `{}` for the default machine-local key, or
 * `{ AGENTS_SECRETS_PASSPHRASE }` to model a pre-upgrade box that exports the
 * master key. That distinction matters — the legacy variable is the STORE key,
 * so reading a bundle back with it set only works if the store was written
 * under the same value. That coupling is exactly what this split removes.
 */
function seedBundle(
  home: string, bundle: string, key: string, value: string,
  storeEnv: Record<string, string> = {},
): void {
  const dotenv = path.join(home, 'seed.env');
  fs.writeFileSync(dotenv, `${key}=${value}\n`);
  const res = runCli(
    home,
    ['secrets', 'import', bundle, '--from', dotenv, '--backend', 'file', '--all-plaintext'],
    storeEnv,
  );
  expect(res.stderr + res.stdout).toContain('Imported');
}

afterEach(() => {
  while (tempHomes.length) {
    const home = tempHomes.pop()!;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describeSecrets('export --to-file / import --from-file use AGENTS_SYNC_PASSPHRASE (RUSH-1968)', () => {
  helperDependentIt('round-trips a bundle through an encrypted file under the NEW variable', () => {
    const home = makeTempHome();
    seedBundle(home, 'src-bundle', 'DEMO_TOKEN', 'demo-value-123');
    const sealed = path.join(home, 'bundle.enc');

    const exported = runCli(home, ['secrets', 'export', 'src-bundle', '--to-file', sealed], {
      [SYNC_ENV]: TRANSPORT_PASS,
    });
    expect(exported.stderr + exported.stdout).toContain('Exported');
    expect(fs.existsSync(sealed)).toBe(true);
    // Sealed, not plaintext: the value must not be readable in the file.
    expect(fs.readFileSync(sealed, 'utf-8')).not.toContain('demo-value-123');

    const imported = runCli(
      home,
      ['secrets', 'import', 'dst-bundle', '--from-file', sealed, '--backend', 'file'],
      { [SYNC_ENV]: TRANSPORT_PASS },
    );
    expect(imported.stderr + imported.stdout).toContain('Imported 1 key');
  });

  helperDependentIt('with NEITHER variable set, both halves error naming the NEW variable', () => {
    const home = makeTempHome();
    seedBundle(home, 'src-bundle', 'DEMO_TOKEN', 'demo-value-123');
    const sealed = path.join(home, 'bundle.enc');

    const exported = runCli(home, ['secrets', 'export', 'src-bundle', '--to-file', sealed]);
    const exportOut = exported.stderr + exported.stdout;
    expect(exportOut).toContain(SYNC_ENV);
    // Naming the master key here is what taught operators to export it.
    expect(exportOut).not.toContain(LEGACY_ENV);

    const imported = runCli(home, ['secrets', 'import', 'dst', '--from-file', sealed]);
    const importOut = imported.stderr + imported.stdout;
    expect(importOut).toContain(SYNC_ENV);
    expect(importOut).not.toContain(LEGACY_ENV);
  });

  helperDependentIt('still accepts the LEGACY variable on a pre-upgrade box, with a deprecation warning', () => {
    // The box that already exports the master key — the configuration this PR
    // exists to retire. Its store is keyed to that same value, so the export
    // works and nothing scripted breaks across the upgrade.
    const home = makeTempHome();
    seedBundle(home, 'src-bundle', 'DEMO_TOKEN', 'demo-value-123', { [LEGACY_ENV]: TRANSPORT_PASS });
    const sealed = path.join(home, 'bundle.enc');

    const exported = runCli(home, ['secrets', 'export', 'src-bundle', '--to-file', sealed], {
      [LEGACY_ENV]: TRANSPORT_PASS,
    });
    expect(exported.stderr + exported.stdout).toContain('Exported');
    expect(exported.stderr).toContain('deprecated');
    expect(exported.stderr).toContain(SYNC_ENV);
  });

  helperDependentIt('a file sealed on a LEGACY box opens on an upgraded box using the NEW variable', () => {
    // Same secret, two spellings, two machines: the upgrade must not strand a
    // file sealed by the other side of the version boundary. Two temp HOMEs,
    // because each box keys its own store differently.
    const sender = makeTempHome();
    const receiver = makeTempHome();
    seedBundle(sender, 'src-bundle', 'DEMO_TOKEN', 'demo-value-123', { [LEGACY_ENV]: TRANSPORT_PASS });
    const sealed = path.join(sender, 'bundle.enc');

    const exported = runCli(sender, ['secrets', 'export', 'src-bundle', '--to-file', sealed], {
      [LEGACY_ENV]: TRANSPORT_PASS,
    });
    expect(exported.stderr + exported.stdout).toContain('Exported');

    // The receiver never holds the sender's master key — only the transport one.
    const imported = runCli(
      receiver,
      ['secrets', 'import', 'dst-bundle', '--from-file', sealed, '--backend', 'file'],
      { [SYNC_ENV]: TRANSPORT_PASS },
    );
    expect(imported.stderr + imported.stdout).toContain('Imported 1 key');
  });
});
