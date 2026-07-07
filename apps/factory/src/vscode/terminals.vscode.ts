// VS Code-dependent terminal state management
// Implements API.md 2-map architecture

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AgentConfig } from './agents.vscode';

import { fetchGitInfo } from '../monitor/snapshotDetector';
import { PanelSnapshotPayload, SnapshotWatch } from '../monitor/protocol';
import { generateTerminalId, resolveRestoredVersion, RunningCounts } from '../core/terminals';
import * as sessionsPersist from '../core/sessions.persist';
import { getSessionPathBySessionId, getSessionPreviewInfo, getOpenCodeSessionPreviewInfo, getCursorSessionPreviewInfo, SessionPreviewInfo, readTailLines } from './sessions.vscode';
import { extractCurrentActivity, formatActivity, detectWaitingForInput } from '../core/session.activity';
import { extractSessionQuickDetails, SessionQuickDetails, SessionQuickSummary, SessionSummaryAgentType } from '../core/session.summary';
import {
  CLAUDE_TITLE,
  CODEX_TITLE,
  GEMINI_TITLE,
  OPENCODE_TITLE,
  CURSOR_TITLE,
  SHELL_TITLE,
  getTerminalDisplayInfo,
  TerminalIdentificationOptions,
  prefixToAgentType,
  canonicalToConfigPrefix,
  SessionAgentType
} from '../core/utils';
import { registerTerminal as registerSessionTracker } from './sessionTracker';
import { relabelTmuxPane } from './tmux';

// getTerminalsByAgentType runs 5x (one per agent type) on every 10s floor poll
// and again on every terminal open/close. Its per-terminal/per-session debug
// lines flooded the console at steady state, so gate them behind an env flag
// (#96). Genuine warn/error logs and one-shot lifecycle logs are left intact.
const TERMINAL_DEBUG = process.env.SWARMIFY_DEBUG_TERMINALS === '1';
function debugLog(...args: unknown[]): void {
  if (TERMINAL_DEBUG) console.log(...args);
}

/**
 * Extract identification options from a VS Code terminal.
 * Used to gather all inputs for getTerminalDisplayInfo.
 */
function extractTerminalIdentificationOptions(terminal: vscode.Terminal): TerminalIdentificationOptions {
  const opts = terminal.creationOptions as vscode.TerminalOptions;
  const env = opts?.env;
  const terminalId = env ? env['AGENT_TERMINAL_ID'] : undefined;
  const sessionId = env ? env['AGENT_SESSION_ID'] : undefined;
  const version = env ? env['AGENT_VERSION'] : undefined;

  // Extract icon filename from iconPath
  let iconFilename: string | null = null;
  if (opts?.iconPath) {
    const icon: any = opts.iconPath;
    if (icon instanceof vscode.Uri) {
      iconFilename = path.basename(icon.fsPath);
    } else if (icon && typeof icon === 'object') {
      // Support { light: Uri; dark: Uri } or direct object with fsPath
      const candidate = icon.light ?? icon.dark ?? icon;
      if (candidate instanceof vscode.Uri || (candidate && typeof candidate.fsPath === 'string')) {
        iconFilename = path.basename(candidate.fsPath);
      }
    }
  }

  return {
    name: terminal.name,
    terminalId: terminalId as string | undefined,
    sessionId: sessionId as string | undefined,
    version: (version as string | undefined) || undefined,
    iconFilename
  };
}

export type TerminalApprovalStatus = 'pending' | 'approved' | 'running' | 'complete' | 'rejected';

// Terminal entry following API.md
export interface EditorTerminal {
  id: string;
  terminal: vscode.Terminal;
  agentConfig: Omit<AgentConfig, 'count'> | null;
  label?: string;           // User-set status bar label (manual via Cmd+L)
  autoLabel?: string;       // Auto-generated label (populated by LLM)
  createdAt: number;
  pid?: number;             // Shell process ID
  messageQueue: string[];   // Queued messages to send after terminal ready
  sessionId?: string;       // CLI session ID (for resume, history reading)
  agentType?: SessionAgentType; // Agent type for session operations
  version?: string;         // Pinned agent version ("2.1.113"); undefined when unknown
  account?: string;         // Resolved account email for this terminal when known
  statusVersion?: string;   // Display-only version from agents-cli metadata
  statusAccount?: string;   // Display-only account from agents-cli metadata
  approvalStatus?: 'pending' | 'approved' | 'running' | 'complete'; // Swarm approval status
  autoLabelPollerId?: NodeJS.Timeout; // Poller for auto-label fetch (cleared once label is set)
}

const STATUS_BAR_LABELS_KEY = 'agentStatusBarLabels';

type StatusBarLabelsStorage = { [pid: number]: string };

// Re-export PersistedSession from sessions.persist for external use
export type { PersistedSession } from '../core/sessions.persist';

export function loadStatusBarLabels(context: vscode.ExtensionContext): StatusBarLabelsStorage {
  const stored = context.globalState.get<StatusBarLabelsStorage>(STATUS_BAR_LABELS_KEY);
  return stored || {};
}

export async function saveStatusBarLabel(
  context: vscode.ExtensionContext,
  pid: number,
  label: string | undefined
): Promise<void> {
  const stored = loadStatusBarLabels(context);
  if (label) {
    stored[pid] = label;
  } else {
    delete stored[pid];
  }
  await context.globalState.update(STATUS_BAR_LABELS_KEY, stored);
}

export async function removeStatusBarLabel(
  context: vscode.ExtensionContext,
  pid: number | undefined
): Promise<void> {
  if (pid === undefined) return;
  const stored = loadStatusBarLabels(context);
  delete stored[pid];
  await context.globalState.update(STATUS_BAR_LABELS_KEY, stored);
}

// Recently closed session info for "reopen last session"
export interface ClosedSession {
  terminalId: string;
  prefix: string;
  sessionId?: string;
  label?: string;
  agentType?: SessionAgentType;
  version?: string;
  account?: string;
  agentConfig: Omit<AgentConfig, 'count'> | null;
  closedAt: number;
}

const MAX_CLOSED_SESSIONS = 10;
const recentlyClosedSessions: ClosedSession[] = [];

export function pushClosedSession(session: ClosedSession): void {
  recentlyClosedSessions.unshift(session);
  if (recentlyClosedSessions.length > MAX_CLOSED_SESSIONS) {
    recentlyClosedSessions.length = MAX_CLOSED_SESSIONS;
  }
}

export function popClosedSession(): ClosedSession | undefined {
  return recentlyClosedSessions.shift();
}

export function getRecentlyClosedSessions(): readonly ClosedSession[] {
  return recentlyClosedSessions;
}

// Two-map architecture (API.md)
const editorTerminals = new Map<string, EditorTerminal>();
const terminalToId = new WeakMap<vscode.Terminal, string>();
let terminalIdCounter = 0;

// Debounced disk persistence
let persistTimeout: NodeJS.Timeout | null = null;

/**
 * Schedule disk persistence (debounced to batch rapid changes).
 * Call this after any terminal state change.
 */
export function schedulePersist(): void {
  const workspacePath = vscode.workspace?.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) return;

  if (persistTimeout) clearTimeout(persistTimeout);
  persistTimeout = setTimeout(() => {
    persistSessions(workspacePath);
    persistTimeout = null;
    console.log('[TERMINALS] Persisted sessions to disk');
  }, 500); // 500ms debounce
}

/**
 * Persist immediately (for critical operations like deactivate).
 */
export function persistNow(): void {
  const workspacePath = vscode.workspace?.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) return;

  if (persistTimeout) {
    clearTimeout(persistTimeout);
    persistTimeout = null;
  }
  persistSessions(workspacePath);
  console.log('[TERMINALS] Persisted sessions to disk (immediate)');
}

// Accessors

export function getByTerminal(t: vscode.Terminal): EditorTerminal | undefined {
  const id = terminalToId.get(t);
  const entry = id ? editorTerminals.get(id) : undefined;
  debugLog(`[DEBUG getByTerminal] terminal="${t.name}" -> id=${id}, entry.label="${entry?.label}"`);
  return entry;
}

export function getById(id: string): EditorTerminal | undefined {
  return editorTerminals.get(id);
}

export function getAllTerminals(): EditorTerminal[] {
  return Array.from(editorTerminals.values());
}

export function isAgentTerminal(t: vscode.Terminal): boolean {
  const entry = getByTerminal(t);
  return entry?.agentConfig !== null && entry?.agentConfig !== undefined;
}

// Mutations

// Generate a unique terminal ID (call before creating terminal for env var)
export function nextId(prefix: string): string {
  return generateTerminalId(prefix, ++terminalIdCounter);
}

// Register a terminal with a pre-generated ID
// IMPORTANT: This function is idempotent - if the terminal is already registered,
// it will skip registration to prevent race conditions from overwriting sessionId
export function register(
  terminal: vscode.Terminal,
  id: string,
  agentConfig: Omit<AgentConfig, 'count'> | null,
  pid?: number,
  context?: vscode.ExtensionContext,
  initialLabel?: string
): void {
  // Check if terminal is already registered (prevents race condition with onDidOpenTerminal)
  const existingId = terminalToId.get(terminal);
  if (existingId) {
    console.log(`[TERMINALS] Terminal "${terminal.name}" already registered with id=${existingId}, skipping duplicate registration`);
    return;
  }

  console.log(`[DEBUG register] Registering terminal: name="${terminal.name}", id=${id}, pid=${pid}, initialLabel=${initialLabel}`);

  const entry: EditorTerminal = {
    id,
    terminal,
    agentConfig,
    createdAt: Date.now(),
    pid,
    messageQueue: []
  };

  if (pid !== undefined && context) {
    const persistedLabels = loadStatusBarLabels(context);
    console.log(`[DEBUG register] All persisted labels in globalState:`, JSON.stringify(persistedLabels));
    const persistedLabel = persistedLabels[pid];
    console.log(`[DEBUG register] Persisted label for PID ${pid}: "${persistedLabel}"`);
    if (persistedLabel) {
      entry.label = persistedLabel;
    } else if (initialLabel) {
      entry.label = initialLabel;
      // Also persist this label since we found it on a restored terminal
      saveStatusBarLabel(context, pid, initialLabel);
    }
  } else if (initialLabel) {
    entry.label = initialLabel;
  }

  console.log(`[DEBUG register] Final entry.label: "${entry.label}"`);
  editorTerminals.set(id, entry);
  terminalToId.set(terminal, id);
  console.log(`[DEBUG register] editorTerminals now has ${editorTerminals.size} entries`);

  // Persist to disk
  schedulePersist();
}

export function unregister(terminal: vscode.Terminal): void {
  const id = terminalToId.get(terminal);
  if (id) {
    const entry = editorTerminals.get(id);
    if (entry?.autoLabelPollerId) {
      clearInterval(entry.autoLabelPollerId);
    }
    editorTerminals.delete(id);
    terminalToId.delete(terminal);

    // Persist to disk
    schedulePersist();
  }
}

export async function setLabel(
  terminal: vscode.Terminal,
  label: string | undefined,
  context?: vscode.ExtensionContext
): Promise<void> {
  console.log(`[DEBUG setLabel] Setting label for terminal "${terminal.name}" to "${label}"`);
  const entry = getByTerminal(terminal);
  console.log(`[DEBUG setLabel] Found entry: id=${entry?.id}, pid=${entry?.pid}, currentLabel="${entry?.label}"`);
  if (entry) {
    entry.label = label;
    if (entry.pid !== undefined && context) {
      console.log(`[DEBUG setLabel] Persisting label "${label}" for PID ${entry.pid}`);
      await saveStatusBarLabel(context, entry.pid, label);
    }

    // Persist to disk
    schedulePersist();

    stopAutoLabelPoller(terminal);

    // Keep the tmux pane border in sync with the tab. A manual label wins over
    // the auto-label; clearing it (label=undefined) falls back to the auto-label.
    // Fire-and-forget — tmux styling is best-effort, never load-bearing.
    void relabelTmuxPane(terminal, label ?? entry.autoLabel).catch(() => { /* ignore */ });
  } else {
    console.log(`[DEBUG setLabel] No entry found for terminal - label NOT saved!`);
  }
}

export function setAutoLabel(terminal: vscode.Terminal, autoLabel: string | undefined): void {
  const entry = getByTerminal(terminal);
  if (entry) {
    entry.autoLabel = autoLabel;
    if (autoLabel && entry.autoLabelPollerId) {
      clearInterval(entry.autoLabelPollerId);
      entry.autoLabelPollerId = undefined;
      console.log(`[TERMINALS] Cleared auto-label poller for terminal "${terminal.name}" - label set: "${autoLabel}"`);
    }
    // Surface the resolved topic in the tmux pane border (a manual label, if
    // set, still takes precedence). This fires even when the terminal isn't
    // focused — unlike the tab rename, which must briefly activate it.
    void relabelTmuxPane(terminal, entry.label ?? autoLabel).catch(() => { /* ignore */ });
  }
}

// Cap the auto-label poll interval. Once a stable label exists the poller
// stops entirely; until then the interval doubles after each failed poll so a
// terminal whose label never resolves doesn't re-spawn a model subprocess
// every 5 minutes forever.
const AUTO_LABEL_MAX_INTERVAL_MS = 60 * 60 * 1000;

export function startAutoLabelPoller(
  terminal: vscode.Terminal,
  pollFn: () => Promise<void>,
  intervalMs: number = 5 * 60 * 1000
): void {
  const entry = getByTerminal(terminal);
  if (!entry) return;
  if (entry.autoLabelPollerId) return;
  if (entry.autoLabel || entry.label) return;

  // Run immediately on start, then back off for subsequent polls.
  pollFn().catch(() => {});

  let delay = intervalMs;
  const schedule = (): void => {
    entry.autoLabelPollerId = setTimeout(async () => {
      // Stable label exists -> stop the drip entirely.
      if (entry.autoLabel || entry.label) {
        entry.autoLabelPollerId = undefined;
        return;
      }
      await pollFn().catch(() => {});
      if (entry.autoLabel || entry.label) {
        entry.autoLabelPollerId = undefined;
        return;
      }
      // Still unlabeled: back off before trying again.
      delay = Math.min(delay * 2, AUTO_LABEL_MAX_INTERVAL_MS);
      schedule();
    }, delay);
  };
  schedule();
  console.log(`[TERMINALS] Started auto-label poller for terminal "${terminal.name}" (interval: ${intervalMs}ms, backoff cap: ${AUTO_LABEL_MAX_INTERVAL_MS}ms)`);
}

export function stopAutoLabelPoller(terminal: vscode.Terminal): void {
  const entry = getByTerminal(terminal);
  if (entry?.autoLabelPollerId) {
    clearInterval(entry.autoLabelPollerId);
    entry.autoLabelPollerId = undefined;
    console.log(`[TERMINALS] Stopped auto-label poller for terminal "${terminal.name}"`);
  }
}

export function setSessionId(terminal: vscode.Terminal, sessionId: string): void {
  const entry = getByTerminal(terminal);
  if (entry) {
    const prevSessionId = entry.sessionId;
    entry.sessionId = sessionId;
    if (prevSessionId && prevSessionId !== sessionId) {
      entry.autoLabel = undefined;
      if (entry.autoLabelPollerId) {
        clearInterval(entry.autoLabelPollerId);
        entry.autoLabelPollerId = undefined;
      }
    }
    console.log(`[TERMINALS] Set sessionId for terminal "${terminal.name}": ${sessionId}`);

    // Persist to disk
    schedulePersist();

    maybeRegisterWithSessionTracker(terminal, entry.agentType, sessionId);
  } else {
    console.error(`[TERMINALS] FAILED to set sessionId - terminal "${terminal.name}" not found in registry. This may indicate a race condition.`);
  }
}

function maybeRegisterWithSessionTracker(
  terminal: vscode.Terminal,
  agentType: SessionAgentType | undefined,
  sessionId: string | undefined,
): void {
  if (agentType !== 'claude' && agentType !== 'codex' && agentType !== 'gemini' && agentType !== 'opencode') return;
  const workspacePath = vscode.workspace?.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) return;
  try {
    registerSessionTracker(terminal, agentType, workspacePath, sessionId);
  } catch (err) {
    console.error('[TERMINALS] sessionTracker.registerTerminal failed', err);
  }
}

export function setAgentType(terminal: vscode.Terminal, agentType: SessionAgentType): void {
  const entry = getByTerminal(terminal);
  if (entry) {
    entry.agentType = agentType;

    // Persist to disk
    schedulePersist();

    // Register with sessionTracker even without a sessionId so the fs watcher
    // can adopt one when the agent CLI writes a fresh rollout/jsonl file.
    // Critical for Codex 0.124+ which dropped session id from its TUI banner.
    maybeRegisterWithSessionTracker(terminal, agentType, entry.sessionId);
  } else {
    console.error(`[TERMINALS] FAILED to set agentType - terminal "${terminal.name}" not found in registry.`);
  }
}

// Convert an SH-registered terminal into an agent terminal once the user has
// launched an agent CLI inside it. Mutates the existing entry in place so
// every consumer (dashboard, status bar, session tracker, label generation,
// autogit, swarm) starts treating the tab as the detected agent.
//
// The VS Code tab icon and `creationOptions` are immutable, so the visible
// tab keeps its SH chip — only the internal registry and downstream display
// names update.
//
// Idempotent: a non-SH entry is returned unchanged.
export function adoptShellAsAgent(
  terminal: vscode.Terminal,
  newAgentConfig: Omit<AgentConfig, 'count'>,
  agentType: SessionAgentType,
  sessionId: string | undefined
): boolean {
  const entry = getByTerminal(terminal);
  if (!entry) {
    console.error(`[TERMINALS] adoptShellAsAgent: terminal "${terminal.name}" not in registry`);
    return false;
  }
  if (entry.agentConfig?.prefix !== 'sh') {
    console.log(`[TERMINALS] adoptShellAsAgent: terminal "${terminal.name}" already adopted (prefix=${entry.agentConfig?.prefix}), skipping`);
    return false;
  }

  console.log(`[TERMINALS] Adopting SH terminal "${terminal.name}" (id=${entry.id}) as ${newAgentConfig.title}, sessionId=${sessionId}`);
  entry.agentConfig = newAgentConfig;
  entry.agentType = agentType;
  if (sessionId) {
    entry.sessionId = sessionId;
  }

  schedulePersist();
  maybeRegisterWithSessionTracker(terminal, agentType, entry.sessionId);
  return true;
}

export function setVersion(terminal: vscode.Terminal, version: string): void {
  const entry = getByTerminal(terminal);
  if (entry) {
    entry.version = version;
    entry.statusVersion = version;
    schedulePersist();
  } else {
    console.error(`[TERMINALS] FAILED to set version - terminal "${terminal.name}" not found in registry.`);
  }
}

export function setAccount(
  terminal: vscode.Terminal,
  account: string | null | undefined
): void {
  const entry = getByTerminal(terminal);
  if (entry) {
    const normalized = account?.trim();
    entry.account = normalized || undefined;
    entry.statusAccount = normalized || undefined;
  } else {
    console.error(`[TERMINALS] FAILED to set account - terminal "${terminal.name}" not found in registry.`);
  }
}

export function getSessionId(terminal: vscode.Terminal): string | undefined {
  const entry = getByTerminal(terminal);
  return entry?.sessionId;
}

export function getAgentType(terminal: vscode.Terminal): SessionAgentType | undefined {
  const entry = getByTerminal(terminal);
  return entry?.agentType;
}

// Message queue management

export function queueMessage(terminal: vscode.Terminal, message: string): void {
  const entry = getByTerminal(terminal);
  if (entry) {
    entry.messageQueue.push(message);
  }
}

export function flushQueue(terminal: vscode.Terminal): string[] {
  const entry = getByTerminal(terminal);
  if (entry) {
    const messages = [...entry.messageQueue];
    entry.messageQueue = [];
    return messages;
  }
  return [];
}

// Rename a terminal tab title.
//
// `workbench.action.terminal.renameWithArg` only operates on the active
// terminal, so we have to briefly make `terminal` active. That forcibly
// switches the visible editor tab — if we don't restore the previously
// active terminal afterwards, every async rename (auto-label LLM finishing,
// session-change handler, etc.) yanks focus to a random tab.
export async function renameTerminal(terminal: vscode.Terminal, newName: string): Promise<void> {
  const previouslyActiveTerminal = vscode.window.activeTerminal;
  try {
    terminal.show(false);
    await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: newName });
  } catch (err) {
    console.error('[TERMINALS] Failed to rename terminal', err);
  } finally {
    if (
      previouslyActiveTerminal &&
      previouslyActiveTerminal !== terminal &&
      previouslyActiveTerminal.exitStatus === undefined
    ) {
      previouslyActiveTerminal.show(false);
    }
  }
}

// Lifecycle

export async function scanExisting(
  inferAgentConfig: (name: string, knownPrefix?: string | null) => Omit<AgentConfig, 'count'> | null,
  context?: vscode.ExtensionContext,
  onSessionRestored?: (terminal: vscode.Terminal) => void
): Promise<number> {
  console.log('[TERMINALS] Scanning all terminals...');
  let registeredCount = 0;

  // Load persisted sessions for session recovery
  const workspacePath = vscode.workspace?.workspaceFolders?.[0]?.uri.fsPath;
  const persistedSessions = workspacePath ? sessionsPersist.getWorkspaceSessions(workspacePath) : [];
  const usedPersistedIds = new Set<string>();
  console.log(`[TERMINALS] Loaded ${persistedSessions.length} persisted sessions`);

  for (const terminal of vscode.window.terminals) {
    console.log(`[TERMINALS] Checking terminal: "${terminal.name}"`);

    // Skip terminals whose process has exited (tab may still be open)
    if (terminal.exitStatus !== undefined) {
      console.log(`[TERMINALS] Process exited, skipping`);
      continue;
    }

    // Skip if already registered
    if (terminalToId.has(terminal)) {
      console.log(`[TERMINALS] Already registered, skipping`);
      continue;
    }

    // Use the central identification function with all available inputs
    const identOpts = extractTerminalIdentificationOptions(terminal);
    const info = getTerminalDisplayInfo(identOpts);
    console.log(`[TERMINALS] Display info for "${terminal.name}": isAgent=${info.isAgent}, prefix=${info.prefix}`);

    if (!info.isAgent || !info.prefix) continue;

    const agentConfig = inferAgentConfig(terminal.name, info.prefix);
    if (!agentConfig) continue;

    const id = identOpts.terminalId || nextId(info.prefix);

    let pid: number | undefined;
    try {
      pid = await terminal.processId;
    } catch (error) {
      console.log(`[TERMINALS] Could not retrieve PID for terminal "${terminal.name}"`);
    }

    register(terminal, id, agentConfig, pid, context, info.label || undefined);
    registeredCount++;
    console.log(`[TERMINALS] Registered: id=${id}, prefix=${info.prefix}, pid=${pid}, label=${info.label}`);

    // Restore the pinned agent version. Env is the most-recent source of
    // truth (set by resumeCurrentInBestProfile at spawn time), but VS Code
    // can drop `terminal.creationOptions.env` across some reload paths, so
    // we also check the persisted session by terminalId. This lookup MUST
    // run regardless of which sessionId-recovery strategy wins below — a
    // prior version of this code nested the persisted fallback inside
    // Strategy 2 (`if (!sessionId && info.prefix) { ... }`), so Strategy 1
    // succeeding silently skipped version recovery, and Cmd+Shift+J's
    // "already on usable version" short-circuit couldn't fire.
    const persistedByTerminalId = identOpts.terminalId
      ? persistedSessions.find(p => p.terminalId === identOpts.terminalId)
      : undefined;
    const pinnedVersion = resolveRestoredVersion(
      identOpts.version,
      persistedByTerminalId?.version
    );
    if (pinnedVersion) {
      setVersion(terminal, pinnedVersion);
    }

    // Restore session tracking - prefer env var sessionId, fallback to sessionChunk from name
    const agentType = prefixToAgentType(info.prefix);
    if (agentType) {
      // Register agent type even when session id is unknown so sessionTracker
      // can adopt new Codex/Claude session files later.
      setAgentType(terminal, agentType);
    }
    let sessionId = identOpts.sessionId;

    // Strategy 1: Try to recover from sessionChunk in terminal name
    if (!sessionId && info.sessionChunk && agentType) {
      const sessionPath = await getSessionPathBySessionId(
        info.sessionChunk,
        agentType as 'claude' | 'codex' | 'gemini',
        workspacePath
      );
      if (sessionPath) {
        // Extract full sessionId from file path (filename without extension)
        const filename = path.basename(sessionPath);
        const ext = path.extname(filename);
        sessionId = filename.slice(0, -ext.length);
        console.log(`[TERMINALS] Recovered sessionId from chunk: ${info.sessionChunk} -> ${sessionId}`);
      }
    }

    // Strategy 2: Try to match with persisted session by prefix
    // Use the most recently created persisted session for this prefix that hasn't been used yet
    // Note: info.prefix is canonical (CC, CX), persisted uses config format (cl, cx)
    if (!sessionId && info.prefix) {
      const configPrefix = canonicalToConfigPrefix(info.prefix);
      const matchingSessions = persistedSessions
        .filter(p => p.prefix === configPrefix && p.sessionId && !usedPersistedIds.has(p.terminalId))
        .sort((a, b) => b.createdAt - a.createdAt); // Most recent first

      if (matchingSessions.length > 0) {
        const matched = matchingSessions[0];
        sessionId = matched.sessionId;
        usedPersistedIds.add(matched.terminalId);
        console.log(`[TERMINALS] Recovered sessionId from persisted session: ${matched.terminalId} -> ${sessionId}`);

        // Also recover the agentType if available
        if (matched.agentType && !agentType) {
          setAgentType(terminal, matched.agentType as SessionAgentType);
        }

        // Version recovery for this branch only — when env.terminalId was
        // absent so the persisted-by-terminalId lookup above missed. Prefer
        // the existing pin from env if present.
        if (!pinnedVersion && matched.version) {
          setVersion(terminal, matched.version);
        }
      }
    }

    if (sessionId) {
      setSessionId(terminal, sessionId);
      console.log(`[TERMINALS] Restored session: sessionId=${sessionId}, agentType=${agentType}`);
      if (onSessionRestored) {
        onSessionRestored(terminal);
      }
    }
  }

  console.log(`[TERMINALS] Scan complete. Registered ${registeredCount} agent terminals.`);
  return registeredCount;
}

// Count running agents
export function countRunning(): RunningCounts {
  const counts: RunningCounts = {
    claude: 0,
    codex: 0,
    gemini: 0,
    opencode: 0,
    cursor: 0,
    shell: 0,
    custom: {}
  };

  for (const terminal of vscode.window.terminals) {
    // Skip terminals whose process has exited (tab may still be open)
    if (terminal.exitStatus !== undefined) continue;

    // Use full identification (name + env + icon) so we keep prefix even when the
    // tab title is just a label (showLabelsInTitles=true) or has been manually renamed.
    const identOpts = extractTerminalIdentificationOptions(terminal);
    const info = getTerminalDisplayInfo(identOpts);
    if (!info.isAgent || !info.prefix) continue;

    switch (info.prefix) {
      case CLAUDE_TITLE:
        counts.claude++;
        break;
      case CODEX_TITLE:
        counts.codex++;
        break;
      case GEMINI_TITLE:
        counts.gemini++;
        break;
      case OPENCODE_TITLE:
        counts.opencode++;
        break;
      case CURSOR_TITLE:
        counts.cursor++;
        break;
      case SHELL_TITLE:
        counts.shell++;
        break;
      default:
        counts.custom[info.prefix] = (counts.custom[info.prefix] || 0) + 1;
        break;
    }
  }

  return counts;
}

// Accurate running counts that verify terminals have active sessions with messages.
// Falls back to countRunning() for shell terminals and unknown terminals.
export async function countActive(workspacePath?: string): Promise<RunningCounts> {
  const openCounts = countRunning();
  const activeCounts: RunningCounts = { ...openCounts, custom: { ...openCounts.custom } };

  const agentKeys = ['claude', 'codex', 'gemini', 'opencode', 'cursor'] as const;
  const checks = agentKeys
    .filter(key => openCounts[key] > 0)
    .map(async (key) => {
      const details = await getTerminalsByAgentType(key, workspacePath);
      const active = details.filter(d => d.messageCount && d.messageCount > 0).length;
      activeCounts[key] = active;
    });

  await Promise.all(checks);
  return activeCounts;
}

// Terminal detail for UI display
export interface TerminalDetail {
  id: string;
  agentType: string;
  label: string | null;
  autoLabel: string | null;
  createdAt: number;
  index: number; // 1-based index within agent type
  sessionId: string | null; // CLI session ID
  firstUserMessage?: string; // First user message (initial task/prompt)
  lastUserMessage?: string; // Last user message from session
  status?: 'running' | 'completed' | 'idle';
  messageCount?: number; // Total message count in session
  firstMessageTimestamp?: string; // ISO-8601 timestamp of first user message
  lastActivityTimestamp?: string; // ISO-8601 timestamp of latest session update
  currentActivity?: string; // Live activity (e.g., "Reading src/auth.ts", "Running npm test")
  quickSummary?: SessionQuickSummary;
  recentFiles?: string[];
  recentFileTimes?: Record<string, number>;
  recentTools?: string[];
  recentToolCalls?: import('../core/session.summary').RecentToolCall[];
  lastFilePath?: string | null;
  narrative?: string; // Agent's most recent substantive assistant prose (rolling summary line)
  cwd?: string | null;
  branch?: string | null;
  recentFileStats?: Record<string, { added: number; removed: number }>;
  waitingForInput?: boolean;
  approvalStatus?: TerminalApprovalStatus;
  role?: string;
  hint?: string;
  isParent?: boolean;
  parentId?: string | null;
  parentLabel?: string | null;
  children?: string[];
}

function pickMostRecentTimestamp(...timestamps: Array<string | undefined>): string | undefined {
  let newestMs = Number.NEGATIVE_INFINITY;
  let newestIso: string | undefined;

  for (const timestamp of timestamps) {
    if (!timestamp) continue;
    const ms = Date.parse(timestamp);
    if (Number.isNaN(ms)) continue;
    if (ms > newestMs) {
      newestMs = ms;
      newestIso = new Date(ms).toISOString();
    }
  }

  return newestIso;
}

// Map from lowercase key (used in UI) to prefix (used in terminal names)
const AGENT_KEY_TO_PREFIX: Record<string, string> = {
  claude: 'CC',
  codex: 'CX',
  gemini: 'GX',
  opencode: 'OC',
  cursor: 'CR',
  shell: 'SH'
};

const AGENT_ROLE_HINTS: Record<string, { role: string; hint: string }> = {
  claude: { role: 'lead', hint: 'Strategy and orchestration' },
  codex: { role: 'fix', hint: 'Fast edits and implementation' },
  gemini: { role: 'research', hint: 'Deep research and exploration' },
  cursor: { role: 'trace', hint: 'Debugging and tracing' },
  opencode: { role: 'assist', hint: 'Editor-style help' },
  shell: { role: 'shell', hint: 'Command execution' }
};

interface WorkspaceGitInfo {
  branch: string | null;
  numstat: Record<string, { added: number; removed: number }>;
}
const gitInfoCache = new Map<string, { ts: number; info: WorkspaceGitInfo }>();
const GIT_INFO_TTL_MS = 2000;
// IN-FLIGHT GUARD (#71): coalesce concurrent computations for the same workspace
// so overlapping panel/floor ticks never fork `git` twice for one path.
const gitInfoInFlight = new Map<string, Promise<WorkspaceGitInfo>>();

// --- Monitor follower routing (#71) ---------------------------------------
//
// When connected to the centralized monitor, the leader's snapshot detector
// computes git/worktree/usage/teams ONCE machine-wide and broadcasts a
// `panel-snapshot` fact; this module + agentPanel render from it instead of
// each window forking the subprocesses on its own 4s poll. When disconnected
// (election race, leader loss) the local compute below runs as the fallback.
// The local code is preserved, not deleted; it is gated on connectivity.
let snapshotMonitorConnected: () => boolean = () => false;
let latestPanelSnapshot: PanelSnapshotPayload | undefined;
let snapshotArmSink: ((watches: SnapshotWatch[]) => void) | undefined;

/** Wire the predicate the snapshot consumers consult for local-vs-broadcast. */
export function setSnapshotMonitorConnectivity(fn: () => boolean): void {
  snapshotMonitorConnected = fn;
}

/** Wire the sink that arms the monitor with this window's snapshot watches. */
export function setSnapshotArmSink(
  fn: ((watches: SnapshotWatch[]) => void) | undefined,
): void {
  snapshotArmSink = fn;
}

/** Replace this window's snapshot watch slice on the monitor (#71). */
export function armSnapshotWatches(watches: SnapshotWatch[]): void {
  snapshotArmSink?.(watches);
}

/** Apply a broadcast panel-snapshot fact: cache it for the panel + floor. */
export function ingestPanelSnapshotFact(payload: PanelSnapshotPayload): void {
  latestPanelSnapshot = payload;
}

/** True while this window is consuming the leader's broadcast snapshot. */
export function isSnapshotMonitorConnected(): boolean {
  return snapshotMonitorConnected();
}

/** The latest broadcast snapshot, or undefined before the first one arrives. */
export function getLatestPanelSnapshot(): PanelSnapshotPayload | undefined {
  return latestPanelSnapshot;
}

async function getWorkspaceGitInfo(workspacePath: string): Promise<WorkspaceGitInfo> {
  // Prefer the leader's broadcast: one git fork machine-wide, not one per window.
  if (snapshotMonitorConnected()) {
    const broadcast = latestPanelSnapshot?.gitByRoot[workspacePath];
    if (broadcast) return broadcast;
  }

  const now = Date.now();
  const cached = gitInfoCache.get(workspacePath);
  if (cached && now - cached.ts < GIT_INFO_TTL_MS) return cached.info;

  const existing = gitInfoInFlight.get(workspacePath);
  if (existing) return existing;

  const compute = (async () => {
    // Canonical git compute lives in snapshotDetector (the leader uses the same).
    const info = await fetchGitInfo(workspacePath);
    gitInfoCache.set(workspacePath, { ts: Date.now(), info });
    return info;
  })().finally(() => {
    gitInfoInFlight.delete(workspacePath);
  });

  gitInfoInFlight.set(workspacePath, compute);
  return compute;
}

const SESSION_SUMMARY_CACHE_MAX = 200;
type SessionSummaryCacheEntry = {
  mtimeMs: number;
  size: number;
  details: SessionQuickDetails;
};
const sessionSummaryCache = new Map<string, SessionSummaryCacheEntry>();

// Read last N lines of a session file for activity extraction. Uses the
// 64KB-backward-seek util in sessions.vscode.ts — earlier this function read
// the entire (multi-MB) file just to slice the last 20 lines, on every
// dashboard tab switch.
async function readSessionTailLines(filePath: string, maxLines: number = 20): Promise<string> {
  const lines = await readTailLines(filePath, maxLines);
  return lines.join('\n');
}

const SESSION_CONTENT_TAIL_BYTES = 256 * 1024;

// Bounded-size read for session-summary parsing. The previous implementation
// did a full fs.readFile on every mtime change; for a 50MB Claude session
// changing on every message, the cache invalidated continuously and the
// extension host re-read the full file every dashboard refresh. Capped at
// 256KB tail, which is enough for the head/tail metadata the summary
// extractor uses.
async function readSessionContent(filePath: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const { size } = await handle.stat();
    if (size === 0) return '';
    const readStart = Math.max(0, size - SESSION_CONTENT_TAIL_BYTES);
    const buf = Buffer.alloc(size - readStart);
    await handle.read(buf, 0, buf.length, readStart);
    return buf.toString('utf-8');
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => {});
  }
}

function makeSessionSummaryCacheKey(filePath: string, agentType: SessionSummaryAgentType): string {
  return `${agentType}:${filePath}`;
}

function cacheSessionSummaryEntry(key: string, entry: SessionSummaryCacheEntry): void {
  if (sessionSummaryCache.has(key)) {
    sessionSummaryCache.delete(key);
  }
  sessionSummaryCache.set(key, entry);
  if (sessionSummaryCache.size <= SESSION_SUMMARY_CACHE_MAX) return;
  const oldestKey = sessionSummaryCache.keys().next().value;
  if (oldestKey) {
    sessionSummaryCache.delete(oldestKey);
  }
}

async function getSessionQuickDetailsCached(
  filePath: string,
  agentType: SessionSummaryAgentType
): Promise<SessionQuickDetails | null> {
  let stats: { mtimeMs: number; size: number };
  try {
    const stat = await fs.stat(filePath);
    stats = { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }

  const cacheKey = makeSessionSummaryCacheKey(filePath, agentType);
  const cached = sessionSummaryCache.get(cacheKey);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.details;
  }

  const sessionContent = await readSessionContent(filePath);
  if (!sessionContent) return null;

  const details = extractSessionQuickDetails(sessionContent, agentType);
  cacheSessionSummaryEntry(cacheKey, {
    ...stats,
    details,
  });
  return details;
}

// Get terminals filtered by agent type with display details
// Scans VS Code terminals directly to handle restored/unregistered terminals
export async function getTerminalsByAgentType(
  agentType: string,
  workspacePath?: string
): Promise<TerminalDetail[]> {
  const expectedPrefix = AGENT_KEY_TO_PREFIX[agentType];
  const results: TerminalDetail[] = [];
  const sessionPromises: Array<{
    index: number;
    sessionPath: Promise<string | undefined>;
    agentType: 'claude' | 'codex' | 'gemini' | 'opencode' | 'cursor' | 'antigravity' | 'grok';
  }> = [];
  let index = 0;

  debugLog(`[getTerminalsByAgentType] Looking for agentType="${agentType}", expectedPrefix="${expectedPrefix}", total terminals=${vscode.window.terminals.length}`);

  for (const terminal of vscode.window.terminals) {
    // Skip terminals whose process has exited (tab may still be open)
    if (terminal.exitStatus !== undefined) continue;

    const identOpts = extractTerminalIdentificationOptions(terminal);
    const info = getTerminalDisplayInfo(identOpts);
    debugLog(`[getTerminalsByAgentType] Terminal "${terminal.name}": info.prefix="${info.prefix}", info.isAgent=${info.isAgent}`);
    if (!info.isAgent || !info.prefix) continue;

    // Match by prefix for built-in agents, or by exact name for custom agents
    const isMatch = expectedPrefix
      ? info.prefix === expectedPrefix
      : info.prefix === agentType;

    if (!isMatch) continue;

    index++;

    // Try to get additional info from our internal map
    const entry = getByTerminal(terminal);
    const resultIndex = results.length;

    debugLog(`[getTerminalsByAgentType] Terminal "${terminal.name}": entry=${entry ? 'found' : 'not found'}, sessionId=${entry?.sessionId || 'null'}, agentType=${entry?.agentType || 'null'}`);

    results.push({
      id: entry?.id || `unregistered-${index}`,
      agentType: agentType,
      label: entry?.label || info.label || null,
      autoLabel: entry?.autoLabel || null,
      createdAt: entry?.createdAt || Date.now(),
      index: index,
      sessionId: entry?.sessionId || null,
      approvalStatus: entry?.approvalStatus || 'pending',
      role: AGENT_ROLE_HINTS[agentType]?.role || 'agent',
      hint: AGENT_ROLE_HINTS[agentType]?.hint || 'Generalist',
      parentId: null,
      parentLabel: null,
      children: []
    });

    // Queue session path lookup if session exists
    if (entry?.sessionId) {
      // Use agentType if available, otherwise infer from agentConfig.prefix
      const sessionAgentType = entry?.agentType || prefixToAgentType(entry?.agentConfig?.prefix ?? null);
      if (sessionAgentType) {
        sessionPromises.push({
          index: resultIndex,
          sessionPath: getSessionPathBySessionId(entry.sessionId!, sessionAgentType, workspacePath),
          agentType: sessionAgentType
        });
      }
    }
  }

  // Resolve all session paths first
  const sessionPaths = await Promise.all(sessionPromises.map(p => p.sessionPath));

  // Now fetch preview info and activity in parallel for each session
  const dataPromises = sessionPromises.map(async (p, i) => {
    const sessionPath = sessionPaths[i];
    debugLog(`[getTerminalsByAgentType] Session ${i}: path=${sessionPath || 'NOT FOUND'}, agentType=${p.agentType}`);
    if (!sessionPath) return {
      index: p.index,
      preview: null,
      activity: null,
      activityTimestamp: null,
      sessionMtimeTimestamp: null,
      quickDetails: null,
      waitingForInput: false
    };

    // Use agent-specific preview function
    let previewPromise: Promise<SessionPreviewInfo | null>;
    if (p.agentType === 'opencode') {
      previewPromise = getOpenCodeSessionPreviewInfo(sessionPath);
    } else if (p.agentType === 'cursor') {
      previewPromise = getCursorSessionPreviewInfo(sessionPath);
    } else {
      previewPromise = getSessionPreviewInfo(sessionPath);
    }

    // OpenCode and Cursor don't use JSONL tail for activity
    const needsTail = p.agentType !== 'opencode' && p.agentType !== 'cursor';
    const summaryAgentType = (p.agentType === 'claude' || p.agentType === 'codex' || p.agentType === 'gemini') ? p.agentType : null;
    const [preview, tail, sessionStat] = await Promise.all([
      previewPromise,
      needsTail ? readSessionTailLines(sessionPath, 20) : Promise.resolve(null),
      fs.stat(sessionPath).catch(() => null)
    ]);

    // Activity extraction only works for JSONL agents
    const activity = (tail && summaryAgentType) ? extractCurrentActivity(tail, summaryAgentType) : null;
    const quickDetails = summaryAgentType
      ? await getSessionQuickDetailsCached(sessionPath, summaryAgentType)
      : null;
    const waitingForInput = (tail && summaryAgentType && summaryAgentType !== 'gemini')
      ? detectWaitingForInput(tail, summaryAgentType)
      : false;

    return {
      index: p.index,
      preview,
      activity: activity ? formatActivity(activity) : null,
      activityTimestamp: activity?.timestamp ? activity.timestamp.toISOString() : null,
      sessionMtimeTimestamp: sessionStat?.mtime ? sessionStat.mtime.toISOString() : null,
      quickDetails,
      waitingForInput
    };
  });

  const dataResults = await Promise.all(dataPromises);

  // Populate results with fetched data
  for (const data of dataResults) {
    if (data.preview) {
      results[data.index].firstUserMessage = data.preview.firstUserMessage;
      results[data.index].lastUserMessage = data.preview.lastUserMessage;
      results[data.index].messageCount = data.preview.messageCount;
      results[data.index].firstMessageTimestamp = data.preview.firstUserMessageTimestamp;
    }
    if (data.activity) {
      results[data.index].currentActivity = data.activity;
    }
    const mostRecentTimestamp = pickMostRecentTimestamp(
      data.activityTimestamp || undefined,
      data.sessionMtimeTimestamp || undefined,
      data.preview?.firstUserMessageTimestamp
    );
    if (mostRecentTimestamp) {
      results[data.index].lastActivityTimestamp = mostRecentTimestamp;
    }
    if (data.quickDetails) {
      results[data.index].quickSummary = data.quickDetails.summary;
      results[data.index].recentFiles = data.quickDetails.recentFiles;
      results[data.index].recentFileTimes = data.quickDetails.recentFileTimes;
      results[data.index].recentTools = data.quickDetails.recentTools;
      results[data.index].recentToolCalls = data.quickDetails.recentToolCalls;
      results[data.index].lastFilePath = data.quickDetails.lastFilePath;
      results[data.index].narrative = data.quickDetails.narrative;
    }
    results[data.index].waitingForInput = data.waitingForInput;

    const currentStatus = results[data.index].approvalStatus;
    const currentActivity = results[data.index].currentActivity;
    if (currentActivity) {
      results[data.index].approvalStatus = 'running';
      results[data.index].status = currentActivity.startsWith('Completed') ? 'completed' : 'running';
    } else if (results[data.index].sessionId && currentStatus === 'pending') {
      results[data.index].approvalStatus = 'approved';
      results[data.index].status = 'idle';
    }
  }

  // All terminals are at the same level - no automatic hierarchy
  // Set status based on activity
  for (const result of results) {
    if (!result.approvalStatus) {
      result.approvalStatus = result.currentActivity ? 'running' : 'pending';
    }
    if (!result.status) {
      result.status = result.currentActivity ? 'running' : 'idle';
    }
  }

  // Annotate with workspace cwd/branch + per-file diff stats (cached per workspace).
  if (workspacePath && results.length > 0) {
    const gitInfo = await getWorkspaceGitInfo(workspacePath).catch(() => null);
    for (const result of results) {
      result.cwd = workspacePath;
      if (gitInfo) {
        result.branch = gitInfo.branch;
        if (result.recentFiles && result.recentFiles.length > 0) {
          const stats: Record<string, { added: number; removed: number }> = {};
          for (const f of result.recentFiles) {
            const s = gitInfo.numstat[f] || gitInfo.numstat[path.resolve(workspacePath, f)];
            if (s) stats[f] = s;
          }
          if (Object.keys(stats).length > 0) result.recentFileStats = stats;
        }
      }
    }
  }

  results.sort((a, b) => a.createdAt - b.createdAt);
  for (let i = 0; i < results.length; i++) {
    results[i].index = i + 1;
  }

  return results;
}

export async function getFloorTerminalDetails(workspacePath?: string): Promise<TerminalDetail[]> {
  const agentTypes = ['claude', 'codex', 'gemini', 'opencode', 'cursor'];
  const localDetails = (await Promise.all(
    agentTypes.map((agentType) => getTerminalsByAgentType(agentType, workspacePath)),
  )).flat();

  localDetails.sort((a, b) => a.createdAt - b.createdAt);
  for (let i = 0; i < localDetails.length; i++) {
    localDetails[i].index = i + 1;
  }
  return localDetails;
}

// Clear state (for testing/deactivation)
export function clear(): void {
  // Dispose any auto-label pollers still running so deactivate doesn't leak
  // intervals for terminals whose label never resolved.
  for (const entry of editorTerminals.values()) {
    if (entry.autoLabelPollerId) {
      clearInterval(entry.autoLabelPollerId);
      entry.autoLabelPollerId = undefined;
    }
  }
  editorTerminals.clear();
  terminalIdCounter = 0;
  sessionSummaryCache.clear();
}

// Session persistence for restore across VS Code restarts

// Build persisted session data from current terminals
export function buildPersistedSessions(): sessionsPersist.PersistedSession[] {
  const sessions: sessionsPersist.PersistedSession[] = [];

  for (const entry of editorTerminals.values()) {
    // Only persist agent terminals (not regular terminals)
    if (!entry.agentConfig) continue;

    sessions.push({
      terminalId: entry.id,
      prefix: entry.agentConfig.prefix,
      sessionId: entry.sessionId,
      label: entry.label,
      agentType: entry.agentType,
      version: entry.version,
      createdAt: entry.createdAt
    });
  }

  return sessions;
}

// Persist all current sessions for a workspace
export function persistSessions(workspacePath: string): void {
  const sessions = buildPersistedSessions();
  sessionsPersist.saveWorkspaceSessions(workspacePath, sessions, true);
}

// Load persisted sessions for a workspace
export function loadPersistedSessions(workspacePath: string): sessionsPersist.PersistedSession[] {
  return sessionsPersist.getWorkspaceSessions(workspacePath);
}

// Clear persisted sessions after successful restore
export function clearPersistedSessions(workspacePath: string): void {
  sessionsPersist.clearWorkspaceSessions(workspacePath);
}

// Update a session's metadata (e.g., when CLI sessionId is captured)
export function updatePersistedSession(
  workspacePath: string,
  terminalId: string,
  updates: Partial<sessionsPersist.PersistedSession>
): void {
  sessionsPersist.updateSession(workspacePath, terminalId, updates);
}
