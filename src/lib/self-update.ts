/**
 * Self-update install plumbing.
 *
 * The hard requirement: an upgrade must replace the copy that is currently
 * running. A bare `npm install -g` writes into the global prefix of whatever
 * `npm` PATH happens to resolve — on machines with more than one node
 * installation (nvm + Homebrew + vendored runtimes) that prefix can belong to
 * a different node than the one this copy lives under. The install then
 * "succeeds" while the running copy stays stale and re-prompts forever.
 *
 * So every step here is anchored to the running package root on disk, never
 * to PATH resolution.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { compareVersions } from './versions.js';

export const NPM_PACKAGE_NAME = '@phnx-labs/agents-cli';

export type PackageManager = 'npm' | 'bun';

/**
 * The directory bun installs global packages into:
 *   <BUN_INSTALL>/install/global   (BUN_INSTALL defaults to ~/.bun)
 *
 * A globally-installed scoped package then lives at
 * `<bunGlobalDir>/node_modules/@phnx-labs/agents-cli` — note there is NO `lib`
 * segment, unlike npm's POSIX layout. That single difference is why an
 * npm-based upgrade silently misses a bun install (see deriveGlobalPrefix).
 */
export function bunGlobalDir(): string {
  const bunInstall = process.env.BUN_INSTALL || path.join(os.homedir(), '.bun');
  return path.join(bunInstall, 'install', 'global');
}

/**
 * Identify which package manager owns the install at `packageRoot`, so the
 * upgrade can shell out to the one that actually replaces this copy.
 *
 * bun lays a global package out as `<bunGlobalDir>/node_modules/<scoped pkg>`,
 * so the prefix (the parent of `node_modules`) is the bun global dir itself.
 * Everything else — npm's `<prefix>/lib/node_modules` and the Windows
 * `<prefix>/node_modules` — is treated as npm.
 *
 * Detection is path-based (no subprocess): it matches the resolved bun global
 * dir from BUN_INSTALL/$HOME, and falls back to the structural `.bun/install/
 * global` tail for a relocated BUN_INSTALL not exported into this process.
 */
export function detectPackageManager(packageRoot: string): PackageManager {
  const resolved = path.resolve(packageRoot);
  const prefix = path.dirname(path.dirname(path.dirname(resolved))); // strip <scope>/<pkg>/node_modules
  if (prefix === path.resolve(bunGlobalDir())) return 'bun';
  const parts = prefix.split(path.sep);
  const n = parts.length;
  if (n >= 3 && parts[n - 1] === 'global' && parts[n - 2] === 'install' && parts[n - 3] === '.bun') {
    return 'bun';
  }
  return 'npm';
}

/** The shell command a user can run by hand to reproduce the upgrade for `manager`. */
function manualInstallHint(manager: PackageManager, packageRoot: string, spec: string): string {
  if (manager === 'bun') return `bun add -g ${spec}`;
  return `npm install -g --prefix ${deriveGlobalPrefix(packageRoot)} ${spec}`;
}

export interface UpdateCheckCache {
  lastCheck: number;
  latestVersion: string;
  dismissed?: string;
}

/** Read the cached update-check state from disk. Returns null if the file is missing or corrupt. */
export function readUpdateCache(file: string): UpdateCheckCache | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    /* cache file missing or corrupt */
    return null;
  }
}

/**
 * Persist the latest known version and current timestamp. Preserves an
 * existing `dismissed` marker — the background refresh must not erase a
 * user's "Skip this version" choice, or they get re-prompted for the exact
 * version they dismissed.
 */
export function saveUpdateCheck(file: string, latestVersion: string): void {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const dismissed = readUpdateCache(file)?.dismissed;
    fs.writeFileSync(
      file,
      JSON.stringify({ lastCheck: Date.now(), latestVersion, ...(dismissed ? { dismissed } : {}) }),
    );
  } catch {
    /* best-effort cache update */
  }
}

/** Record that the user chose to skip `version`; suppresses prompts until a newer version appears. */
export function dismissUpdateVersion(file: string, version: string): void {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const existing = readUpdateCache(file);
    fs.writeFileSync(
      file,
      JSON.stringify({
        lastCheck: existing?.lastCheck ?? Date.now(),
        latestVersion: version,
        dismissed: version,
      }),
    );
  } catch {
    /* best-effort */
  }
}

/** Whether the cached state warrants an upgrade prompt for a copy running `currentVersion`. */
export function shouldPromptUpgrade(cache: UpdateCheckCache | null, currentVersion: string): boolean {
  if (!cache?.latestVersion) return false;
  return (
    cache.latestVersion !== currentVersion &&
    compareVersions(cache.latestVersion, currentVersion) > 0 &&
    cache.latestVersion !== cache.dismissed
  );
}

/**
 * Derive the npm global prefix that owns the install at `packageRoot`.
 *
 * npm's global layout for a scoped package:
 *   POSIX:   <prefix>/lib/node_modules/@phnx-labs/agents-cli
 *   Windows: <prefix>/node_modules/@phnx-labs/agents-cli
 *
 * Throws when `packageRoot` is not inside a node_modules tree (e.g. running
 * from a source checkout) — there is no prefix to install into, and guessing
 * one is exactly the bug this module exists to prevent.
 */
export function deriveGlobalPrefix(packageRoot: string): string {
  const resolved = path.resolve(packageRoot);
  // Two levels up from the package root: the scope dir, then node_modules.
  const nodeModulesDir = path.dirname(path.dirname(resolved));
  if (path.basename(nodeModulesDir) !== 'node_modules') {
    throw new Error(
      `${resolved} is not an npm-managed install; reinstall with: npm install -g ${NPM_PACKAGE_NAME}`,
    );
  }
  const parent = path.dirname(nodeModulesDir);
  return path.basename(parent) === 'lib' ? path.dirname(parent) : parent;
}

/**
 * Install `spec` into an explicit global prefix. `--prefix` pins the
 * destination no matter which npm binary PATH resolves. `--ignore-scripts`
 * skips lifecycle scripts; the caller refreshes alias shims afterwards via
 * refreshAliasShims().
 */
export async function installPackageIntoPrefix(spec: string, prefix: string): Promise<void> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  await execFileAsync('npm', ['install', '-g', '--prefix', prefix, spec, '--ignore-scripts']);
}

/**
 * Install `spec` into bun's global store with `bun add -g`. bun writes to
 * `<bunGlobalDir>/node_modules/<pkg>`, which is exactly the running package
 * root for a bun install — so verifyInstalledVersion() sees the new version
 * in place. bun skips untrusted lifecycle scripts, so the caller refreshes
 * alias shims afterwards via refreshAliasShims() rather than relying on the
 * package's postinstall hook.
 */
export async function installPackageWithBun(spec: string): Promise<void> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  await execFileAsync('bun', ['add', '-g', spec]);
}

/** Read the version field of the package.json at `packageRoot`, fresh from disk. */
export function readInstalledVersion(packageRoot: string): string {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8')).version;
}

/**
 * Assert that the install at `packageRoot` now carries `expectedVersion`.
 * npm exiting 0 only proves it wrote *somewhere*; this proves it wrote *here*.
 */
export function verifyInstalledVersion(packageRoot: string, expectedVersion: string): void {
  const actual = readInstalledVersion(packageRoot);
  if (actual !== expectedVersion) {
    const manager = detectPackageManager(packageRoot);
    const hint = manualInstallHint(manager, packageRoot, `${NPM_PACKAGE_NAME}@${expectedVersion}`);
    throw new Error(
      `the package manager reported success but ${packageRoot} is still ${actual} (expected ${expectedVersion}). ` +
        `Run manually: ${hint}`,
    );
  }
}

/**
 * Re-run the freshly installed copy's postinstall in shims-only mode so the
 * bare-command aliases (secrets, sessions, ...) pick up the new entrypoint
 * and any aliases added in the new version. Best-effort: a failure here
 * leaves the previous shims in place, which still point at the (now
 * upgraded) package root.
 */
export function refreshAliasShims(packageRoot: string): void {
  spawnSync(process.execPath, [path.join(packageRoot, 'scripts', 'postinstall.js')], {
    env: { ...process.env, AGENTS_POSTINSTALL_SHIMS_ONLY: '1' },
    stdio: 'ignore',
  });
}

export interface AgentsCliInstall {
  /** The PATH entry (`<dir>/agents`) that resolves to this install. */
  binPath: string;
  /** Package root containing package.json and dist/. */
  packageRoot: string;
  version: string;
}

/**
 * Scan PATH for `agents` entrypoints and resolve each to the agents-cli
 * package root it executes. More than one distinct root means upgrades,
 * shims, and the command the user types can act on different copies — the
 * divergence behind silently-failing self-updates.
 *
 * npm bin entries are symlinks that resolve to `<packageRoot>/dist/index.js`
 * (the dev install's `~/.local/bin/agents` chains through the dev prefix to
 * the same shape). Anything that doesn't resolve to a dist/index.js inside a
 * package named @phnx-labs/agents-cli is some other tool and is skipped.
 * POSIX-only: Windows npm bins are .cmd wrappers, not symlinks.
 */
export function findAgentsCliInstalls(pathEnv: string): AgentsCliInstall[] {
  if (process.platform === 'win32') return [];
  const installs: AgentsCliInstall[] = [];
  const seenRoots = new Set<string>();
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'agents');
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      continue; // missing or dangling symlink
    }
    if (path.basename(real) !== 'index.js' || path.basename(path.dirname(real)) !== 'dist') {
      continue;
    }
    const packageRoot = path.dirname(path.dirname(real));
    if (seenRoots.has(packageRoot)) continue;
    let pkg: { name?: unknown; version?: unknown };
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8'));
    } catch {
      continue;
    }
    if (pkg.name !== NPM_PACKAGE_NAME || typeof pkg.version !== 'string') continue;
    seenRoots.add(packageRoot);
    installs.push({ binPath: candidate, packageRoot, version: pkg.version });
  }
  return installs;
}
