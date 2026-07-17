import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { needsWindowsShell, toPosix } from './platform/index.js';
import {
  bunGlobalDir,
  deriveGlobalPrefix,
  detectPackageManager,
  dismissUpdateVersion,
  downloadVerifiedTarball,
  findAgentsCliInstalls,
  installPackageIntoPrefix,
  readInstalledVersion,
  readUpdateCache,
  saveUpdateCheck,
  shouldPromptUpgrade,
  verifyInstalledVersion,
  verifyTarballIntegrity,
} from './self-update.js';

const tempDirs: string[] = [];

function makeTempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agents-self-update-${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('deriveGlobalPrefix', () => {
  it('resolves the POSIX npm global layout (<prefix>/lib/node_modules/<scoped pkg>)', () => {
    const root = path.join('/Users/x/.nvm/versions/node/v24.15.0', 'lib', 'node_modules', '@phnx-labs', 'agents-cli');
    // path.resolve so the expected carries a drive on Windows, matching the
    // function's own path.resolve of the input.
    expect(deriveGlobalPrefix(root)).toBe(path.resolve('/Users/x/.nvm/versions/node/v24.15.0'));
  });

  it('resolves the Windows npm global layout (<prefix>/node_modules/<scoped pkg>)', () => {
    const root = path.join('/x/npm-prefix', 'node_modules', '@phnx-labs', 'agents-cli');
    expect(deriveGlobalPrefix(root)).toBe(path.resolve('/x/npm-prefix'));
  });

  it('resolves the dev-install prefix used by scripts/install.sh', () => {
    const root = path.join('/Users/x/.local/agents-cli-dev', 'lib', 'node_modules', '@phnx-labs', 'agents-cli');
    expect(deriveGlobalPrefix(root)).toBe(path.resolve('/Users/x/.local/agents-cli-dev'));
  });

  it('throws for a source checkout that is not under node_modules', () => {
    expect(() => deriveGlobalPrefix('/Users/x/src/github.com/muqsitnawaz/agents-cli')).toThrow(
      /not an npm-managed install/,
    );
  });
});

describe('detectPackageManager', () => {
  const savedBunInstall = process.env.BUN_INSTALL;
  afterEach(() => {
    if (savedBunInstall === undefined) delete process.env.BUN_INSTALL;
    else process.env.BUN_INSTALL = savedBunInstall;
  });

  it('detects bun from the BUN_INSTALL global layout (no lib segment)', () => {
    process.env.BUN_INSTALL = '/Users/x/.bun';
    const root = path.join(bunGlobalDir(), 'node_modules', '@phnx-labs', 'agents-cli');
    expect(toPosix(root)).toBe('/Users/x/.bun/install/global/node_modules/@phnx-labs/agents-cli');
    expect(detectPackageManager(root)).toBe('bun');
  });

  it('detects bun structurally when BUN_INSTALL is not exported (default ~/.bun)', () => {
    delete process.env.BUN_INSTALL;
    // A bun install rooted at a `.bun` dir other than the current $HOME's.
    const root = path.join('/opt/someuser/.bun/install/global', 'node_modules', '@phnx-labs', 'agents-cli');
    expect(detectPackageManager(root)).toBe('bun');
  });

  it('treats the npm POSIX layout (<prefix>/lib/node_modules) as npm', () => {
    delete process.env.BUN_INSTALL;
    const root = path.join('/Users/x/.nvm/versions/node/v24.15.0', 'lib', 'node_modules', '@phnx-labs', 'agents-cli');
    expect(detectPackageManager(root)).toBe('npm');
  });

  it('does not mistake a non-bun "global" dir for a bun install', () => {
    process.env.BUN_INSTALL = '/Users/x/.bun';
    const root = path.join('/srv/global', 'node_modules', '@phnx-labs', 'agents-cli');
    expect(detectPackageManager(root)).toBe('npm');
  });
});

describe('verifyInstalledVersion', () => {
  function writePackage(dir: string, version: string): string {
    const root = path.join(dir, 'lib', 'node_modules', '@phnx-labs', 'agents-cli');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@phnx-labs/agents-cli', version }));
    return root;
  }

  it('passes when the package root carries the expected version', () => {
    const root = writePackage(makeTempDir('verify-ok'), '1.20.7');
    expect(() => verifyInstalledVersion(root, '1.20.7')).not.toThrow();
  });

  it('throws with both versions when the running root was not updated', () => {
    // The original incident: npm exits 0 after installing into a different
    // prefix, while the running copy's root still carries the old version.
    const root = writePackage(makeTempDir('verify-stale'), '1.20.4');
    expect(() => verifyInstalledVersion(root, '1.20.7')).toThrow(/still 1\.20\.4 \(expected 1\.20\.7\)/);
  });

  it('suggests `bun add -g` (not npm --prefix) when the stale install is bun-managed', () => {
    // The bun incident: the npm --prefix command in the hint is exactly what
    // could not update a bun install, so the manual hint must use bun instead.
    const saved = process.env.BUN_INSTALL;
    const base = makeTempDir('verify-bun');
    process.env.BUN_INSTALL = base;
    try {
      const root = path.join(base, 'install', 'global', 'node_modules', '@phnx-labs', 'agents-cli');
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ name: '@phnx-labs/agents-cli', version: '1.20.17' }),
      );
      expect(() => verifyInstalledVersion(root, '1.20.19')).toThrow(
        /Run manually: bun add -g @phnx-labs\/agents-cli@1\.20\.19/,
      );
    } finally {
      if (saved === undefined) delete process.env.BUN_INSTALL;
      else process.env.BUN_INSTALL = saved;
    }
  });
});

describe('installPackageIntoPrefix', () => {
  function packDummyPackage(version: string): string {
    const src = makeTempDir('dummy-src');
    fs.writeFileSync(
      path.join(src, 'package.json'),
      JSON.stringify({ name: '@agents-cli-test/dummy', version, license: 'MIT' }),
    );
    const tarball = execFileSync('npm', ['pack', '--silent'], {
      cwd: src,
      encoding: 'utf-8',
      shell: needsWindowsShell('npm'),
    }).trim();
    return path.join(src, tarball);
  }

  it('installs into the given prefix and the result verifies in place', { timeout: 120_000 }, async () => {
    const prefix = makeTempDir('prefix');
    const tarball = packDummyPackage('2.0.0');

    await installPackageIntoPrefix(tarball, prefix);

    // npm prefix layout is platform-divergent: POSIX nests under lib/, Windows
    // installs node_modules directly under the prefix. Source handles both.
    const installedRoot = process.platform === 'win32'
      ? path.join(prefix, 'node_modules', '@agents-cli-test', 'dummy')
      : path.join(prefix, 'lib', 'node_modules', '@agents-cli-test', 'dummy');
    expect(readInstalledVersion(installedRoot)).toBe('2.0.0');
    expect(() => verifyInstalledVersion(installedRoot, '2.0.0')).not.toThrow();
    // The exact upgrade-flow composition: the prefix derived from the
    // installed root must round-trip back to the prefix we installed into.
    expect(deriveGlobalPrefix(installedRoot)).toBe(prefix);
  });

  it('verification catches an install that landed in a different prefix', { timeout: 120_000 }, async () => {
    // Reproduces the divergent-prefix incident end-to-end: the "running"
    // copy lives in prefix A at 1.0.0, the install writes 2.0.0 into prefix
    // B, and verification against A's root must fail rather than report a
    // successful upgrade.
    const prefixA = makeTempDir('prefix-a');
    const prefixB = makeTempDir('prefix-b');
    const runningRoot = path.join(prefixA, 'lib', 'node_modules', '@agents-cli-test', 'dummy');
    fs.mkdirSync(runningRoot, { recursive: true });
    fs.writeFileSync(
      path.join(runningRoot, 'package.json'),
      JSON.stringify({ name: '@agents-cli-test/dummy', version: '1.0.0' }),
    );

    await installPackageIntoPrefix(packDummyPackage('2.0.0'), prefixB);

    expect(() => verifyInstalledVersion(runningRoot, '2.0.0')).toThrow(/still 1\.0\.0 \(expected 2\.0\.0\)/);
  });
});

function sriFor(buf: Buffer): string {
  return `sha512-${createHash('sha512').update(buf).digest('base64')}`;
}

describe('verifyTarballIntegrity', () => {
  const tarball = Buffer.from('fake tarball bytes   for integrity check');

  it('accepts a tarball whose bytes match the SRI digest', () => {
    expect(() => verifyTarballIntegrity(tarball, sriFor(tarball))).not.toThrow();
  });

  it('rejects a tarball whose bytes do not match the SRI digest (tampered/corrupt)', () => {
    // The security gate: the registry attested one hash, the delivered bytes
    // hash to another — self-update must refuse it, not install it.
    const attested = sriFor(tarball);
    const tampered = Buffer.concat([tarball, Buffer.from('!')]);
    expect(() => verifyTarballIntegrity(tampered, attested)).toThrow(/integrity check failed/);
  });

  it('refuses an algorithm weaker than sha512', () => {
    const sha1 = `sha1-${createHash('sha1').update(tarball).digest('base64')}`;
    expect(() => verifyTarballIntegrity(tarball, sha1)).toThrow(/unsupported integrity algorithm 'sha1'/);
  });

  it('rejects a malformed integrity string', () => {
    expect(() => verifyTarballIntegrity(tarball, 'not-an-sri')).toThrow(/unsupported integrity algorithm/);
    expect(() => verifyTarballIntegrity(tarball, 'sha512')).toThrow(/malformed integrity string/);
  });
});

describe('downloadVerifiedTarball', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  });

  function serve(bytes: Buffer): Promise<string> {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(bytes);
    });
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve(`http://127.0.0.1:${addr.port}/@phnx-labs/agents-cli/-/agents-cli-9.9.9.tgz`);
      });
    });
  }

  it('writes the tarball to disk when the served bytes match the integrity', async () => {
    const bytes = Buffer.from('verified package payload');
    const url = await serve(bytes);
    const file = await downloadVerifiedTarball(url, sriFor(bytes));
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(path.basename(file)).toBe('agents-cli-9.9.9.tgz');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('rejects a wrong-hash tarball and writes nothing', async () => {
    // End-to-end over real HTTP + real crypto: the server delivers bytes that
    // do not match the attested integrity; the download must reject.
    const attested = sriFor(Buffer.from('the legitimate published tarball'));
    const url = await serve(Buffer.from('a malicious substituted tarball'));
    await expect(downloadVerifiedTarball(url, attested)).rejects.toThrow(/integrity check failed/);
  });
});

describe('update-check cache', () => {
  function cacheFile(): string {
    return path.join(makeTempDir('cache'), 'nested', '.update-check');
  }

  it('readUpdateCache returns null for a missing or corrupt file', () => {
    const file = cacheFile();
    expect(readUpdateCache(file)).toBeNull();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json');
    expect(readUpdateCache(file)).toBeNull();
  });

  it('saveUpdateCheck creates the parent directory and records the version', () => {
    const file = cacheFile();
    saveUpdateCheck(file, '1.20.7');
    const cache = readUpdateCache(file);
    expect(cache?.latestVersion).toBe('1.20.7');
    expect(cache?.lastCheck).toBeTypeOf('number');
  });

  it('a background refresh does not erase a dismissed version', () => {
    // The original bug: the user picked "Skip 1.20.7", then the next 24h
    // background refresh rewrote the cache without the dismissed marker and
    // re-prompted for the exact version they skipped.
    const file = cacheFile();
    dismissUpdateVersion(file, '1.20.7');
    expect(shouldPromptUpgrade(readUpdateCache(file), '1.20.4')).toBe(false);

    saveUpdateCheck(file, '1.20.7');

    expect(readUpdateCache(file)?.dismissed).toBe('1.20.7');
    expect(shouldPromptUpgrade(readUpdateCache(file), '1.20.4')).toBe(false);
  });

  it('a newer latest than the dismissed one resumes prompting', () => {
    const file = cacheFile();
    dismissUpdateVersion(file, '1.20.7');
    saveUpdateCheck(file, '1.20.8');

    const cache = readUpdateCache(file);
    expect(cache?.dismissed).toBe('1.20.7');
    expect(shouldPromptUpgrade(cache, '1.20.4')).toBe(true);
  });

  it('shouldPromptUpgrade is false when current is equal to or ahead of latest', () => {
    const cache = { lastCheck: 1, latestVersion: '1.20.7' };
    expect(shouldPromptUpgrade(cache, '1.20.7')).toBe(false);
    expect(shouldPromptUpgrade(cache, '1.21.0')).toBe(false);
    expect(shouldPromptUpgrade(null, '1.20.4')).toBe(false);
    expect(shouldPromptUpgrade(cache, '1.20.4')).toBe(true);
  });
});

// findAgentsCliInstalls is POSIX-only (Windows npm bins are .cmd wrappers, not
// symlinks — the function returns [] on win32), and the fixtures here create
// symlinks that need Developer Mode on Windows. Skip the whole block there.
describe.skipIf(process.platform === 'win32')('findAgentsCliInstalls', () => {
  /** Lay out an npm-global-shaped install and a bin dir whose `agents` symlinks into it. */
  function makeInstall(base: string, name: string, version: string, pkgName = '@phnx-labs/agents-cli') {
    const packageRoot = path.join(base, name, 'lib', 'node_modules', ...pkgName.split('/'));
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: pkgName, version }));
    fs.writeFileSync(path.join(packageRoot, 'dist', 'index.js'), '// entrypoint\n');
    const binDir = path.join(base, name, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync(path.join(packageRoot, 'dist', 'index.js'), path.join(binDir, 'agents'));
    // realpath the root: on macOS the tmpdir lives under /var -> /private/var,
    // and the scanner reports canonicalized paths.
    return { packageRoot: fs.realpathSync(packageRoot), binDir };
  }

  it('resolves each PATH entry to its package root, deduplicating repeats', () => {
    const base = makeTempDir('installs');
    const a = makeInstall(base, 'prefix-a', '1.20.4');
    const b = makeInstall(base, 'prefix-b', '1.20.7');
    const pathEnv = [a.binDir, b.binDir, a.binDir].join(path.delimiter);

    const installs = findAgentsCliInstalls(pathEnv);

    expect(installs).toHaveLength(2);
    expect(installs.map((i) => i.packageRoot).sort()).toEqual([a.packageRoot, b.packageRoot].sort());
    expect(installs.find((i) => i.packageRoot === a.packageRoot)?.version).toBe('1.20.4');
    expect(installs.find((i) => i.packageRoot === b.packageRoot)?.version).toBe('1.20.7');
  });

  it('follows symlink chains like the dev install (~/.local/bin/agents -> prefix bin -> dist)', () => {
    const base = makeTempDir('chain');
    const real = makeInstall(base, 'dev-prefix', '0.0.0-dev.abc123');
    const localBin = path.join(base, 'local-bin');
    fs.mkdirSync(localBin, { recursive: true });
    fs.symlinkSync(path.join(real.binDir, 'agents'), path.join(localBin, 'agents'));

    const installs = findAgentsCliInstalls(localBin);

    expect(installs).toHaveLength(1);
    expect(installs[0].packageRoot).toBe(real.packageRoot);
    expect(installs[0].version).toBe('0.0.0-dev.abc123');
  });

  it('skips unrelated binaries, foreign packages, and missing entries', () => {
    const base = makeTempDir('noise');
    // A plain executable named `agents` that is some other tool entirely.
    const plainBin = path.join(base, 'plain-bin');
    fs.mkdirSync(plainBin, { recursive: true });
    fs.writeFileSync(path.join(plainBin, 'agents'), '#!/bin/sh\necho other tool\n', { mode: 0o755 });
    // A dist/index.js layout that belongs to a different npm package.
    const foreign = makeInstall(base, 'foreign', '3.0.0', '@other/agents-tool');
    // A dangling symlink and a dir with no `agents` at all.
    const dangling = path.join(base, 'dangling-bin');
    fs.mkdirSync(dangling, { recursive: true });
    fs.symlinkSync(path.join(base, 'nowhere', 'dist', 'index.js'), path.join(dangling, 'agents'));
    const empty = path.join(base, 'empty-bin');
    fs.mkdirSync(empty, { recursive: true });

    const pathEnv = [plainBin, foreign.binDir, dangling, empty].join(path.delimiter);
    expect(findAgentsCliInstalls(pathEnv)).toEqual([]);
  });
});
