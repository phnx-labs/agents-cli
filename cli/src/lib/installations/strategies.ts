import * as crypto from 'crypto';
import { promisify } from 'util';
import { exec, execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AGENTS, findInPath, isSelfUpdatingAgent } from '../agents.js';
import { VERSION_RE } from '../agent-spec/primitives.js';
import { importInstallScriptBinary } from '../import.js';
import {
  getBinaryPath,
  getLatestNpmVersion,
  getOldestNpmVersion,
  getLiveVersion,
  getVersionHomePath,
  invalidateLiveVersionCache,
  isGlobalBinaryAgent,
} from './versions.js';
import type { AgentId } from '../types.js';
import { installationDir } from './store.js';
import type { Installation, UpdateStrategyId } from './types.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/** npm install timeout, matching the install path's own installer budget. */
const INSTALL_TIMEOUT_MS = 120_000;

export interface UpdateContext {
  agent: AgentId;
  installation: Installation;
  /** What the user asked for: `latest`, `oldest`, or a concrete release. */
  requested: string;
  onProgress?: (message: string) => void;
}

/** A release fetched but not yet live. */
export interface StagedRelease {
  release: string;
  /** Extensionless launch target to probe. Windows appends `.cmd` (see verifyBinaryLaunches). */
  binary: string;
  /** HOME the probe runs under — always the installation's own home. */
  home: string;
  /** Scratch dir to delete once the run finishes, or null when nothing was staged. */
  stagingDir: string | null;
}

/** Undo/finish handles returned by a commit, so update.ts owns the transaction. */
export interface CommitHandles {
  /** Put the previous release back. Must be safe to call once, immediately after commit. */
  undo: () => void;
  /** Discard the undo material. Called only once the update is durable. */
  finalize: () => void;
}

/**
 * How one class of harness replaces the release inside a frozen installation.
 *
 * Chosen from the registry's declared capabilities — never from an agent id — so
 * a harness added to `AGENTS` is covered the day it lands. See
 * {@link selectUpdateStrategy}.
 */
export interface UpdateStrategy {
  readonly id: UpdateStrategyId;
  /**
   * True only when `undo` can restore the PREVIOUS RELEASE in full — i.e. the
   * vendor artifact lives inside this installation's own directory and was
   * fetched without mutating anything global.
   *
   * It is not a switch for whether the orchestrator rolls back: `undo` always
   * runs on a post-commit failure, because every strategy that displaces
   * something must put it back. What this flag changes is what the user is
   * told, since for an installer-driven harness the global binary the vendor
   * replaced is not ours to restore.
   */
  readonly transactional: boolean;
  /** True when several installations of this agent share one binary on disk. */
  readonly sharedBinary: boolean;
  /** Turn `requested` into the concrete release this run will install. */
  resolveTarget(ctx: UpdateContext): Promise<string>;
  /** Fetch the target release into a place that is not yet live. */
  stage(ctx: UpdateContext, target: string): Promise<StagedRelease>;
  /** Make the staged release the live one. */
  commit(ctx: UpdateContext, staged: StagedRelease): Promise<CommitHandles>;
}

function runId(): string {
  return `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}

function moveDir(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    // Windows refuses a rename while any file in the tree is open, and a
    // cross-device staging dir cannot be renamed at all. Copy+remove is the same
    // observable move; it is slower, so it is the fallback, not the default.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Entries a swap replaces: everything npm owns inside a version dir. The lockfile
 * is included deliberately — leaving the previous release's `package-lock.json`
 * beside the new `node_modules` would make the directory describe a release it no
 * longer contains, and the next repair reinstall would resolve from that stale lock.
 * Entries absent on either side are skipped, so a dir without a lockfile is fine.
 */
const NPM_LIVE_ENTRIES = ['node_modules', 'package.json', 'package-lock.json'] as const;

/**
 * npm-packaged harnesses (claude, codex, kimi, opencode, …). The only fully
 * transactional class: a pinned release can be fetched into a sibling directory,
 * probed there, and swapped in, with the displaced tree kept until the swap is
 * proven — so a failed update leaves the previous release running.
 */
const npmPackageStrategy: UpdateStrategy = {
  id: 'npm-package',
  transactional: true,
  sharedBinary: false,

  async resolveTarget(ctx) {
    if (ctx.requested === 'latest' || ctx.requested === 'oldest') {
      const resolved = ctx.requested === 'latest'
        ? await getLatestNpmVersion(ctx.agent)
        : await getOldestNpmVersion(ctx.agent);
      if (!resolved) {
        throw new Error(
          `Could not resolve the ${ctx.requested} published version for ${AGENTS[ctx.agent].name} from npm.`
        );
      }
      return resolved;
    }
    return ctx.requested;
  },

  async stage(ctx, target) {
    const pkg = AGENTS[ctx.agent].npmPackage;
    const dir = installationDir(ctx.agent, ctx.installation.label);
    const stagingDir = path.join(dir, `.staging-${runId()}`);
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(
      path.join(stagingDir, 'package.json'),
      JSON.stringify({ name: `agents-${ctx.agent}-${target}`, version: '1.0.0', private: true }, null, 2)
    );

    const winShell = process.platform === 'win32';
    ctx.onProgress?.(`Staging ${pkg}@${target}...`);
    // `--ignore-scripts` for the dependency tree; the first-party package's own
    // postinstall is re-run below, exactly as the install path does — several
    // harnesses ship their native binary via that script and are unlaunchable
    // without it.
    await execFileAsync('npm', ['install', `${pkg}@${target}`, '--ignore-scripts'], {
      cwd: stagingDir,
      shell: winShell,
      timeout: INSTALL_TIMEOUT_MS,
    });

    const pkgRoot = path.join(stagingDir, 'node_modules', pkg);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8'));
      const postinstall = manifest?.scripts?.postinstall;
      if (typeof postinstall === 'string' && postinstall.trim()) {
        ctx.onProgress?.(`Running ${AGENTS[ctx.agent].name} postinstall...`);
        await execFileAsync(postinstall, [], { cwd: pkgRoot, shell: true, timeout: INSTALL_TIMEOUT_MS });
      }
    } catch {
      /* non-fatal: the launch probe in update.ts is the real gate */
    }

    return {
      release: target,
      binary: path.join(stagingDir, 'node_modules', '.bin', AGENTS[ctx.agent].cliCommand),
      home: getVersionHomePath(ctx.agent, ctx.installation.label),
      stagingDir,
    };
  },

  async commit(ctx, staged) {
    const dir = installationDir(ctx.agent, ctx.installation.label);
    const rollbackDir = path.join(dir, `.rollback-${runId()}`);
    const displaced: string[] = [];

    // Move the live tree aside first, then move the staged tree in. Doing it in
    // this order means the failure window contains no half-merged tree: either
    // the old entries are all aside (undo restores them) or the new ones are all
    // in place.
    for (const entry of NPM_LIVE_ENTRIES) {
      const live = path.join(dir, entry);
      if (!fs.existsSync(live)) continue;
      moveDir(live, path.join(rollbackDir, entry));
      displaced.push(entry);
    }
    for (const entry of NPM_LIVE_ENTRIES) {
      const from = path.join(staged.stagingDir!, entry);
      if (fs.existsSync(from)) moveDir(from, path.join(dir, entry));
    }

    return {
      undo: () => {
        for (const entry of NPM_LIVE_ENTRIES) {
          fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
        }
        for (const entry of displaced) {
          moveDir(path.join(rollbackDir, entry), path.join(dir, entry));
        }
        fs.rmSync(rollbackDir, { recursive: true, force: true });
      },
      finalize: () => fs.rmSync(rollbackDir, { recursive: true, force: true }),
    };
  },
};

/**
 * Harnesses that are ONE global self-updating binary (droid, muse, warp): every
 * installation of the agent points at the same file, so there is nothing
 * per-installation to stage or swap, and updating one necessarily updates all.
 * The honest model is therefore: run the official installer, probe the live
 * binary, and record the new release on every installation that shares it.
 */
const globalBinaryStrategy: UpdateStrategy = {
  id: 'global-binary',
  transactional: false,
  sharedBinary: true,

  async resolveTarget(ctx) {
    // The installer for these carries no version token, so a requested release
    // cannot be honoured. Fail loud rather than install something else and
    // report it as the pin the user asked for.
    if (ctx.requested !== 'latest') {
      throw new Error(
        `${AGENTS[ctx.agent].name} is a single self-updating binary with no pinnable releases — `
        + `it can only be updated to the current one. Re-run: agents update ${ctx.agent}@${ctx.installation.label} --to latest`
      );
    }
    // Resolved after the installer runs — `latest` here is whatever it fetches.
    return 'latest';
  },

  async stage(ctx) {
    const script = AGENTS[ctx.agent].installScript!;
    ctx.onProgress?.(`Updating ${AGENTS[ctx.agent].name} via official installer...`);
    await execAsync(script, { timeout: INSTALL_TIMEOUT_MS });
    invalidateLiveVersionCache(ctx.agent);
    const live = await getLiveVersion(ctx.agent);
    if (!live) {
      throw new Error(
        `${AGENTS[ctx.agent].name} installer finished but its version could not be determined.`
      );
    }
    return {
      release: live,
      binary: getBinaryPath(ctx.agent, ctx.installation.label),
      home: getVersionHomePath(ctx.agent, ctx.installation.label),
      stagingDir: null,
    };
  },

  async commit() {
    // The installer already replaced the shared binary; there is no per-install
    // swap to perform and no previous copy to restore.
    return { undo: () => {}, finalize: () => {} };
  },
};

/**
 * Harnesses installed by an official script that keeps a per-installation copy
 * or symlink farm (grok, cursor, antigravity, hermes, kiro, goose, …). The
 * vendor artifact lands in a global location the installer owns, so the fetch
 * itself is not reversible; what IS per-installation — the version dir's binary
 * link farm — is staged and swapped so a failed re-import cannot strand the
 * installation without a launch target.
 */
const installScriptStrategy: UpdateStrategy = {
  id: 'install-script',
  transactional: false,
  sharedBinary: false,

  async resolveTarget(ctx) {
    const script = AGENTS[ctx.agent].installScript!;
    if (!script.includes('VERSION') && ctx.requested !== 'latest') {
      throw new Error(
        `${AGENTS[ctx.agent].name}'s installer takes no version, so it can only be updated to the current release. `
        + `Re-run: agents update ${ctx.agent}@${ctx.installation.label} --to latest`
      );
    }
    return ctx.requested;
  },

  async stage(ctx, target) {
    const config = AGENTS[ctx.agent];
    const script = config.installScript!.replaceAll('VERSION', target === 'latest' ? 'latest' : target);
    ctx.onProgress?.(`Updating ${config.name} via official installer...`);
    await execAsync(script, { timeout: INSTALL_TIMEOUT_MS });
    invalidateLiveVersionCache(ctx.agent);

    // findInPath skips our own shims dir, so this is the genuine vendor binary
    // and never our dispatcher (which would produce a self-execing link farm).
    const installed = findInPath(config.cliCommand);
    if (!installed) {
      throw new Error(
        `${config.name} installer finished but ${config.cliCommand} is not on PATH — the install did not complete.`
      );
    }
    // On Windows there is no `.cmd` wrapper beside an imported install-script
    // binary, so the staged launch probe cannot run and reports healthy. The
    // gate is therefore weaker here than on POSIX; the unconditional undo in
    // update.ts is what keeps a bad swap recoverable.

    const release = target === 'latest'
      ? (await getLiveVersion(ctx.agent)) ?? target
      : target;

    const dir = installationDir(ctx.agent, ctx.installation.label);
    const stagingDir = path.join(dir, `.staging-${runId()}`);
    fs.mkdirSync(stagingDir, { recursive: true });
    const imported = importInstallScriptBinary(
      { agentId: ctx.agent, npmPackage: config.npmPackage, cliCommand: config.cliCommand },
      ctx.installation.label,
      installed,
      stagingDir
    );
    if (!imported.success) {
      // Swallowing this reported the launch probe's generic "binary not found"
      // instead of the real reason the import failed.
      throw new Error(
        `${config.name} ${release} was installed but could not be linked into the version directory: ${imported.error ?? 'unknown error'}`
      );
    }

    return {
      release,
      binary: path.join(stagingDir, 'node_modules', '.bin', config.cliCommand),
      home: getVersionHomePath(ctx.agent, ctx.installation.label),
      stagingDir,
    };
  },

  commit: npmPackageStrategy.commit,
};

/**
 * Pick the update strategy for an agent from the registry's declared shape.
 *
 * The ordering mirrors `installVersion`: an npm package wins whenever one is
 * declared (kimi declares both a package and a script, and its package is what
 * `agents add` installs), then a single shared global binary, then a per-install
 * script. Anything else is an integration boundary we do not handle — it throws
 * rather than silently no-opping and reporting success.
 */
export function selectUpdateStrategy(agent: AgentId): UpdateStrategy {
  const config = AGENTS[agent];
  if (config.npmPackage) return npmPackageStrategy;
  if (config.installScript && isGlobalBinaryAgent(agent)) return globalBinaryStrategy;
  if (config.installScript) {
    if (!usesVersionDirLinkFarm(agent)) {
      // The install path resolves this harness's binary somewhere the version
      // dir's link farm does not describe (grok keeps a real per-release copy
      // under its version home). Staging and swapping the link farm would leave
      // the launch target untouched, so the update would record a release that
      // is not actually installed. Refuse instead of reporting a false success.
      throw new Error(
        `${config.name} keeps its binary outside the managed version directory, so agents-cli cannot yet update an `
        + `installation in place. Install the current release as a new installation: agents add ${agent}@latest`
      );
    }
    return installScriptStrategy;
  }
  throw new Error(
    `${config.name} is not installed by agents-cli (it declares no npm package and no installer), so there is nothing to update. `
    + `Update it with its own tooling.`
  );
}

/**
 * Does this harness's launch target live in the version dir's own
 * `node_modules/.bin` link farm — the thing an installation can stage and swap?
 *
 * Probed through `getBinaryPath`, the single resolver the shims and `agents run`
 * use, rather than tested against an agent id, so a harness that resolves its
 * binary elsewhere is recognised without being enumerated here.
 */
function usesVersionDirLinkFarm(agent: AgentId): boolean {
  const probe = '0.0.0-probe';
  const expected = path.join(installationDir(agent, probe), 'node_modules', '.bin', AGENTS[agent].cliCommand);
  return getBinaryPath(agent, probe) === expected;
}

/**
 * Whether a concrete release can be requested for this agent at all. False for
 * every self-updating harness — their installers carry no version token.
 */
export function supportsPinnedUpdate(agent: AgentId): boolean {
  const config = AGENTS[agent];
  if (config.npmPackage) return true;
  return !isSelfUpdatingAgent(agent);
}

/** Guard a user-supplied release token before it reaches a path or a package spec. */
export function assertValidRelease(requested: string): void {
  if (!VERSION_RE.test(requested)) {
    throw new Error(`Invalid release: ${JSON.stringify(requested)}`);
  }
}
