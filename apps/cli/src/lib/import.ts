/**
 * Import existing unmanaged agent installations into agents-cli.
 *
 * Two flavors:
 *
 *  1. Config-only import — moves an agent's config dir (e.g. ~/.openclaw)
 *     into the version structure and symlinks it back. Used by `agents setup`
 *     on first-run when an agent was previously installed via npm/homebrew.
 *
 *  2. Full import — also registers an existing binary install (e.g. a global
 *     `npm i -g openclaw`) under the managed version path so the shim
 *     resolver can find it. This is what `agents import <agent>` does.
 *
 * The binary side never moves files. It creates a thin symlink farm under
 * `~/.agents/.history/versions/<agent>/<version>/` pointing at the original
 * global install, plus a package.json marker so `isVersionInstalled` returns
 * true.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentId } from './types.js';
import { AGENTS } from './agents.js';
import { getVersionsDir } from './state.js';
import { setGlobalDefault } from './versions.js';
import { createShim, createVersionedAlias, ensureShimCurrent, switchHomeFileSymlinks } from './shims.js';

export interface ImportConfigResult {
  success: boolean;
  skipped?: boolean;
  error?: string;
}

export interface ImportBinaryResult {
  success: boolean;
  skipped?: boolean;
  error?: string;
  resolvedFromPath?: string;
}

const IMPORT_VERSION_RE = /^(?:latest|[A-Za-z0-9._+-]{1,64})$/;

export function isValidImportVersion(version: string): boolean {
  return IMPORT_VERSION_RE.test(version);
}

/**
 * Move an agent's config dir into the managed version structure and symlink it
 * back to its original location. Sets the imported version as the global
 * default and refreshes the shim so the user's PATH lookup hits the managed
 * version.
 *
 * No-op (returns skipped=true) if the version's config dir is already created.
 */
export async function importAgentConfig(
  agentId: AgentId,
  version: string
): Promise<ImportConfigResult> {
  if (!isValidImportVersion(version)) {
    return { success: false, error: `Invalid version: ${JSON.stringify(version)}` };
  }

  const agent = AGENTS[agentId];
  const configDir = agent.configDir;
  const versionsDir = getVersionsDir();
  const versionHome = path.join(versionsDir, agentId, version, 'home');
  // Match the shim's derivation in generateShimScript: the per-version config
  // path mirrors the original configDir's path relative to $HOME. Hardcoding
  // `.${agentId}` broke for nested configDirs like Antigravity
  // (`~/.gemini/antigravity-cli`) — the destination would be `.antigravity`,
  // mismatching the shim's expectation of `.gemini/antigravity-cli`.
  const versionConfigDir = path.join(versionHome, path.relative(os.homedir(), configDir));

  if (fs.existsSync(versionConfigDir)) {
    return { success: false, skipped: true, error: `${version} already installed` };
  }

  try {
    fs.mkdirSync(path.dirname(versionConfigDir), { recursive: true });
    fs.renameSync(configDir, versionConfigDir);
    fs.symlinkSync(versionConfigDir, configDir);
    setGlobalDefault(agentId, version);
    switchHomeFileSymlinks(agentId, version);
    ensureShimCurrent(agentId);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Wire an imported version into the rest of the system so it behaves the same
 * as a freshly installed version:
 *
 *   - registered as the global default in agents.yaml (so `agents view`
 *     reports it correctly and resolvers find it),
 *   - main shim refreshed (`~/.agents/.cache/shims/<cli>`),
 *   - versioned alias created (`~/.agents/.cache/shims/<cli>@<version>`),
 *   - home-file symlinks (CLAUDE.md / AGENTS.md / etc.) repointed at this
 *     version's home dir.
 *
 * Without this, the binary-only import path would leave the version stranded:
 * isVersionInstalled returns true, but the resolver never picks it. Safe to
 * call multiple times — each underlying function is idempotent.
 */
export function finalizeImport(agentId: AgentId, version: string): void {
  setGlobalDefault(agentId, version);
  createShim(agentId);
  createVersionedAlias(agentId, version);
  switchHomeFileSymlinks(agentId, version);
  ensureShimCurrent(agentId);
}

/**
 * Agent metadata needed by importAgentBinary. Taking these as explicit
 * inputs (rather than looking up AGENTS internally) decouples the symlink
 * farm from the AGENTS registry, which keeps the function pure and avoids
 * fragile coupling in test setups that stub `lib/agents.ts`.
 */
export interface AgentBinarySpec {
  /** Agent id used in the marker package.json (`agents-{agentId}-{version}`). */
  agentId: string;
  /** npm package name (e.g. `openclaw`) — used as the `node_modules/<name>` dir. */
  npmPackage: string;
  /** Binary name on PATH (e.g. `openclaw`) — used as the `.bin/<name>` entry. */
  cliCommand: string;
}

/**
 * Register an existing global npm package install under the managed version
 * path so the shim resolver finds it.
 *
 * Layout produced (everything is a symlink, nothing is copied):
 *
 *   {versionDir}/
 *     package.json                          # marker so isVersionInstalled() is true
 *     home/                                 # empty isolated $HOME for this version
 *     node_modules/{npmPackage}    -> {globalPath}
 *     node_modules/.bin/{cliCommand} -> {binaryEntry}
 */
export function importAgentBinary(
  spec: AgentBinarySpec,
  version: string,
  globalPath: string,
  versionDir: string
): ImportBinaryResult {
  const binaryLink = path.join(versionDir, 'node_modules', '.bin', spec.cliCommand);

  // lstat — we want to detect the symlink itself, not follow it. fs.existsSync
  // can return false on dangling symlinks, which would incorrectly let us
  // proceed to symlinkSync below and throw EEXIST.
  let alreadyExists = false;
  try {
    fs.lstatSync(binaryLink);
    alreadyExists = true;
  } catch {
    /* not present */
  }
  if (alreadyExists) {
    return { success: false, skipped: true, error: `${version} already installed`, resolvedFromPath: globalPath };
  }

  if (!fs.existsSync(globalPath)) {
    return { success: false, error: `Path does not exist: ${globalPath}` };
  }

  const globalPkgJson = path.join(globalPath, 'package.json');
  if (!fs.existsSync(globalPkgJson)) {
    return { success: false, error: `Not an npm package (no package.json): ${globalPath}` };
  }

  let pkgBinEntry: string | undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(globalPkgJson, 'utf8'));
    if (typeof pkg.bin === 'string') {
      pkgBinEntry = pkg.bin;
    } else if (pkg.bin && typeof pkg.bin === 'object') {
      // Strict: only accept the exact cliCommand key. Multi-bin packages
      // (e.g. @anthropic-ai/claude-code ships several bins) would otherwise
      // silently get a wrong binary chosen by Object.values() ordering.
      pkgBinEntry = pkg.bin[spec.cliCommand];
    }
  } catch (err) {
    return { success: false, error: `Failed to read package.json: ${(err as Error).message}` };
  }

  if (!pkgBinEntry) {
    return { success: false, error: `package.json has no bin entry for "${spec.cliCommand}" — pass --from-path to a package that ships it` };
  }

  const binaryTarget = path.resolve(globalPath, pkgBinEntry);
  if (!fs.existsSync(binaryTarget)) {
    return { success: false, error: `Binary entry missing: ${binaryTarget}` };
  }

  try {
    fs.mkdirSync(path.join(versionDir, 'home'), { recursive: true });
    fs.mkdirSync(path.join(versionDir, 'node_modules', '.bin'), { recursive: true });

    fs.writeFileSync(
      path.join(versionDir, 'package.json'),
      JSON.stringify({ name: `agents-${spec.agentId}-${version}`, version: '1.0.0', private: true, imported: true, from: globalPath }, null, 2)
    );

    const pkgLink = path.join(versionDir, 'node_modules', spec.npmPackage);
    fs.mkdirSync(path.dirname(pkgLink), { recursive: true });
    if (!fs.existsSync(pkgLink)) {
      fs.symlinkSync(globalPath, pkgLink);
    }

    fs.symlinkSync(binaryTarget, binaryLink);

    return { success: true, resolvedFromPath: globalPath };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Register an existing installScript-based binary (Grok, Antigravity, Cursor,
 * etc. — anything with `npmPackage: ''` and a curl/brew installer) under the
 * managed version path. Unlike `importAgentBinary` this skips the npm
 * package.json walk and just symlinks the resolved PATH binary directly into
 * `{versionDir}/node_modules/.bin/{cliCommand}`. The symlink is what makes
 * `listInstalledVersions` consider the version Managed.
 *
 * Layout produced:
 *
 *   {versionDir}/
 *     package.json                              # marker (private, imported, from)
 *     home/                                     # empty isolated $HOME
 *     node_modules/.bin/{cliCommand} -> {binaryPath}
 *
 * For agents whose binary lookup is special-cased elsewhere (e.g. Grok's
 * `~/.grok/downloads/`), the symlink is still created — `getBinaryPath` won't
 * read it for those agents, but it documents provenance and lets a future
 * refactor consolidate the binary-resolution registry.
 */
export function importInstallScriptBinary(
  spec: AgentBinarySpec,
  version: string,
  binaryPath: string,
  versionDir: string
): ImportBinaryResult {
  const binaryLink = path.join(versionDir, 'node_modules', '.bin', spec.cliCommand);

  let alreadyExists = false;
  try {
    fs.lstatSync(binaryLink);
    alreadyExists = true;
  } catch {
    /* not present */
  }
  if (alreadyExists) {
    return { success: false, skipped: true, error: `${version} already installed`, resolvedFromPath: binaryPath };
  }

  if (!fs.existsSync(binaryPath)) {
    return { success: false, error: `Binary does not exist: ${binaryPath}` };
  }

  try {
    fs.mkdirSync(path.join(versionDir, 'home'), { recursive: true });
    fs.mkdirSync(path.join(versionDir, 'node_modules', '.bin'), { recursive: true });

    fs.writeFileSync(
      path.join(versionDir, 'package.json'),
      JSON.stringify(
        { name: `agents-${spec.agentId}-${version}`, version: '1.0.0', private: true, imported: true, from: binaryPath, installScriptBased: true },
        null,
        2
      )
    );

    fs.symlinkSync(binaryPath, binaryLink);

    return { success: true, resolvedFromPath: binaryPath };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Resolve the on-disk npm package directory for an agent's CLI binary by
 * walking up from the binary, following any symlinks. Returns null if the
 * package can't be identified.
 *
 * Handles the homebrew/global-npm pattern where:
 *   /opt/homebrew/bin/{cli}  ->  ../lib/node_modules/{pkg}/dist/index.js
 */
export function resolvePackageDirFromBinary(binaryPath: string): string | null {
  try {
    let real = fs.realpathSync(binaryPath);
    let dir = path.dirname(real);

    // Walk up looking for the nearest package.json
    for (let i = 0; i < 6; i++) {
      const pkg = path.join(dir, 'package.json');
      if (fs.existsSync(pkg)) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}
