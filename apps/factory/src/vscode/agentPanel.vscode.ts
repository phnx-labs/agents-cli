// Agent Panel: an activity-bar sidebar view that always reflects the user's
// currently focused agent terminal.
//
// Shows:
//   - Agent logo + name + version + session chunk + label (manual or auto)
//   - Worktree path with branch + dirty count and Commit / Cleanup / Wrap buttons
//   - Conversation topic + recent tool calls (read/edit/run)
//   - Linear ticket + PR URL extracted from the session, when present
//   - Quick prompts (favorites first) — click to send into the focused terminal
//   - Teams whose workspace_dir is related to the terminal's cwd
//
// Detection model:
//   active terminal -> terminals.getByTerminal(t) -> EditorTerminal struct
//   cwd            -> terminal.creationOptions.cwd
//   teams          -> agents teams list --json + agents teams status <t> --json
//                     filtered by pathsRelated(workspace_dir, cwd)
//   git info       -> vscode.git extension repository state
//   linear/PR      -> regex scan over the session preview + tail
//
// Refresh signals:
//   onDidChangeActiveTerminal               -> re-render immediately
//   onDidCloseTerminal / onDidOpenTerminal  -> re-render
//   fs.watch on PLAN.md                     -> re-render
//   4s poll while visible                   -> teams + git freshness

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as terminals from './terminals.vscode';
import { buildAgentTerminalEnv } from '../core/terminals';
import { listTeamsForCwd, TeamWithMates } from './foreman.sources';
import { getSessionPathBySessionId, getSessionPreviewInfo, SessionPreviewInfo, readTailLines } from './sessions.vscode';
import { extractLinearTicketId } from '../core/utils';
import { readPrompts } from './settings.vscode';
import { BUILT_IN_AGENTS } from '../core/agents';
import { parseLineForActivity, formatActivity } from '../core/session.activity';
import { getSessionToolStatsViaAgentsCli } from '../core/handoff';
import {
  extractPrUrls as extractPrUrlsHelper,
  type PullRequestRef as SharedPullRequestRef,
  type WorktreeRef as SharedWorktreeRef,
} from '../core/panel.helpers';
import { fetchUsage, fetchWorktrees } from '../monitor/snapshotDetector';
import type { AgentsViewJsonAgent } from '../core/resumeInBest';
import type { SnapshotWatch } from '../monitor/protocol';

export const AGENT_PANEL_VIEW_ID = 'agentsPanel.terminal';

interface PlanFileInfo {
  path: string;
  mtimeMs: number;
}

interface ConversationSummary {
  topic?: string;            // first user prompt — what this session is about
  lastMessage?: string;      // most recent user message
  messageCount: number;
  lastActivityMs?: number;
}

interface ActivityItem {
  kind: string;   // 'reading' | 'editing' | 'running' | 'thinking' | 'completed' | ...
  summary: string;
  ts: number;
}

interface QuickPromptLite {
  id: string;
  title: string;
  preview: string;
  favorite: boolean;
}

interface GitInfo {
  branch?: string;
  dirtyCount?: number;
}

// Derived from session mtime + git + PRs. Drives which Quick Actions render.
// Deterministic — no LLM call. See computeAgentState().
type AgentState =
  | 'streaming'         // session JSONL touched recently — agent is producing output
  | 'pr_open'           // a PR URL was extracted from the session
  | 'idle_dirty'        // idle, working tree has changes
  | 'idle_clean_wt'     // idle, clean tree, terminal is in a worktree
  | 'idle_clean';       // idle, clean tree, no worktree

// "Streaming" window: panel polls every 4s, so this is ~2 polls.
const STREAMING_MS = 10_000;

// Re-export shared types so the rest of this file doesn't need to switch on
// `SharedFoo` everywhere. Keeps the snapshot interface readable.
type PullRequestRef = SharedPullRequestRef;
type WorktreeRef = SharedWorktreeRef;

interface RecentFile {
  path: string;            // absolute file path
  mtimeMs?: number;        // filesystem mtime, when readable
}

interface PanelSnapshot {
  hasTerminal: boolean;
  // Terminal facts
  terminalId?: string;       // internal id for action commands
  agentName?: string;        // "Claude"
  agentPrefix?: string;      // "CC"
  agentType?: string;        // "claude" | "codex" | ... — used for usage lookup
  agentIconUri?: string;     // webview URI to PNG logo
  sessionChunk?: string;     // first 8 of session UUID
  fullSessionId?: string;
  version?: string;
  label?: string;
  autoLabel?: string;
  account?: string;
  // Filesystem
  cwd?: string;
  worktreePath?: string;     // when distinguishable from workspace root
  worktreeName?: string;     // basename shown compactly in the terminal card
  workspaceRoot?: string;
  // Git
  git?: GitInfo;
  // Conversation
  conversation?: ConversationSummary;
  recentActivity?: ActivityItem[];
  // Linked artifacts — multi-PR (the agent may have opened several in one session)
  linearIssue?: string;
  pullRequests?: PullRequestRef[];
  // Recent file edits — surfaces what the agent has been touching
  recentFiles?: RecentFile[];
  // All worktrees attached to the workspace, including the main checkout
  worktrees?: WorktreeRef[];
  // Account usage state — surfaces "out of credits" / "rate limited"
  usageStatus?: 'available' | 'rate_limited' | 'out_of_credits' | null;
  // Plan files
  plan?: PlanFileInfo;
  // Teams
  teams: TeamWithMates[];
  // Quick prompts (top N favorites + recent)
  quickPrompts: QuickPromptLite[];
  // Derived state — drives state-driven Quick Actions
  agentState?: AgentState;
  // Errors / diagnostics
  teamsError?: string;
}

function computeAgentState(snap: PanelSnapshot): AgentState {
  // Streaming wins over everything: while the session file is actively being
  // written, the agent owns the input — show "Working", hide actions.
  const lastMs = snap.conversation?.lastActivityMs;
  if (lastMs && Date.now() - lastMs < STREAMING_MS) return 'streaming';
  // PR open: once a PR is in flight, the primary action is to surface it.
  if (snap.pullRequests && snap.pullRequests.length > 0) return 'pr_open';
  const dirty = snap.git?.dirtyCount ?? 0;
  if (dirty > 0) return 'idle_dirty';
  if (snap.worktreePath) return 'idle_clean_wt';
  return 'idle_clean';
}

class AgentPanelProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private snapshot: PanelSnapshot = { hasTerminal: false, teams: [], quickPrompts: [] };
  // IN-FLIGHT GUARD (#71): overlapping refreshes (4s poll racing an event-driven
  // refresh, or a slow local-fallback `agents view`) coalesce onto one running
  // build so two snapshot computations never run concurrently.
  private buildInFlight: Promise<PanelSnapshot> | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private planWatcher: vscode.FileSystemWatcher | undefined;
  private lastWatchedDir: string | undefined;
  // The webview script signals 'ready' once its message listener is attached.
  // Until then, postMessage calls race the iframe load and get dropped — so we
  // queue a single "send current snapshot when ready" flag.
  private webviewReady = false;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    this.view = webviewView;
    // Each fresh resolve gets a fresh iframe — its listener has not attached
    // yet, so any cached "ready" state from a previous mount is invalid.
    this.webviewReady = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'assets')],
    };

    webviewView.webview.html = this.renderShell(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.refresh();
        this.startPolling();
      } else {
        this.stopPolling();
      }
    });

    webviewView.onDidDispose(() => {
      this.stopPolling();
      this.disposePlanWatcher();
      this.view = undefined;
    });

    void this.refresh();
    if (webviewView.visible) this.startPolling();
  }

  private async handleMessage(msg: any): Promise<void> {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'ready':
        this.webviewReady = true;
        this.view?.webview.postMessage({ type: 'snapshot', data: this.snapshot });
        void this.refresh();
        return;
      case 'openPath':
        if (typeof msg.path === 'string') {
          vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path));
        }
        return;
      case 'openWorktree':
        // Worktree paths are DIRECTORIES — `vscode.open` shows an error toast
        // for directories. Open as a folder in a new window instead so the
        // user lands inside the parallel agent's checkout.
        if (typeof msg.path === 'string') {
          vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(msg.path), {
            forceNewWindow: true,
          });
        }
        return;
      case 'revealCwd':
        if (typeof msg.path === 'string') {
          vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(msg.path));
        }
        return;
      case 'openUrl':
        if (typeof msg.url === 'string') {
          vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        return;
      case 'openSourceControl':
        vscode.commands.executeCommand('workbench.view.scm');
        return;
      case 'refresh':
        void this.refresh();
        return;
      case 'runQuickAction':
        await this.runQuickAction(msg.action, msg.terminalId, msg.workspaceRoot, msg.url);
        return;
      case 'sendQuickPrompt':
        await this.sendQuickPrompt(msg.promptId, msg.terminalId);
        return;
      case 'insertPathInTerminal':
        if (typeof msg.path === 'string' && msg.path) {
          const t = msg.terminalId ? terminals.getById(msg.terminalId)?.terminal : vscode.window.activeTerminal;
          if (t) {
            t.show(true);
            t.sendText(msg.path, false);
          }
        }
        return;
    }
  }

  private async runQuickAction(
    action: string,
    terminalId: string | undefined,
    workspaceRoot: string | undefined,
    url: string | undefined,
  ): Promise<void> {
    const entry = terminalId ? terminals.getById(terminalId) : undefined;
    const terminal = entry?.terminal ?? vscode.window.activeTerminal;
    // Claude's Ink TUI submits on \r; Codex/Gemini submit on the \n that
    // sendText(_, true) appends. Centralized here so action handlers below
    // don't duplicate the gotcha.
    const sendSlash = (slash: string) => {
      if (!terminal) return false;
      terminal.show(true);
      if (entry?.agentType === 'claude') {
        terminal.sendText(slash, false);
        terminal.sendText('\r', false);
      } else {
        terminal.sendText(slash, true);
      }
      return true;
    };
    switch (action) {
      case 'cleanup': {
        // `agents worktree prune` scans .history/worktrees/ *under a repo root*,
        // not inside an individual worktree — so always pass the workspace root,
        // never the active terminal's worktree path.
        const root = workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
          vscode.window.showInformationMessage('No workspace root for cleanup.');
          return;
        }
        await runInShellTerminal(`agents worktree prune --root ${shellQuote(root)}`);
        return;
      }
      case 'openPr':
        if (typeof url === 'string') {
          vscode.env.openExternal(vscode.Uri.parse(url));
        }
        return;
      case 'diff':
        vscode.commands.executeCommand('workbench.view.scm');
        return;
      case 'slash':
        // url field carries the slash command text (e.g. "/commit", "/done").
        // Reused over a new field so the existing webview->host message shape
        // stays unchanged.
        if (typeof url === 'string' && url.startsWith('/')) {
          if (!sendSlash(url)) {
            vscode.window.showInformationMessage('No active agent terminal.');
          }
        }
        return;
    }
  }

  private async sendQuickPrompt(
    promptId: string | undefined,
    terminalId: string | undefined,
  ): Promise<void> {
    if (!promptId) return;
    const all = readPrompts();
    const entry = all.find((p) => p.id === promptId);
    if (!entry) {
      vscode.window.showWarningMessage(`Prompt "${promptId}" no longer exists.`);
      return;
    }
    const terminal = terminalId ? terminals.getById(terminalId)?.terminal : vscode.window.activeTerminal;
    if (!terminal) {
      vscode.window.showInformationMessage('No agent terminal to send the prompt to.');
      return;
    }
    terminal.show(true);
    // Insert without submitting so the user can edit before pressing Enter.
    terminal.sendText(entry.content, false);
  }

  // Public so the extension can poke a refresh on terminal lifecycle events
  // (open / close / active change) without us subscribing to them here.
  async refresh(): Promise<void> {
    if (!this.view) return;
    this.snapshot = await this.runBuildSnapshot();
    this.syncPlanWatcher(this.snapshot.cwd);
    if (this.webviewReady) {
      this.view.webview.postMessage({ type: 'snapshot', data: this.snapshot });
    }
    // If not ready, snapshot stays cached; the 'ready' handler will push it.
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, 4000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private disposePlanWatcher(): void {
    if (this.planWatcher) {
      this.planWatcher.dispose();
      this.planWatcher = undefined;
      this.lastWatchedDir = undefined;
    }
  }

  // Reset the PLAN.md watcher when the focused terminal's cwd changes.
  private syncPlanWatcher(cwd: string | undefined): void {
    if (cwd === this.lastWatchedDir) return;
    this.disposePlanWatcher();
    if (!cwd) return;
    const pattern = new vscode.RelativePattern(cwd, 'PLAN.md');
    this.planWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onChange = () => void this.refresh();
    this.planWatcher.onDidChange(onChange);
    this.planWatcher.onDidCreate(onChange);
    this.planWatcher.onDidDelete(onChange);
    this.lastWatchedDir = cwd;
  }

  // Coalesce concurrent builds onto one running computation (in-flight guard).
  private runBuildSnapshot(): Promise<PanelSnapshot> {
    if (this.buildInFlight) return this.buildInFlight;
    const p = this.buildSnapshot().finally(() => {
      if (this.buildInFlight === p) this.buildInFlight = undefined;
    });
    this.buildInFlight = p;
    return p;
  }

  private async buildSnapshot(): Promise<PanelSnapshot> {
    const active = vscode.window.activeTerminal;
    if (!active) {
      return { hasTerminal: false, teams: [], quickPrompts: [] };
    }
    const entry = terminals.getByTerminal(active);
    if (!entry || !entry.agentConfig) {
      return { hasTerminal: false, teams: [], quickPrompts: [] };
    }

    const opts = active.creationOptions as vscode.TerminalOptions;
    const env = opts?.env as Record<string, string | undefined> | undefined;
    const envWorkspaceDir = env?.AGENT_WORKSPACE_DIR?.trim() || undefined;
    const cwdRaw = opts?.cwd;
    const cwd =
      typeof cwdRaw === 'string'
        ? cwdRaw
        : cwdRaw && 'fsPath' in cwdRaw
          ? (cwdRaw as vscode.Uri).fsPath
          : envWorkspaceDir;

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const worktreePath = cwd && workspaceRoot && path.resolve(cwd) !== path.resolve(workspaceRoot) ? cwd : undefined;
    const worktreeName = cwd ? path.basename(cwd) : undefined;

    const plan = cwd ? readPlanFile(cwd) : undefined;

    const sessionId = entry.sessionId;
    const sessionChunk = sessionId ? sessionId.slice(0, 8) : undefined;

    const snapshot: PanelSnapshot = {
      hasTerminal: true,
      terminalId: entry.id,
      agentName: entry.agentConfig.title,
      agentPrefix: entry.agentConfig.prefix,
      agentType: entry.agentType,
      agentIconUri: this.iconUriFor(entry.agentConfig.prefix),
      sessionChunk,
      fullSessionId: sessionId,
      version: entry.statusVersion || entry.version,
      label: entry.label,
      autoLabel: entry.autoLabel,
      account: entry.statusAccount || entry.account,
      cwd,
      worktreePath,
      worktreeName,
      workspaceRoot,
      plan,
      teams: [],
      quickPrompts: pickQuickPrompts(),
    };

    // Conversation summary + recent activity + linked artifacts come from
    // the session JSONL. All best-effort; never block the panel on them.
    // Resolved once and reused for the tool-stats mtime cache below (#94).
    let sessionFilePath: string | undefined;
    if (sessionId && entry.agentType) {
      try {
        sessionFilePath = await getSessionPathBySessionId(sessionId, entry.agentType);
        const filePath = sessionFilePath;
        if (filePath) {
          const preview: SessionPreviewInfo = await getSessionPreviewInfo(filePath);
          snapshot.conversation = {
            topic: preview.firstUserMessage,
            lastMessage: preview.lastUserMessage,
            messageCount: preview.messageCount,
            lastActivityMs: preview.lastActivityMs,
          };
          const linear =
            extractLinearTicketId(preview.firstUserMessage) ||
            extractLinearTicketId(preview.lastUserMessage);
          if (linear) snapshot.linearIssue = linear;

          const tailLines = await readTailLines(filePath, 80);
          snapshot.recentActivity = collectRecentActivity(tailLines, entry.agentType, 5);
          // Scan the full transcript-by-tail PLUS first/last user messages so a
          // PR mentioned in a wrap-up message isn't dropped. extractPrUrls
          // returns every match deduped, not just the first.
          snapshot.pullRequests = extractPrUrls(tailLines.concat(
            preview.firstUserMessage ?? '',
            preview.lastUserMessage ?? '',
          ));
        }
      } catch {
        // Session preview is best-effort; never block the panel on it.
      }
    }

    // Recent file edits — surfaces what the agent actually touched, beyond
    // the "5 changed" chip. Best-effort: handoff helper shells out to
    // `agents sessions <id> --json --include tools`. Never block on this.
    if (sessionId && cwd) {
      try {
        const stats = await getSessionToolStatsViaAgentsCli(sessionId, cwd, sessionFilePath);
        // recentFiles from the helper is chronological; the last entry is the
        // newest edit. Reverse so the panel shows newest-first, then enrich
        // with mtime where the file still exists.
        const files = stats.recentFiles.slice().reverse().slice(0, 10);
        snapshot.recentFiles = files.map((p) => {
          let mtimeMs: number | undefined;
          try { mtimeMs = fs.statSync(p).mtimeMs; } catch { /* file gone or unreadable */ }
          return { path: p, mtimeMs };
        });
      } catch { /* best-effort */ }
    }

    // Arm the monitor with what this window's panel + floor need so the leader
    // computes git/worktrees (workspace root) + teams/usage (active tuple) once
    // machine-wide (#71). Replaces this window's whole slice each refresh.
    if (workspaceRoot) {
      const watches: SnapshotWatch[] = [{ workspaceRoot }];
      watches.push({ workspaceRoot, cwd: cwd ?? workspaceRoot, agentType: entry.agentType });
      terminals.armSnapshotWatches(watches);
    }

    snapshot.git = cwd ? await readGitInfo(cwd) : undefined;

    // Worktrees attached to this workspace — `git worktree list --porcelain`
    // emits the main checkout + every additional worktree. Lets the user see
    // sibling agents working on parallel branches. Rendered from the broadcast
    // snapshot when connected; computed locally only while disconnected (#71).
    if (workspaceRoot) {
      try {
        snapshot.worktrees = await getWorktreesRouted(workspaceRoot, cwd);
      } catch { /* best-effort */ }
    }

    // Usage status (rate-limited / out of credits) for the bound agent
    // version. The signal is the same one `agents view --json` exposes per
    // version. Rendered from the broadcast snapshot when connected (#71).
    if (entry.agentType) {
      try {
        snapshot.usageStatus = await getUsageStatusRouted(entry.agentType, entry.statusVersion || entry.version);
      } catch { /* best-effort */ }
    }

    try {
      snapshot.teams = await getTeamsRouted(cwd);
    } catch (err) {
      snapshot.teamsError = err instanceof Error ? err.message : String(err);
    }

    snapshot.agentState = computeAgentState(snapshot);
    return snapshot;
  }

  private iconUriFor(prefix: string | undefined): string | undefined {
    if (!prefix || !this.view) return undefined;
    const def = BUILT_IN_AGENTS.find(
      (a) => a.prefix === prefix || a.prefix.toUpperCase() === (prefix ?? '').toUpperCase(),
    );
    if (!def) return undefined;
    const onDisk = vscode.Uri.joinPath(this.extensionUri, 'assets', def.icon);
    return this.view.webview.asWebviewUri(onDisk).toString();
  }

  private renderShell(webview: vscode.Webview): string {
    const nonce = randomNonce();
    const cspSource = webview.cspSource;
    return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src ${cspSource} https: data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root {
    color-scheme: light dark;
  }
  body {
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-foreground);
    padding: 0 12px 16px;
    margin: 0;
  }
  h2 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground);
    font-weight: 600;
    margin: 14px 0 6px;
  }
  .empty {
    color: var(--vscode-descriptionForeground);
    padding: 24px 4px;
    font-style: italic;
  }
  .card {
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 4px;
    padding: 8px 10px;
    background: var(--vscode-sideBar-background);
    margin-top: 4px;
  }
  .agent-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .agent-logo {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    flex-shrink: 0;
    object-fit: contain;
    background: var(--vscode-input-background, transparent);
  }
  .agent-head-text { flex: 1; min-width: 0; }
  .title-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-weight: 600;
  }
  .agent-name { color: var(--vscode-foreground); }
  .session-chunk {
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    font-weight: 400;
  }
  .version-pill {
    margin-left: auto;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 1px 6px;
    border-radius: 8px;
    font-size: 10px;
    font-weight: 500;
  }
  .label-row {
    margin-top: 3px;
    color: var(--vscode-foreground);
  }
  .label-auto {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }
  .account-row {
    margin-top: 3px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }
  .worktree-row {
    margin-top: 3px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .branch-row {
    margin-top: 3px;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
  .branch-name {
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-foreground);
    background: transparent;
    border: none;
    padding: 0;
    font-size: inherit;
    cursor: pointer;
  }
  .branch-name:hover { text-decoration: underline; }
  .dirty-pill {
    background: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-badge-background));
    color: var(--vscode-badge-foreground);
    padding: 0 5px;
    border-radius: 8px;
    font-size: 10px;
    border: none;
    cursor: pointer;
    font: inherit;
    font-size: 10px;
  }
  .dirty-pill:hover { filter: brightness(1.15); }
  .working-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--vscode-descriptionForeground);
    font-size: 11.5px;
    padding: 4px 2px;
  }
  .pulse-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--vscode-charts-green, #6abe6a);
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 1; }
  }
  .row-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 8px;
    margin-top: 4px;
  }
  .row-grid dt {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }
  .row-grid dd {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .path-link {
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-decoration: none;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
  }
  .path-link:hover { text-decoration: underline; }
  .plan-line {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 0;
  }
  .plan-meta {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }
  .conv-topic {
    color: var(--vscode-foreground);
    line-height: 1.4;
    word-break: break-word;
  }
  .conv-topic p { margin: 0 0 6px; }
  .conv-topic p:last-child { margin-bottom: 0; }
  .conv-topic .md-heading {
    font-weight: 600;
    margin: 0 0 5px;
  }
  .conv-topic code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.94em;
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.16));
    border-radius: 3px;
    padding: 0 3px;
  }
  .conv-topic .md-bullet {
    padding-left: 10px;
    text-indent: -8px;
  }
  .conv-meta {
    margin-top: 6px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }
  .activity {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 2px 0;
    font-size: 11.5px;
    line-height: 1.4;
  }
  .activity-kind {
    width: 56px;
    flex-shrink: 0;
    color: var(--vscode-descriptionForeground);
    text-transform: lowercase;
    font-size: 10.5px;
  }
  .activity-summary {
    color: var(--vscode-foreground);
    word-break: break-word;
  }
  .actions-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .action-btn {
    flex: 1 1 auto;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 4px;
    padding: 6px 8px;
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
    text-align: center;
  }
  .action-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground));
  }
  .action-btn.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .action-btn.primary:hover {
    background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
  }
  .slash-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 5px;
  }
  .action-btn.slash {
    flex: none;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11.5px;
    padding: 5px 8px;
    text-align: left;
  }
  .actions-pr {
    margin-bottom: 8px;
  }
  .actions-hint {
    margin-top: 8px;
    color: var(--vscode-descriptionForeground);
    font-size: 10.5px;
  }
  .prompt-grid {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .prompt-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 4px;
    padding: 6px 8px;
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
    text-align: left;
    overflow: hidden;
  }
  .prompt-btn:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .prompt-title {
    font-weight: 500;
    flex: 0 0 auto;
  }
  .prompt-preview {
    color: var(--vscode-descriptionForeground);
    font-size: 10.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .prompt-star {
    color: var(--vscode-charts-yellow, #d4a72c);
    font-size: 10px;
    margin-right: 2px;
  }
  .links-list { display: flex; flex-direction: column; gap: 4px; }
  .link-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
  }
  .link-row a {
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-decoration: none;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .link-row a:hover { text-decoration: underline; }
  .link-tag {
    color: var(--vscode-descriptionForeground);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .usage-badge {
    display: inline-block;
    margin-left: 8px;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .usage-badge.usage-out {
    background: var(--vscode-inputValidation-errorBackground, rgba(228, 86, 86, 0.18));
    color: var(--vscode-inputValidation-errorForeground, #e45656);
    border: 1px solid var(--vscode-inputValidation-errorBorder, transparent);
  }
  .usage-badge.usage-rate {
    background: var(--vscode-inputValidation-warningBackground, rgba(212, 153, 0, 0.18));
    color: var(--vscode-inputValidation-warningForeground, #d49900);
    border: 1px solid var(--vscode-inputValidation-warningBorder, transparent);
  }
  .recent-file {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 2px 0;
    font-size: 11.5px;
  }
  .recent-file .path-link {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-decoration: none;
  }
  .recent-file .path-link:hover { text-decoration: underline; }
  .recent-file-time {
    color: var(--vscode-descriptionForeground);
    font-size: 10.5px;
    flex-shrink: 0;
  }
  .worktree {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 0;
    font-size: 11.5px;
  }
  .wt-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--vscode-descriptionForeground);
    opacity: 0.5;
    flex-shrink: 0;
  }
  .wt-dot.active {
    background: var(--vscode-charts-green, #6bc167);
    opacity: 1;
  }
  .wt-name {
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-decoration: none;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .wt-name:hover { text-decoration: underline; }
  .wt-name.active { font-weight: 600; }
  .wt-tag {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-badge-background, transparent);
    padding: 0 5px;
    border-radius: 6px;
  }
  .wt-branch {
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10.5px;
    margin-left: auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .team {
    margin-top: 6px;
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 4px;
    padding: 6px 8px;
    background: var(--vscode-sideBar-background);
  }
  .team-head {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .team-name { font-weight: 600; }
  .team-counts {
    margin-left: auto;
    font-size: 10.5px;
    color: var(--vscode-descriptionForeground);
  }
  .mate {
    display: grid;
    grid-template-columns: 14px 1fr auto auto;
    align-items: center;
    gap: 6px;
    padding: 2px 0 2px 4px;
    font-size: 11.5px;
  }
  .mate-dot {
    width: 6px; height: 6px; border-radius: 50%;
    justify-self: center;
  }
  .mate-dot.running   { background: var(--vscode-charts-green, #6abe6a); }
  .mate-dot.completed { background: var(--vscode-descriptionForeground); }
  .mate-dot.pending   { background: var(--vscode-charts-yellow, #d4a72c); }
  .mate-dot.failed    { background: var(--vscode-errorForeground, #d4534b); }
  .mate-dot.stopped   { background: var(--vscode-descriptionForeground); opacity: 0.5; }
  .mate-name { font-family: var(--vscode-editor-font-family, monospace); }
  .mate-agent {
    color: var(--vscode-descriptionForeground);
    font-size: 10.5px;
  }
  .mate-status {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground);
  }
  .err {
    color: var(--vscode-errorForeground);
    font-size: 11px;
    margin-top: 4px;
  }
  .footer {
    margin-top: 16px;
    color: var(--vscode-descriptionForeground);
    font-size: 10.5px;
    text-align: right;
  }
  .footer button {
    background: none;
    border: none;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    font: inherit;
    padding: 0;
  }
  .footer button:hover { text-decoration: underline; }
</style>
</head>
<body>
<div id="root">
  <div class="empty">Loading...</div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function relTime(ms) {
  if (!ms) return '';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  const m = Math.floor(delta / 60_000);
  if (m < 60) return m + ' minute' + (m === 1 ? '' : 's') + ' ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' hour' + (h === 1 ? '' : 's') + ' ago';
  const d = Math.floor(h / 24);
  return d + ' day' + (d === 1 ? '' : 's') + ' ago';
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function renderTerminalCard(s) {
  const logo = s.agentIconUri
    ? '<img class="agent-logo" src="' + esc(s.agentIconUri) + '" alt="" />'
    : '';
  const titleBits = [
    '<span class="agent-name">' + esc(s.agentName || s.agentPrefix || 'Agent') + '</span>',
    s.sessionChunk ? '<span class="session-chunk">' + esc(s.sessionChunk) + '</span>' : '',
    s.version ? '<span class="version-pill">v' + esc(s.version) + '</span>' : ''
  ].join('');
  let label = '';
  if (s.label) {
    label = '<div class="label-row">' + esc(s.label) + '</div>';
  } else if (s.autoLabel) {
    label = '<div class="label-row label-auto">' + esc(s.autoLabel) + '</div>';
  }
  let usageBadge = '';
  if (s.usageStatus === 'out_of_credits') {
    usageBadge = '<span class="usage-badge usage-out">⚠ out of credits</span>';
  } else if (s.usageStatus === 'rate_limited') {
    usageBadge = '<span class="usage-badge usage-rate">⚠ rate-limited</span>';
  }
  const account = (s.account || usageBadge)
    ? '<div class="account-row">' + (s.account ? esc(s.account) : '') + usageBadge + '</div>'
    : '';
  const worktree = s.worktreeName
    ? '<div class="worktree-row">' + esc((s.worktreePath ? 'worktree ' : 'cwd ') + s.worktreeName) + '</div>'
    : '';
  let branch = '';
  if (s.git && s.git.branch) {
    const dirty = s.git.dirtyCount && s.git.dirtyCount > 0
      ? '<button type="button" class="dirty-pill" data-scm="1" title="Open Source Control">' + s.git.dirtyCount + ' changed</button>'
      : '';
    branch = '<div class="branch-row"><span>branch</span>' +
      '<button type="button" class="branch-name" data-scm="1" title="Open Source Control">' + esc(s.git.branch) + '</button>' +
      dirty + '</div>';
  }
  return (
    '<div class="card">' +
      '<div class="agent-head">' +
        logo +
        '<div class="agent-head-text">' +
          '<div class="title-row">' + titleBits + '</div>' +
          label +
          worktree +
          branch +
          account +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

function renderActionsCard(s) {
  if (!s.cwd) return '';
  const state = s.agentState || 'idle_clean';

  // Streaming: agent is actively producing output. Sending a slash command
  // mid-stream would corrupt the prompt. Render a passive "Working..." pill
  // so the slot doesn't collapse.
  if (state === 'streaming') {
    return (
      '<h2>Quick actions</h2>' +
      '<div class="card"><div class="working-pill"><span class="pulse-dot"></span>Working...</div></div>'
    );
  }

  const dirty = (s.git && s.git.dirtyCount) || 0;

  // Chips are the slash commands they actually send. Click injects the
  // command into the focused terminal via the 'slash' action (handled in
  // runQuickAction). One chip is marked primary based on the current
  // agent state so the recommended next step stands out.
  const SLASH_COMMANDS = ['/commit', '/done', '/next', '/finish', '/test', '/review'];

  // Recommended chip by state:
  //   dirty tree         -> /commit
  //   in worktree, clean -> /done (wrap up)
  //   plain idle         -> /next
  let recommended;
  switch (state) {
    case 'idle_dirty': recommended = '/commit'; break;
    case 'idle_clean_wt': recommended = '/done'; break;
    case 'pr_open': recommended = '/done'; break;
    case 'idle_clean':
    default: recommended = '/next'; break;
  }

  const dirtyHint = dirty > 0
    ? '<div class="actions-hint">' + dirty + ' uncommitted ' + (dirty === 1 ? 'change' : 'changes') + '</div>'
    : '';

  const chips = SLASH_COMMANDS.map((cmd) => {
    const cls = cmd === recommended ? 'action-btn slash primary' : 'action-btn slash';
    return '<button class="' + cls + '" data-action="slash" data-url="' + esc(cmd) + '">' + esc(cmd) + '</button>';
  }).join('');

  // Keep the PR shortcut visible when one exists — it's not a slash command
  // but it's the most useful jump when a PR is open.
  const prs = s.pullRequests || [];
  const pr = state === 'pr_open' ? prs[prs.length - 1] : undefined;
  const prRow = pr
    ? '<div class="actions-pr"><button class="action-btn primary" data-action="openPr" data-url="' + esc(pr.url) + '">Open PR #' + pr.number + '</button></div>'
    : '';

  return (
    '<h2>Quick actions</h2>' +
    '<div class="card">' +
      prRow +
      '<div class="slash-grid">' + chips + '</div>' +
      dirtyHint +
    '</div>'
  );
}

function renderLinksCard(s) {
  // Linear ticket gets its own compact row above the multi-PR card so the
  // "Pull Requests" header can stay focused on PRs (which can be many).
  const prs = (s.pullRequests || []);
  if (!s.linearIssue && prs.length === 0) return '';

  const linearRow = s.linearIssue
    ? '<div class="link-row"><span class="link-tag">linear</span>' +
        '<a data-url="' + esc('https://linear.app/issue/' + encodeURIComponent(s.linearIssue)) + '">' +
          esc(s.linearIssue) +
        '</a></div>'
    : '';

  const prRows = prs.map((pr) => (
    '<div class="link-row"><span class="link-tag">pr</span>' +
      '<a data-url="' + esc(pr.url) + '">' +
        esc(pr.ownerRepo) + ' #' + pr.number +
      '</a></div>'
  )).join('');

  let html = '';
  if (linearRow) {
    html += '<h2>Linear</h2>' +
      '<div class="card"><div class="links-list">' + linearRow + '</div></div>';
  }
  if (prRows) {
    const heading = prs.length === 1 ? 'Pull request' : 'Pull requests (' + prs.length + ')';
    html += '<h2>' + heading + '</h2>' +
      '<div class="card"><div class="links-list">' + prRows + '</div></div>';
  }
  return html;
}

function renderConversationCard(s) {
  if (!s.conversation) return '';
  const c = s.conversation;
  const topic = (c.topic || '').trim();
  if (!topic && !c.messageCount) return '';
  const meta = [];
  if (c.messageCount) meta.push(c.messageCount + ' message' + (c.messageCount === 1 ? '' : 's'));
  if (c.lastActivityMs) meta.push(relTime(c.lastActivityMs));
  return (
    '<h2>Conversation</h2>' +
    '<div class="card">' +
      (topic ? '<div class="conv-topic">' + renderMarkdownPreview(truncate(topic, 420)) + '</div>' : '') +
      (meta.length ? '<div class="conv-meta">' + esc(meta.join(' · ')) + '</div>' : '') +
    '</div>'
  );
}

function renderActivityCard(s) {
  const items = s.recentActivity || [];
  if (!items.length) return '';
  const rows = items.map((it) => (
    '<div class="activity">' +
      '<span class="activity-kind">' + esc(it.kind) + '</span>' +
      '<span class="activity-summary">' + esc(truncate(it.summary, 80)) + '</span>' +
    '</div>'
  )).join('');
  return (
    '<h2>Recent activity</h2>' +
    '<div class="card">' + rows + '</div>'
  );
}

function renderPromptsCard(s) {
  const prompts = s.quickPrompts || [];
  if (!prompts.length) return '';
  const rows = prompts.map((p) => (
    '<button class="prompt-btn" data-prompt-id="' + esc(p.id) + '" title="' + esc(p.preview) + '">' +
      (p.favorite ? '<span class="prompt-star">★</span>' : '') +
      '<span class="prompt-title">' + esc(p.title) + '</span>' +
      '<span class="prompt-preview">' + esc(p.preview) + '</span>' +
    '</button>'
  )).join('');
  return (
    '<h2>Quick prompts</h2>' +
    '<div class="card"><div class="prompt-grid">' + rows + '</div></div>'
  );
}

function renderInlineMarkdown(s) {
  let out = esc(s);
  out = out.replace(/\\[([^\\]]+)\\]\\([^\\)]+\\)/g, '$1');
  out = out.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  return out;
}

function renderMarkdownPreview(s) {
  const lines = String(s || '').split(/\\r?\\n/);
  const blocks = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push('<p>' + renderInlineMarkdown(paragraph.join(' ')) + '</p>');
    paragraph = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushParagraph();
      continue;
    }
    const heading = line.match(/^#{1,6}\\s+(.+)$/);
    if (heading) {
      flushParagraph();
      blocks.push('<div class="md-heading">' + renderInlineMarkdown(heading[1]) + '</div>');
      continue;
    }
    const bullet = line.match(/^[-*]\\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      blocks.push('<div class="md-bullet">- ' + renderInlineMarkdown(bullet[1]) + '</div>');
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks.join('');
}

function renderRecentFilesCard(s) {
  const files = s.recentFiles || [];
  if (!files.length) return '';
  // Show basename in the row and the full path in the title attr — the panel
  // is narrow and absolute paths line-wrap into unreadable ribbon.
  const rows = files.map((f) => {
    const rel = s.cwd && f.path.startsWith(s.cwd) ? f.path.slice(s.cwd.length).replace(/^[/\\]/, '') : f.path;
    const ts = f.mtimeMs ? '<span class="recent-file-time">' + esc(relTime(f.mtimeMs)) + '</span>' : '';
    return (
      '<div class="recent-file">' +
        '<a class="path-link" data-path="' + esc(f.path) + '" title="' + esc(f.path) + '">' +
          esc(rel) +
        '</a>' + ts +
      '</div>'
    );
  }).join('');
  return (
    '<h2>Recently edited (' + files.length + ')</h2>' +
    '<div class="card">' + rows + '</div>'
  );
}

function renderWorktreesCard(s) {
  const wts = s.worktrees || [];
  // Suppress the card when there's only the main checkout — no useful list
  // to show. Once any extra worktree exists it's worth surfacing all of them.
  if (wts.length < 2) return '';
  const rows = wts.map((w) => {
    const marker = w.isActive
      ? '<span class="wt-dot active" title="active terminal"></span>'
      : '<span class="wt-dot"></span>';
    const nameClass = w.isActive ? 'wt-name active' : 'wt-name';
    const tag = w.isMain ? '<span class="wt-tag main">main</span>' : '';
    const branch = w.branch ? '<span class="wt-branch">' + esc(w.branch) + '</span>' : '';
    // wt-link (not path-link) so the click dispatches openWorktree, which
    // opens the directory as a folder in a new window. vscode.open on a
    // directory shows an error toast.
    return (
      '<div class="worktree">' +
        marker +
        '<a class="' + nameClass + ' wt-link" data-worktree-path="' + esc(w.path) + '" title="' + esc(w.path) + '">' +
          esc(w.name) +
        '</a>' +
        tag + branch +
      '</div>'
    );
  }).join('');
  return (
    '<h2>Worktrees (' + wts.length + ')</h2>' +
    '<div class="card">' + rows + '</div>'
  );
}

function renderCwdCard(s) {
  if (!s.cwd) return '';
  const rows = [];
  rows.push(
    '<dt>cwd</dt><dd><a class="path-link" data-path="' + esc(s.cwd) + '">' + esc(s.cwd) + '</a></dd>'
  );
  if (s.worktreePath && s.workspaceRoot && s.worktreePath !== s.workspaceRoot) {
    rows.push(
      '<dt>worktree</dt><dd><a class="path-link" data-path="' + esc(s.worktreePath) + '">' + esc(s.worktreePath) + '</a></dd>'
    );
  }
  return (
    '<h2>Working dir</h2>' +
    '<div class="card"><dl class="row-grid">' + rows.join('') + '</dl></div>'
  );
}

function renderPlanCard(s) {
  if (!s.plan) {
    if (!s.cwd) return '';
    return (
      '<h2>Plan</h2>' +
      '<div class="card"><div class="plan-meta">No PLAN.md in this directory.</div></div>'
    );
  }
  return (
    '<h2>Plan</h2>' +
    '<div class="card">' +
      '<div class="plan-line">' +
        '<a class="path-link" data-path="' + esc(s.plan.path) + '">PLAN.md</a>' +
        '<span class="plan-meta">' + esc(relTime(s.plan.mtimeMs)) + '</span>' +
      '</div>' +
    '</div>'
  );
}

function statusClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'running' || s === 'in_progress') return 'running';
  if (s === 'completed' || s === 'done')      return 'completed';
  if (s === 'pending' || s === 'queued')      return 'pending';
  if (s === 'failed' || s === 'error')        return 'failed';
  if (s === 'stopped' || s === 'cancelled')   return 'stopped';
  return 'pending';
}

function renderTeammate(m) {
  return (
    '<div class="mate">' +
      '<span class="mate-dot ' + statusClass(m.status) + '"></span>' +
      '<span class="mate-name">' + esc(m.name) + '</span>' +
      '<span class="mate-agent">' + esc(m.agent_type) + '</span>' +
      '<span class="mate-status">' + esc(m.status) + '</span>' +
    '</div>'
  );
}

function renderTeam(t) {
  const counts = [];
  if (t.running)   counts.push(t.running + ' run');
  if (t.pending)   counts.push(t.pending + ' pend');
  if (t.completed) counts.push(t.completed + ' done');
  if (t.failed)    counts.push(t.failed + ' fail');
  const headRight = counts.length ? counts.join(' · ') : (t.agent_count + ' agent' + (t.agent_count === 1 ? '' : 's'));
  const mates = (t.teammates || []).map(renderTeammate).join('');
  return (
    '<div class="team">' +
      '<div class="team-head">' +
        '<span class="team-name">' + esc(t.task_name) + '</span>' +
        '<span class="team-counts">' + esc(headRight) + '</span>' +
      '</div>' +
      mates +
    '</div>'
  );
}

function renderTeamsCard(s) {
  const teams = s.teams || [];
  if (!teams.length) {
    if (s.teamsError) {
      return (
        '<h2>Teams in this directory</h2>' +
        '<div class="card"><div class="plan-meta">' + esc(s.teamsError) + '</div></div>'
      );
    }
    return '';
  }
  return (
    '<h2>Teams in this directory</h2>' +
    teams.map(renderTeam).join('')
  );
}

let lastSnapshot = null;

function render(snap) {
  lastSnapshot = snap;
  if (!snap || !snap.hasTerminal) {
    root.innerHTML = (
      '<div class="empty">No agent terminal focused.<br><br>' +
      'Click an agent tab in the editor, or open one with <b>Cmd+Shift+A</b>.</div>'
    );
    return;
  }
  root.innerHTML = (
    renderTerminalCard(snap) +
    renderActionsCard(snap) +
    renderLinksCard(snap) +
    renderConversationCard(snap) +
    renderActivityCard(snap) +
    renderRecentFilesCard(snap) +
    renderWorktreesCard(snap) +
    renderPromptsCard(snap) +
    renderCwdCard(snap) +
    renderPlanCard(snap) +
    renderTeamsCard(snap) +
    '<div class="footer"><button id="refresh-btn">Refresh</button></div>'
  );
  for (const el of root.querySelectorAll('.path-link')) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'openPath', path: el.getAttribute('data-path') });
    });
  }
  // Worktree paths are DIRECTORIES — they need vscode.openFolder, not the
  // file-only vscode.open that openPath uses. Distinct selector + message
  // type so the extension can branch on intent without sniffing the path.
  for (const el of root.querySelectorAll('.wt-link')) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'openWorktree', path: el.getAttribute('data-worktree-path') });
    });
  }
  for (const el of root.querySelectorAll('[data-url]:not([data-action])')) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'openUrl', url: el.getAttribute('data-url') });
    });
  }
  for (const el of root.querySelectorAll('[data-scm]')) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'openSourceControl' });
    });
  }
  for (const el of root.querySelectorAll('[data-action]')) {
    el.addEventListener('click', () => {
      vscode.postMessage({
        type: 'runQuickAction',
        action: el.getAttribute('data-action'),
        terminalId: lastSnapshot && lastSnapshot.terminalId,
        workspaceRoot: lastSnapshot && lastSnapshot.workspaceRoot,
        url: el.getAttribute('data-url') || undefined,
      });
    });
  }
  for (const el of root.querySelectorAll('[data-prompt-id]')) {
    el.addEventListener('click', () => {
      vscode.postMessage({
        type: 'sendQuickPrompt',
        promptId: el.getAttribute('data-prompt-id'),
        terminalId: lastSnapshot && lastSnapshot.terminalId,
      });
    });
  }
  const btn = root.querySelector('#refresh-btn');
  if (btn) btn.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg && msg.type === 'snapshot') render(msg.data);
});

// The panel keeps retainContextWhenHidden so quick tab switches preserve scroll
// + DOM state, and the heavy snapshot polling is already gated on visibility
// (startPolling/stopPolling). The one thing retain leaves running is the
// .pulse-dot's "animation: pulse ... infinite" — off-screen it still forces
// layout/paint every frame and burns CPU. Remove the element from the DOM while
// hidden (CSS-hiding alone doesn't stop the animation); the next snapshot on
// reveal (onDidChangeVisibility -> refresh) re-renders it if still streaming.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    for (const el of root.querySelectorAll('.pulse-dot')) el.remove();
  }
});

// Drag a file from the explorer/editor onto the panel -> paste its absolute
// path into the focused agent terminal instead of letting VS Code's editor
// host catch the drop and open the file.
document.body.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
document.body.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!e.dataTransfer) return;
  const uriList = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (!uriList) return;
  // RFC 2483: newline-delimited; '#' lines are comments. Take the first uri.
  const firstUri = uriList.split(/\\r?\\n/).find((line) => line && !line.startsWith('#'));
  if (!firstUri) return;
  let p = firstUri.trim();
  if (p.startsWith('file://')) {
    try { p = decodeURIComponent(p.slice('file://'.length)); } catch { /* leave as-is */ }
  }
  vscode.postMessage({
    type: 'insertPathInTerminal',
    path: p,
    terminalId: lastSnapshot && lastSnapshot.terminalId,
  });
});

// Signal readiness AFTER the listener is attached so the extension host
// doesn't race us with the first snapshot.
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

function readPlanFile(cwd: string): PlanFileInfo | undefined {
  try {
    const p = path.join(cwd, 'PLAN.md');
    const st = fs.statSync(p);
    if (!st.isFile()) return undefined;
    return { path: p, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
}

async function readGitInfo(cwd: string): Promise<GitInfo | undefined> {
  try {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) return undefined;
    const api = (await ext.activate()).getAPI(1);
    const target = path.resolve(cwd);
    const repo = api.repositories.find((r: any) => {
      const root = String(r.rootUri?.fsPath || '');
      return root && (target === root || target.startsWith(root + path.sep));
    });
    if (!repo) return undefined;
    const branch = repo.state?.HEAD?.name as string | undefined;
    const dirtyCount =
      (repo.state?.workingTreeChanges?.length ?? 0) +
      (repo.state?.indexChanges?.length ?? 0) +
      (repo.state?.mergeChanges?.length ?? 0);
    return { branch, dirtyCount };
  } catch {
    return undefined;
  }
}

function collectRecentActivity(tailLines: string[], agentType: string, max: number): ActivityItem[] {
  const out: ActivityItem[] = [];
  // Walk backward so we end up with the most recent items first.
  const seen = new Set<string>();
  for (let i = tailLines.length - 1; i >= 0 && out.length < max; i--) {
    const activity = parseLineForActivity(tailLines[i], agentType as 'claude' | 'codex' | 'gemini');
    if (!activity) continue;
    const formatted = formatActivity(activity);
    const dedupeKey = `${activity.type}|${activity.summary}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      kind: activity.type,
      summary: activity.summary || formatted,
      ts: activity.timestamp.getTime(),
    });
  }
  return out;
}

/**
 * Wrapper around the shared {@link extractPrUrlsHelper} kept here so existing
 * call sites in `buildSnapshot` stay readable. Tests live next to the helper.
 */
function extractPrUrls(lines: string[]): PullRequestRef[] {
  return extractPrUrlsHelper(lines);
}

/**
 * Enumerate every worktree attached to `workspaceRoot` via
 * `git worktree list --porcelain`. Delegates to the canonical `fetchWorktrees`
 * (snapshotDetector) the leader runs, so the local fallback and the broadcast
 * path share one implementation. Returns [] when the directory isn't a git repo
 * or git isn't available.
 */
async function listWorktrees(workspaceRoot: string, activeCwd: string | undefined): Promise<WorktreeRef[]> {
  return fetchWorktrees(workspaceRoot, activeCwd);
}

type UsageStatus = 'available' | 'rate_limited' | 'out_of_credits' | null;

/**
 * Pick the throttle state for `version` from a parsed `agents view --json` view.
 * Prefers the exact version match, then the default row, then the first. Shared
 * by the local fetch and the broadcast-snapshot path so selection is identical.
 */
function selectUsageStatus(view: AgentsViewJsonAgent, version: string | undefined): UsageStatus {
  const rows = view.versions || [];
  const match = (version && rows.find((r) => r.version === version))
    || rows.find((r) => r.isDefault)
    || rows[0];
  return match?.usageStatus ?? null;
}

/**
 * Read the throttle state for `agentType@version` from `agents view --json`.
 * Returns null when the binary isn't on PATH, when the JSON doesn't include a
 * matching version row, or when the field is missing — never throws. The fetch
 * reuses the canonical `fetchUsage` (snapshotDetector) the leader runs.
 */
async function readUsageStatus(
  agentType: string,
  version: string | undefined,
): Promise<UsageStatus> {
  const view = await fetchUsage(agentType);
  return view ? selectUsageStatus(view, version) : null;
}

// --- Monitor follower routing (#71) ---------------------------------------
// Prefer the leader's broadcast panel-snapshot (computed once machine-wide);
// fall back to a local compute only while disconnected from the monitor.

async function getWorktreesRouted(
  workspaceRoot: string,
  activeCwd: string | undefined,
): Promise<WorktreeRef[]> {
  if (terminals.isSnapshotMonitorConnected()) {
    const broadcast = terminals.getLatestPanelSnapshot()?.worktreesByRoot[workspaceRoot];
    if (broadcast) return broadcast;
  }
  return listWorktrees(workspaceRoot, activeCwd);
}

async function getUsageStatusRouted(
  agentType: string,
  version: string | undefined,
): Promise<UsageStatus> {
  if (terminals.isSnapshotMonitorConnected()) {
    const view = terminals.getLatestPanelSnapshot()?.usageByAgent[agentType];
    if (view) return selectUsageStatus(view, version);
  }
  return readUsageStatus(agentType, version);
}

async function getTeamsRouted(cwd: string | undefined): Promise<TeamWithMates[]> {
  if (cwd && terminals.isSnapshotMonitorConnected()) {
    const broadcast = terminals.getLatestPanelSnapshot()?.teamsByCwd[cwd];
    if (broadcast) return broadcast as TeamWithMates[];
  }
  return listTeamsForCwd(cwd);
}

function pickQuickPrompts(): QuickPromptLite[] {
  try {
    const all = readPrompts();
    const sorted = [...all].sort((a, b) => {
      if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
      return (b.accessedAt || 0) - (a.accessedAt || 0);
    });
    return sorted.slice(0, 6).map((p) => ({
      id: p.id,
      title: p.title,
      preview: p.content.replace(/\s+/g, ' ').trim().slice(0, 120),
      favorite: !!p.isFavorite,
    }));
  } catch {
    return [];
  }
}

async function runInShellTerminal(command: string): Promise<void> {
  const existing = vscode.window.terminals.find((t) => t.name === 'agents: shell');
  const terminal = existing ?? vscode.window.createTerminal({
    name: 'agents: shell',
    env: buildAgentTerminalEnv(terminals.nextId('SH'), null),
  });
  terminal.show(true);
  terminal.sendText(command);
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function randomNonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

export function registerAgentPanel(context: vscode.ExtensionContext): AgentPanelProvider {
  const provider = new AgentPanelProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AGENT_PANEL_VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Re-render on terminal lifecycle events. refresh() -> buildSnapshot() spawns
  // 2-8 subprocesses (git/teams probes), so a burst of events — e.g. clicking
  // through editor tabs fires onDidChangeActiveTerminal per tab, and closing a
  // terminal fires close + active-change together — would stampede the box.
  // Trailing-edge debounce (matching the inline clearTimeout/setTimeout idiom
  // in settings.vscode.ts) coalesces a burst into one snapshot per window.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const debouncedRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void provider.refresh();
    }, 300);
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal(debouncedRefresh),
    vscode.window.onDidCloseTerminal(debouncedRefresh),
    vscode.window.onDidOpenTerminal(debouncedRefresh),
    { dispose: () => { if (refreshTimer) clearTimeout(refreshTimer); } }
  );

  return provider;
}
