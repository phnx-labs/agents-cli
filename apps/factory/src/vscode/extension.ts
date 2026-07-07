import * as vscode from 'vscode';
import { BUILT_IN_AGENTS, getBuiltInByKey, getBuiltInDefByTitle, getBuiltInByPrefix, pickLatestVersion, STRATEGY_LAUNCH_AGENTS, modeFlagForAgent, AgentLaunchMode } from '../core/agents';
import { parseSpawnRequest, SpawnRequest } from '../core/spawn';
import {
  AgentConfig,
  buildIconPath,
  createAgentConfig,
  getBuiltInByTitle
} from './agents.vscode';
import * as claudemd from './claudemd.vscode';
import { AgentsMarkdownEditorProvider, swarmCurrentDocument } from './customEditor';
import * as git from './git.vscode';
import { AgentSettings, hasLoginEnabled, PromptEntry, QUICK_LAUNCH_SLOT_KEYS, getQuickLaunchSlot, QuickLaunchSlot } from '../core/settings';
import * as settings from './settings.vscode';
import * as swarm from './swarm.vscode';
import {
  startWatchdog,
  setWatchdogMonitorConnectivity,
  setWatchdogArmSink,
  ingestWatchdogStallFact,
  ingestWatchdogVersionsFact,
} from './watchdog.vscode';
import { startWatchdogBridge } from '../mcp/watchdog-bridge';
import { ensureWatchdogMcpInstalled } from '../mcp/watchdogInstall';
import * as notifications from './notifications.vscode';
import * as terminals from './terminals.vscode';
import * as sessionTracker from './sessionTracker';
import { runRecapHeadless, isRecapSupported } from './recap.vscode';
import { buildAgentTerminalEnv } from '../core/terminals';
import {
  AgentsViewJsonAgent,
  AgentsViewJsonVersion,
  pickBestVersion,
  sessionUsedPercent,
  buildLaunchCommand,
  buildResumeInput,
  isVersionStillUsable,
} from '../core/resumeInBest';
import * as os from 'os';
import * as fsSync from 'fs';
import { randomUUID } from 'crypto';
import * as workbench from './workbench.vscode';
import { ensureSymlinksOnWorkspaceOpen, createSymlinksCodebaseWide } from './agentlinks.vscode';
import {
  initWorkspaceConfig,
  getActiveWorkspaceFolder,
  loadWorkspaceConfig,
  watchConfigFile,
  watchUserConfig,
} from './swarmifyConfig.vscode';
import {
  CLAUDE_TITLE,
  CODEX_TITLE,
  GEMINI_TITLE,
  CURSOR_TITLE,
  OPENCODE_TITLE,
  findTerminalNameByTabLabel,
  getExpandedAgentName,
  getTerminalDisplayInfo,
  parseTerminalName,
  sanitizeLabel,
  formatTerminalTitle,
  getSessionChunk,
  truncateText,
  extractFirstNWords,
  extractLinearTicketId,
  formatRelativeTime,
  TerminalIdentificationOptions,
  prefixToAgentType,
  SessionAgentType
} from '../core/utils';
import { generateLabelWithLLM } from '../core/labelgen';
import { readClaudeSessionName } from '../core/sessionName';
import { resolveTerminalCwd, tryReleaseWorktreeForTerminal } from '../core/worktree';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  createTmuxTerminal,
  getTmuxState,
  isTmuxTerminal,
  registerTmuxCleanup,
  tmuxSplitH,
  tmuxSplitV,
  isTmuxAvailable
} from './tmux';
import { normalizeTerminalMode, resolveTerminalMode } from '../core/terminalMode';
import { DEFAULT_DISPLAY_PREFERENCES } from '../core/settings';
import * as readiness from './terminalReadiness';
import { resolveAlias, isAgentInstalled } from '../core/agentModels';
// readAgentRunStrategy no longer needed: agents-cli reads strategy from
// agents.yaml itself when invoked via `agents run`.
import { resolveAgentsBin, AgentsBinNotFoundError } from '../core/agentsBin';

const AGENTS_CLI_INSTALL_CMD = 'npm install -g @phnx-labs/agents-cli';
let agentsCliPromptShown = false;

async function ensureAgentsCliInstalled(): Promise<void> {
  try {
    await resolveAgentsBin();
  } catch (err) {
    if (!(err instanceof AgentsBinNotFoundError) || agentsCliPromptShown) return;
    agentsCliPromptShown = true;
    const choice = await vscode.window.showInformationMessage(
      'Swarmify needs the agents CLI. Install it now?',
      { modal: false },
      'Install',
      'Later',
    );
    if (choice === 'Install') {
      const term = vscode.window.createTerminal({ name: 'Install agents-cli' });
      term.show();
      term.sendText(AGENTS_CLI_INSTALL_CMD);
    }
  }
}
import { supportsPrewarming, buildVersionedResumeCommand, PREWARM_CONFIGS, PrewarmAgentType } from '../core/prewarm';
import { generateClaudeSessionId, listOpencodeSessions } from '../core/prewarm.simple';
import { liveSessionIdForShell, pruneStaleSessionState } from '../core/liveSession';
import { getSessionPathBySessionId, getSessionPreviewInfo, getOpenCodeSessionPreviewInfo, getCursorSessionPreviewInfo } from './sessions.vscode';
import * as tasksImport from './tasks.vscode';
import { SOURCE_BADGES } from '../core/tasks';
import * as handoff from '../core/handoff';
import { decodeInjectQuery, selectInjectTarget } from '../core/inject';

// Settings types are now imported from ./settings
// Settings functions are in ./settings.vscode

let agentStatusBarItem: vscode.StatusBarItem | undefined;
let defaultAgentTitle: string = CLAUDE_TITLE;
let secondaryAgentTitle: string = CODEX_TITLE;
let lastFocusedTerminal: vscode.Terminal | null = null;
const STATUS_BAR_AGENTS_VIEW_TTL_MS = 30_000;
const agentsViewCache = new Map<PrewarmAgentType, { fetchedAtMs: number; data: AgentsViewJsonAgent | null }>();
const statusBarMetaInFlight = new Set<string>();

// BUILT_IN_AGENTS is now imported from ./agents

// Prompts helpers (file-based storage at ~/.swarmify/agents/prompts.yaml)
function getPrompts(): PromptEntry[] {
  return settings.readPrompts();
}

function savePrompts(prompts: PromptEntry[]): void {
  settings.writePrompts(prompts);
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function getDisplayPrefs(context: vscode.ExtensionContext) {
  return settings.getSettings(context).display || DEFAULT_DISPLAY_PREFERENCES;
}

function buildTerminalTitle(
  prefix: string,
  label: string | undefined | null,
  context: vscode.ExtensionContext,
  sessionId?: string | null,
  isFocused?: boolean
): string {
  const display = getDisplayPrefs(context);
  const sessionChunk = display.showSessionIdInTitles ? getSessionChunk(sessionId || undefined) : null;
  return formatTerminalTitle(prefix, { label: label || undefined, display, sessionChunk, isFocused });
}

// Build the launch command for any built-in agent. Always routes through
// `agents run <agent> --interactive` so the agents-cli applies the
// configured strategy (pinned/available/balanced) from agents.yaml. Claude
// gets --session-id for resume; other agents detect their own session
// post-spawn.
type LaunchableAgent = 'claude' | 'codex' | 'gemini' | 'opencode' | 'cursor' | 'antigravity';

// Version/account selection strategy passed to `agents run --strategy`. Mirrors
// the agents-cli: pinned uses the configured default, balanced rotates across
// healthy accounts. (Latest is expressed as an explicit @version pin, not a
// strategy.) The CLI ignores --strategy when an @version is pinned.
type RunStrategy = 'pinned' | 'available' | 'balanced';

function buildAgentLaunchCommand(
  agentKey: LaunchableAgent,
  sessionId: string | null,
  defaultModel?: string,
  additionalFlags?: string,
  pinnedVersion?: string,
  strategy?: RunStrategy,
  mode?: AgentLaunchMode,
): string {
  const agentSpec = pinnedVersion ? `${agentKey}@${pinnedVersion}` : agentKey;
  let command = `agents run ${agentSpec} --interactive`;
  if (sessionId && agentKey === 'claude') {
    command += ` --session-id ${sessionId}`;
  }
  // --strategy is meaningless (and ignored by the CLI) once a version is
  // pinned, so only emit it for the unpinned, strategy-driven launches.
  if (strategy && !pinnedVersion) {
    command += ` --strategy ${strategy}`;
  }
  if (defaultModel && (!additionalFlags || !additionalFlags.includes('--model'))) {
    command += ` --model ${defaultModel}`;
  }
  // Dispatch mode -> `agents run --mode plan|auto|edit`, next to --model/--strategy.
  // Skip when the caller already threaded an explicit --mode via additionalFlags
  // so we never emit it twice.
  if (mode) {
    const modeFlag = modeFlagForAgent(agentKey, mode);
    if (modeFlag && (!additionalFlags || !additionalFlags.includes('--mode'))) {
      command += ` ${modeFlag}`;
    }
  }
  if (additionalFlags?.trim()) {
    command += ` ${additionalFlags.trim()}`;
  }
  return command;
}

// PATH augmented with the agents shim dirs — the extension-host PATH can omit them,
// so a bare `agents` spawn would fail to resolve. Shared by the detached spawns below.
function agentsSpawnEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  const extraPath = [
    path.join(home, '.agents/.cache/shims'),
    path.join(home, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].join(':');
  return { ...process.env, PATH: `${extraPath}:${process.env.PATH ?? ''}` };
}

// Dispatch an agent HEADLESS: `agents run <agent> --mode <m> --headless -p <prompt>`
// spawned DETACHED with no terminal tab. The run outlives this call (`unref`) and
// shows in `agents sessions --active` under this machine as context:'headless', so it
// can be focused/resumed later via `agents sessions focus`. No shell: args go straight
// to the binary (prompt stays a single arg, no quoting hazard).
export function runHeadlessAgent(
  agentKey: string,
  prompt: string,
  mode: AgentLaunchMode,
  cwd?: string,
): void {
  // modeFlagForAgent -> '--mode auto' | '--mode edit' | ... ; split into argv parts.
  const modeArgs = (modeFlagForAgent(agentKey, mode) ?? '').split(' ').filter(Boolean);
  const args = ['run', agentKey, ...modeArgs, '--headless', '-p', prompt];
  const child = spawn('agents', args, {
    cwd: cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: agentsSpawnEnv(),
  });
  child.unref();
}

// Focus a session: `agents sessions focus <id>` opens/attaches a real terminal on it (a
// background/headless run reopens in a new tab and resumes; a live terminal session is
// attached). It auto-resolves the surface (no interactive picker), so it's safe to run
// detached from the extension host.
export function focusSessionInTerminal(sessionId: string): void {
  const child = spawn('agents', ['sessions', 'focus', sessionId], {
    detached: true,
    stdio: 'ignore',
    env: agentsSpawnEnv(),
  });
  child.unref();
}

// Back-compat shim: keeps the old name used elsewhere in this file. The
// strategy argument is no longer needed since agents-cli reads it from
// agents.yaml directly. `buildClaudeOpenCommand` is no longer called —
// pinned now also routes through `agents run`.
function buildClaudeLaunchCommand(
  _context: vscode.ExtensionContext,
  sessionId: string,
  defaultModel?: string,
  additionalFlags?: string,
  mode?: AgentLaunchMode,
): string {
  return buildAgentLaunchCommand('claude', sessionId, defaultModel, additionalFlags, undefined, undefined, mode);
}

// Terminal readiness detection moved to src/vscode/terminalReadiness.ts.
// All spawn/resume flows now call readiness.waitFor(t, 'promptReady') instead.

/**
 * Detect OpenCode session ID after spawn by comparing session lists.
 * OpenCode creates its own session IDs (ses_xxx format) internally.
 * This runs asynchronously and updates the terminal entry when found.
 */
async function detectOpencodeSessionId(
  terminal: vscode.Terminal,
  terminalId: string,
  cwd: string,
  sessionsBefore: string[],
  context: vscode.ExtensionContext
): Promise<void> {
  // Wait for OpenCode to start and create a session
  await new Promise(resolve => setTimeout(resolve, 3000));

  const sessionsAfter = await listOpencodeSessions(cwd);
  if (!sessionsAfter || sessionsAfter.length === 0) {
    console.log(`[PREWARM] OpenCode: No sessions found after spawn`);
    return;
  }

  // Find new session (in sessionsAfter but not in sessionsBefore)
  const beforeSet = new Set(sessionsBefore);
  const newSessions = sessionsAfter.filter(id => !beforeSet.has(id));

  let sessionId: string | null = null;
  if (newSessions.length === 1) {
    sessionId = newSessions[0];
  } else if (newSessions.length > 1) {
    // Multiple new sessions - take the first one (most recent based on list order)
    sessionId = newSessions[0];
  } else {
    // No new sessions - take the most recent from after list
    sessionId = sessionsAfter[0];
  }

  if (sessionId) {
    console.log(`[PREWARM] OpenCode detected session ID: ${sessionId}`);
    terminals.setSessionId(terminal, sessionId);
    terminals.setAgentType(terminal, 'opencode');
    // Update terminal title to include session ID
    updateStatusBarForTerminal(terminal, context.extensionPath);
    startAutoLabelPollerForTerminal(terminal, context);
  }
}

async function updateTerminalTitleOnFocus(
  newTerminal: vscode.Terminal | undefined,
  context: vscode.ExtensionContext
): Promise<void> {
  const display = getDisplayPrefs(context);

  // Only update titles if showLabelOnlyOnFocus is enabled
  if (!display.showLabelOnlyOnFocus) {
    return;
  }

  // Update the newly focused terminal's title (with label)
  if (newTerminal) {
    const entry = terminals.getByTerminal(newTerminal);
    if (entry?.agentConfig) {
      const newTitle = buildTerminalTitle(
        entry.agentConfig.prefix,
        entry.label,
        context,
        entry.sessionId,
        true  // isFocused = true
      );
      await terminals.renameTerminal(newTerminal, newTitle);
    }
  }

  // Update the previously focused terminal's title (without label)
  if (lastFocusedTerminal && lastFocusedTerminal !== newTerminal) {
    const prevEntry = terminals.getByTerminal(lastFocusedTerminal);
    if (prevEntry?.agentConfig) {
      const prevTitle = buildTerminalTitle(
        prevEntry.agentConfig.prefix,
        prevEntry.label,
        context,
        prevEntry.sessionId,
        false  // isFocused = false
      );
      await terminals.renameTerminal(lastFocusedTerminal, prevTitle);
    }
  }

  // Update tracking
  lastFocusedTerminal = newTerminal || null;
}

interface PromptQuickPickItem extends vscode.QuickPickItem {
  entry?: PromptEntry;
  isAddNew?: boolean;
}

async function showPrompts(): Promise<void> {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    vscode.window.showInformationMessage('No active terminal');
    return;
  }

  const parsed = parseTerminalName(terminal.name);
  if (!parsed.isAgent) {
    vscode.window.showInformationMessage('Active terminal is not an agent terminal');
    return;
  }

  const prompts = getPrompts();

  // Sort: favorites first, then by accessedAt descending (most recently used first)
  const sorted = [...prompts].sort((a, b) => {
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
    return b.accessedAt - a.accessedAt;
  });

  const quickPick = vscode.window.createQuickPick<PromptQuickPickItem>();
  quickPick.placeholder = 'Search prompts...';
  quickPick.matchOnDescription = true;

  const buildItems = (): PromptQuickPickItem[] => {
    const items: PromptQuickPickItem[] = sorted.map(entry => ({
      label: `${entry.isFavorite ? '$(star-full) ' : ''}${entry.title}`,
      description: truncateText(entry.content, 50),
      detail: entry.content,
      entry,
      buttons: [
        {
          iconPath: new vscode.ThemeIcon(entry.isFavorite ? 'star-full' : 'star-empty'),
          tooltip: entry.isFavorite ? 'Remove from favorites' : 'Add to favorites'
        },
        {
          iconPath: new vscode.ThemeIcon('trash'),
          tooltip: 'Delete prompt'
        }
      ]
    }));

    items.push({
      label: '$(add) Add new prompt',
      isAddNew: true
    });

    return items;
  };

  quickPick.items = buildItems();

  quickPick.onDidTriggerItemButton(async (e) => {
    const item = e.item;
    if (!item.entry) return;

    const buttonIndex = (quickPick.items.find(i => i.entry?.id === item.entry?.id) as PromptQuickPickItem)
      ?.buttons?.indexOf(e.button);

    if (buttonIndex === 0) {
      // Toggle favorite
      item.entry.isFavorite = !item.entry.isFavorite;
      item.entry.updatedAt = Date.now();
      savePrompts(prompts);
      // Re-sort and rebuild items
      sorted.sort((a, b) => {
        if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
        return b.accessedAt - a.accessedAt;
      });
      quickPick.items = buildItems();
    } else if (buttonIndex === 1) {
      // Delete
      const idx = prompts.findIndex(p => p.id === item.entry?.id);
      if (idx !== -1) {
        prompts.splice(idx, 1);
        const sortedIdx = sorted.findIndex(p => p.id === item.entry?.id);
        if (sortedIdx !== -1) sorted.splice(sortedIdx, 1);
        savePrompts(prompts);
        quickPick.items = buildItems();
      }
    }
  });

  quickPick.onDidAccept(async () => {
    const selected = quickPick.selectedItems[0];
    if (!selected) return;

    quickPick.hide();

    if (selected.isAddNew) {
      // Add new prompt flow
      const title = await vscode.window.showInputBox({
        prompt: 'Prompt title',
        placeHolder: 'e.g., Debug Helper'
      });
      if (!title) return;

      const content = await vscode.window.showInputBox({
        prompt: 'Prompt content',
        placeHolder: 'Enter the prompt text...'
      });
      if (!content) return;

      const now = Date.now();
      const newEntry: PromptEntry = {
        id: generateId(),
        title,
        content,
        isFavorite: false,
        createdAt: now,
        updatedAt: now,
        accessedAt: now
      };

      prompts.push(newEntry);
      savePrompts(prompts);
      vscode.window.showInformationMessage(`Added "${title}" to Prompts`);
    } else if (selected.entry) {
      // Update accessedAt and paste to terminal (no auto-execute)
      selected.entry.accessedAt = Date.now();
      savePrompts(prompts);
      terminal.sendText(selected.entry.content, false);
      terminal.show();
    }
  });

  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();
}

function getAgentsToOpen(context: vscode.ExtensionContext): AgentConfig[] {
  const agentSettings = settings.getSettings(context);
  const extensionPath = context.extensionPath;
  const agents: AgentConfig[] = [];

  // Built-in agents
  for (const def of BUILT_IN_AGENTS) {
    const config = agentSettings.builtIn[def.key as keyof AgentSettings['builtIn']];
    if (config.login && config.instances > 0) {
      agents.push({ ...createAgentConfig(extensionPath, def.title, def.command, def.icon, def.prefix), count: config.instances });
    }
  }

  // Custom agents
  for (const custom of agentSettings.custom) {
    if (custom.login && custom.instances > 0) {
      agents.push({
        ...createAgentConfig(extensionPath, custom.name, custom.command, 'agents.png', custom.name.toLowerCase()),
        count: custom.instances
      });
    }
  }

  return agents;
}

// getBuiltInByTitle is now imported from ./agents.vscode

interface AgentTerminalInfo {
  isAgent: boolean;
  prefix: string | null;
  label: string | null;
  iconPath: vscode.IconPath | null;
}

/**
 * Extract identification options from a VS Code terminal.
 */
function extractTerminalIdentificationOptions(terminal: vscode.Terminal): TerminalIdentificationOptions {
  const opts = terminal.creationOptions as vscode.TerminalOptions;
  const env = opts?.env;
  const terminalId = env ? env['AGENT_TERMINAL_ID'] : undefined;

  // Extract icon filename from iconPath
  let iconFilename: string | null = null;
  if (opts?.iconPath) {
    const icon: any = opts.iconPath;
    if (icon instanceof vscode.Uri) {
      iconFilename = path.basename(icon.fsPath);
    } else if (icon && typeof icon === 'object') {
      // Handle { light: Uri; dark: Uri } shape
      const candidate = icon.light ?? icon.dark ?? icon;
      if (candidate instanceof vscode.Uri || (candidate && typeof candidate.fsPath === 'string')) {
        iconFilename = path.basename(candidate.fsPath);
      }
    }
  }

  return {
    name: terminal.name,
    terminalId: terminalId as string | undefined,
    iconFilename
  };
}

function identifyAgentTerminal(terminal: vscode.Terminal, extensionPath: string): AgentTerminalInfo {
  // First check terminals module state
  const entry = terminals.getByTerminal(terminal);
  if (entry && entry.agentConfig) {
    return {
      isAgent: true,
      prefix: entry.agentConfig.title,
      label: entry.label ?? null,
      iconPath: buildIconPath(entry.agentConfig.title, extensionPath)
    };
  }

  // Fall back to central identification function with all available inputs
  const identOpts = extractTerminalIdentificationOptions(terminal);
  const info = getTerminalDisplayInfo(identOpts);
  if (info.isAgent && info.prefix) {
    return {
      isAgent: true,
      prefix: info.prefix,
      label: info.label,
      iconPath: buildIconPath(info.prefix, extensionPath)
    };
  }

  return { isAgent: false, prefix: null, label: null, iconPath: null };
}

function getAgentConfigFromTerminal(
  terminal: vscode.Terminal,
  context: vscode.ExtensionContext
): Omit<AgentConfig, 'count'> | null {
  const info = identifyAgentTerminal(terminal, context.extensionPath);

  if (!info.isAgent || !info.prefix) {
    // Check custom agents by name
    const terminalName = terminal.name.trim();
    const agentSettings = settings.getSettings(context);
    for (const custom of agentSettings.custom) {
      if (terminalName === custom.name || terminalName.startsWith(`${custom.name} - `)) {
        return createAgentConfig(context.extensionPath, custom.name, custom.command, 'agents.png', custom.name.toLowerCase());
      }
    }
    return null;
  }

  // Check built-in agents
  const builtIn = getBuiltInDefByTitle(info.prefix);
  if (builtIn) {
    return createAgentConfig(context.extensionPath, builtIn.title, builtIn.command, builtIn.icon, builtIn.prefix);
  }

  // Check custom agents
  const agentSettings = settings.getSettings(context);
  for (const custom of agentSettings.custom) {
    if (info.prefix === custom.name) {
      return createAgentConfig(context.extensionPath, custom.name, custom.command, 'agents.png', custom.name.toLowerCase());
    }
  }

  return null;
}

// Settings functions are now in ./settings.vscode

// scanExistingEditorTerminals is now terminals.scanExisting()

// Infer agent config from terminal name for scan
function inferAgentConfigFromName(name: string, extensionPath: string, knownPrefix?: string | null): Omit<AgentConfig, 'count'> | null {
  // Build identification options - when called from scanExisting, we may have a knownPrefix
  const identOpts: TerminalIdentificationOptions = { name };
  // If we have a knownPrefix from the env var extraction, we can reconstruct a terminalId pattern
  // to trigger the terminalId fallback strategy
  if (knownPrefix) {
    identOpts.terminalId = `${knownPrefix}-0`; // Fake ID just to trigger the strategy
  }

  const info = getTerminalDisplayInfo(identOpts);
  if (!info.isAgent || !info.prefix) return null;

  const def = getBuiltInDefByTitle(info.prefix);
  if (def) {
    return createAgentConfig(extensionPath, def.title, def.command, def.icon, def.prefix);
  }
  return null;
}

export async function activate(context: vscode.ExtensionContext) {
  console.log('Cursor Agents extension is now active');

  // Store context for deactivate
  extensionContext = context;

  // Revive any Factory dashboard tab VS Code restored from the previous
  // session. Must be registered before any await so the restored webview
  // doesn't sit blank while activation runs.
  settings.registerPanelSerializer(context);

  // Prompt to install agents-cli if missing. Don't block activation —
  // resolveAgentsBin runs in the background; if it throws AgentsBinNotFoundError
  // we surface a notification with a one-click installer.
  void ensureAgentsCliInstalled();

  // Drop session-state files left behind by agents that have exited. The
  // SessionStart hook keys files by pid; without a SessionEnd cleanup hook,
  // those files would otherwise accumulate forever.
  void pruneStaleSessionState();

  // Initialize terminal readiness event tracking (shell integration + close cleanup)
  readiness.initReadiness(context);

  sessionTracker.initSessionTracker(context);
  context.subscriptions.push(
    sessionTracker.onSessionChanged((terminal, _oldId, newId) => {
      terminals.setSessionId(terminal, newId);
      startAutoLabelPollerForTerminal(terminal, context);
      updateStatusBarForTerminal(terminal, context.extensionPath);
    }),
  );

  // Cross-window live-terminal registry: every VS Code window publishes its
  // agent terminals to a shared JSON file so the Foreman (and future tools)
  // can see the factory state across all windows. Keepalive every 15s; also
  // fires on open/close.
  initForemanRegistry(context);

  // Elect exactly one "monitor" owner across all open IDE windows (epic #64,
  // foundation #65). The winner will own the heavy global probes/watches in
  // later migration issues; for now it just holds a renewable lease so the rest
  // of the stack can gate on isLeader(). Re-elects automatically on takeover.
  initMonitorLeader(context);

  // Monitor runtime (#67): the leader runs the broadcast host; EVERY window runs
  // a thin follower that reports its terminal tuples to the monitor and resolves
  // broadcast facts back to its own terminals. Migrations #68-71 move the heavy
  // probes/watchers/watchdog/panel behind this gate; they are NOT moved here.
  initMonitorHost(context);
  initMonitorFollower(context);

  // Activity-bar sidebar that always reflects the currently focused agent
  // terminal: title, version, label, cwd, PLAN.md, and any teams running in
  // this directory. Lazy-resolves when the user clicks the activity-bar icon.
  const { registerAgentPanel } = require('./agentPanel.vscode') as typeof import('./agentPanel.vscode');
  registerAgentPanel(context);

  // Issues view: GitHub + Linear issues scoped to the current repository.
  const { registerIssuesPanel } = require('./issuesPanel.vscode') as typeof import('./issuesPanel.vscode');
  registerIssuesPanel(context);

  // Create status bar item for showing active terminal status bar label
  agentStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  agentStatusBarItem.text = 'Agents';
  agentStatusBarItem.command = 'agents.sessionId';
  agentStatusBarItem.tooltip = 'Copy session ID';
  agentStatusBarItem.show();
  context.subscriptions.push(agentStatusBarItem);

  // Scan existing terminals in the editor area to register any agent terminals
  // Then restore persisted sessions with proper icons/titles
  terminals.scanExisting(
    (name, knownPrefix) => inferAgentConfigFromName(name, context.extensionPath, knownPrefix),
    context,
    (terminal) => startAutoLabelPollerForTerminal(terminal, context)
  )
    .then(() => restoreAgentTerminals(context))
    .then(() => {
      // Adopt any SH terminals that are already running an agent CLI
      // (e.g. user launched claude before reload).
      for (const entry of terminals.getAllTerminals()) {
        if (entry.agentConfig?.prefix === 'sh') {
          armShellAdoptionForTerminal(entry.terminal, context);
        }
      }
    })
    .catch(err => {
      console.error('[EXTENSION] Error scanning/restoring terminals:', err);
    });

  // Register terminals that appear after activation (e.g., restored sessions)
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(async (terminal) => {
      // Already tracked?
      if (terminals.getByTerminal(terminal)) {
        return;
      }

      // Use central identification with all available inputs
      const identOpts = extractTerminalIdentificationOptions(terminal);
      const info = getTerminalDisplayInfo(identOpts);
      if (!info.isAgent || !info.prefix) {
        return;
      }

      const agentConfig = inferAgentConfigFromName(terminal.name, context.extensionPath, info.prefix);
      if (!agentConfig) {
        return;
      }

      const id = identOpts.terminalId || terminals.nextId(info.prefix);
      let pid: number | undefined;
      try {
        pid = await terminal.processId;
      } catch {
        // ignore
      }

      terminals.register(terminal, id, agentConfig, pid, context, info.label || undefined);
      readiness.registerTerminal(terminal, { restored: true });

      const agentType = prefixToAgentType(info.prefix);
      if (agentType) {
        // Register the agent type even when sessionId is missing so
        // sessionTracker can adopt a fresh session file later.
        terminals.setAgentType(terminal, agentType);
      }

      if (identOpts.sessionId) {
        terminals.setSessionId(terminal, identOpts.sessionId);
        if (agentType) {
          startAutoLabelPollerForTerminal(terminal, context);
        }
      }

      if (info.prefix === 'SH') {
        armShellAdoptionForTerminal(terminal, context);
      }
    })
  );

  registerTmuxCleanup(context);

  // Start watchdog MCP bridge for smart agent mode
  const watchdogBridge = startWatchdogBridge(context);
  context.subscriptions.push(watchdogBridge);

  // Register the watchdog MCP server in each supported agent's user-scope
  // config so peer terminals can call `send_to_agent`. Fire-and-forget —
  // failures are logged but never block activation.
  ensureWatchdogMcpInstalled(watchdogBridge.mcpServerPath).catch((err) => {
    console.warn('[WATCHDOG] ensureWatchdogMcpInstalled failed:', err);
  });

  context.subscriptions.push(
    startWatchdog(context, {
      rotateTerminal: (entry) =>
        rotateTerminalToBestVersion(context, entry, {
          closeOldTerminal: true,
          focusNewTerminal: false,
          notifyOnFailure: false,
        }),
      mcpServerPath: watchdogBridge.mcpServerPath,
    })
  );

  // Ensure CLAUDE.md has Swarm instructions if Swarm is enabled
  claudemd.ensureSwarmInstructions();

  // Ensure symlinks exist for workspaces with .agents config
  for (const folder of vscode.workspace.workspaceFolders || []) {
    ensureSymlinksOnWorkspaceOpen(folder).catch(err => {
      console.error('[agents] Error ensuring symlinks:', err);
    });
  }

  // Watch for .agents config changes
  watchConfigFile(context, (workspaceFolder) => {
    ensureSymlinksOnWorkspaceOpen(workspaceFolder).catch(err => {
      console.error('[agents] Error ensuring symlinks on config change:', err);
    });
  });

  // Watch for user-level .agents config changes
  watchUserConfig(context, () => {
    for (const folder of vscode.workspace.workspaceFolders || []) {
      ensureSymlinksOnWorkspaceOpen(folder).catch(err => {
        console.error('[agents] Error ensuring symlinks on user config change:', err);
      });
    }
  });

  // Register URI handler for notification callbacks
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        const params = new URLSearchParams(uri.query);

        if (uri.path === '/focus') {
          const terminalId = params.get('terminalId');
          const entry = terminalId ? terminals.getById(terminalId) : undefined;
          if (entry) {
            entry.terminal.show();
          }
        } else if (uri.path === '/inject') {
          // External nudge: an outside process (agents-cli) delivers text into a
          // live integrated terminal by session id. Payload is base64url-JSON in
          // the single `p` query param. Malformed input logs + returns, never throws.
          const payload = decodeInjectQuery(uri.query);
          if (!payload) {
            console.warn('[INJECT] Ignoring malformed inject URI (bad or missing `p` payload)');
            return;
          }

          const all = terminals.getAllTerminals();
          const target = selectInjectTarget(all, payload.terminalId);
          if (!target) {
            const known = all.map((t) => t.sessionId).filter(Boolean).join(', ');
            console.warn(
              `[INJECT] No live terminal for id ${payload.terminalId}. Active sessions: ${known}`
            );
            return;
          }

          try {
            if (payload.enter === false) {
              // Text only, no submit.
              target.terminal.sendText(payload.text, false);
            } else if (payload.combined) {
              // Single write with the carriage return appended.
              target.terminal.sendText(payload.text + '\r', false);
            } else {
              // Ink-safe default: two writes so Claude's TUI sees Enter alone.
              target.terminal.sendText(payload.text, false);
              target.terminal.sendText('\r', false);
            }
            console.log(
              `[INJECT] Delivered to ${target.id} (session ${target.sessionId ?? 'unknown'}): "${payload.text.slice(0, 80)}${payload.text.length > 80 ? '…' : ''}"`
            );
          } catch (err) {
            console.error(
              `[INJECT] Failed to deliver to ${target.id}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        // /spawn — open an agent terminal in an editor tab running the supplied
        // command (e.g. `claude --resume <id>`). Used by the agents-cli terminal
        // engine's `vscodium-agent` backend to resume sessions into this editor.
        if (uri.path === '/spawn') {
          const req = parseSpawnRequest(uri.query);
          if (req) {
            await spawnCommandTerminal(context, req);
          }
        }
      }
    })
  );

  // Register custom markdown editor
  try {
    context.subscriptions.push(
      AgentsMarkdownEditorProvider.register(context)
    );
  } catch (error) {
    // Editor already registered (hot reload) - continue activation
    console.log('Custom editor already registered, continuing...');
  }

  try {
    const currentSettings = settings.getSettings(context);
    await workbench.setMarkdownEditorAssociation(
      currentSettings.editor?.markdownViewerEnabled ?? true
    );
  } catch (error) {
    console.error('Failed to apply markdown editor association:', error);
  }

  // Load cached default agents if set
  const storedDefault = context.globalState.get<string>('agents.defaultAgentTitle');
  if (storedDefault) {
    defaultAgentTitle = storedDefault;
  }
  const storedSecondary = context.globalState.get<string>('agents.secondaryAgentTitle');
  if (storedSecondary) {
    secondaryAgentTitle = storedSecondary;
  } else {
    secondaryAgentTitle = CODEX_TITLE;
    context.globalState.update('agents.secondaryAgentTitle', CODEX_TITLE);
  }

  // Set initial context keys and subscribe to config changes
  await updateContextKeys(context);
  updateActiveAgentContextKey(vscode.window.activeTerminal, context.extensionPath);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('agents')) {
        await updateContextKeys(context);
      }
    })
  );

  // Run lightweight first-setup if needed
  await maybeRunFirstSetup(context);

  // Open Dashboard on startup if enabled (welcome screen)
  const agentSettings = settings.getSettings(context);
  if (agentSettings.showWelcomeScreen) {
    // Delay slightly to allow VS Code to fully initialize
    setTimeout(() => {
      settings.openPanel(context);
    }, 500);
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.open', () => openAgentTerminals(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.openAgent', () => goToTerminal(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.cycleNextTerminal', () => cycleAgentTerminal(1))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.cyclePrevTerminal', () => cycleAgentTerminal(-1))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.reopenLastSession', () => reopenLastClosedSession(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.configure', () => settings.openPanel(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.dispatchTask', () => settings.openPanelAndDispatch(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.focusQuickSpawn', () => settings.openPanelAndFocusQuickSpawn(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.settings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:agents');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.newAgent', async () => {
      // Default is always Claude
      const agentConfig = getBuiltInByTitle(context.extensionPath, defaultAgentTitle);
      if (agentConfig) {
        await openSingleAgent(context, agentConfig);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.newSecondaryAgent', async () => {
      const targetTitle = secondaryAgentTitle || defaultAgentTitle;
      const targetDef = getBuiltInDefByTitle(targetTitle);
      let agentConfig: Omit<AgentConfig, 'count'> | null = getBuiltInByTitle(context.extensionPath, targetTitle);
      if (targetDef?.key && !(await isAgentInstalled(targetDef.key))) {
        agentConfig = null;
      }
      if (!agentConfig) {
        agentConfig = getBuiltInByTitle(context.extensionPath, defaultAgentTitle);
      }
      if (agentConfig) {
        openSingleAgent(context, agentConfig);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.newAgentHSplit', async () => {
      const config = vscode.workspace.getConfiguration('agents');
      const tmuxEnabled = normalizeTerminalMode(config.get('terminalMode')) !== 'native';
      const terminal = vscode.window.activeTerminal;

      if (tmuxEnabled && terminal && isTmuxTerminal(terminal)) {
        const state = getTmuxState(terminal);
        if (state) {
          const agentDef = getBuiltInByKey(state.agentType);
          const customAgent = !agentDef
            ? settings.getSettings(context).custom.find(agent => agent.name === state.agentType)
            : undefined;
          const command = agentDef?.command ?? customAgent?.command ?? '';
          tmuxSplitH(terminal, command);
        }
        return;
      }

      // Create horizontal split (new editor group below current)
      await vscode.commands.executeCommand('workbench.action.splitEditorDown');

      // Open default agent in the new (active) group
      const agentConfig = getBuiltInByTitle(context.extensionPath, defaultAgentTitle);
      if (agentConfig) {
        openSingleAgent(context, agentConfig);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.newAgentVSplit', async () => {
      const config = vscode.workspace.getConfiguration('agents');
      const tmuxEnabled = normalizeTerminalMode(config.get('terminalMode')) !== 'native';
      const terminal = vscode.window.activeTerminal;

      if (tmuxEnabled && terminal && isTmuxTerminal(terminal)) {
        const state = getTmuxState(terminal);
        if (state) {
          const agentDef = getBuiltInByKey(state.agentType);
          const customAgent = !agentDef
            ? settings.getSettings(context).custom.find(agent => agent.name === state.agentType)
            : undefined;
          const command = agentDef?.command ?? customAgent?.command ?? '';
          tmuxSplitV(terminal, command);
        }
        return;
      }

      // Create vertical split (new editor group to the side)
      await vscode.commands.executeCommand('workbench.action.splitEditor');

      // Open default agent in the new (active) group
      const agentConfig = getBuiltInByTitle(context.extensionPath, defaultAgentTitle);
      if (agentConfig) {
        openSingleAgent(context, agentConfig);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.setTitle', () => setStatusBarLabelForActiveTerminal(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.relabelTerminal', () => relabelActiveTerminal(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.clear', () => clearActiveTerminal(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.reload', () => reloadActiveTerminal(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.autogit', git.generateCommitMessage)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.prompts', showPrompts)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.setupClaude', () => swarm.setupSwarmIntegrationForAgent('claude', context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.setupCodex', () => swarm.setupSwarmIntegrationForAgent('codex', context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.setupGemini', () => swarm.setupSwarmIntegrationForAgent('gemini', context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.enableNotifications', () => notifications.enableNotifications(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.enableTmux', async () => {
      // Back-compat command id: flips terminalMode back to 'auto' (tmux by
      // default when available). The setting is the source of truth now.
      const config = vscode.workspace.getConfiguration();
      await config.update('agents.terminalMode', 'auto', vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Tmux mode enabled (auto). New agent terminals will run inside tmux when available.');
      await updateContextKeys(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.disableTmux', async () => {
      const config = vscode.workspace.getConfiguration();
      await config.update('agents.terminalMode', 'native', vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Tmux mode disabled. New agent terminals will use VS Code editor terminals.');
      await updateContextKeys(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.enableReader', async () => {
      const current = settings.getSettings(context);
      const next: AgentSettings = {
        ...current,
        editor: { ...(current.editor ?? { markdownViewerEnabled: true }), markdownViewerEnabled: true }
      };
      await settings.saveSettings(context, next);
      vscode.window.showInformationMessage('Markdown reader enabled. .md files will open in the Agents Markdown Editor.');
      await updateContextKeys(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.disableReader', async () => {
      const current = settings.getSettings(context);
      const next: AgentSettings = {
        ...current,
        editor: { ...(current.editor ?? { markdownViewerEnabled: true }), markdownViewerEnabled: false }
      };
      await settings.saveSettings(context, next);
      vscode.window.showInformationMessage('Markdown reader disabled. .md files will open in the default text editor.');
      await updateContextKeys(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.newTask', () => newTaskWithContext(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.askAnotherAgent', () => askAnotherAgentFromTerminal(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.spawnWithPrompt', async (args?: { agent?: string; prompt?: string }) => {
      await spawnWithPrompt(context, args);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.spawnWithContext', async () => {
      await spawnWithContext(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.handoff', () => handoffToAgent(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.closeWithRecap', () => closeActiveAgentWithRecap(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.continueInNew', () => continueInNewSession(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.continueFromSelection', () => continueFromSelection(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.sessionTrace', () => copySessionTrace(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.sessionId', () => copySessionId())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.sessionResume', () => resumeSession(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agents.resumeCurrentInBestProfile',
      () => resumeCurrentInBestProfile(context)
    )
  );

  interface TerminalQuickPickItem extends vscode.QuickPickItem {
    terminal: vscode.Terminal;
  }

  // Session warming has been removed; keep command for backwards compatibility.
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.disableWarming', async () => {
      vscode.window.showInformationMessage('Session warming is no longer used. Session IDs are discovered after launch.');
    })
  );

  // Agents: Init - create .agents config and symlinks
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.init', async () => {
      const workspaceFolder = getActiveWorkspaceFolder();
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open. Please open a folder first.');
        return;
      }

      // Create/open .agents config
      const config = await initWorkspaceConfig(workspaceFolder);
      if (!config) {
        return;
      }

      // Create symlinks codebase-wide
      const { created, errors } = await createSymlinksCodebaseWide(workspaceFolder, config);

      if (errors.length > 0) {
        vscode.window.showWarningMessage(`Created ${created} symlink(s), but ${errors.length} failed.`);
        console.error('[agents] Symlink errors:', errors);
      } else if (created > 0) {
        vscode.window.showInformationMessage(`Created ${created} symlink(s) in workspace.`);
      } else {
        vscode.window.showInformationMessage('.agents config ready. No new symlinks needed.');
      }
    })
  );

  // Register built-in individual agent commands
  for (const def of BUILT_IN_AGENTS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(def.commandId, () => {
        const agentConfig = getBuiltInByTitle(context.extensionPath, def.title);
        if (agentConfig) {
          openSingleAgent(context, agentConfig);
        }
      })
    );
  }

  // Register the per-strategy launch trio for version/account-managed agents:
  //   (Pinned)   -> pick an exact version interactively, launch it pinned
  //   (Latest)   -> resolve the newest installed version, launch it pinned
  //   (Balanced) -> launch with --strategy balanced (rotate across accounts)
  // STRATEGY_LAUNCH_AGENTS = claude, codex, gemini, cursor, antigravity.
  for (const def of BUILT_IN_AGENTS) {
    if (!(STRATEGY_LAUNCH_AGENTS as readonly string[]).includes(def.key)) continue;

    // (Pinned): interactive version picker. Command id keeps the legacy
    // `PickVersion` suffix for back-compat with existing keybindings.
    context.subscriptions.push(
      vscode.commands.registerCommand(`${def.commandId}PickVersion`, async () => {
        const version = await pickAgentVersion(def.key);
        if (!version) return;
        const agentConfig = getBuiltInByTitle(context.extensionPath, def.title);
        if (agentConfig) {
          openSingleAgent(context, agentConfig, undefined, version.version);
        }
      })
    );

    // (Latest): newest installed version, no prompt.
    context.subscriptions.push(
      vscode.commands.registerCommand(`${def.commandId}Latest`, async () => {
        const latest = await resolveLatestVersion(def.key);
        if (!latest) {
          vscode.window.showInformationMessage(`No installed ${def.key} versions found`);
          return;
        }
        const agentConfig = getBuiltInByTitle(context.extensionPath, def.title);
        if (agentConfig) {
          openSingleAgent(context, agentConfig, undefined, latest);
        }
      })
    );

    // (Balanced): rotate across healthy accounts via --strategy balanced.
    context.subscriptions.push(
      vscode.commands.registerCommand(`${def.commandId}Balanced`, () => {
        const agentConfig = getBuiltInByTitle(context.extensionPath, def.title);
        if (agentConfig) {
          openSingleAgent(context, agentConfig, undefined, undefined, 'balanced');
        }
      })
    );
  }

  // Register unified agent version picker (all agents in one list, ranked by usage)
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.newAgentPickVersion', async () => {
      const result = await pickAnyAgentVersion(context.extensionPath);
      if (!result) return;
      const def = getBuiltInByKey(result.agentKey);
      if (!def) return;
      const agentConfig = getBuiltInByTitle(context.extensionPath, def.title);
      if (agentConfig) {
        openSingleAgent(context, agentConfig, undefined, result.version);
      }
    })
  );

  // Dynamically register custom agent commands
  const customAgentSettings = settings.getSettings(context);
  for (const custom of customAgentSettings.custom) {
    const commandId = `agents.new${custom.name.replace(/[^a-zA-Z0-9]/g, '')}`;
    const agentConfig = createAgentConfig(context.extensionPath, custom.name, custom.command, 'agents.png', custom.name.toLowerCase());

    context.subscriptions.push(
      vscode.commands.registerCommand(commandId, () => {
        openSingleAgent(context, agentConfig);
      })
    );

    console.log(`Registered custom agent command: ${commandId} for ${custom.name}`);
  }

  // Register the "New (Alias)" command - shows a QuickPick of all configured aliases
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.newAlias', async () => {
      const currentSettings = settings.getSettings(context);
      const aliases = currentSettings.aliases || [];

      if (aliases.length === 0) {
        const action = await vscode.window.showInformationMessage(
          'No aliases configured. Create one in the Agents dashboard.',
          'Open Dashboard'
        );
        if (action === 'Open Dashboard') {
          vscode.commands.executeCommand('agents.configure');
        }
        return;
      }

      // Build QuickPick items
      const items = aliases.map(alias => {
        const builtInDef = getBuiltInByKey(alias.agent);
        const agentName = builtInDef ? getExpandedAgentName(builtInDef.prefix) : alias.agent;
        return {
          label: `${agentName} (${alias.name})`,
          description: alias.flags,
          alias
        };
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select an alias to launch'
      });

      if (selected) {
        const builtInDef = getBuiltInByKey(selected.alias.agent);
        if (builtInDef) {
          const agentConfig = getBuiltInByTitle(context.extensionPath, builtInDef.title);
          if (agentConfig) {
            openSingleAgent(context, agentConfig, selected.alias.flags);
          }
        }
      }
    })
  );

  // Dynamically register command aliases
  // Aliases let users define shortcuts like "Agents: New Claude (Fast)" with custom flags
  const aliases = customAgentSettings.aliases || [];
  for (const alias of aliases) {
    // Get the built-in agent this alias is for
    const builtInDef = getBuiltInByKey(alias.agent);
    if (!builtInDef) {
      console.warn(`Alias "${alias.name}" references unknown agent: ${alias.agent}`);
      continue;
    }

    // Create command ID: agents.alias.Fast, agents.alias.MaxContext, etc.
    const commandId = `agents.alias.${alias.name.replace(/[^a-zA-Z0-9]/g, '')}`;
    const agentConfig = getBuiltInByTitle(context.extensionPath, builtInDef.title);

    if (agentConfig) {
      context.subscriptions.push(
        vscode.commands.registerCommand(commandId, () => {
          openSingleAgent(context, agentConfig, alias.flags);
        })
      );

      console.log(`Registered alias command: ${commandId} -> ${alias.agent} with flags: ${alias.flags}`);
    }
  }

  // Register quick launch commands (Cmd+Shift+0..9). Always register all ten so
  // keybindings stay valid even before the user assigns a slot — unassigned
  // shortcuts silently no-op.
  for (const digit of QUICK_LAUNCH_SLOT_KEYS) {
    const command = `agents.quickLaunch${digit}`;
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async () => {
        // Re-read settings on every press so newly saved slots take effect
        // without reloading the window.
        const fresh = settings.getSettings(context);
        const slot: QuickLaunchSlot | undefined = getQuickLaunchSlot(fresh.quickLaunch, digit);
        if (!slot) return;

        const builtInDef = getBuiltInByKey(slot.agent);
        if (!builtInDef) return;

        const agentConfig = getBuiltInByTitle(context.extensionPath, builtInDef.title);
        if (!agentConfig) return;

        let modelId = slot.model;
        if (!modelId && slot.modelAlias) {
          modelId = (await resolveAlias(slot.agent, slot.modelAlias)) ?? undefined;
        }

        const parts: string[] = [];
        if (modelId) parts.push(`--model ${modelId}`);
        if (slot.mode) parts.push(`--mode ${slot.mode}`);
        if (slot.extraFlags && slot.extraFlags.trim()) parts.push(slot.extraFlags.trim());
        const flags = parts.length ? parts.join(' ') : undefined;

        openSingleAgent(context, agentConfig, flags, slot.version || undefined);
      })
    );
  }

  // Listen for terminal closures to update our tracking
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      // Capture session info before unregistering (for reopen)
      const entry = terminals.getByTerminal(terminal);
      if (entry?.agentConfig && entry.sessionId) {
        terminals.pushClosedSession({
          terminalId: entry.id,
          prefix: entry.agentConfig.prefix,
          sessionId: entry.sessionId,
          label: entry.label,
          agentType: entry.agentType,
          version: entry.version,
          account: entry.account || entry.statusAccount || undefined,
          agentConfig: entry.agentConfig,
          closedAt: Date.now()
        });
      }

      // Lazy release of the per-terminal worktree (no-op unless
      // agents.worktreePerTerminal is enabled). Safe-by-default: only removes
      // when clean and merged; otherwise leaves the worktree for the user to
      // inspect or for `agents worktree prune` to revisit later.
      if (entry?.id) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceFolder) {
          tryReleaseWorktreeForTerminal(workspaceFolder, entry.id);
        }
      }

      terminals.unregister(terminal);
      updateActiveAgentContextKey(vscode.window.activeTerminal, context.extensionPath);
    })
  );

  // Update status bar when active terminal changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      updateActiveAgentContextKey(terminal, context.extensionPath);
      if (!agentStatusBarItem) return;

      if (!terminal) {
        agentStatusBarItem.text = 'Agents';
        return;
      }

      // Check if this is an agent terminal and scroll to bottom
      const agentInfo = identifyAgentTerminal(terminal, context.extensionPath);
      if (agentInfo.isAgent) {
        vscode.commands.executeCommand('workbench.action.terminal.scrollToBottom');

        // Try to fetch label on focus if not already set (immediate update instead of 5-min poller)
        tryFetchLabelOnFocus(terminal, context);
      }

      updateStatusBarForTerminal(terminal, context.extensionPath);

      // Update terminal titles based on focus state (for showLabelOnlyOnFocus feature)
      updateTerminalTitleOnFocus(terminal, context);
    })
  );

  // Prefer activeTerminal (identity) over a tab-label name match: same-agent
  // terminals share a name ("CC"), so name matching always returns the first.
  const terminalForActiveTab = (tabLabel: string | undefined): vscode.Terminal | undefined => {
    const active = vscode.window.activeTerminal;
    if (active) return active;
    if (!tabLabel) return undefined;
    const names = vscode.window.terminals.map((t) => t.name);
    const matchedName = findTerminalNameByTabLabel(names, tabLabel);
    return matchedName ? vscode.window.terminals.find((t) => t.name === matchedName) : undefined;
  };

  // Update status bar when active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!agentStatusBarItem) return;

      if (editor) {
        // Switching to a real text editor - reset status bar
        agentStatusBarItem.text = 'Agents';
      } else {
        // editor is undefined - could be switching to a terminal tab
        // Check if active tab is a terminal and update status bar accordingly
        const activeGroup = vscode.window.tabGroups.activeTabGroup;
        const activeTab = activeGroup?.activeTab;

        if (activeTab?.input instanceof vscode.TabInputTerminal) {
          const matchedTerminal = terminalForActiveTab(activeTab.label);
          if (matchedTerminal) {
            updateStatusBarForTerminal(matchedTerminal, context.extensionPath);
            return;
          }
        }
      }
    })
  );

  // Listen for tab changes to catch editor-area terminal switches
  // (onDidChangeActiveTerminal doesn't fire reliably for terminal editor tabs)
  // Debounced because onDidChangeTabs fires in rapid bursts during workspace restore,
  // tab drag, etc. — each fire used to trigger a full session-file read.
  let tabChangeTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => {
      if (!agentStatusBarItem) return;
      if (tabChangeTimer) clearTimeout(tabChangeTimer);
      tabChangeTimer = setTimeout(() => {
        tabChangeTimer = undefined;
        const activeGroup = vscode.window.tabGroups.activeTabGroup;
        const activeTab = activeGroup?.activeTab;

        if (!activeTab || !(activeTab.input instanceof vscode.TabInputTerminal)) {
          return;
        }

        const matchedTerminal = terminalForActiveTab(activeTab.label);
        if (!matchedTerminal) return;

        tryFetchLabelOnFocus(matchedTerminal, context);
        updateStatusBarForTerminal(matchedTerminal, context.extensionPath);
        updateTerminalTitleOnFocus(matchedTerminal, context);
      }, 120);
    })
  );
  context.subscriptions.push({
    dispose: () => {
      if (tabChangeTimer) clearTimeout(tabChangeTimer);
    },
  });

  // Auto-open terminals on startup if any agents have login enabled
  const startupSettings = settings.getSettings(context);
  if (hasLoginEnabled(startupSettings)) {
    setTimeout(() => openAgentTerminals(context), 1000);
  }
}

async function sendCommandWhenReady(
  terminal: vscode.Terminal,
  command: string,
): Promise<void> {
  const t0 = Date.now();
  const elapsed = () => `t+${Date.now() - t0}ms`;
  console.log(`[SEND-CMD] ${elapsed()} waiting for promptReady`);
  try {
    await readiness.waitFor(terminal, 'promptReady');
    console.log(`[SEND-CMD] ${elapsed()} promptReady fired, sending`);
  } catch (err) {
    console.warn(`[SEND-CMD] ${elapsed()} promptReady wait failed: ${err}. Sending anyway.`);
  }
  terminal.sendText(command);
  console.log(`[SEND-CMD] ${elapsed()} sendText returned`);
}

async function openSingleAgent(
  context: vscode.ExtensionContext,
  agentConfig: Omit<AgentConfig, 'count'>,
  additionalFlags?: string,
  pinnedVersion?: string,
  strategy?: RunStrategy
) {
  const config = vscode.workspace.getConfiguration('agents');
  const terminalMode = normalizeTerminalMode(config.get('terminalMode'));
  // 'auto' (default) and 'tmux' both need the availability probe; 'native' skips it.
  const tmuxAvailable = terminalMode === 'native' ? false : await isTmuxAvailable();
  const { useTmux: tmuxOk, warnUnavailable } = resolveTerminalMode(terminalMode, tmuxAvailable);

  if (warnUnavailable) {
    vscode.window.showWarningMessage('Tmux mode is forced, but tmux is not available on PATH. Falling back to VS Code terminals.');
  }

  // Build command with default model if configured
  const builtInDef = getBuiltInDefByTitle(agentConfig.title);
  const agentKey = builtInDef?.key as keyof AgentSettings['builtIn'] | undefined;
  const defaultModel = agentKey && (!additionalFlags || !additionalFlags.includes('--model'))
    ? settings.getDefaultModel(context, agentKey)
    : undefined;
  let command = agentConfig.command || '';
  if (command) {
    if (defaultModel) {
      command = `${command} --model ${defaultModel}`;
    }
    if (additionalFlags) {
      command = `${command} ${additionalFlags}`;
    }
  }

  // Handle session ID for supported agent types
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

  // Generate the terminal-id up front so both the tmux and the non-tmux
  // branches reuse it. This also lets us provision a per-terminal worktree
  // (opt-in via agents.worktreePerTerminal) before the terminal is created.
  const terminalId = terminals.nextId(agentConfig.prefix);
  const { cwd, isolated: worktreeIsolated } = await resolveTerminalCwd(workspaceFolder, terminalId);

  let sessionId: string | null = null;

  // Track OpenCode sessions before spawn to detect new one
  let opencodeSessionsBefore: string[] | null = null;
  if (agentKey === 'opencode') {
    opencodeSessionsBefore = await listOpencodeSessions(cwd);
  }

  // All built-in agents launch via `agents run <agent> --interactive` so the
  // agents-cli picks up the configured strategy (pinned/available/balanced)
  // from ~/.agents-system/agents.yaml automatically — or an explicit override
  // (pinnedVersion / strategy) from the per-strategy launch commands. Only
  // Claude's session is generated up-front for the resume flow; other agents
  // detect their session post-spawn.
  const LAUNCHABLE: ReadonlySet<string> = new Set(['claude', 'codex', 'gemini', 'opencode', 'cursor', 'antigravity']);
  if (agentKey && LAUNCHABLE.has(agentKey)) {
    if (agentKey === 'claude') {
      sessionId = generateClaudeSessionId();
      console.log(`[SESSION] Claude using on-demand session ID: ${sessionId}`);
    }
    command = buildAgentLaunchCommand(agentKey as LaunchableAgent, sessionId, defaultModel, additionalFlags, pinnedVersion, strategy);
  }

  if (tmuxOk) {
    const title = buildTerminalTitle(agentConfig.title, undefined, context, sessionId);
    const agentType = builtInDef?.key ?? agentConfig.title;
    const terminal = createTmuxTerminal(
      title,
      agentType,
      command,
      {
        iconPath: agentConfig.iconPath as vscode.Uri,
        env: buildAgentTerminalEnv(terminalId, sessionId, cwd, undefined, { scrubSensitive: agentKey !== 'shell' }),
        viewColumn: vscode.ViewColumn.Active,
        cwd: worktreeIsolated ? cwd : undefined,
      }
    );

    const pid = await terminal.processId;
    terminals.register(terminal, terminalId, agentConfig, pid, context);
    readiness.registerTerminal(terminal);
    if (command) {
      readiness.armAgentReady(terminal, agentKey && sessionId
        ? { agentKey, sessionId, cwd }
        : {});
    }

    if (agentKey && supportsPrewarming(agentKey)) {
      terminals.setAgentType(terminal, agentKey);
    }
    if (sessionId) {
      terminals.setSessionId(terminal, sessionId);
      if (agentKey && supportsPrewarming(agentKey)) {
        startAutoLabelPollerForTerminal(terminal, context);
      }
    }
    if (pinnedVersion) {
      terminals.setVersion(terminal, pinnedVersion);
    }

    if (agentKey === 'shell') {
      armShellAdoptionForTerminal(terminal, context);
    }

    // OpenCode: Detect session ID asynchronously after spawn
    if (agentKey === 'opencode' && opencodeSessionsBefore !== null) {
      detectOpencodeSessionId(terminal, terminalId, cwd, opencodeSessionsBefore, context);
    }

    terminal.show();
    return;
  }

  const editorLocation: vscode.TerminalEditorLocationOptions = {
    viewColumn: vscode.ViewColumn.Active,
    preserveFocus: false
  };

  const title = buildTerminalTitle(agentConfig.title, undefined, context, sessionId);
  const terminal = vscode.window.createTerminal({
    iconPath: agentConfig.iconPath,
    location: editorLocation,
    name: title,
    env: buildAgentTerminalEnv(terminalId, sessionId, cwd, undefined, { scrubSensitive: agentKey !== 'shell' }),
    cwd: worktreeIsolated ? cwd : undefined,
    isTransient: true
  });

  const pid = await terminal.processId;
  terminals.register(terminal, terminalId, agentConfig, pid, context);
  readiness.registerTerminal(terminal);

  if (agentKey && supportsPrewarming(agentKey)) {
    terminals.setAgentType(terminal, agentKey);
  }
  if (sessionId) {
    terminals.setSessionId(terminal, sessionId);
    if (agentKey && supportsPrewarming(agentKey)) {
      startAutoLabelPollerForTerminal(terminal, context);
    }
  }
  if (pinnedVersion) {
    terminals.setVersion(terminal, pinnedVersion);
  }

  if (command) {
    await sendCommandWhenReady(terminal, command);
    readiness.armAgentReady(terminal, agentKey && sessionId
      ? { agentKey, sessionId, cwd }
      : {});
  }

  if (agentKey === 'shell') {
    armShellAdoptionForTerminal(terminal, context);
  }

  // OpenCode: Detect session ID asynchronously after spawn
  if (agentKey === 'opencode' && opencodeSessionsBefore !== null) {
    detectOpencodeSessionId(terminal, terminalId, cwd, opencodeSessionsBefore, context);
  }
}

// Tracks the most recent /spawn terminal so a follow-up split lands beside it
// (the engine's two-per-tab packing: tab, then split, then tab, …).
let lastSpawnedTerminal: vscode.Terminal | undefined;

// The parent terminal for a split: the last /spawn terminal if it is still
// open, else the active terminal, else none (caller falls back to a new tab).
function aliveSpawnParent(): vscode.Terminal | undefined {
  if (lastSpawnedTerminal && vscode.window.terminals.includes(lastSpawnedTerminal)) {
    return lastSpawnedTerminal;
  }
  return vscode.window.activeTerminal ?? undefined;
}

// Open an editor-tab terminal running an arbitrary command (the /spawn verb).
// Mirrors openSingleAgent's non-tmux editor-terminal path but for a caller-
// supplied command: it is registered as a shell terminal with shell adoption
// armed, so a resume command like `claude --resume <id>` is auto-promoted to
// the Claude chip + session tracking. When req.split is set, the terminal
// splits beside the previous /spawn pane instead of opening a new tab.
async function spawnCommandTerminal(
  context: vscode.ExtensionContext,
  req: SpawnRequest
): Promise<void> {
  const shellDef = getBuiltInByKey('shell');
  if (!shellDef) return;
  const agentConfig = createAgentConfig(
    context.extensionPath,
    shellDef.title,
    shellDef.command,
    shellDef.icon,
    shellDef.prefix
  );

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const cwd = req.cwd || workspaceFolder;
  const terminalId = terminals.nextId(agentConfig.prefix);

  const parent = req.split ? aliveSpawnParent() : undefined;
  const location: vscode.TerminalEditorLocationOptions | vscode.TerminalSplitLocationOptions =
    parent
      ? { parentTerminal: parent }
      : { viewColumn: vscode.ViewColumn.Active, preserveFocus: false };

  const terminal = vscode.window.createTerminal({
    iconPath: agentConfig.iconPath,
    location,
    name: buildTerminalTitle(agentConfig.title, undefined, context, null),
    env: buildAgentTerminalEnv(terminalId, null, cwd, undefined, { scrubSensitive: false }),
    cwd,
    isTransient: true
  });

  const pid = await terminal.processId;
  terminals.register(terminal, terminalId, agentConfig, pid, context);
  readiness.registerTerminal(terminal);
  armShellAdoptionForTerminal(terminal, context);

  await sendCommandWhenReady(terminal, req.command);
  terminal.show();
  lastSpawnedTerminal = terminal;
}

async function newTaskWithContext(context: vscode.ExtensionContext) {
  const agentSettings = settings.getSettings(context);
  const { tasks } = await tasksImport.fetchAllTasks(context, agentSettings.taskSources);

  let message: string;

  if (tasks.length === 0) {
    const userPrompt = await vscode.window.showInputBox({
      prompt: 'Enter task for the agent',
      placeHolder: 'What should the agent do?'
    });

    if (userPrompt === undefined) return;

    message = userPrompt;
  } else {
    interface TaskQuickPickItem extends vscode.QuickPickItem {
      task: typeof tasks[0];
    }

    const items: TaskQuickPickItem[] = tasks.map(task => {
      const badge = SOURCE_BADGES[task.source];
      const identifier = task.metadata.identifier;
      const description = identifier ? `${badge.label} ${identifier}` : badge.label;

      return {
        label: task.title,
        description,
        detail: task.description ? `${task.description.slice(0, 100)}${task.description.length > 100 ? '...' : ''}` : undefined,
        task
      };
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a task to work on',
      matchOnDescription: true,
      matchOnDetail: true
    });

    if (!selected) return;

    const task = selected.task;
    message = task.title;

    if (task.description) {
      message += `\n\n${task.description}`;
    }

    if (task.metadata.url) {
      message += `\n\nReference: ${task.metadata.url}`;
    }
  }

  const clipboardText = await vscode.env.clipboard.readText();
  if (clipboardText && clipboardText.trim()) {
    message = `<context>\n${clipboardText.trim()}\n</context>\n\n${message}`;
  }

  const agentConfig = getBuiltInByTitle(context.extensionPath, defaultAgentTitle);
  if (agentConfig) {
    await openSingleAgentWithQueue(context, agentConfig, [message]);
  }
}

async function askAnotherAgentFromTerminal(context: vscode.ExtensionContext) {
  const clipboardText = (await vscode.env.clipboard.readText()).trim();
  if (!clipboardText) {
    vscode.window.showInformationMessage(
      'Copy the line first (Cmd+C), then press Cmd+Shift+K or right-click and choose "Start Task".'
    );
    return;
  }

  const preview = clipboardText.length > 80
    ? `${clipboardText.slice(0, 80).replace(/\s+/g, ' ')}...`
    : clipboardText.replace(/\s+/g, ' ');

  const question = await vscode.window.showInputBox({
    prompt: `Start a task with context: ${preview}`,
    placeHolder: 'What should the agent do?'
  });
  if (question === undefined || !question.trim()) return;

  const sourceTerminal = vscode.window.activeTerminal;
  const sourceEntry = sourceTerminal ? terminals.getByTerminal(sourceTerminal) : undefined;
  const sourceAgent = sourceEntry?.agentConfig
    ? getExpandedAgentName(sourceEntry.agentConfig.prefix)
    : undefined;
  const sourceSessionId = sourceEntry?.sessionId;
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  let sourceSummary: string | null = null;
  if (sourceSessionId) {
    sourceSummary = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Loading source session summary…' },
      () => handoff.getSessionSummaryViaAgentsCli(sourceSessionId, workspacePath)
    );
  }

  const contextLines: string[] = [];
  if (sourceAgent) contextLines.push(`source-agent: ${sourceAgent}`);
  if (sourceSessionId) contextLines.push(`source-session-id: ${sourceSessionId}`);
  if (workspacePath) contextLines.push(`workspace: ${workspacePath}`);
  contextLines.push('selected-text:');
  contextLines.push(clipboardText);
  if (sourceSummary) {
    contextLines.push('');
    contextLines.push('source-session-summary:');
    contextLines.push(sourceSummary);
  }

  const message = `<context>\n${contextLines.join('\n')}\n</context>\n\n${question.trim()}`;
  const agentConfig = getBuiltInByTitle(context.extensionPath, defaultAgentTitle);
  if (agentConfig) {
    await openSingleAgentWithQueue(context, agentConfig, [message]);
  }
}

async function handoffToAgent(context: vscode.ExtensionContext) {
  const activeTerminal = vscode.window.activeTerminal;

  if (!activeTerminal) {
    vscode.window.showInformationMessage('No active terminal to handoff from');
    return;
  }

  const terminalEntry = terminals.getByTerminal(activeTerminal);

  if (!terminalEntry || !terminalEntry.agentConfig) {
    vscode.window.showInformationMessage('Active terminal is not an agent terminal');
    return;
  }

  const fromAgent = getExpandedAgentName(terminalEntry.agentConfig.prefix);
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  let messages: handoff.HandoffMessage[] = [];
  let planInfo: { path: string; content: string } | null = null;

  if (terminalEntry.sessionId && terminalEntry.agentType) {
    const agentType = terminalEntry.agentType as 'claude' | 'codex' | 'gemini';

    messages = await handoff.getSessionMessagesViaAgentsCli(terminalEntry.sessionId, 10, workspacePath);

    if (agentType === 'claude') {
      planInfo = await handoff.findRecentClaudePlan();
    }
  }

  if (messages.length === 0 && !planInfo && terminalEntry.agentType !== 'opencode') {
    vscode.window.showInformationMessage('No session history available for handoff');
    return;
  }

  interface AgentQuickPickItem extends vscode.QuickPickItem {
    agentKey: string;
    agentConfig: Omit<AgentConfig, 'count'>;
  }

  const agentItems: AgentQuickPickItem[] = [];

  for (const def of BUILT_IN_AGENTS) {
    if (def.key === 'shell') continue;
    if (def.title === terminalEntry.agentConfig.title) continue;

    const config = getBuiltInByTitle(context.extensionPath, def.title);
    if (!config) continue;

    const expandedName = getExpandedAgentName(def.prefix);
    agentItems.push({
      label: expandedName,
      description: def.key.toUpperCase(),
      agentKey: def.key,
      agentConfig: config
    });
  }

  const customAgentSettings = settings.getSettings(context);
  for (const custom of customAgentSettings.custom) {
    if (custom.name === terminalEntry.agentConfig.title) continue;

    agentItems.push({
      label: custom.name,
      description: 'Custom',
      agentKey: custom.name.toLowerCase(),
      agentConfig: createAgentConfig(context.extensionPath, custom.name, custom.command, 'agents.png', custom.name.toLowerCase())
    });
  }

  if (agentItems.length === 0) {
    vscode.window.showInformationMessage('No other agents available for handoff');
    return;
  }

  const selectedAgent = await vscode.window.showQuickPick(agentItems, {
    placeHolder: `Handoff from ${fromAgent} to...`,
    matchOnDescription: true
  });

  if (!selectedAgent) return;

  const handoffContext: handoff.HandoffContext = {
    fromAgent,
    messages,
    planContent: planInfo?.content,
    planPath: planInfo?.path
  };

  const prompt = handoff.formatHandoffPrompt(handoffContext);

  await openSingleAgentWithQueue(context, selectedAgent.agentConfig, [prompt]);
}

async function continueInNewSession(context: vscode.ExtensionContext) {
  const activeTerminal = vscode.window.activeTerminal;

  if (!activeTerminal) {
    vscode.window.showInformationMessage('No active terminal to continue from');
    return;
  }

  const terminalEntry = terminals.getByTerminal(activeTerminal);

  if (!terminalEntry || !terminalEntry.agentConfig) {
    vscode.window.showInformationMessage('Active terminal is not an agent terminal');
    return;
  }

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (!terminalEntry.sessionId || !terminalEntry.agentType) {
    vscode.window.showInformationMessage('No session data available to continue from');
    return;
  }

  const [messages, toolStats] = await Promise.all([
    handoff.getSessionMessagesViaAgentsCli(terminalEntry.sessionId, 999, workspacePath),
    handoff.getSessionToolStatsViaAgentsCli(terminalEntry.sessionId, workspacePath)
  ]);

  const originalTask = messages.find(m => m.role === 'user')?.content ?? null;
  const lastResponse = [...messages].reverse().find(m => m.role === 'assistant')?.content ?? null;

  if (!originalTask && !lastResponse) {
    vscode.window.showInformationMessage('No session history available to continue from');
    return;
  }

  const continueCtx: handoff.ContinueContext = {
    originalTask,
    lastResponse,
    recentFiles: toolStats.recentFiles,
    toolCalls: toolStats.toolCalls,
    filesEdited: toolStats.filesEdited,
    filesRead: toolStats.filesRead
  };

  const prompt = handoff.formatContinuePrompt(continueCtx);

  await openSingleAgentWithQueue(context, terminalEntry.agentConfig, [prompt]);
}

async function readSelectionForContinue(): Promise<string> {
  const editor = vscode.window.activeTextEditor;
  if (editor && !editor.selection.isEmpty) {
    return editor.document.getText(editor.selection).trim();
  }
  // No public API exposes terminal selection text — the only path is to copy
  // it to the system clipboard, read, and restore. The two readText calls
  // bracketing copySelection can race on macOS in practice (clipboard write
  // is normally awaited but is not strictly ordered with the next read), so
  // treat any non-empty change as the selection and otherwise restore.
  if (vscode.window.activeTerminal) {
    const original = await vscode.env.clipboard.readText();
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    const fromTerminal = (await vscode.env.clipboard.readText()).trim();
    if (fromTerminal && fromTerminal !== original.trim()) {
      // Restore the user's prior clipboard — they didn't ask to lose it.
      await vscode.env.clipboard.writeText(original);
      return fromTerminal;
    }
    await vscode.env.clipboard.writeText(original);
  }
  return (await vscode.env.clipboard.readText()).trim();
}

async function continueFromSelection(context: vscode.ExtensionContext) {
  const selection = await readSelectionForContinue();
  if (!selection) {
    vscode.window.showInformationMessage(
      'Select a session ID (in editor or terminal) or copy it first, then press Cmd+Shift+C.'
    );
    return;
  }

  const agentConfig = getBuiltInByTitle(context.extensionPath, defaultAgentTitle);
  if (!agentConfig) {
    vscode.window.showErrorMessage(`No agent config for default "${defaultAgentTitle}"`);
    return;
  }

  vscode.window.setStatusBarMessage(`Continuing session ${selection.slice(0, 8)}…`, 3000);
  await openSingleAgentWithQueue(context, agentConfig, [`/continue ${selection}`]);
}

interface CliSessionItem {
  id: string;
  shortId: string;
  agent: 'claude' | 'codex' | 'gemini' | 'opencode' | 'openclaw' | 'cursor';
  timestamp: string;
  version?: string;
  account?: string;
  project?: string;
  cwd?: string;
  filePath?: string;
  topic?: string;
  messageCount?: number;
  tokenCount?: number;
}

interface AgentVersionInfo {
  version: string;
  isDefault: boolean;
  signedIn: boolean;
  email?: string;
  plan?: string;
  usageStatus?: 'available' | 'rate_limited' | 'out_of_credits';
  windows?: Array<{
    key: string;
    usedPercent: number;
    resetsAt: string;
  }>;
  lastActive?: string;
  path?: string;
}

interface AgentViewResponse {
  agent: string;
  versions: AgentVersionInfo[];
}

async function listAgentVersions(agentKey: string): Promise<AgentVersionInfo[]> {
  const { runAgents } = await import('../core/agentsBin');
  try {
    const { stdout } = await runAgents(`view ${agentKey} --json`, {
      maxBuffer: 10 * 1024 * 1024,
    });
    const parsed: AgentViewResponse = JSON.parse(stdout);
    return parsed.versions || [];
  } catch {
    return [];
  }
}

// Resolve the newest installed version for an agent (used by the "(Latest)"
// launch commands). Returns null when nothing semver-shaped is installed.
async function resolveLatestVersion(agentKey: string): Promise<string | null> {
  const versions = await listAgentVersions(agentKey);
  return pickLatestVersion(versions.map(v => v.version)) ?? null;
}

function formatUsageStatus(status?: string): string {
  switch (status) {
    case 'available': return 'available';
    case 'rate_limited': return 'rate limited';
    case 'out_of_credits': return 'out of credits';
    default: return '';
  }
}

function formatVersionUsage(version: AgentVersionInfo): string {
  const weekWindow = version.windows?.find(w => w.key === 'week');
  if (weekWindow) {
    return `${weekWindow.usedPercent}% used`;
  }
  return '';
}

interface VersionQuickPickItem extends vscode.QuickPickItem {
  version: AgentVersionInfo;
}

async function pickAgentVersion(agentKey: string): Promise<AgentVersionInfo | null> {
  let versions: AgentVersionInfo[];
  try {
    versions = await listAgentVersions(agentKey);
  } catch (err: any) {
    const msg = err?.stderr || err?.message || String(err);
    vscode.window.showInformationMessage(`Failed to list versions: ${msg.slice(0, 120)}`);
    return null;
  }

  if (versions.length === 0) {
    vscode.window.showInformationMessage(`No ${agentKey} versions installed`);
    return null;
  }

  const pinButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('pin'),
    tooltip: 'Pin as default version',
  };

  const items: VersionQuickPickItem[] = versions.map(v => {
    const statusIcon = v.usageStatus === 'available' ? '$(check)' :
                       v.usageStatus === 'rate_limited' ? '$(warning)' :
                       v.usageStatus === 'out_of_credits' ? '$(error)' : '';
    const defaultTag = v.isDefault ? '$(pinned) ' : '';
    const usage = formatVersionUsage(v);
    const status = formatUsageStatus(v.usageStatus);

    return {
      label: `${defaultTag}${v.version}`,
      description: `${v.email || 'not signed in'}${status ? ` - ${status}` : ''}`,
      detail: `${statusIcon} ${v.plan || ''}${usage ? ` - ${usage}` : ''}`.trim(),
      version: v,
      buttons: v.isDefault ? [] : [pinButton],
    };
  });

  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<VersionQuickPickItem>();
    quickPick.title = `Pick ${agentKey} version`;
    quickPick.placeholder = 'Select to launch, or click pin icon to set as default';
    quickPick.items = items;
    quickPick.matchOnDescription = true;

    quickPick.onDidTriggerItemButton(async (e) => {
      const item = e.item;
      const { runAgents } = await import('../core/agentsBin');
      try {
        await runAgents(`use ${agentKey}@${item.version.version}`);
        vscode.window.showInformationMessage(`Pinned ${agentKey}@${item.version.version} as default`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to pin: ${err.message || err}`);
      }
      quickPick.hide();
      resolve(null);
    });

    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      quickPick.hide();
      resolve(selected?.version ?? null);
    });

    quickPick.onDidHide(() => {
      quickPick.dispose();
      resolve(null);
    });

    quickPick.show();
  });
}

interface UnifiedVersionInfo extends AgentVersionInfo {
  agentKey: string;
  agentTitle: string;
}

interface UnifiedVersionQuickPickItem extends vscode.QuickPickItem {
  unified: UnifiedVersionInfo;
}

function usageRank(status?: string): number {
  switch (status) {
    case 'available': return 0;
    case 'rate_limited': return 1;
    case 'out_of_credits': return 2;
    default: return 3;
  }
}

async function pickAnyAgentVersion(
  extensionPath: string
): Promise<{ agentKey: string; version: string } | null> {
  const AGENTS_TO_FETCH = ['claude', 'codex', 'gemini', 'cursor'];
  const allVersions: UnifiedVersionInfo[] = [];

  const results = await Promise.allSettled(
    AGENTS_TO_FETCH.map(async (agentKey) => {
      const versions = await listAgentVersions(agentKey);
      const def = getBuiltInByKey(agentKey);
      return versions.map(v => ({
        ...v,
        agentKey,
        agentTitle: def?.title || agentKey,
      }));
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allVersions.push(...result.value);
    }
  }

  if (allVersions.length === 0) {
    vscode.window.showInformationMessage('No agent versions installed');
    return null;
  }

  allVersions.sort((a, b) => {
    const rankDiff = usageRank(a.usageStatus) - usageRank(b.usageStatus);
    if (rankDiff !== 0) return rankDiff;
    const aWeek = a.windows?.find(w => w.key === 'week')?.usedPercent ?? 100;
    const bWeek = b.windows?.find(w => w.key === 'week')?.usedPercent ?? 100;
    return aWeek - bWeek;
  });

  const pinButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('pin'),
    tooltip: 'Pin as default version',
  };

  const items: UnifiedVersionQuickPickItem[] = allVersions.map(v => {
    const statusIcon = v.usageStatus === 'available' ? '$(check)' :
                       v.usageStatus === 'rate_limited' ? '$(warning)' :
                       v.usageStatus === 'out_of_credits' ? '$(error)' : '';
    const defaultTag = v.isDefault ? '$(pinned) ' : '';
    const usage = formatVersionUsage(v);
    const status = formatUsageStatus(v.usageStatus);
    const agentLabel = v.agentKey.charAt(0).toUpperCase() + v.agentKey.slice(1);

    return {
      label: `${defaultTag}${agentLabel} ${v.version}`,
      description: `${v.email || 'not signed in'}${status ? ` - ${status}` : ''}`,
      detail: `${statusIcon} ${v.plan || ''}${usage ? ` - ${usage}` : ''}`.trim(),
      unified: v,
      buttons: v.isDefault ? [] : [pinButton],
    };
  });

  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<UnifiedVersionQuickPickItem>();
    quickPick.title = 'Pick agent version';
    quickPick.placeholder = 'Select to launch, or click pin icon to set as default';
    quickPick.items = items;
    quickPick.matchOnDescription = true;

    quickPick.onDidTriggerItemButton(async (e) => {
      const item = e.item;
      const { runAgents } = await import('../core/agentsBin');
      try {
        await runAgents(`use ${item.unified.agentKey}@${item.unified.version}`);
        vscode.window.showInformationMessage(`Pinned ${item.unified.agentKey}@${item.unified.version} as default`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to pin: ${err.message || err}`);
      }
      quickPick.hide();
      resolve(null);
    });

    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      quickPick.hide();
      if (selected) {
        resolve({ agentKey: selected.unified.agentKey, version: selected.unified.version });
      } else {
        resolve(null);
      }
    });

    quickPick.onDidHide(() => {
      quickPick.dispose();
      resolve(null);
    });

    quickPick.show();
  });
}

async function listSessionsViaCli(limit = 30): Promise<CliSessionItem[]> {
  const { runAgents } = await import('../core/agentsBin');
  const { stdout } = await runAgents(`sessions list --all -n ${limit} --json`, {
    maxBuffer: 10 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];
  return parsed as CliSessionItem[];
}

function formatSessionWhen(timestamp: string): string {
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return '';
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function cleanSessionTopic(topic: string | undefined): string {
  if (!topic) return '(no topic)';
  return topic.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '(no topic)';
}

interface SessionPickerOptions {
  title: string;
  placeholder: string;
  pinShortId?: string | null;
  pinLabel?: string;
}

async function pickSession(opts: SessionPickerOptions): Promise<CliSessionItem | null> {
  let sessions: CliSessionItem[];
  try {
    sessions = await listSessionsViaCli(30);
  } catch (err: any) {
    const msg = err?.stderr || err?.message || String(err);
    if (msg.includes('ENOENT') || msg.includes('not found')) {
      vscode.window.showInformationMessage('agents CLI not found. Install with: npm i -g @swarmify/agents-cli');
    } else {
      vscode.window.showInformationMessage(`Failed to list sessions: ${msg.slice(0, 120)}`);
    }
    return null;
  }

  if (sessions.length === 0) {
    vscode.window.showInformationMessage('No sessions found');
    return null;
  }

  if (opts.pinShortId) {
    const idx = sessions.findIndex(s => s.shortId === opts.pinShortId || s.id === opts.pinShortId);
    if (idx > 0) {
      const [pinned] = sessions.splice(idx, 1);
      sessions.unshift(pinned);
    }
  }

  interface SessionQuickPickItem extends vscode.QuickPickItem {
    session: CliSessionItem;
  }

  const items: SessionQuickPickItem[] = sessions.map((s, idx) => {
    const agentLabel = s.version ? `${s.agent}@${s.version}` : s.agent;
    const when = formatSessionWhen(s.timestamp);
    const topic = cleanSessionTopic(s.topic);
    const isPinned = idx === 0 && opts.pinShortId &&
      (s.shortId === opts.pinShortId || s.id === opts.pinShortId);
    const pinTag = isPinned && opts.pinLabel ? `$(pinned) ${opts.pinLabel} · ` : '';
    return {
      label: `${pinTag}${s.shortId}  ${topic}`,
      description: `${agentLabel} · ${when}${s.account ? ` · ${s.account}` : ''}`,
      detail: `${s.project || '-'}${s.cwd ? `  ${s.cwd}` : ''}`,
      session: s,
    };
  });

  const picked = await vscode.window.showQuickPick<SessionQuickPickItem>(items, {
    title: opts.title,
    placeHolder: opts.placeholder,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  return picked?.session ?? null;
}

async function copySessionTrace(_context: vscode.ExtensionContext) {
  const activeTerminal = vscode.window.activeTerminal;
  const terminalEntry = activeTerminal ? terminals.getByTerminal(activeTerminal) : null;
  const currentSessionId = terminalEntry?.sessionId ?? null;
  const currentShortId = currentSessionId ? currentSessionId.slice(0, 8) : null;

  const session = await pickSession({
    title: 'Agents: Session Trace',
    placeholder: 'Pick a session to copy its trace to clipboard',
    pinShortId: currentShortId,
    pinLabel: 'Current',
  });
  if (!session) return;

  const { runAgents } = await import('../core/agentsBin');
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  try {
    const { stdout } = await runAgents(`sessions view ${session.id} --trace`, {
      maxBuffer: 10 * 1024 * 1024,
      cwd: workspacePath,
    });

    const lines = stdout.split('\n');
    const headerEnd = lines.findIndex(l => l.startsWith('# '));
    const trace = headerEnd >= 0 ? lines.slice(headerEnd).join('\n') : stdout;

    const agentLabel = session.version ? `${session.agent}@${session.version}` : session.agent;
    const header = [
      `## Session`,
      `- Agent: ${agentLabel}`,
      `- Session ID: ${session.id}`,
      session.cwd ? `- Directory: ${session.cwd}` : '',
      session.account ? `- Account: ${session.account}` : '',
    ].filter(Boolean).join('\n');

    const fullTrace = `${header}\n\n${trace}`;
    await vscode.env.clipboard.writeText(fullTrace);
    vscode.window.setStatusBarMessage(`Session trace copied (${session.shortId})`, 3000);
  } catch (err: any) {
    const msg = err?.message || 'Unknown error';
    vscode.window.showInformationMessage(`Failed to get session trace: ${msg.slice(0, 120)}`);
  }
}

async function copySessionId() {
  const activeTerminal = vscode.window.activeTerminal;

  if (!activeTerminal) {
    vscode.window.showInformationMessage('No active terminal');
    return;
  }

  const terminalEntry = terminals.getByTerminal(activeTerminal);

  if (!terminalEntry || !terminalEntry.agentConfig) {
    vscode.window.showInformationMessage('Active terminal is not an agent terminal');
    return;
  }

  // The session id stored on terminalEntry is the spawn-time value. It goes
  // stale when the user exits and reruns the agent in the same terminal, or
  // after /clear. Prefer the live id captured by the SessionStart hook
  // (~/.agents/.cache/terminals/sessions/<agent-pid>.json).
  const shellPid = await activeTerminal.processId;
  const liveId = await liveSessionIdForShell(shellPid);
  const sessionId = liveId || terminalEntry.sessionId;

  if (!sessionId) {
    vscode.window.showInformationMessage('No session ID available');
    return;
  }

  await vscode.env.clipboard.writeText(sessionId);
  vscode.window.setStatusBarMessage(`Session ID copied: ${sessionId.slice(0, 8)}...`, 3000);
}

function agentKeyFromSession(agent: CliSessionItem['agent']): PrewarmAgentType | null {
  if (agent === 'claude' || agent === 'codex' || agent === 'gemini' ||
      agent === 'opencode' || agent === 'cursor') {
    return agent;
  }
  return null;
}

async function resumeSession(context: vscode.ExtensionContext) {
  const activeTerminal = vscode.window.activeTerminal;
  const terminalEntry = activeTerminal ? terminals.getByTerminal(activeTerminal) : null;
  const currentSessionId = terminalEntry?.sessionId ?? null;
  const currentShortId = currentSessionId ? currentSessionId.slice(0, 8) : null;

  const session = await pickSession({
    title: 'Agents: Session Resume',
    placeholder: 'Pick a session to resume in a new terminal',
    pinShortId: currentShortId,
    pinLabel: 'Current',
  });
  if (!session) return;

  const agentKey = agentKeyFromSession(session.agent);
  if (!agentKey) {
    vscode.window.showInformationMessage(`Cannot resume sessions of type ${session.agent}`);
    return;
  }

  const builtIn = BUILT_IN_AGENTS.find(a => a.key === agentKey);
  if (!builtIn) {
    vscode.window.showInformationMessage(`No built-in agent config for ${agentKey}`);
    return;
  }

  const agentConfig = createAgentConfig(
    context.extensionPath,
    builtIn.title,
    builtIn.command,
    builtIn.icon,
    builtIn.prefix,
  );

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const resumeCmd = buildVersionedResumeCommand(agentKey, session.id, session.version);

  const terminalId = terminals.nextId(builtIn.prefix);
  const title = buildTerminalTitle(agentConfig.title, undefined, context, session.id);
  const terminal = vscode.window.createTerminal({
    iconPath: agentConfig.iconPath,
    location: { viewColumn: vscode.ViewColumn.Active },
    name: title,
    env: buildAgentTerminalEnv(terminalId, session.id, workspacePath, session.version),
    isTransient: true,
  });

  const pid = await terminal.processId;
  terminals.register(terminal, terminalId, agentConfig, pid, context);
  readiness.registerTerminal(terminal);
  terminals.setSessionId(terminal, session.id);
  terminals.setAgentType(terminal, agentKey);
  if (session.version) {
    terminals.setVersion(terminal, session.version);
  }
  if (session.account) {
    terminals.setAccount(terminal, session.account);
  }
  startAutoLabelPollerForTerminal(terminal, context);

  try {
    await readiness.waitFor(terminal, 'promptReady');
  } catch (err) {
    console.warn(`[READINESS] promptReady wait failed: ${err}`);
  }
  if (terminal.shellIntegration) {
    terminal.shellIntegration.executeCommand(resumeCmd);
  } else {
    terminal.sendText(resumeCmd);
  }
  readiness.armAgentReady(terminal, {
    agentKey,
    sessionId: session.id,
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  });

  terminal.show();
  vscode.window.setStatusBarMessage(`Resuming ${agentKey}${session.version ? `@${session.version}` : ''} · ${session.shortId}`, 3000);
}

async function fetchAgentsViewJson(
  agentKey: PrewarmAgentType,
  opts: { quiet?: boolean; useCache?: boolean } = {}
): Promise<AgentsViewJsonAgent | null> {
  const useCache = opts.useCache === true;
  if (useCache) {
    const cached = agentsViewCache.get(agentKey);
    if (cached && Date.now() - cached.fetchedAtMs < STATUS_BAR_AGENTS_VIEW_TTL_MS) {
      return cached.data;
    }
  }

  const { runAgents } = await import('../core/agentsBin');
  try {
    const { stdout } = await runAgents(`view ${agentKey} --json`, {
      maxBuffer: 5 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as AgentsViewJsonAgent;
    if (!parsed || !Array.isArray(parsed.versions)) {
      if (useCache) {
        agentsViewCache.set(agentKey, { fetchedAtMs: Date.now(), data: null });
      }
      return null;
    }
    if (useCache) {
      agentsViewCache.set(agentKey, { fetchedAtMs: Date.now(), data: parsed });
    }
    return parsed;
  } catch (err: any) {
    if (useCache) {
      agentsViewCache.set(agentKey, { fetchedAtMs: Date.now(), data: null });
    }
    if (!opts.quiet) {
      const msg = err?.stderr || err?.message || String(err);
      if (msg.includes('unknown option') || msg.includes('--json')) {
        vscode.window.showInformationMessage(
          'Needs @swarmify/agents-cli >= 1.13.0. Run: npm i -g @swarmify/agents-cli'
        );
      } else {
        vscode.window.showInformationMessage(`Failed to query agents view: ${msg.slice(0, 120)}`);
      }
    }
    return null;
  }
}

export type RotateOutcome =
  | { status: 'no_session' }
  | { status: 'unsupported_agent' }
  | { status: 'view_unavailable' }
  | { status: 'already_usable'; agentKey: string; version: string; usedPercent: number }
  | { status: 'no_versions'; agentKey: string }
  | { status: 'rotated'; agentKey: string; oldVersion?: string; newVersion: string; newSessionId: string; email: string | null; usedPercent: number };

async function resumeCurrentInBestProfile(context: vscode.ExtensionContext) {
  const activeTerminal = vscode.window.activeTerminal;
  if (!activeTerminal) {
    vscode.window.showInformationMessage('No active terminal');
    return;
  }
  const terminalEntry = terminals.getByTerminal(activeTerminal);
  if (!terminalEntry) {
    vscode.window.showInformationMessage('Active terminal has no session to resume');
    return;
  }
  const outcome = await rotateTerminalToBestVersion(context, terminalEntry, {
    closeOldTerminal: false,
    focusNewTerminal: true,
    notifyOnFailure: true,
  });
  if (outcome.status === 'no_session') {
    vscode.window.showInformationMessage('Active terminal has no session to resume');
  }
}

export async function rotateTerminalToBestVersion(
  context: vscode.ExtensionContext,
  terminalEntry: terminals.EditorTerminal,
  opts: { closeOldTerminal: boolean; focusNewTerminal: boolean; notifyOnFailure: boolean }
): Promise<RotateOutcome> {
  if (!terminalEntry.sessionId) {
    return { status: 'no_session' };
  }

  const agentKey = terminalEntry.agentType
    || prefixToAgentType(terminalEntry.agentConfig?.prefix ?? null);
  if (!agentKey || !supportsPrewarming(agentKey)) {
    return { status: 'unsupported_agent' };
  }

  const data = await fetchAgentsViewJson(agentKey);
  if (!data) return { status: 'view_unavailable' };

  // If the active terminal already sits on a version that still has usage,
  // there's nothing to do — "best" is really "any version with usage", so
  // a usable current version IS the best. Skip the terminal churn and the
  // /continue round-trip. Undefined version falls through to the legacy
  // switch path (we can't reason about untagged terminals).
  const currentVersion = terminalEntry.version;
  if (currentVersion) {
    const currentVersionData = data.versions.find(v => v.version === currentVersion);
    if (isVersionStillUsable(currentVersionData)) {
      if (opts.focusNewTerminal) {
        terminalEntry.terminal.show();
        vscode.window.setStatusBarMessage(
          `Already on ${agentKey}@${currentVersion} · ${sessionUsedPercent(currentVersionData!)}% session`,
          3000
        );
      }
      console.log(`[RESUME-IN-BEST] skipping switch — terminal already on usable version ${agentKey}@${currentVersion}`);
      return {
        status: 'already_usable',
        agentKey,
        version: currentVersion,
        usedPercent: sessionUsedPercent(currentVersionData!),
      };
    }
  }

  const best = pickBestVersion(data.versions);
  if (!best) {
    if (opts.notifyOnFailure) {
      vscode.window.showInformationMessage(
        `No signed-in ${agentKey} versions available. Run: agents add ${agentKey}@latest`
      );
    }
    return { status: 'no_versions', agentKey };
  }

  const builtIn = BUILT_IN_AGENTS.find(a => a.key === agentKey);
  if (!builtIn) {
    if (opts.notifyOnFailure) {
      vscode.window.showInformationMessage(`No built-in agent config for ${agentKey}`);
    }
    return { status: 'unsupported_agent' };
  }

  const agentConfig = createAgentConfig(
    context.extensionPath,
    builtIn.title,
    builtIn.command,
    builtIn.icon,
    builtIn.prefix,
  );

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

  // The OLD session id lives in the terminal we're resuming FROM — it
  // belongs to whatever version's home originally created it. We pass
  // this to /continue so the new agent loads that transcript.
  const oldSessionId = terminalEntry.sessionId;

  // Generate a NEW session id for the fresh claude process. Passing it
  // via `--session-id` does two things:
  //   1. Claude creates its jsonl at a path readiness can predict, so
  //      fs.watch fires `agentReady` the moment the TUI is live — much
  //      more reliable than polling process state, which was firing
  //      during the shim/node startup window BEFORE Claude was actually
  //      accepting input (that's why /continue was landing at zsh).
  //   2. The terminal's AGENT_SESSION_ID stays consistent with the UUID
  //      Claude actually uses, so session tracking doesn't drift.
  // Only Claude supports `--session-id` right now; other agents fall
  // back to reusing the old id and the generic ps/pgrep probe.
  const supportsSessionIdFlag = agentKey === 'claude';
  const newSessionId = supportsSessionIdFlag ? randomUUID() : oldSessionId;
  const launchCmd = buildLaunchCommand(
    builtIn.command,
    best.version,
    agentKey,
    supportsSessionIdFlag ? newSessionId : null,
  );

  const terminalId = terminals.nextId(builtIn.prefix);
  const title = buildTerminalTitle(agentConfig.title, undefined, context, newSessionId);
  const terminal = vscode.window.createTerminal({
    iconPath: agentConfig.iconPath,
    location: { viewColumn: vscode.ViewColumn.Active },
    name: title,
    env: buildAgentTerminalEnv(terminalId, newSessionId, workspacePath, best.version),
    isTransient: true,
  });

  const pid = await terminal.processId;
  terminals.register(terminal, terminalId, agentConfig, pid, context);
  readiness.registerTerminal(terminal);
  terminals.setSessionId(terminal, newSessionId);
  terminals.setAgentType(terminal, agentKey);
  terminals.setVersion(terminal, best.version);
  terminals.setAccount(terminal, best.email);
  startAutoLabelPollerForTerminal(terminal, context);

  // /continue takes the OLD session id (the transcript we want to load),
  // not the new one (which is just the container for the fresh process).
  // Prefer the /continue slash command if it's synced to this version's
  // home; otherwise inline the full instructions.
  const versionHomeCommand = path.join(
    os.homedir(), '.agents-system', 'versions', agentKey, best.version,
    'home', '.claude', 'commands', 'continue.md'
  );
  const hasContinueCmd = fsSync.existsSync(versionHomeCommand);

  let centralContinueMdBody: string | null = null;
  if (!hasContinueCmd) {
    const centralCommand = path.join(os.homedir(), '.agents-system', 'commands', 'continue.md');
    try {
      centralContinueMdBody = fsSync.readFileSync(centralCommand, 'utf-8');
    } catch {
      centralContinueMdBody = null;
    }
  }
  const resumeInput = buildResumeInput(oldSessionId, hasContinueCmd, centralContinueMdBody);

  const t0 = Date.now();
  const elapsed = () => `t+${Date.now() - t0}ms`;
  console.log(`[RESUME-IN-BEST] ${elapsed()} starting — agent=${agentKey}@${best.version} oldSession=${oldSessionId.slice(0, 8)} newSession=${newSessionId.slice(0, 8)} cmdSynced=${hasContinueCmd}`);

  try {
    await readiness.waitFor(terminal, 'promptReady');
    console.log(`[RESUME-IN-BEST] ${elapsed()} promptReady — sending launch: ${launchCmd}`);
  } catch (err) {
    console.warn(`[RESUME-IN-BEST] ${elapsed()} promptReady wait FAILED: ${err} — sending launch anyway`);
  }
  terminal.sendText(launchCmd);
  // Pass the NEW session id so readiness can watch for its jsonl file
  // appearing — that's the signal that Claude's TUI is live and accepting
  // input on the pty.
  readiness.armAgentReady(terminal, {
    agentKey,
    sessionId: newSessionId,
    cwd: workspacePath,
  });
  if (opts.focusNewTerminal) {
    terminal.show();
  }

  // Send the resume input only after the agent CLI is actually idle on the
  // pty. Replaces a hardcoded 6s guess that was unreliable on slow machines
  // (never enough) and wasteful on fast ones (always too much).
  // Claude Code's TUI uses Ink (React for CLI) which puts stdin in raw mode
  // and watches for `\r` as Enter. VS Code's `sendText(text, true)` appends
  // `\n` on macOS, which types into the input box but does NOT submit.
  // Explicit two-step: type the payload with shouldExecute=false, then
  // separately send `\r` to signal Enter. Precedent: tmux.ts:71 uses tmux's
  // `send-keys … Enter` keyword for the same reason.
  const submitToTui = () => {
    terminal.sendText(resumeInput, false);
    // Same bracketed-paste race as openSingleAgentWithQueue's flushQueued:
    // multi-line input swallows a same-tick \r, so Enter goes after a beat.
    setTimeout(() => terminal.sendText('\r', false), 300);
  };
  readiness.waitFor(terminal, 'agentReady').then(
    () => {
      console.log(`[RESUME-IN-BEST] ${elapsed()} agentReady — sending resume input (${resumeInput.length} chars): ${resumeInput.slice(0, 80)}${resumeInput.length > 80 ? '…' : ''}`);
      submitToTui();
      if (opts.closeOldTerminal) {
        try {
          terminalEntry.terminal.dispose();
          console.log(`[RESUME-IN-BEST] ${elapsed()} disposed old terminal ${terminalEntry.id}`);
        } catch (err) {
          console.warn(`[RESUME-IN-BEST] failed to dispose old terminal: ${err}`);
        }
      }
    },
    (err) => {
      console.warn(`[RESUME-IN-BEST] ${elapsed()} agentReady wait FAILED: ${err} — sending resume input anyway`);
      submitToTui();
      if (opts.closeOldTerminal) {
        try {
          terminalEntry.terminal.dispose();
        } catch (e) {
          console.warn(`[RESUME-IN-BEST] failed to dispose old terminal: ${e}`);
        }
      }
    },
  );

  const acct = best.email ? ` (${best.email})` : '';
  const usage = `${sessionUsedPercent(best)}% session`;
  vscode.window.setStatusBarMessage(
    `Resumed ${agentKey}@${best.version}${acct} · ${usage} · ${newSessionId.slice(0, 8)}`,
    5000
  );

  return {
    status: 'rotated',
    agentKey,
    oldVersion: currentVersion,
    newVersion: best.version,
    newSessionId,
    email: best.email,
    usedPercent: sessionUsedPercent(best),
  };
}

interface TerminalQuickPickItem extends vscode.QuickPickItem {
  terminal: vscode.Terminal;
  lastActivityMs?: number;
}

async function getSessionPreviewForEntry(
  entry: terminals.EditorTerminal,
  workspacePath?: string
): Promise<{ firstUserMessage?: string; lastUserMessage?: string; lastActivityMs?: number; messageCount: number } | null> {
  if (!entry.sessionId) return null;
  const agentType = entry.agentType || prefixToAgentType(entry.agentConfig?.prefix ?? null);
  if (!agentType) return null;

  const sessionPath = await getSessionPathBySessionId(
    entry.sessionId,
    agentType,
    workspacePath
  );
  if (!sessionPath) return null;

  if (agentType === 'opencode') {
    return await getOpenCodeSessionPreviewInfo(sessionPath);
  }
  if (agentType === 'cursor') {
    return await getCursorSessionPreviewInfo(sessionPath);
  }
  return await getSessionPreviewInfo(sessionPath);
}

function cycleAgentTerminal(direction: 1 | -1) {
  const agentEntries = terminals.getAllTerminals().filter(e => e.agentConfig);
  if (agentEntries.length === 0) return;

  const active = vscode.window.activeTerminal;
  const currentIdx = active ? agentEntries.findIndex(e => e.terminal === active) : -1;
  const startIdx = currentIdx === -1 ? (direction === 1 ? -1 : 0) : currentIdx;
  const nextIdx = (startIdx + direction + agentEntries.length) % agentEntries.length;

  agentEntries[nextIdx].terminal.show();
}

async function goToTerminal(context: vscode.ExtensionContext) {
  const allEntries = terminals.getAllTerminals();
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const items: TerminalQuickPickItem[] = [];
  const previewPromises: Array<{ itemIndex: number; entry: terminals.EditorTerminal; promise: Promise<{ firstUserMessage?: string; lastUserMessage?: string; lastActivityMs?: number; messageCount: number } | null> }> = [];

  const display = getDisplayPrefs(context);
  const extensionPath = context.extensionPath;

  for (const entry of allEntries) {
    if (!entry.agentConfig) continue;

    const effectiveTitle = entry.label || entry.autoLabel || 'Untitled';
    const itemIndex = items.length;

    items.push({
      label: effectiveTitle,
      description: '',
      detail: '',
      iconPath: buildIconPath(entry.agentConfig.title, extensionPath) ?? undefined,
      terminal: entry.terminal
    });

    if (entry.sessionId) {
      previewPromises.push({
        itemIndex,
        entry,
        promise: getSessionPreviewForEntry(entry, workspacePath)
      });
    }
  }

  if (items.length === 0) {
    vscode.window.showInformationMessage('No agent terminals open');
    return;
  }

  const previewResults = await Promise.all(previewPromises.map(p => p.promise));
  for (let i = 0; i < previewPromises.length; i++) {
    const previewPromise = previewPromises[i];
    const entry = previewPromise.entry;
    const idx = previewPromise.itemIndex;
    const info = previewResults[i];
    if (info) {
      if (!entry.label && !entry.autoLabel && info.firstUserMessage) {
        const words = extractFirstNWords(info.firstUserMessage, 5);
        const ticket = extractLinearTicketId(info.firstUserMessage);
        const generatedTitle = ticket && words ? `${ticket} ${words}` : (ticket ?? words);
        if (generatedTitle) {
          terminals.setAutoLabel(entry.terminal, generatedTitle);
          items[idx].label = generatedTitle;
        }
      }

      if (info.lastActivityMs) {
        const diffMs = Date.now() - info.lastActivityMs;
        items[idx].description = diffMs < 60_000 ? 'Just now' : formatRelativeTime(info.lastActivityMs);
        items[idx].lastActivityMs = info.lastActivityMs;
      }

      const parts: string[] = [];
      if (info.firstUserMessage) parts.push(truncateText(info.firstUserMessage, 80));
      if (info.messageCount > 0) parts.push(`(${info.messageCount})`);
      items[idx].detail = parts.join(' ');
    }
  }

  items.sort((a, b) => (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0));

  const maxLabelLen = items.reduce((m, i) => Math.max(m, i.label.length), 0);
  const targetLen = maxLabelLen + 6;
  for (const item of items) {
    if (item.description) {
      const padCount = Math.max(1, targetLen - item.label.length);
      item.label = item.label + '\u00a0'.repeat(padCount);
    }
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Go to terminal',
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (selected) {
    selected.terminal.show();
  }
}

export async function openSingleAgentWithQueue(
  context: vscode.ExtensionContext,
  agentConfig: Omit<AgentConfig, 'count'>,
  messages: string[],
  opts?: { cwd?: string; mode?: AgentLaunchMode; sessionId?: string }
): Promise<{ terminalId: string; sessionId: string | null }> {
  const editorLocation: vscode.TerminalEditorLocationOptions = {
    viewColumn: vscode.ViewColumn.Active,
    preserveFocus: false
  };

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const terminalId = terminals.nextId(agentConfig.prefix);
  // An explicit cwd (task dispatch resolved the task's repo to a local clone)
  // pins the terminal there; otherwise the workspace folder + optional
  // worktree isolation applies as before.
  const { cwd, isolated: worktreeIsolated } = opts?.cwd
    ? { cwd: opts.cwd, isolated: false }
    : await resolveTerminalCwd(workspaceFolder, terminalId);

  // Determine agent key and handle session ID
  const builtInDef = getBuiltInByPrefix(agentConfig.prefix);
  const agentKey = builtInDef?.key as 'claude' | 'codex' | 'gemini' | 'opencode' | 'cursor' | undefined;
  const defaultModel = agentKey ? settings.getDefaultModel(context, agentKey) : undefined;

  let command = agentConfig.command;
  let sessionId: string | null = null;
  let opencodeSessionsBefore: string[] | null = null;

  if (agentKey === 'opencode') {
    opencodeSessionsBefore = await listOpencodeSessions(cwd);
  }

  if (agentKey === 'claude') {
    // Claude: generate session ID at open time; others are discovered post-spawn.
    // A caller (dispatch) may pre-supply the id so it can watch that exact
    // session file for a plan / completion afterwards.
    sessionId = opts?.sessionId ?? generateClaudeSessionId();
    command = buildClaudeLaunchCommand(context, sessionId, defaultModel, undefined, opts?.mode);
  }

  const title = buildTerminalTitle(agentConfig.title, undefined, context, sessionId);
  const terminal = vscode.window.createTerminal({
    iconPath: agentConfig.iconPath,
    location: editorLocation,
    name: title,
    env: buildAgentTerminalEnv(terminalId, sessionId, cwd),
    cwd: worktreeIsolated || opts?.cwd ? cwd : undefined,
    isTransient: true
  });

  const pid = await terminal.processId;
  terminals.register(terminal, terminalId, agentConfig, pid, context);
  readiness.registerTerminal(terminal);

  // Track session ID and agent type
  if (agentKey && supportsPrewarming(agentKey)) {
    // Set agent type unconditionally so the sessionTracker fs watcher can adopt
    // a session id when the CLI writes a fresh rollout/jsonl (Codex 0.124+
    // dropped session id from the TUI banner so this is the only signal).
    terminals.setAgentType(terminal, agentKey);
    if (sessionId) {
      terminals.setSessionId(terminal, sessionId);
    }
  }

  // Pull focus from the webview so the terminal tab becomes the visible one.
  terminal.show(false);

  // Queue messages
  for (const msg of messages) {
    terminals.queueMessage(terminal, msg);
  }

  if (command) {
    await sendCommandWhenReady(terminal, command);
  }

  // Arm agentReady detection so the session-file fast path can fire.
  readiness.armAgentReady(terminal, agentKey && sessionId
    ? { agentKey, sessionId, cwd }
    : {});

  if (agentKey === 'opencode' && opencodeSessionsBefore !== null) {
    detectOpencodeSessionId(terminal, terminalId, cwd, opencodeSessionsBefore, context);
  }

  // Flush queued messages once the agent is ready to accept input.
  // Ink TUIs (Claude) watch for `\r` as Enter; `sendText(text, true)` appends
  // `\n` which types into the input but does NOT submit. See the resume flow
  // around line 2086 for the same workaround.
  // 45s hard-timeout fallback: if agentReady never fires (agent exits early,
  // slow machine), we still attempt delivery so the user sees the prompt.
  const AGENT_READY_FALLBACK_MS = 45_000;
  const flushQueued = () => {
    const queued = terminals.flushQueue(terminal);
    queued.forEach((msg, i) => {
      setTimeout(() => {
        terminal.sendText(msg, false);
        // Multi-line prompts go over the pty as a bracketed paste; a \r sent
        // in the same tick gets consumed as paste content and the input never
        // submits. Let the TUI finish ingesting the paste before Enter.
        setTimeout(() => terminal.sendText('\r', false), 300);
      }, i * 700);
    });
  };
  const fallbackHandle = setTimeout(flushQueued, AGENT_READY_FALLBACK_MS);
  readiness.waitFor(terminal, 'agentReady').then(() => {
    clearTimeout(fallbackHandle);
    flushQueued();
  }).catch(() => {
    // waitFor rejects on timeout — fallback handle already scheduled
  });

  return { terminalId, sessionId };
}

async function openAgentTerminals(context: vscode.ExtensionContext) {
  const agents = getAgentsToOpen(context);

  if (agents.length === 0) {
    vscode.window.showInformationMessage('No agents configured to open on login. Use "Agents" to configure.');
    return;
  }

  const editorLocation: vscode.TerminalEditorLocationOptions = {
    viewColumn: vscode.ViewColumn.Active,
    preserveFocus: false
  };

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  let totalCount = 0;

  for (const agent of agents) {
    for (let i = 0; i < agent.count; i++) {
      // Generate ID first for env var
      const terminalId = terminals.nextId(agent.prefix);

      // Determine agent key and handle session ID
      const builtInDef = getBuiltInByPrefix(agent.prefix);
      const agentKey = builtInDef?.key as 'claude' | 'codex' | 'gemini' | 'opencode' | undefined;
      const defaultModel = agentKey ? settings.getDefaultModel(context, agentKey) : undefined;

      let command = agent.command;
      let sessionId: string | null = null;
      let opencodeSessionsBefore: string[] | null = null;

      if (agentKey === 'opencode') {
        opencodeSessionsBefore = await listOpencodeSessions(cwd);
      }

      if (agentKey === 'claude') {
        // Claude: generate session ID at open time; others are discovered post-spawn.
        sessionId = generateClaudeSessionId();
        command = buildClaudeLaunchCommand(context, sessionId, defaultModel);
        console.log(`[SESSION] Auto-open Claude with session ID: ${sessionId}`);
      }

      const title = buildTerminalTitle(agent.title, undefined, context, sessionId);

      const terminal = vscode.window.createTerminal({
        iconPath: agent.iconPath,
        location: editorLocation,
        name: title,
        env: buildAgentTerminalEnv(terminalId, sessionId, cwd),
        isTransient: true
      });

      const pid = await terminal.processId;
      terminals.register(terminal, terminalId, agent, pid, context);
      readiness.registerTerminal(terminal);

      // Track session ID
      if (agentKey && supportsPrewarming(agentKey)) {
        // Set agent type unconditionally so sessionTracker fs watcher can adopt
        // a session id from the CLI's rollout file (Codex 0.124+ banner has none).
        terminals.setAgentType(terminal, agentKey);
        if (sessionId) {
          terminals.setSessionId(terminal, sessionId);
        }
        startAutoLabelPollerForTerminal(terminal, context);
      }

      if (command) {
        try {
          await readiness.waitFor(terminal, 'promptReady');
        } catch (err) {
          console.warn(`[READINESS] promptReady wait failed: ${err}`);
        }
        if (terminal.shellIntegration) {
          terminal.shellIntegration.executeCommand(command);
        } else {
          terminal.sendText(command);
        }
        readiness.armAgentReady(terminal, agentKey && sessionId
          ? { agentKey, sessionId, cwd }
          : {});
      }
      if (agentKey === 'opencode' && opencodeSessionsBefore !== null) {
        detectOpencodeSessionId(terminal, terminalId, cwd, opencodeSessionsBefore, context);
      }
      totalCount++;
    }
  }

  if (totalCount > 0) {
    vscode.window.showInformationMessage(`Opened ${totalCount} agent terminal${totalCount > 1 ? 's' : ''}`);
  }
}

interface FetchAutoLabelOpts {
  force?: boolean;
  useFullConversation?: boolean;
}

async function fetchAndSetAutoLabel(
  terminal: vscode.Terminal,
  entry: terminals.EditorTerminal,
  opts: FetchAutoLabelOpts = {}
): Promise<string | undefined> {
  if (!entry.sessionId) return entry.autoLabel;
  if (!opts.force && entry.autoLabel) return entry.autoLabel;

  try {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const previewInfo = await getSessionPreviewForEntry(entry, workspacePath);
    if (!previewInfo) return undefined;
    if (!previewInfo.firstUserMessage) return undefined;

    const ticket = extractLinearTicketId(previewInfo.firstUserMessage);

    // Prefer Claude's own persisted session name (the title shown by /status)
    // — it's already a clean human summary and avoids a redundant LLM call.
    // Codex/Gemini/Opencode don't persist this yet, so they fall through to
    // the LLM path.
    if (entry.agentType === 'claude') {
      const persistedName = await readClaudeSessionName(entry.sessionId);
      if (persistedName) {
        const claudeLabel = ticket ? `${ticket} ${persistedName}` : persistedName;
        terminals.setAutoLabel(terminal, claudeLabel);
        return claudeLabel;
      }
    }

    const sourceText = opts.useFullConversation && previewInfo.lastUserMessage
      ? `Initial task:\n${previewInfo.firstUserMessage}\n\nLatest activity:\n${previewInfo.lastUserMessage}`
      : previewInfo.firstUserMessage;

    const llmTitle = await generateLabelWithLLM(sourceText);
    const fallback = extractFirstNWords(previewInfo.firstUserMessage, 5);
    const base = llmTitle ?? fallback;
    const autoLabel = ticket && base ? `${ticket} ${base}` : (ticket ?? base);

    if (autoLabel) {
      terminals.setAutoLabel(terminal, autoLabel);
    }
    return autoLabel ?? undefined;
  } catch {
    return undefined;
  }
}

function startAutoLabelPollerForTerminal(terminal: vscode.Terminal, context: vscode.ExtensionContext): void {
  const display = getDisplayPrefs(context);
  if (!display.autoLabelInTabTitles) return;

  const entry = terminals.getByTerminal(terminal);
  if (!entry || entry.label || entry.autoLabel) return;
  if (!entry.sessionId || !entry.agentType) return;

  terminals.startAutoLabelPoller(terminal, async () => {
    const autoLabel = await fetchAndSetAutoLabel(terminal, entry);
    if (autoLabel && vscode.window.activeTerminal === terminal) {
      updateStatusBarForTerminal(terminal, context.extensionPath);
    }
  });
}

// Arm shell-adoption on an SH terminal: poll its descendant process tree for
// a known agent CLI (claude/codex/gemini/cursor/opencode). On detection,
// re-register the entry as the detected agent so the dashboard, session
// tracker, label generation, autogit, and recap all treat it as that agent.
// The VS Code tab icon is immutable so it keeps the SH chip — internal
// state and downstream display only.
function armShellAdoptionForTerminal(terminal: vscode.Terminal, context: vscode.ExtensionContext): void {
  const entry = terminals.getByTerminal(terminal);
  if (!entry) {
    appendAdoptionLog(`armShellAdoptionForTerminal: "${terminal.name}" not in terminals registry — skipping`);
    return;
  }
  if (entry.agentConfig?.prefix !== 'sh') {
    appendAdoptionLog(`armShellAdoptionForTerminal: "${terminal.name}" prefix=${entry.agentConfig?.prefix}, not 'sh' — skipping`);
    return;
  }

  appendAdoptionLog(`armShellAdoptionForTerminal: calling readiness.armShellAdoption for "${terminal.name}" (id=${entry.id})`);

  readiness.armShellAdoption(terminal, ({ agentKey, sessionId }) => {
    appendAdoptionLog(`armShellAdoptionForTerminal callback: agentKey=${agentKey} sessionId=${sessionId} terminal="${terminal.name}"`);
    const def = getBuiltInByKey(agentKey);
    if (!def) {
      appendAdoptionLog(`armShellAdoptionForTerminal callback: no built-in def for "${agentKey}" — aborting`);
      console.warn(`[ADOPT] No built-in def for agent key "${agentKey}"`);
      return;
    }
    const newConfig = createAgentConfig(
      context.extensionPath,
      def.title,
      def.command,
      def.icon,
      def.prefix
    );
    const adopted = terminals.adoptShellAsAgent(terminal, newConfig, agentKey, sessionId);
    appendAdoptionLog(`armShellAdoptionForTerminal callback: adoptShellAsAgent returned ${adopted}`);
    if (!adopted) return;
    if (sessionId && supportsPrewarming(agentKey)) {
      startAutoLabelPollerForTerminal(terminal, context);
    }
    if (vscode.window.activeTerminal === terminal) {
      updateStatusBarForTerminal(terminal, context.extensionPath);
    }
  });
}

function appendAdoptionLog(msg: string): void {
  try {
    const file = path.join(os.homedir(), '.cache', 'swarmify', 'shell-adoption.log');
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    fsSync.appendFileSync(file, `${new Date().toISOString()} [ext] ${msg}\n`);
  } catch { /* ignore */ }
}

/**
 * Try to fetch and set the auto-label when terminal gains focus.
 * This provides immediate label update instead of waiting for the 5-minute poller.
 * Also updates the terminal tab title if showLabelsInTitles is enabled.
 */
async function tryFetchLabelOnFocus(
  terminal: vscode.Terminal,
  context: vscode.ExtensionContext
): Promise<void> {
  const entry = terminals.getByTerminal(terminal);
  if (!entry) return;

  // Skip if already has a label
  if (entry.label || entry.autoLabel) return;

  // Need sessionId and agentType to fetch label
  if (!entry.sessionId || !entry.agentType) return;

  // Fetch the label from session file
  const autoLabel = await fetchAndSetAutoLabel(terminal, entry);
  if (!autoLabel) return;

  // Update status bar
  updateStatusBarForTerminal(terminal, context.extensionPath);

  // Update terminal tab title if showLabelsInTitles is enabled.
  // Bail when the user has navigated away during the async LLM fetch — the
  // rename has to briefly activate this terminal, which switches the visible
  // editor tab. The label is already stored on the entry, so the next time
  // this terminal gets focus the title picks it up.
  const display = getDisplayPrefs(context);
  if (
    display.showLabelsInTitles &&
    display.autoLabelInTabTitles &&
    entry.agentConfig &&
    vscode.window.activeTerminal === terminal
  ) {
    const newTitle = buildTerminalTitle(
      entry.agentConfig.title,
      autoLabel,
      context,
      entry.sessionId
    );
    await terminals.renameTerminal(terminal, newTitle);
  }
}

function normalizeStatusEmail(email: string | null | undefined): string | undefined {
  const trimmed = email?.replace(/[<>]/g, '').trim();
  return trimmed || undefined;
}

function formatAgentStatusBarText(
  expandedName: string,
  version: string | undefined,
  account: string | undefined,
  label: string | null,
  sessionId: string | undefined,
  showTrackingHint = false,
): string {
  let text = `Agents: ${expandedName}`;
  if (version) {
    text += ` ${version}`;
  }
  if (account) {
    text += ` <${account}>`;
  }
  if (label) {
    text += ` - ${label}`;
  }
  if (sessionId) {
    text += ` (${sessionId})`;
  } else if (showTrackingHint) {
    text += ' (tracking session)';
  }
  return text;
}

function resolveStatusFromAgentsView(
  view: AgentsViewJsonAgent,
  pinnedVersion?: string
): { version?: string; account?: string } {
  const versions = Array.isArray(view.versions) ? view.versions : [];
  if (versions.length === 0) return {};

  if (pinnedVersion) {
    const matched = versions.find(v => v.version === pinnedVersion);
    return {
      version: pinnedVersion,
      account: normalizeStatusEmail(matched?.email),
    };
  }

  const selected = versions.find(v => v.isDefault) ?? versions[0];
  if (!selected) return {};
  return {
    version: selected.version,
    account: normalizeStatusEmail(selected.email),
  };
}

async function tryHydrateStatusBarAgentMeta(
  terminal: vscode.Terminal,
  entry: terminals.EditorTerminal,
  prefix: string
): Promise<void> {
  const agentKey = (entry.agentType || prefixToAgentType(prefix)) as PrewarmAgentType | null;
  if (!agentKey) return;

  const inflightKey = entry.id || `${agentKey}:${entry.sessionId || terminal.name}`;
  if (statusBarMetaInFlight.has(inflightKey)) return;
  statusBarMetaInFlight.add(inflightKey);

  try {
    const view = await fetchAgentsViewJson(agentKey, { quiet: true, useCache: true });
    if (!view) return;

    const resolved = resolveStatusFromAgentsView(view, entry.version);
    if (!entry.statusVersion && resolved.version) {
      entry.statusVersion = resolved.version;
    }
    if (entry.version && resolved.account && !entry.account) {
      terminals.setAccount(terminal, resolved.account);
    } else if (!entry.statusAccount && resolved.account) {
      entry.statusAccount = resolved.account;
    }

    if (!agentStatusBarItem || vscode.window.activeTerminal !== terminal) return;
    const rawLabel = entry.label;
    const displayLabel = rawLabel ? rawLabel.replace(/<[^>]*>/g, '').trim() : null;
    agentStatusBarItem.text = formatAgentStatusBarText(
      getExpandedAgentName(prefix),
      entry.version || entry.statusVersion,
      normalizeStatusEmail(entry.account || entry.statusAccount),
      displayLabel,
      entry.sessionId,
      entry.agentType === 'codex',
    );
  } finally {
    statusBarMetaInFlight.delete(inflightKey);
  }
}

const liveSessionInFlight = new Set<string>();

async function tryHydrateLiveSessionId(
  terminal: vscode.Terminal,
  prefix: string
): Promise<void> {
  const entry = terminals.getByTerminal(terminal);
  if (!entry) return;
  const inflightKey = entry.id || `live:${terminal.name}`;
  if (liveSessionInFlight.has(inflightKey)) return;
  liveSessionInFlight.add(inflightKey);

  try {
    const shellPid = await terminal.processId;
    const liveId = await liveSessionIdForShell(shellPid);
    if (!liveId) return;

    if (entry.sessionId !== liveId) {
      terminals.setSessionId(terminal, liveId);
    }

    if (!agentStatusBarItem || vscode.window.activeTerminal !== terminal) return;
    const rawLabel = entry.label;
    const displayLabel = rawLabel ? rawLabel.replace(/<[^>]*>/g, '').trim() : null;
    agentStatusBarItem.text = formatAgentStatusBarText(
      getExpandedAgentName(prefix),
      entry.version || entry.statusVersion,
      normalizeStatusEmail(entry.account || entry.statusAccount),
      displayLabel,
      liveId,
      entry.agentType === 'codex',
    );
  } finally {
    liveSessionInFlight.delete(inflightKey);
  }
}

function updateStatusBarForTerminal(terminal: vscode.Terminal, extensionPath: string) {
  if (!agentStatusBarItem) return;

  const entry = terminals.getByTerminal(terminal);
  const info = identifyAgentTerminal(terminal, extensionPath);

  // If this is an agent terminal, show model/account/session metadata.
  // Format: "Agents: Claude 2.1.118 <user@example.com> - <manual label> (uuid)"
  if (info.isAgent && info.prefix) {
    const expandedName = getExpandedAgentName(info.prefix);
    const sessionId = entry?.sessionId;

    // Show immediate status bar with current data
    const rawLabel = entry?.label;
    const displayLabel = rawLabel ? rawLabel.replace(/<[^>]*>/g, '').trim() : null;
    const version = entry?.version || entry?.statusVersion;
    const account = normalizeStatusEmail(entry?.account || entry?.statusAccount);
    agentStatusBarItem.text = formatAgentStatusBarText(
      expandedName,
      version,
      account,
      displayLabel,
      sessionId,
      entry?.agentType === 'codex',
    );

    if (entry && (!version || !account)) {
      void tryHydrateStatusBarAgentMeta(terminal, entry, info.prefix);
    }
    // Async-resolve the live session id from the SessionStart hook's state file
    // and re-render. Catches the case where the user exited and reran the
    // agent in the same terminal, or fired /clear — entry.sessionId is the
    // spawn-time value and goes stale; the hook's per-pid file has the truth.
    void tryHydrateLiveSessionId(terminal, info.prefix);

    return;
  }

  // Not an agent terminal - show "Terminal" for regular shells
  agentStatusBarItem.text = 'Agents: Terminal';
}

async function relabelActiveTerminal(context: vscode.ExtensionContext): Promise<void> {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    vscode.window.showInformationMessage('No active terminal to re-label.');
    return;
  }

  const entry = terminals.getByTerminal(terminal);
  if (!entry || !entry.sessionId || !entry.agentType) {
    vscode.window.showInformationMessage('This terminal does not have a session to summarize.');
    return;
  }

  terminals.setAutoLabel(terminal, undefined);

  const newLabel = await fetchAndSetAutoLabel(terminal, entry, {
    force: true,
    useFullConversation: true
  });

  if (!newLabel) {
    vscode.window.showInformationMessage('Could not generate a label from session activity.');
    return;
  }

  updateStatusBarForTerminal(terminal, context.extensionPath);

  const display = getDisplayPrefs(context);
  if (display.showLabelsInTitles && display.autoLabelInTabTitles && entry.agentConfig) {
    const newTitle = buildTerminalTitle(
      entry.agentConfig.title,
      newLabel,
      context,
      entry.sessionId
    );
    await terminals.renameTerminal(terminal, newTitle);
  }
}

function setStatusBarLabelForActiveTerminal(context: vscode.ExtensionContext) {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    vscode.window.showInformationMessage('No active terminal to set status bar label.');
    return;
  }

  const info = identifyAgentTerminal(terminal, context.extensionPath);
  if (!info.isAgent) {
    vscode.window.showInformationMessage('This terminal is not an agent terminal.');
    return;
  }

  const currentLabel = info.label ?? '';

  vscode.window.showInputBox({
    prompt: 'Set a status bar label for this agent',
    placeHolder: 'Status bar label (max 5 words)',
    value: currentLabel
  }).then(async (input) => {
    if (input === undefined) {
      return;
    }

    // Ensure terminal is registered before setting label
    let entry = terminals.getByTerminal(terminal);
    if (!entry && info.prefix) {
      const def = getBuiltInDefByTitle(info.prefix);
      if (def) {
        const agentConfig = createAgentConfig(context.extensionPath, def.title, def.command, def.icon, def.prefix);
        const id = terminals.nextId(info.prefix);
        const pid = await terminal.processId;
        terminals.register(terminal, id, agentConfig, pid, context);
      }
    }

    const cleaned = sanitizeLabel(input.trim());
    await terminals.setLabel(terminal, cleaned || undefined, context);

    // Update status bar only (don't rename terminal tab)
    updateStatusBarForTerminal(terminal, context.extensionPath);

    // Optionally update tab title when labels are shown in titles
    const display = getDisplayPrefs(context);
    if (display.showLabelsInTitles && info.prefix) {
      const updatedEntry = terminals.getByTerminal(terminal);
      const newTitle = buildTerminalTitle(
        info.prefix,
        cleaned || undefined,
        context,
        updatedEntry?.sessionId || null
      );
      await terminals.renameTerminal(terminal, newTitle);
    }

    // Mirror the label into Claude via /rename when applicable.
    // Only fire when we have a non-empty label and the agent is Claude.
    if (cleaned && info.prefix === CLAUDE_TITLE) {
      terminal.sendText(`/rename ${cleaned}`, true);
    }
  });
}

async function clearActiveTerminal(context: vscode.ExtensionContext) {
  try {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      vscode.window.showErrorMessage('No active terminal to clear.');
      return;
    }

    const agentConfig = getAgentConfigFromTerminal(terminal, context);
    if (!agentConfig) {
      vscode.window.showErrorMessage('Could not identify agent type from active terminal.');
      return;
    }

    // Get agent type info for session handling
    const builtInDef = getBuiltInDefByTitle(agentConfig.title);
    const agentKey = builtInDef?.key as keyof AgentSettings['builtIn'] | undefined;

    // 1. Terminate current agent (Ctrl+C twice)
    terminal.show();
    await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', {
      text: '\u0003'
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', {
      text: '\u0003'
    });

    // Wait for the agent to release the pty and the shell prompt to reappear
    readiness.resetAfterAgentExit(terminal);
    try {
      await readiness.waitFor(terminal, 'promptReady');
    } catch (err) {
      console.warn(`[READINESS] promptReady wait after agent exit failed: ${err}`);
    }

    try {
      // 2. Generate new IDs for fresh session
      const newTerminalId = terminals.nextId(agentConfig.prefix);
      let newSessionId: string | null = null;
      let command = agentConfig.command || '';
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
      const defaultModel = agentKey ? settings.getDefaultModel(context, agentKey) : undefined;

      if (agentKey === 'claude') {
        // Claude: generate UUID on-demand
        newSessionId = generateClaudeSessionId();
        command = buildClaudeLaunchCommand(context, newSessionId, defaultModel);
      }

      // 3. Unregister old entry, re-register with new IDs
      terminals.unregister(terminal);
      const pid = await terminal.processId;
      terminals.register(terminal, newTerminalId, agentConfig, pid, context);

      // 4. Set new session/agent type
      if (agentKey && supportsPrewarming(agentKey)) {
        terminals.setAgentType(terminal, agentKey);
      }
      if (newSessionId && agentKey && supportsPrewarming(agentKey)) {
        terminals.setSessionId(terminal, newSessionId);
      }

      // 5. Clear labels and start fresh poller
      await terminals.setLabel(terminal, undefined, context);
      terminals.setAutoLabel(terminal, undefined);
      startAutoLabelPollerForTerminal(terminal, context);

      // 6. Unpin terminal
      await vscode.commands.executeCommand('workbench.action.unpinEditor');

      // 7. Update title with new session ID chunk
      const newTitle = buildTerminalTitle(agentConfig.title, null, context, newSessionId);
      await terminals.renameTerminal(terminal, newTitle);

      // 8. Restart agent with new session
      terminal.sendText('clear && ' + command);
      readiness.armAgentReady(terminal, agentKey && newSessionId
        ? { agentKey, sessionId: newSessionId, cwd }
        : {});

      // 9. Update status bar
      updateStatusBarForTerminal(terminal, context.extensionPath);

      const agentNum = newTerminalId.split('-').pop() || '';
      const numSuffix = agentNum ? ` agent # ${agentNum}` : ' agent';
      vscode.window.showInformationMessage(`Cleared ${getExpandedAgentName(agentConfig.title)}${numSuffix} (new session)`);
    } catch (sendError) {
      vscode.window.showWarningMessage('Terminal may have been closed. Please open a new agent terminal.');
    }
  } catch (error) {
    console.error('Error clearing terminal:', error);
    vscode.window.showErrorMessage(`Failed to clear terminal: ${error}`);
  }
}

async function reloadActiveTerminal(context: vscode.ExtensionContext) {
  try {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      vscode.window.showErrorMessage('No active terminal to reload.');
      return;
    }

    const entry = terminals.getByTerminal(terminal);
    if (!entry || !entry.agentConfig) {
      vscode.window.showErrorMessage('Active terminal is not an agent terminal.');
      return;
    }

    const agentConfig = entry.agentConfig;
    if (agentConfig.prefix) {
      await tryHydrateLiveSessionId(terminal, agentConfig.prefix);
    }
    const sessionId = entry.sessionId;
    const agentType = entry.agentType;

    if (!sessionId || !agentType) {
      vscode.window.showErrorMessage('This terminal does not have session tracking enabled. Reload requires a session ID.');
      return;
    }

    if (!supportsPrewarming(agentType)) {
      vscode.window.showErrorMessage('This agent type does not support session reload.');
      return;
    }

    const config = PREWARM_CONFIGS[agentType];
    const exitSequence = config.exitSequence;
    const resumeCommand = buildVersionedResumeCommand(agentType, sessionId, entry.version);

    terminal.show();
    for (const seq of exitSequence) {
      await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', {
        text: seq
      });
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    readiness.resetAfterAgentExit(terminal);
    try {
      await readiness.waitFor(terminal, 'promptReady');
    } catch (err) {
      console.warn(`[READINESS] promptReady wait after agent exit failed: ${err}`);
    }

    terminal.sendText(`clear && ${resumeCommand}`);
    readiness.armAgentReady(terminal, {
      agentKey: agentType,
      sessionId,
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    });

    updateStatusBarForTerminal(terminal, context.extensionPath);
  } catch (error) {
    console.error('Error reloading terminal:', error);
    vscode.window.showErrorMessage(`Failed to reload terminal: ${error}`);
  }
}

async function updateContextKeys(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('agents');
  // 'native' hides the "Disable Tmux" toggle; 'auto'/'tmux' show it (tmux is active).
  const tmuxEnabled = normalizeTerminalMode(config.get('terminalMode')) !== 'native';
  await vscode.commands.executeCommand('setContext', 'agents.tmuxEnabled', tmuxEnabled);

  const viewEnabled = workbench.isStreamlineLayout();
  await vscode.commands.executeCommand('setContext', 'agents.viewEnabled', viewEnabled);

  await vscode.commands.executeCommand('setContext', 'agents.warmingEnabled', false);

  const readerEnabled = settings.getSettings(context).editor?.markdownViewerEnabled ?? true;
  await vscode.commands.executeCommand('setContext', 'agents.readerEnabled', readerEnabled);
}

function updateActiveAgentContextKey(
  terminal: vscode.Terminal | undefined,
  extensionPath: string
): void {
  const isAgent = !!terminal && identifyAgentTerminal(terminal, extensionPath).isAgent;
  vscode.commands.executeCommand('setContext', 'agents.activeIsAgent', isAgent);
}

async function closeActiveAgentWithRecap(context: vscode.ExtensionContext): Promise<void> {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    await vscode.commands.executeCommand('workbench.action.terminal.kill');
    return;
  }

  const entry = terminals.getByTerminal(terminal);
  if (entry?.agentConfig?.prefix) {
    await tryHydrateLiveSessionId(terminal, entry.agentConfig.prefix);
  }
  const agentType = entry?.agentType;
  const sessionId = entry?.sessionId;
  const version = entry?.version;
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Not an agent terminal, or missing info we need — fall back to default close.
  if (!entry?.agentConfig || !sessionId || !agentType || !workspacePath || !isRecapSupported(agentType)) {
    await vscode.commands.executeCommand('workbench.action.terminal.kill');
    return;
  }

  // Launch the headless recap before disposing so the JSONL has stabilized.
  // We await up to the spawn() so we know the child has the file handle;
  // child.unref() inside runRecapHeadless means it survives this function.
  try {
    await runRecapHeadless({
      sessionId,
      agentType,
      version,
      workspacePath,
      extensionPath: context.extensionPath,
    });
  } catch (err) {
    console.warn('[recap] runRecapHeadless failed', err);
  }

  try {
    terminal.dispose();
  } catch (err) {
    console.warn('[recap] terminal.dispose() failed', err);
  }
}

async function detectDefaultAgentTitle(): Promise<string> {
  const candidates = [
    { title: CLAUDE_TITLE, key: 'claude' },
    { title: CODEX_TITLE, key: 'codex' },
    { title: GEMINI_TITLE, key: 'gemini' }
  ];

  for (const candidate of candidates) {
    if (await isAgentInstalled(candidate.key)) {
      return candidate.title;
    }
  }

  return CLAUDE_TITLE;
}

async function maybeRunFirstSetup(context: vscode.ExtensionContext, force = false): Promise<void> {
  const already = context.globalState.get<boolean>('agents.setupComplete', false);
  if (already && !force) {
    const stored = context.globalState.get<string>('agents.defaultAgentTitle');
    if (stored) {
      defaultAgentTitle = stored;
    }
    const storedSecondary = context.globalState.get<string>('agents.secondaryAgentTitle');
    if (storedSecondary) {
      secondaryAgentTitle = storedSecondary;
    }
    return;
  }

  // Set default agents on first setup
  defaultAgentTitle = CLAUDE_TITLE;
  secondaryAgentTitle = CODEX_TITLE;
  await context.globalState.update('agents.defaultAgentTitle', CLAUDE_TITLE);
  await context.globalState.update('agents.secondaryAgentTitle', CODEX_TITLE);

  // Ensure swarm MCP + command is enabled for the detected default agent only
  try {
    const def = getBuiltInDefByTitle(defaultAgentTitle);
    const cliAgent = def && ['claude', 'codex', 'gemini'].includes(def.key) ? def.key as swarm.AgentCli : undefined;
    if (cliAgent) {
      const status = await swarm.getSwarmStatus();
      const agentStatus = status.agents[cliAgent];
      if (agentStatus.cliAvailable && (!agentStatus.mcpEnabled || !agentStatus.commandInstalled)) {
        await swarm.setupSwarmIntegrationForAgent(cliAgent, context);
      }
    }
  } catch {
    // Non-fatal; user can rerun setup
  }

  await context.globalState.update('agents.setupComplete', true);
  vscode.window.showInformationMessage(`Agents setup completed. Default agent: ${defaultAgentTitle}.`);
}

// Git functions are now in ./git.vscode

async function spawnWithPrompt(
  context: vscode.ExtensionContext,
  args?: { agent?: string; prompt?: string }
): Promise<void> {
  let agentKey: string | undefined = args?.agent;
  let prompt: string | undefined = args?.prompt;

  if (!agentKey) {
    const items = BUILT_IN_AGENTS.map(a => ({ label: a.title, description: a.key }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Pick agent type' });
    if (!picked) return;
    agentKey = picked.description!;
  }

  if (prompt === undefined) {
    prompt = await vscode.window.showInputBox({ prompt: 'Prompt to send to the new agent' });
    if (prompt === undefined) return;
  }
  if (!prompt.trim()) return;

  const def = getBuiltInByKey(agentKey);
  if (!def) {
    vscode.window.showErrorMessage(`Unknown agent: ${agentKey}`);
    return;
  }

  const agentConfig = createAgentConfig(context.extensionPath, def.title, def.command, def.icon, def.prefix);
  await openSingleAgentWithQueue(context, agentConfig, [prompt]);
}

async function spawnWithContext(context: vscode.ExtensionContext): Promise<void> {
  const activeTerminal = vscode.window.activeTerminal;
  if (!activeTerminal) {
    vscode.window.showErrorMessage('No active terminal to continue from.');
    return;
  }

  const entryBefore = terminals.getByTerminal(activeTerminal);
  if (entryBefore?.agentConfig?.prefix) {
    await tryHydrateLiveSessionId(activeTerminal, entryBefore.agentConfig.prefix);
  }

  const entry = terminals.getByTerminal(activeTerminal);
  if (!entry?.sessionId) {
    vscode.window.showErrorMessage('No session ID found for the active terminal.');
    return;
  }

  if (!entry.agentConfig) {
    vscode.window.showErrorMessage('Active terminal is not an agent terminal.');
    return;
  }

  await openSingleAgentWithQueue(context, entry.agentConfig, [`/continue ${entry.sessionId}`]);
}

// Store context reference for deactivate
let extensionContext: vscode.ExtensionContext | undefined;

// Restore agent terminals from persisted sessions
// Called after scanExisting() on activation
async function restoreAgentTerminals(context: vscode.ExtensionContext): Promise<void> {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) return;

  const persisted = terminals.loadPersistedSessions(workspacePath);
  if (persisted.length === 0) return;

  // Check which persisted sessions are NOT properly tracked
  // (VS Code may have restored them but without our icons/env vars)
  const tracked = terminals.getAllTerminals();
  const trackedIds = new Set(tracked.map(e => e.id));

  const toRestore = persisted.filter(p => !trackedIds.has(p.terminalId));
  if (toRestore.length === 0) {
    terminals.clearPersistedSessions(workspacePath);
    return;
  }

  // Recreate terminals with proper properties
  // Note: With isTransient: true, VS Code won't auto-restore terminals,
  // so we don't need to close "broken" restores - we're the only restore path
  for (const session of toRestore) {
    // Handle shell separately (no built-in def)
    let agentConfig: Omit<import('./agents.vscode').AgentConfig, 'count'>;
    let displayTitle: string;

    if (session.prefix.toLowerCase() === 'sh') {
      agentConfig = createAgentConfig(context.extensionPath, 'SH', '', 'agents.png', 'sh');
      displayTitle = 'SH';
    } else {
      const def = getBuiltInByPrefix(session.prefix);
      if (!def) {
        console.log(`[RESTORE] Unknown prefix: ${session.prefix}, skipping`);
        continue;
      }
      agentConfig = createAgentConfig(context.extensionPath, def.title, def.command, def.icon, def.prefix);
      displayTitle = def.title;
    }

    const title = buildTerminalTitle(displayTitle, session.label, context, session.sessionId || null);

    const terminal = vscode.window.createTerminal({
      iconPath: agentConfig.iconPath,
      location: { viewColumn: vscode.ViewColumn.Active },
      name: title,
      env: buildAgentTerminalEnv(session.terminalId, session.sessionId || null, workspacePath, session.version, { scrubSensitive: session.prefix.toLowerCase() !== 'sh' }),
      isTransient: true
    });

    const pid = await terminal.processId;
    terminals.register(terminal, session.terminalId, agentConfig, pid, context, session.label);
    readiness.registerTerminal(terminal);

    // Preserve the version pin across reloads. The env var above is belt; this
    // is suspenders — without it, `resumeCurrentInBestProfile`'s "already on
    // usable version" short-circuit sees `terminalEntry.version === undefined`
    // and falls through to the full profile switch.
    if (session.version) {
      terminals.setVersion(terminal, session.version);
    }

    if (session.prefix.toLowerCase() === 'sh') {
      armShellAdoptionForTerminal(terminal, context);
    }

    // Restore session tracking metadata if present
    if (session.sessionId && session.agentType) {
      terminals.setSessionId(terminal, session.sessionId);
      terminals.setAgentType(terminal, session.agentType as SessionAgentType);
      startAutoLabelPollerForTerminal(terminal, context);

      // Actually resume the session by sending the resume command
      if (supportsPrewarming(session.agentType)) {
        const resumeCmd = buildVersionedResumeCommand(
          session.agentType,
          session.sessionId,
          session.version
        );
        try {
          await readiness.waitFor(terminal, 'promptReady');
        } catch (err) {
          console.warn(`[READINESS] promptReady wait failed: ${err}`);
        }
        if (terminal.shellIntegration) {
          terminal.shellIntegration.executeCommand(resumeCmd);
        } else {
          terminal.sendText(resumeCmd);
        }
        readiness.armAgentReady(terminal, {
          agentKey: session.agentType,
          sessionId: session.sessionId,
          cwd: workspacePath,
        });
      }
    }
  }

  terminals.clearPersistedSessions(workspacePath);
  console.log(`[RESTORE] Restored ${toRestore.length} agent terminal(s)`);
}

async function reopenLastClosedSession(context: vscode.ExtensionContext): Promise<void> {
  const closed = terminals.popClosedSession();
  if (!closed) {
    vscode.window.showInformationMessage('No recently closed sessions to reopen.');
    return;
  }

  if (!closed.agentConfig || !closed.sessionId) {
    vscode.window.showInformationMessage('Last closed session has no resumable session.');
    return;
  }

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const title = buildTerminalTitle(
    closed.agentConfig.title,
    closed.label,
    context,
    closed.sessionId
  );

  const terminalId = terminals.nextId(closed.prefix);
  const terminal = vscode.window.createTerminal({
    iconPath: closed.agentConfig.iconPath,
    location: { viewColumn: vscode.ViewColumn.Active },
    name: title,
    env: buildAgentTerminalEnv(terminalId, closed.sessionId, workspacePath, closed.version),
    isTransient: true
  });

  const pid = await terminal.processId;
  terminals.register(terminal, terminalId, closed.agentConfig, pid, context, closed.label);
  readiness.registerTerminal(terminal);

  if (closed.sessionId && closed.agentType) {
    terminals.setSessionId(terminal, closed.sessionId);
    terminals.setAgentType(terminal, closed.agentType);
    if (closed.version) {
      terminals.setVersion(terminal, closed.version);
    }
    if (closed.account) {
      terminals.setAccount(terminal, closed.account);
    }
    startAutoLabelPollerForTerminal(terminal, context);

    if (supportsPrewarming(closed.agentType)) {
      const resumeCmd = buildVersionedResumeCommand(
        closed.agentType,
        closed.sessionId,
        closed.version
      );
      try {
        await readiness.waitFor(terminal, 'promptReady');
      } catch (err) {
        console.warn(`[READINESS] promptReady wait failed: ${err}`);
      }
      if (terminal.shellIntegration) {
        terminal.shellIntegration.executeCommand(resumeCmd);
      } else {
        terminal.sendText(resumeCmd);
      }
      readiness.armAgentReady(terminal, {
        agentKey: closed.agentType,
        sessionId: closed.sessionId,
        cwd: workspacePath,
      });
    }
  }

  terminal.show();
  console.log(`[REOPEN] Reopened session: ${closed.sessionId} (${closed.agentType})`);
}

function initForemanRegistry(context: vscode.ExtensionContext): void {
  // Lazy import to avoid loading the registry before activate() fires.
  const registry = require('./foreman.registry') as typeof import('./foreman.registry');
  let timer: NodeJS.Timeout | undefined;
  const publish = async () => {
    try {
      const snap = await registry.snapshotOwnTerminals();
      await registry.publishLiveTerminals(snap);
    } catch { /* best effort */ }
  };
  // Trailing-edge debounce: a flurry of terminal-state changes (each of which
  // awaits processId + does a registry file read/write) coalesces into a
  // single publish instead of N.
  let debounceTimer: NodeJS.Timeout | undefined;
  const schedulePublish = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { debounceTimer = undefined; void publish(); }, 300);
  };
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => schedulePublish()),
    vscode.window.onDidCloseTerminal(() => schedulePublish()),
    vscode.window.onDidChangeTerminalState(() => schedulePublish()),
    { dispose: () => { if (debounceTimer) clearTimeout(debounceTimer); } },
  );
  // Long keepalive: publish() itself skips the disk write when nothing
  // changed and the keepalive window isn't due, so this interval is just a
  // safety net. Kept under STALE_WINDOW_MS (10 min) so peers don't prune us.
  timer = setInterval(publish, 60_000);
  context.subscriptions.push({ dispose: () => { if (timer) clearInterval(timer); } });
  void publish();
}

function initMonitorLeader(context: vscode.ExtensionContext): void {
  // Lazy import to keep activation lean and avoid loading the elector early.
  const leader = require('../monitor/leader') as typeof import('../monitor/leader');
  const { computeWindowId } = require('../core/foreman.windowId') as typeof import('../core/foreman.windowId');
  // process.pid is per-extension-host, so a window reload yields a fresh
  // windowId and leadership is re-elected rather than silently continued.
  const selfId = computeWindowId(vscode.env.sessionId, process.pid);
  leader.electLeader({ selfId, pid: process.pid });
  // Graceful handoff: drop the lease on dispose so a peer takes over at once
  // instead of waiting out the TTL.
  context.subscriptions.push({ dispose: () => leader.disposeLeader() });
}

// Run the monitor host (the broadcast server) ONLY while this window is the
// elected leader (#67). `runOnLeaderOnly` starts it on leadership gain and
// disposes it on loss; the next leader binds the same socket and followers
// auto-reconnect. This is also the seam the migration issues (#68-71) wrap
// their heavy starters in — they are intentionally NOT moved here.
function initMonitorHost(context: vscode.ExtensionContext): void {
  const { runOnLeaderOnly } = require('../monitor/gate') as typeof import('../monitor/gate');
  const { MonitorHost } = require('../monitor/host') as typeof import('../monitor/host');
  const { listTeamsForCwd } = require('./foreman.sources') as typeof import('./foreman.sources');
  const gate = runOnLeaderOnly(() => {
    // detectors enables the centralized readiness probes (#68), the machine-wide
    // session watcher (#69), the watchdog detector (#70), and the panel/floor
    // snapshot detector (#71) on the leader only. The snapshot detector's teams
    // fetch is vscode-coupled, so it's injected here (host.ts stays vscode-free).
    const host = new MonitorHost({
      detectors: {
        snapshotFetchTeams: (cwd) => listTeamsForCwd(cwd) as Promise<unknown[]>,
      },
    });
    void host.start().catch((err) => console.error('[MONITOR] host start failed:', err));
    return { dispose: () => { void host.stop().catch(() => {}); } };
  });
  context.subscriptions.push(gate);
}

// The always-on per-window follower (#67). It connects to the monitor, reports
// this window's terminal tuples over the broadcast request channel, and
// resolves broadcast facts back to this window's own `vscode.Terminal` via the
// window-local `editorTerminals` map (never moved out of this window). The
// foreman-registry write (initForemanRegistry) stays as the disconnected-case
// fallback — reportTuples is a no-op until the connection is up.
function initMonitorFollower(context: vscode.ExtensionContext): void {
  const { MonitorFollower } = require('../monitor/follower') as typeof import('../monitor/follower');
  const { computeWindowId } = require('../core/foreman.windowId') as typeof import('../core/foreman.windowId');
  type TerminalTuple = import('../monitor/protocol').TerminalTuple;

  const windowId = computeWindowId(vscode.env.sessionId, process.pid);

  // Resolve a broadcast pid/sessionId back to THIS window's terminal, scanning
  // only the window-local registry (stays per-window per epic #64).
  const resolver = (key: { pid?: number | null; sessionId?: string | null }):
    | vscode.Terminal
    | undefined => {
    for (const entry of terminals.getAllTerminals()) {
      if (key.pid != null && entry.pid === key.pid) return entry.terminal;
      if (key.sessionId && entry.sessionId === key.sessionId) return entry.terminal;
    }
    return undefined;
  };

  const collectTuples = (): TerminalTuple[] => {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    return terminals
      .getAllTerminals()
      .filter((e) => e.terminal.exitStatus === undefined && e.agentConfig)
      .map((e) => ({
        windowId,
        terminalId: e.id,
        pid: e.pid ?? null,
        sessionId: e.sessionId ?? null,
        workspacePath,
        agentType: e.agentType ?? null,
      }));
  };

  let follower: InstanceType<typeof MonitorFollower<vscode.Terminal>>;
  const report = () => {
    if (follower?.connected) void follower.reportTuples(collectTuples());
  };

  follower = new MonitorFollower<vscode.Terminal>({
    windowId,
    resolver,
    // Report as soon as the connection (re)establishes, then on terminal events.
    // On loss, restart local readiness probing so nothing stalls (#68 fallback).
    clientOptions: {
      onStateChange: (s) => {
        if (s === 'connected') report();
        else if (s === 'disconnected' || s === 'closed') readiness.onMonitorDisconnected();
      },
    },
  });

  // Migration wiring (#68, #69): the leader runs the probes/watchers once and
  // broadcasts facts; this window resolves them to its own terminals. The gate
  // predicates make terminalReadiness / sessionTracker suppress their local
  // probing while connected and fall back when not.
  const connected = () => follower.connected;
  readiness.setMonitorConnectivity(connected);
  sessionTracker.setMonitorConnectivity(connected);
  readiness.setMonitorArmSink({
    armAgent: (pid, agentKey, sessionId) => { void follower.armAgent(pid, agentKey, sessionId); },
    armShellAdoption: (pid) => { void follower.armShellAdoption(pid); },
  });
  // Watchdog (#70): the leader detects stalls + polls `agents view` once; this
  // window arms its sessions and delivers the nudge/rotate locally.
  setWatchdogMonitorConnectivity(connected);
  setWatchdogArmSink((watches) => { void follower.setWatchdogWatches(watches); });
  // Snapshot (#71): the leader computes git/worktrees/usage/teams once and
  // broadcasts; the panel/floor render from the fact and arm their watch slice.
  terminals.setSnapshotMonitorConnectivity(connected);
  terminals.setSnapshotArmSink((watches) => { void follower.setSnapshotWatches(watches); });

  const proto = require('../monitor/protocol') as typeof import('../monitor/protocol');
  const factSub = follower.onMonitorEvent((event) => {
    if (proto.isReadinessFact(event)) {
      readiness.ingestReadinessFact(event.payload.pid, event.payload.event);
    } else if (proto.isShellAdoptionFact(event)) {
      const p = event.payload;
      readiness.ingestShellAdoptionFact(p.pid, {
        agentKey: p.agentKey as readiness.ShellAdoptionInfo['agentKey'],
        sessionId: p.sessionId,
        childPid: p.childPid,
      });
    } else if (proto.isSessionFact(event)) {
      sessionTracker.ingestSessionFact(event.payload);
    } else if (proto.isSessionWarmth(event)) {
      sessionTracker.ingestSessionWarmth(event.payload.filePath);
    } else if (proto.isWatchdogStall(event)) {
      ingestWatchdogStallFact(event.payload);
    } else if (proto.isWatchdogVersions(event)) {
      ingestWatchdogVersionsFact(event.payload);
    } else if (proto.isPanelSnapshot(event)) {
      terminals.ingestPanelSnapshotFact(event.payload);
    }
  });
  context.subscriptions.push({ dispose: factSub });

  follower.start();

  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => report()),
    vscode.window.onDidCloseTerminal(() => report()),
    vscode.window.onDidChangeTerminalState(() => report()),
  );
  const timer = setInterval(report, 60_000);
  (timer as { unref?: () => void })?.unref?.();
  context.subscriptions.push({
    dispose: () => {
      clearInterval(timer);
      follower.stop();
    },
  });
}

export async function deactivate(): Promise<void> {
  if (extensionContext) {
    // Persist open agent terminals for restore on next launch (immediate, not debounced)
    terminals.persistNow();
  }

  // Release the monitor lease so another window can take over immediately.
  try {
    const leader = require('../monitor/leader') as typeof import('../monitor/leader');
    leader.disposeLeader();
  } catch { /* best effort */ }

  // Clear internal tracking (don't dispose terminals - let VS Code handle them)
  terminals.clear();
}
