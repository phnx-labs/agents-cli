// VS Code-dependent symlink creation for context files

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getSymlinkTargetsForFileName,
  getMissingTargets,
  getContextMappings,
  isSymlinkingEnabled,
} from '../core/agentlinks';
import { AgentsConfig } from '../core/swarmifyConfig';
import { loadWorkspaceConfig, hasEffectiveConfig } from './swarmifyConfig.vscode';

const PROMPT_ACTION_CREATE = 'Create symlinks';
const PROMPT_ACTION_NOT_NOW = 'Not now';

// Existence cache per workspace, invalidated when the mapping set changes (#98).
// re-check only happens when the resolved mapping set differs from last time.
const existenceCache = new Map<string, { signature: string; paths: Map<string, boolean> }>();

// The last mapping-set signature fully processed per workspace. When unchanged,
// the whole glob + symlink pass is skipped (#98, #99).
const lastProcessedSignature = new Map<string, string>();

// In-flight pass per workspace. ensureSymlinksOnWorkspaceOpen is fired from
// several sites at once (activation loop + the .agents and user-config
// watchers). Without this, two concurrent calls both clear the signature guard
// before either sets it, run the full pass twice against a shared existence
// cache, and the loser's symlink() races to EEXIST. Registering the promise
// synchronously on entry collapses concurrent calls onto one pass.
const inFlightEnsure = new Map<string, Promise<void>>();

function mappingSignature(config: AgentsConfig): string {
  return JSON.stringify(
    getContextMappings(config).map(m => [m.source, [...m.aliases].sort()])
  );
}

function getExistenceCache(workspaceKey: string, signature: string): Map<string, boolean> {
  const entry = existenceCache.get(workspaceKey);
  if (entry && entry.signature === signature) {
    return entry.paths;
  }
  const paths = new Map<string, boolean>();
  existenceCache.set(workspaceKey, { signature, paths });
  return paths;
}

async function pathExists(filePath: string, cache?: Map<string, boolean>): Promise<boolean> {
  const cached = cache?.get(filePath);
  if (cached !== undefined) {
    return cached;
  }
  let exists: boolean;
  try {
    await fs.promises.lstat(filePath);
    exists = true;
  } catch {
    exists = false;
  }
  cache?.set(filePath, exists);
  return exists;
}

// Legacy function for backward compatibility - used when no .agents config exists
export async function maybePromptForAgentSymlinks(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument
): Promise<void> {
  const fileName = path.basename(document.uri.fsPath);
  const targets = getSymlinkTargetsForFileName(fileName);
  if (targets.length === 0) return;

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) return;

  // If any config exists, use config-driven symlinks instead
  if (hasEffectiveConfig(workspaceFolder)) {
    return;
  }

  const folderPath = workspaceFolder.uri.fsPath;
  const existingTargets: string[] = [];
  for (const target of targets) {
    const targetPath = path.join(folderPath, target);
    if (await pathExists(targetPath)) {
      existingTargets.push(target);
    }
  }

  const missingTargets = getMissingTargets(targets, existingTargets);
  if (missingTargets.length === 0) return;

  const stateKey = `agents.symlinkPrompted:${workspaceFolder.uri.toString()}:${document.uri.fsPath}`;
  if (context.workspaceState.get<boolean>(stateKey, false)) return;

  const message = `Link ${missingTargets.join(', ')} to ${fileName}?`;
  const selection = await vscode.window.showInformationMessage(
    message,
    { modal: false },
    PROMPT_ACTION_CREATE,
    PROMPT_ACTION_NOT_NOW
  );

  await context.workspaceState.update(stateKey, true);

  if (selection !== PROMPT_ACTION_CREATE) return;

  const sourcePath = document.uri.fsPath;
  const errors: string[] = [];

  for (const target of missingTargets) {
    const targetPath = path.join(folderPath, target);
    if (await pathExists(targetPath)) {
      continue;
    }

    try {
      const relativeSource = path.relative(path.dirname(targetPath), sourcePath);
      await fs.promises.symlink(relativeSource, targetPath, 'file');
    } catch (err) {
      const error = err as Error;
      errors.push(`${target}: ${error.message}`);
    }
  }

  if (errors.length > 0) {
    vscode.window.showErrorMessage(
      `Failed to create symlinks. ${errors.join(' | ')}`
    );
    return;
  }

  vscode.window.showInformationMessage('Symlinks created.');
}

// Create symlink at a specific path
async function createSymlink(
  sourcePath: string,
  targetPath: string,
  cache?: Map<string, boolean>
): Promise<string | null> {
  if (await pathExists(targetPath, cache)) {
    return null; // Target exists, skip (safety: don't overwrite)
  }

  try {
    const relativeSource = path.relative(path.dirname(targetPath), sourcePath);
    await fs.promises.symlink(relativeSource, targetPath, 'file');
    cache?.set(targetPath, true);
    return null;
  } catch (err) {
    const error = err as Error;
    return error.message;
  }
}

// In-flight guard + short TTL cache for findFiles. Each findFiles spawns VS
// Code's bundled ripgrep; without this, concurrent or rapid-fire passes (one per
// workspace folder x mapping, fired by the .agents watcher) stack ripgrep
// processes for the same glob. Storing the promise dedupes in-flight calls; the
// TTL lets a burst of passes within the same window reuse one result.
const FIND_FILES_TTL_MS = 1000;
const findFilesCache = new Map<string, { at: number; result: Promise<string[]> }>();

// Dirs the AGENTS.md-mirror walk must never descend into: dependency/build
// caches (Go module cache is read-only -> EACCES), VCS internals, build output,
// vendored deps, and nested agent worktrees (each a full repo copy). Without
// these, a large monorepo workspace produced thousands of stray symlinks and a
// wall of EACCES errors on every workspace open.
const EXCLUDE_GLOB = '{**/node_modules/**,**/.git/**,**/.gocache/**,**/.agents/worktrees/**,**/dist/**,**/out/**,**/build/**,**/vendor/**,**/target/**,**/.venv/**,**/.next/**}';

// Find all source files recursively in a directory
async function findSourceFilesRecursively(
  rootPath: string,
  sourceFileName: string
): Promise<string[]> {
  const key = JSON.stringify([rootPath, sourceFileName]);
  const cached = findFilesCache.get(key);
  if (cached && Date.now() - cached.at < FIND_FILES_TTL_MS) {
    return cached.result;
  }

  const pattern = new vscode.RelativePattern(rootPath, `**/${sourceFileName}`);
  // Exclude dependency caches, VCS internals, build output, and nested agent
  // worktrees. Globbing only `node_modules` let the walk descend into the Go
  // module cache (`.gocache/mod`, read-only -> EACCES on symlink) and every
  // `.agents/worktrees/*`, creating thousands of stray symlinks and error spam.
  // We only want to mirror AGENTS.md next to real source, not vendored deps.
  const result = Promise.resolve(
    vscode.workspace.findFiles(pattern, EXCLUDE_GLOB)
  ).then(files => files.map(f => f.fsPath));
  // Don't let a rejected glob stick in the cache for the whole TTL; drop it so
  // the next caller retries instead of inheriting the failure.
  result.catch(() => {
    if (findFilesCache.get(key)?.result === result) {
      findFilesCache.delete(key);
    }
  });
  findFilesCache.set(key, { at: Date.now(), result });
  return result;
}

// Create symlinks for a single source file in its directory
export async function createSymlinksInDirectory(
  sourcePath: string,
  aliases: string[],
  cache?: Map<string, boolean>
): Promise<{ created: number; errors: string[] }> {
  const dirPath = path.dirname(sourcePath);
  const errors: string[] = [];
  let created = 0;

  for (const target of aliases) {
    const targetPath = path.join(dirPath, target);
    const error = await createSymlink(sourcePath, targetPath, cache);
    if (error) {
      errors.push(`${targetPath}: ${error}`);
    } else if (!(await pathExists(targetPath, cache))) {
      // Symlink was not created because target already existed
    } else {
      created++;
    }
  }

  return { created, errors };
}

// Create symlinks codebase-wide using config
export async function createSymlinksCodebaseWide(
  workspaceFolder: vscode.WorkspaceFolder,
  config: AgentsConfig,
  existsCache?: Map<string, boolean>
): Promise<{ created: number; errors: string[] }> {
  if (!isSymlinkingEnabled(config)) {
    return { created: 0, errors: [] };
  }

  let totalCreated = 0;
  const allErrors: string[] = [];

  // Process each context mapping (source -> aliases)
  for (const mapping of getContextMappings(config)) {
    const sourceFiles = await findSourceFilesRecursively(
      workspaceFolder.uri.fsPath,
      mapping.source
    );

    for (const sourcePath of sourceFiles) {
      const { created, errors } = await createSymlinksInDirectory(sourcePath, mapping.aliases, existsCache);
      totalCreated += created;
      allErrors.push(...errors);
    }
  }

  return { created: totalCreated, errors: allErrors };
}

// Ensure symlinks exist on workspace open (silent, no prompts)
export async function ensureSymlinksOnWorkspaceOpen(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<void> {
  const workspaceKey = workspaceFolder.uri.toString();

  // Coalesce concurrent calls for the same workspace onto a single pass. The
  // promise is registered synchronously below, before any await yields, so a
  // second caller that arrives while the first is awaiting findFiles/config
  // sees it here and reuses it instead of racing a duplicate pass.
  const existing = inFlightEnsure.get(workspaceKey);
  if (existing) {
    return existing;
  }

  const run = ensureSymlinksOnWorkspaceOpenInner(workspaceFolder, workspaceKey);
  inFlightEnsure.set(workspaceKey, run);
  try {
    await run;
  } finally {
    inFlightEnsure.delete(workspaceKey);
  }
}

async function ensureSymlinksOnWorkspaceOpenInner(
  workspaceFolder: vscode.WorkspaceFolder,
  workspaceKey: string
): Promise<void> {
  if (!hasEffectiveConfig(workspaceFolder)) {
    return;
  }

  const config = await loadWorkspaceConfig(workspaceFolder);
  if (!isSymlinkingEnabled(config)) {
    return;
  }

  const signature = mappingSignature(config);

  // Skip the entire glob + symlink pass when the mapping set is unchanged since
  // the last run for this workspace. This is what keeps a burst of .agents
  // events from re-globbing the codebase (#99) and re-lstat-ing every alias (#98).
  if (lastProcessedSignature.get(workspaceKey) === signature) {
    return;
  }

  const existsCache = getExistenceCache(workspaceKey, signature);
  const { created, errors } = await createSymlinksCodebaseWide(workspaceFolder, config, existsCache);
  lastProcessedSignature.set(workspaceKey, signature);

  // Silent operation - only show errors if any
  if (errors.length > 0) {
    console.error('[agents] Symlink errors:', errors);
  }

  if (created > 0) {
    console.log(`[agents] Created ${created} symlink(s) in workspace`);
  }
}
