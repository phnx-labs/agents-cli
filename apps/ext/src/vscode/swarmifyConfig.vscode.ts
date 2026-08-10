// VS Code integration for .agents config

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  AGENTS_CONFIG_FILENAME,
  AgentsConfig,
  getDefaultConfig,
  parseAgentsConfig,
  parseAgentsConfigOverrides,
  mergeAgentsConfig,
  serializeAgentsConfig,
} from '../core/swarmifyConfig';

// Cache for loaded configs per workspace
const configCache = new Map<string, AgentsConfig>();

export function getConfigPath(workspaceFolder: vscode.WorkspaceFolder): string {
  return path.join(workspaceFolder.uri.fsPath, AGENTS_CONFIG_FILENAME);
}

export function getUserConfigPath(): string {
  return path.join(os.homedir(), AGENTS_CONFIG_FILENAME);
}

export function configExists(workspaceFolder: vscode.WorkspaceFolder): boolean {
  const configPath = getConfigPath(workspaceFolder);
  try {
    fs.accessSync(configPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function userConfigExists(): boolean {
  const configPath = getUserConfigPath();
  try {
    fs.accessSync(configPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function hasEffectiveConfig(workspaceFolder: vscode.WorkspaceFolder): boolean {
  return configExists(workspaceFolder) || userConfigExists();
}

export function loadUserConfig(): AgentsConfig {
  const configPath = getUserConfigPath();
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    return parseAgentsConfig(content);
  } catch {
    return getDefaultConfig();
  }
}

export async function loadWorkspaceConfig(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<AgentsConfig> {
  const cacheKey = workspaceFolder.uri.toString();

  // Check cache first
  const cached = configCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const userConfig = loadUserConfig();
  const configPath = getConfigPath(workspaceFolder);

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const overrides = parseAgentsConfigOverrides(content);
    const config = overrides
      ? mergeAgentsConfig(userConfig, overrides, { contextMerge: 'union' })
      : userConfig;
    configCache.set(cacheKey, config);
    return config;
  } catch {
    // File doesn't exist or is unreadable, return user config
    configCache.set(cacheKey, userConfig);
    return userConfig;
  }
}

export async function saveWorkspaceConfig(
  workspaceFolder: vscode.WorkspaceFolder,
  config: AgentsConfig
): Promise<void> {
  const configPath = getConfigPath(workspaceFolder);
  const content = serializeAgentsConfig(config);
  fs.writeFileSync(configPath, content, 'utf-8');

  // Update cache
  const cacheKey = workspaceFolder.uri.toString();
  configCache.set(cacheKey, config);
}

export function clearConfigCache(workspaceFolder?: vscode.WorkspaceFolder): void {
  if (workspaceFolder) {
    configCache.delete(workspaceFolder.uri.toString());
  } else {
    configCache.clear();
  }
}

// Trailing debounce for the .agents watcher. A single tool rewriting a config
// file can emit a burst of create/change/delete events; without coalescing each
// one fans out into a findFiles/symlink pass per workspace folder x mapping.
const CONFIG_WATCH_DEBOUNCE_MS = 500;

// A trailing-edge scheduler that coalesces rapid calls per key into a single
// invocation after `delayMs` of quiet. Exported for unit testing.
export function createCoalescingScheduler<T>(
  delayMs: number,
  fn: (value: T) => void
): { schedule: (key: string, value: T) => void; dispose: () => void } {
  const pending = new Map<string, NodeJS.Timeout>();

  const schedule = (key: string, value: T): void => {
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        fn(value);
      }, delayMs)
    );
  };

  const dispose = (): void => {
    for (const timer of pending.values()) {
      clearTimeout(timer);
    }
    pending.clear();
  };

  return { schedule, dispose };
}

export function watchConfigFile(
  context: vscode.ExtensionContext,
  onConfigChange: (workspaceFolder: vscode.WorkspaceFolder) => void
): void {
  // Watch for .agents file changes in all workspace folders
  const watcher = vscode.workspace.createFileSystemWatcher(
    `**/${AGENTS_CONFIG_FILENAME}`,
    false, // create
    false, // change
    false // delete
  );

  const scheduler = createCoalescingScheduler<vscode.WorkspaceFolder>(
    CONFIG_WATCH_DEBOUNCE_MS,
    onConfigChange
  );

  // The cache is cleared eagerly on every event so a subsequent read sees fresh
  // data; only the (expensive) onConfigChange fan-out is debounced.
  const handleEvent = (uri: vscode.Uri): void => {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder) {
      clearConfigCache(workspaceFolder);
      scheduler.schedule(workspaceFolder.uri.toString(), workspaceFolder);
    }
  };

  watcher.onDidChange(handleEvent);
  watcher.onDidCreate(handleEvent);
  watcher.onDidDelete(handleEvent);

  context.subscriptions.push(watcher);
  context.subscriptions.push({ dispose: () => scheduler.dispose() });
}

// How often to poll for the user config file when it doesn't exist yet.
// Cheap O(1) existsSync; only runs until the file appears and the real
// file watcher takes over.
const CONFIG_POLL_MS = 5000;

export function watchUserConfig(
  context: vscode.ExtensionContext,
  onConfigChange: () => void
): void {
  const configPath = path.join(os.homedir(), AGENTS_CONFIG_FILENAME);

  let fileWatcher: fs.FSWatcher | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let disposed = false;

  // Watch the specific .agents file, never the home directory. fs.watch on
  // $HOME fires for every file change anywhere under it (downloads,
  // screenshots, Spotlight) — a huge FSEvents firehose — so we avoid it.
  const attachFileWatcher = (): boolean => {
    try {
      fileWatcher = fs.watch(configPath, () => {
        clearConfigCache();
        onConfigChange();
      });
      return true;
    } catch {
      return false;
    }
  };

  // If the file doesn't exist yet, fs.watch on it throws. Instead of falling
  // back to watching $HOME, poll cheaply for its creation, then attach the
  // real file watcher and stop polling.
  if (!attachFileWatcher()) {
    pollTimer = setInterval(() => {
      if (disposed) return;
      if (fs.existsSync(configPath) && attachFileWatcher()) {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        clearConfigCache();
        onConfigChange();
      }
    }, CONFIG_POLL_MS);
  }

  context.subscriptions.push({
    dispose: () => {
      disposed = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (fileWatcher) {
        fileWatcher.close();
        fileWatcher = null;
      }
    },
  });
}

export async function initWorkspaceConfig(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<AgentsConfig | null> {
  const configPath = getConfigPath(workspaceFolder);

  // Check if config already exists
  if (configExists(workspaceFolder)) {
    // Load and return existing config
    const config = await loadWorkspaceConfig(workspaceFolder);

    // Open file in editor
    const doc = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(doc);

    return config;
  }

  // Create new config with defaults
  const config = getDefaultConfig();
  await saveWorkspaceConfig(workspaceFolder, config);

  // Open file in editor
  const doc = await vscode.workspace.openTextDocument(configPath);
  await vscode.window.showTextDocument(doc);

  return config;
}

export function getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  // Try to get workspace folder from active editor
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) {
      return folder;
    }
  }

  // Fall back to first workspace folder
  return vscode.workspace.workspaceFolders?.[0];
}
