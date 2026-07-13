// VS Code-dependent settings functions
// Pure types are in settings.ts

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { homedir, hostname } from 'os';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { AgentSettings, getDefaultSettings, CustomAgentConfig, SwarmAgentType, ALL_SWARM_AGENTS, PromptEntry, DEFAULT_DISPLAY_PREFERENCES, DEFAULT_NOTIFICATION_SETTINGS, DEFAULT_TASK_SOURCE_SETTINGS, DEFAULT_QUICK_LAUNCH, QuickLaunchSlot, migrateStaleClaudeQuickLaunch, migrateLegacyQuickLaunchSlots } from '../core/settings';
import { readPromptsFromPath, writePromptsToPath, DEFAULT_PROMPTS } from '../core/prompts';
import * as terminals from './terminals.vscode';
import * as swarm from './swarm.vscode';
import { fetchAllTasks, detectAvailableSources } from './tasks.vscode';
import { getBuiltInByTitle, configFromDef } from './agents.vscode';
import { openSingleAgentWithQueue, runHeadlessAgent, focusSessionInTerminal } from './extension';
import { generateClaudeSessionId } from '../core/prewarm.simple';
import { nudgeSession } from '../mcp/watchdog-bridge';
import { runAgents } from '../core/agentsBin';
import { AgentLaunchMode, extractPlanFromSessionJson, planTextToSteps } from '../core/agents';
import { CLAUDE_TITLE } from '../core/utils';
import { discoverRecentSessions, getSessionPathBySessionId } from './sessions.vscode';
import { formatTerminalTitle, parseTerminalName, getSessionChunk } from '../core/utils';
import { getBuiltInByKey, getBuiltInDefByTitle } from '../core/agents';
import {
  mapInventoriesToInstalledAgents,
  buildDispatchHosts,
  rankTargets,
  buildManagedTargets,
} from '../core/dispatchRanking';
import {
  readManagedProjects,
  upsertManagedProject,
  deleteManagedProject,
  projectNameFromPath,
  type ManagedProject,
} from '../core/managedProjects';
import { repoSlugFromPath } from '../core/projectIndex';
import { matchLinearProject } from '../core/linearProjects';
import { fetchLinearProjects } from './linear.vscode';
import { resolveForemanTarget, candidateName } from '../core/foreman.target';
import { parseEvents, WATCHDOG_LOG_PATH } from '../core/watchdogLog';
import {
  WATCHDOG_PLAYBOOK_PATH,
  ensureWatchdogPlaybookScaffold,
  getWatchdogPlaybookStatus,
} from './watchdog.vscode';
import * as workspaceConfig from './swarmifyConfig.vscode';
import { createSymlinksCodebaseWide } from './agentlinks.vscode';
import { scanMemoryFiles } from './contextFiles';
import { fetchAllAgentModels, checkInstalledAgentsViaCli, resolveAlias } from '../core/agentModels';
import { fetchAgentInventories, writeAgentRunStrategy, AgentRunStrategy, AgentInventory, normalizeRunStrategy } from '../core/agentInventory';
import { getAgentResources, invalidateAgentResourcesCache } from '../core/agentResources';
import * as workbench from './workbench.vscode';
import * as theme from './theme.vscode';
import { buildAgentTerminalEnv } from '../core/terminals';
import * as foreman from './foreman.vscode';
import { startForemanAudio, ForemanAudioSession } from './foreman.audio';
import { runSmartTurn, capHistory } from './foreman.smart';
import { buildTaskDispatchPrompt } from '../core/tasks';
import { draftDispatchPrompt, type DraftTicket } from '../core/draftPrompt';
import { listRegisteredDevices, fetchDeviceStats, countRunningAgents, resolveSecret, getDeviceSyncStatus } from './deviceHealth.vscode';
import { inferProjectCandidates } from '../core/projectIndex';
import { normalizeHost } from '../core/remoteSessions';
import { rankRepos } from '../core/repoIndex';
import { detectProjects } from '../core/projectDetect';
import { getSyncStatus } from '../core/repoSync';
import {
  isWindowsDevicePlatform,
  encodePowershellScript,
  buildDeviceDispatchRemoteCmd,
} from '../core/deviceDispatchShell';

let foremanSession: ForemanAudioSession | undefined;
let foremanSessionGen = 0;
// Smart-mode (turn-based text brain) rolling history. Capped on assignment
// (via capHistory, on a safe turn boundary) so a long session doesn't grow the
// OpenAI context unbounded.
let foremanSmartHistory: any[] = [];
let foremanSmartAbort: AbortController | undefined;

// Get GitHub repo from git remote (returns "username/repo" or null)
function getGitHubRepo(workspacePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    exec('git remote get-url origin', { cwd: workspacePath }, (err, stdout) => {
      if (err || !stdout) {
        resolve(null);
        return;
      }
      const url = stdout.trim();
      // Parse GitHub URL formats:
      // https://github.com/user/repo.git
      // git@github.com:user/repo.git
      // https://github.com/user/repo
      const httpsMatch = url.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
      const sshMatch = url.match(/github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
      const repo = httpsMatch?.[1] || sshMatch?.[1] || null;
      resolve(repo);
    });
  });
}

// Just the owner part of the workspace's git remote (e.g. "muqsitnawaz")
async function getGitHubOwner(workspacePath: string): Promise<string | null> {
  const repo = await getGitHubRepo(workspacePath);
  if (!repo) return null;
  const [owner] = repo.split('/');
  return owner || null;
}

// Infer owner via `gh api user` if the workspace has no remote
function inferOwnerFromGhCli(): Promise<string | null> {
  return new Promise((resolve) => {
    exec('gh api user -q .login', (err, stdout) => {
      if (err || !stdout) {
        resolve(null);
        return;
      }
      const login = stdout.trim();
      resolve(login || null);
    });
  });
}

// Fallback chain for determining the GitHub owner used to compose
// `owner/repo` from a `repo:<name>` Linear label.
// 1. Panel setting (AgentSettings.githubOwner)
// 2. Workspace git remote owner
// 3. `gh api user` login
// 4. null -> caller prompts the user
export async function resolveGithubOwner(
  workspacePath: string | undefined,
  settings: AgentSettings
): Promise<string | null> {
  const fromSettings = settings.githubOwner?.trim();
  if (fromSettings) return fromSettings;
  if (workspacePath) {
    const fromWorkspace = await getGitHubOwner(workspacePath);
    if (fromWorkspace) return fromWorkspace;
  }
  const fromGh = await inferOwnerFromGhCli();
  if (fromGh) return fromGh;
  return null;
}

// True when the task identifier looks like a Linear ticket (e.g. RUSH-461).
// Linear-sourced cloud dispatches never silently fall back to the workspace
// repo — the workspace is often a different codebase than the ticket targets
// (e.g. dispatching RUSH-461 from the swarmify workspace must NOT default to
// muqsitnawaz/swarmify). Mirrored in ui/settings/components/mission-control/
// dispatch.ts for the webview — keep in sync.
function isLinearSourcedTask(identifier: string | null | undefined): boolean {
  if (typeof identifier !== 'string') return false;
  return /^[A-Z][A-Z0-9]*-\d+$/.test(identifier.trim());
}

// Parse repo:<name> labels from a task, combine with the resolved owner.
// Returns all resolved repos (a task can target multiple repos).
function resolveReposFromLabels(labels: string[] | undefined, owner: string | null): string[] {
  if (!labels || labels.length === 0) return [];
  if (!owner || !owner.trim()) return [];
  const cleanOwner = owner.trim();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of labels) {
    if (typeof raw !== 'string') continue;
    const match = raw.trim().match(/^repo:([A-Za-z0-9._-]+)$/);
    if (!match) continue;
    const name = match[1];
    const full = `${cleanOwner}/${name}`;
    if (seen.has(full)) continue;
    seen.add(full);
    out.push(full);
  }
  return out;
}

// Single shared terminal for all cloud dispatches. Opens as an editor tab with
// the Rush bird icon so it's recognizable; reused across dispatches so firing
// 10 cloud tasks at once doesn't produce 10 terminals.
const RUSH_CLOUD_TERMINAL_NAME = 'Rush Cloud';
const RUSH_CLOUD_PREFIX = 'rc';
let rushCloudTerminal: vscode.Terminal | undefined;

async function getOrCreateRushCloudTerminal(
  context: vscode.ExtensionContext,
  cwd: string
): Promise<vscode.Terminal> {
  if (rushCloudTerminal && rushCloudTerminal.exitStatus === undefined) {
    return rushCloudTerminal;
  }
  const existing = vscode.window.terminals.find(
    (t) => t.name === RUSH_CLOUD_TERMINAL_NAME && t.exitStatus === undefined
  );
  if (existing) {
    rushCloudTerminal = existing;
    return existing;
  }
  const iconPath = theme.buildIconPath(context.extensionPath, 'rush.png');
  const terminalId = terminals.nextId(RUSH_CLOUD_PREFIX);
  const terminal = vscode.window.createTerminal({
    name: RUSH_CLOUD_TERMINAL_NAME,
    cwd,
    iconPath,
    env: buildAgentTerminalEnv(terminalId, null, cwd),
    location: {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: true,
    },
    isTransient: true,
  });
  const pid = await terminal.processId;
  terminals.register(
    terminal,
    terminalId,
    {
      title: RUSH_CLOUD_TERMINAL_NAME,
      command: '',
      iconPath,
      prefix: RUSH_CLOUD_PREFIX,
    },
    pid,
    context,
  );
  rushCloudTerminal = terminal;
  return terminal;
}

// ---------------------------------------------------------------------------
// Unified Dispatch (the consolidated panel). The two build roots are isolated
// (src/ cannot import ui/), so the webview contract in
// ui/settings/components/mission-control/dispatch.types.ts is mirrored here by
// hand. These shapes MUST stay in sync with that file.
// ---------------------------------------------------------------------------
type DispatchModeMsg = AgentLaunchMode; // 'plan' | 'auto' | 'edit'
type WatchdogPolicyMsg = 'off' | 'keep' | 'handsoff';

interface NotifyPrefsMsg {
  events: { stall: boolean; question: boolean; plan: boolean; finish: boolean; fail: boolean };
  channel: 'imessage' | 'slack' | 'desktop';
  dnd: boolean;
}

interface DispatchAttachmentMsg { type: 'image' | 'file'; name: string; ref?: string }

interface DispatchRequestMsg {
  prompt: string;
  ticketIds: string[];
  attachments: DispatchAttachmentMsg[];
  agent: string;
  runOn: string;
  project?: string;
  projectPath?: string;
  repo?: string;
  branch?: string;
  mode: DispatchModeMsg;
  headless?: boolean;
  watchdog: WatchdogPolicyMsg;
  notify: NotifyPrefsMsg;
  batch: 'all' | 'per';
}

interface PendingPlanMsg {
  sessionId: string;
  agentId: string;
  steps: { n: number; text: string }[];
}

type DispatchHostResolution =
  | { kind: 'cloud'; provider: 'rush' | 'codex' | 'factory' }
  | { kind: 'local' }
  | { kind: 'remote'; host: string };

// Map a DispatchHost.id to where it actually runs. Cloud ids (matching the
// prototype HOSTS) carry an explicit provider; the local machine is 'this-mac'
// or the real hostname; everything else is a remote SSH machine — which has no
// agent-spawn path in this lane yet (backend-data owns remoteSessions), so it
// surfaces as 'remote' for an honest inline error rather than a silent
// local fallback.
function classifyDispatchHost(runOn: string): DispatchHostResolution {
  if (runOn === 'rush') return { kind: 'cloud', provider: 'rush' };
  if (runOn === 'codex' || runOn === 'codex-cloud') return { kind: 'cloud', provider: 'codex' };
  if (runOn === 'factory') return { kind: 'cloud', provider: 'factory' };
  const host = hostname();
  if (runOn === '' || runOn === 'this-mac' || runOn === host || runOn === host.split('.')[0]) {
    return { kind: 'local' };
  }
  return { kind: 'remote', host: runOn };
}

// Cloud CLI (`agents cloud run --mode`) accepts plan|edit|full. The panel's
// Auto ("asks before risky") has no cloud analog — cloud runs are
// non-interactive — so it maps to full autonomy.
function cloudModeForDispatch(mode: DispatchModeMsg): 'plan' | 'edit' | 'full' {
  return mode === 'plan' ? 'plan' : mode === 'edit' ? 'edit' : 'full';
}

// The typed prompt is the source of truth; attached ticket ids and attachment
// refs ride along as context lines the agent can act on.
function composeDispatchPrompt(
  userPrompt: string,
  ticketIds: string[],
  attachments: DispatchAttachmentMsg[],
): string {
  const parts: string[] = [];
  const p = userPrompt.trim();
  if (p) parts.push(p);
  if (ticketIds.length) parts.push(`Attached tickets: ${ticketIds.join(', ')}`);
  if (attachments.length) {
    parts.push(`Attachments: ${attachments.map(a => a.ref ? `${a.name} (${a.ref})` : a.name).join(', ')}`);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Registered-device dispatch (SSH to a real machine). A device is 'local' when
// its host points at this machine; otherwise the agent is spawned over SSH.
// ---------------------------------------------------------------------------
function isLocalDeviceHost(host: string): boolean {
  const h = hostname();
  return host === 'this-mac' || host === 'localhost' || host === '' || host === h || host === h.split('.')[0];
}

// Single-quote a value for safe embedding in a remote /bin/sh command.
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Build the auto-sync shell snippet run in the project dir before the agent
// starts. Safe = fetch + fast-forward only (fails loudly on divergence rather
// than forcing). Aggressive = also rebase, but never force: on a rebase
// conflict it aborts and exits non-zero so the caller can surface it. Off = ''.
function buildDeviceSyncShell(policy: 'off' | 'safe' | 'aggressive'): string {
  if (policy === 'off') return '';
  const fetch = 'git fetch origin';
  if (policy === 'safe') {
    return `${fetch} && git merge --ff-only @{u}`;
  }
  return `${fetch} && (git merge --ff-only @{u} || git rebase @{u} || (git rebase --abort; echo "SYNC_CONFLICT: rebase left conflicts — resolve manually" 1>&2; exit 3))`;
}

const deviceExecFileAsync = promisify(execFile);

// Spawn a coding agent on a registered device over SSH, honoring the resolved
// credentials (identity file / user) and the auto-sync policy. Fire-and-forget:
// the remote agent is backgrounded (nohup) so the ssh call returns promptly.
// Returns an error string to surface inline, or null on success.
async function dispatchToDevice(input: {
  agentType: string;
  host: string;
  secretRef?: string;
  projectPath: string;
  repoSlug?: string;
  syncPolicy: 'off' | 'safe' | 'aggressive';
  mode: DispatchModeMsg;
  prompt: string;
  /** Device registry platform (windows/macos/linux) — selects remote shell. */
  platform?: string;
}): Promise<string | null> {
  const { agentType, host, secretRef, projectPath, repoSlug, syncPolicy, mode, prompt, platform } = input;
  if (!projectPath) return 'Device dispatch: no project path resolved — pick a repo/project first.';

  const creds = secretRef ? await resolveSecret(secretRef) : {};
  const windows = isWindowsDevicePlatform(platform);

  // Windows remotes: PowerShell script (no bash). POSIX: bash snippet (unchanged).
  let remote: string;
  if (windows) {
    const pAssign = projectPath === '~' || projectPath === ''
      ? '$P = $env:USERPROFILE'
      : projectPath.startsWith('~/')
        ? `$P = Join-Path $env:USERPROFILE ${shq(projectPath.slice(2))}`
        : `$P = ${shq(projectPath)}`;
    const logDir = 'Join-Path $env:USERPROFILE ".agents\\.tmp"';
    const runArgs = ['run', agentType, '--mode', mode, prompt]
      .map((a) => a.replace(/'/g, "''"))
      .map((a) => `'${a}'`)
      .join(' ');
    const cloneUrl = repoSlug ? `git@github.com:${repoSlug}.git` : '';
    const ensureClone = cloneUrl
      ? `if (-not (Test-Path (Join-Path $P '.git'))) { New-Item -ItemType Directory -Force -Path (Split-Path $P) | Out-Null; git clone '${cloneUrl.replace(/'/g, "''")}' $P }; `
      : '';
    // Background Start-Process so the ssh hop returns promptly (parity with nohup).
    remote =
      `$tmp = ${logDir}; New-Item -ItemType Directory -Force -Path $tmp | Out-Null; ` +
      `${pAssign}; ${ensureClone}Set-Location -LiteralPath $P; ` +
      `$log = Join-Path $tmp ("dispatch-" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + ".log"); ` +
      `Start-Process -FilePath agents -ArgumentList @(${runArgs}) -WorkingDirectory $P -RedirectStandardOutput $log -RedirectStandardError $log -WindowStyle Hidden`;
  } else {
    const syncShell = buildDeviceSyncShell(syncPolicy);
    const runCmd = `agents run ${shq(agentType)} --mode ${mode} ${shq(prompt)}`;
    const pAssign =
      projectPath === '~' ? 'P="$HOME"'
        : projectPath.startsWith('~/') ? `P="$HOME/"${shq(projectPath.slice(2))}`
          : `P=${shq(projectPath)}`;
    const cloneUrl = repoSlug ? `git@github.com:${repoSlug}.git` : '';
    const ensureClone = cloneUrl
      ? `if [ ! -d "$P/.git" ]; then mkdir -p "$(dirname "$P")" && git clone ${shq(cloneUrl)} "$P"; fi && `
      : '';
    remote =
      `mkdir -p "$HOME/.agents/.tmp"; ${pAssign}; ${ensureClone}cd "$P" && ` +
      (syncShell ? `${syncShell} && ` : '') +
      `nohup ${runCmd} > "$HOME/.agents/.tmp/dispatch-$(date +%s).log" 2>&1 &`;
  }

  if (isLocalDeviceHost(host)) {
    // Local device: run through the host's native shell, no SSH hop.
    try {
      if (windows) {
        await deviceExecFileAsync('powershell', ['-NoProfile', '-EncodedCommand', encodePowershellScript(remote)], { timeout: 60_000 });
      } else {
        await deviceExecFileAsync('/bin/sh', ['-lc', remote], { timeout: 60_000 });
      }
      return null;
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      return `Device dispatch failed on ${host}: ${(e.stderr || e.message || 'unknown error').trim()}`;
    }
  }

  const target = creds.user ? `${creds.user}@${host}` : host;
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new'];
  if (creds.identityFile) args.push('-i', creds.identityFile);
  // `--` stops ssh option parsing; shell dialect follows device platform (RUSH-1481).
  args.push('--', target, buildDeviceDispatchRemoteCmd(remote, platform));
  try {
    await deviceExecFileAsync('ssh', args, { timeout: 60_000 });
    return null;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return `Device dispatch failed on ${host}: ${(e.stderr || e.message || 'unknown error').trim()}`;
  }
}

// Per-session policy captured at dispatch time. The Floor / notification layer
// and the watchdog consult this to honor the user's watchdog + notify choices
// after the agent is running. Exported so cross-lane consumers (the existing
// watchdog stall detector, the integrator) can read a session's policy.
interface DispatchSessionPolicy {
  watchdog: WatchdogPolicyMsg;
  notify: NotifyPrefsMsg;
  agentId: string;    // terminal id of the running agent
  prompt: string;     // original composed prompt (reused by reassignAgent)
  cwd?: string;       // resolved local cwd, if any
  mode: DispatchModeMsg;
}
const dispatchSessionPolicies = new Map<string, DispatchSessionPolicy>();
export function getDispatchSessionPolicy(sessionId: string): DispatchSessionPolicy | undefined {
  return dispatchSessionPolicies.get(sessionId);
}

// Watch a plan-mode Claude session for an ExitPlanMode tool call and post
// `planReady` to the webview once, so the Floor can show the plan for approval.
// Polls `agents sessions <id> --json --local` (the CLI's canonical session
// state engine, which captures the plan markdown at scan time) until the plan
// appears or the budget elapses. Previous versions read the raw JSONL and
// re-implemented the ExitPlanMode scanner; the CLI now carries `session.plan`,
// so the extension consumes it directly.
function watchForPlan(
  sessionId: string,
  agentId: string,
  _cwd: string,
  notify: NotifyPrefsMsg,
): void {
  const POLL_MS = 2000;
  const MAX_ATTEMPTS = 600; // ~20 min
  let attempts = 0;
  let done = false;
  const tick = async () => {
    if (done) return;
    attempts++;
    try {
      const { stdout } = await runAgents(`sessions ${sessionId} --json --local`, { timeout: 10_000 });
      const planText = extractPlanFromSessionJson(stdout);
      if (planText) {
        done = true;
        const plan: PendingPlanMsg = { sessionId, agentId, steps: planTextToSteps(planText) };
        settingsPanel?.webview.postMessage({ type: 'planReady', plan });
        if (notify.events.plan && !notify.dnd) {
          console.log(`[DISPATCH] plan ready for ${sessionId} — notify via ${notify.channel}`);
        }
        return;
      }
    } catch (err) {
      console.warn('[DISPATCH] plan watch poll failed:', err);
    }
    if (attempts < MAX_ATTEMPTS) setTimeout(tick, POLL_MS);
  };
  setTimeout(tick, POLL_MS);
}

// The Foreman tool-dependency bundle, shared by BOTH voice engines: the
// realtime session's onToolCall and the smart-mode text brain both dispatch
// through runForemanTool with these deps, so tool behavior is identical
// regardless of mode.
function buildForemanToolDeps(context: vscode.ExtensionContext): foreman.ForemanToolDeps {
  return {
    fetchCycleTasks: async () => {
      const s = getSettings(context);
      return fetchAllTasks(context, s.taskSources);
    },
    fetchTaskDetails: (id) => findTaskDetailsForForeman(context, id),
    dispatchTask: (opts) => dispatchForForeman(context, opts),
    spawnAgent: (opts) => spawnAgentForForeman(context, opts),
    messageAgent: (opts) => messageAgentForForeman(opts),
    createTicket: (opts) => createTicketForForeman(opts),
  };
}

// Headless lookup used by Foreman's task_details tool. Finds a task by
// identifier (case-insensitive) across the configured sources.
async function findTaskDetailsForForeman(
  context: vscode.ExtensionContext,
  id: string
): Promise<foreman.ForemanTaskDetails | null> {
  const settings = getSettings(context);
  const { tasks } = await fetchAllTasks(context, settings.taskSources);
  const needle = id.trim().toLowerCase();
  const task = tasks.find((t) => {
    const ident = (t.metadata.identifier ?? '').toLowerCase();
    if (ident && ident === needle) return true;
    if (t.id.toLowerCase() === needle) return true;
    return false;
  });
  if (!task) return null;

  const owner = await resolveGithubOwner(
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    settings,
  );
  const repos = resolveReposFromLabels(task.metadata.labels, owner);
  return {
    id: task.metadata.identifier ?? task.id,
    title: task.title,
    description: task.description ?? null,
    priority: task.priority ?? null,
    status: task.status ?? null,
    assignee: task.metadata.assignee ?? null,
    labels: task.metadata.labels ?? [],
    source: task.source,
    resolved_repo: repos.length > 0 ? repos.join(', ') : null,
  };
}

// Headless dispatch used by Foreman's dispatch tool. Mirrors the core
// behavior of `case 'dispatchTask'` but without the multi-step webview
// picker protocol: resolves target repos from the ticket's repo:<name>
// label (optionally overridden by `opts.repo`), and fails fast with a
// speakable message when the repo is ambiguous. No UI prompts.
// Map "owner/repo" to a local clone so local dispatches start the agent in
// the task's repo instead of whatever workspace happens to be open. Checks
// open workspace folders first (matched by git remote), then two layouts
// derived from the current workspace's location: a flat sibling
// (<parent>/<repo>) and an owner-nested sibling (<grandparent>/<owner>/<repo>,
// i.e. the ~/src/github.com/<owner>/<repo> convention). The owner half of the
// slug is a guess from resolveGithubOwner (Linear labels only carry the repo
// name), so a candidate also wins when its origin's repo NAME matches even if
// the owner differs (e.g. label says muqsitnawaz/agents-cli but the clone's
// remote is phnx-labs/agents-cli).
async function resolveLocalRepoPath(repo: string): Promise<string | null> {
  const repoName = repo.split('/')[1];
  if (!repoName) return null;
  const remoteMatches = (remote: string | null) =>
    remote !== null && (remote === repo || remote.split('/')[1] === repoName);
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    if (remoteMatches(await getGitHubRepo(folder.uri.fsPath))) return folder.uri.fsPath;
  }
  const base = folders[0]?.uri.fsPath;
  if (!base) return null;
  const candidates = [
    path.join(path.dirname(base), repoName),
    path.join(path.dirname(path.dirname(base)), repo),
  ];
  for (const dir of candidates) {
    if (dir === base || !fs.existsSync(dir)) continue;
    if (remoteMatches(await getGitHubRepo(dir))) return dir;
  }
  return null;
}

async function dispatchForForeman(
  context: vscode.ExtensionContext,
  opts: foreman.ForemanDispatchOpts,
): Promise<foreman.ForemanDispatchResult> {
  const settings = getSettings(context);
  const { tasks } = await fetchAllTasks(context, settings.taskSources);
  const needle = opts.id.trim().toLowerCase();
  const task = tasks.find((t) => {
    const ident = (t.metadata.identifier ?? '').toLowerCase();
    if (ident && ident === needle) return true;
    if (t.id.toLowerCase() === needle) return true;
    return false;
  });
  if (!task) return { ok: false, message: `No ticket matching "${opts.id}".` };

  const agent = opts.agent && opts.agent.trim() ? opts.agent.trim() : 'claude';
  const target = opts.target === 'local' ? 'local' : 'cloud';
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const identifier = task.metadata.identifier ?? '';
  const prompt = buildTaskDispatchPrompt({
    title: task.title,
    description: task.description,
    identifier,
    url: task.metadata.url,
  });

  if (target === 'local') {
    const def = getBuiltInByKey(agent);
    if (!def) return { ok: false, message: `Unknown agent type: ${agent}.` };
    const agentConfig = configFromDef(context.extensionPath, def);
    const localOwner = await resolveGithubOwner(workspacePath, settings);
    const repoSlugs = opts.repo && /^[^/]+\/[^/]+$/.test(opts.repo)
      ? [opts.repo]
      : resolveReposFromLabels(task.metadata.labels, localOwner);
    const cwd = repoSlugs.length === 1 ? await resolveLocalRepoPath(repoSlugs[0]) : null;
    await openSingleAgentWithQueue(context, agentConfig, [prompt], cwd ? { cwd } : undefined);
    return {
      ok: true,
      message: `Started ${agent} locally on ${identifier || task.title}${cwd ? ` in ${cwd}` : ''}.`,
      dispatched: { id: identifier || task.id, agent, target, repos: repoSlugs },
    };
  }

  const owner = await resolveGithubOwner(workspacePath, settings);
  let targetRepos: string[] = [];
  if (opts.repo) {
    if (/^[^/]+\/[^/]+$/.test(opts.repo)) {
      targetRepos = [opts.repo];
    } else if (owner) {
      targetRepos = [`${owner}/${opts.repo.replace(/^\//, '')}`];
    } else {
      return { ok: false, message: `No GitHub owner known; say the full repo as owner/name.` };
    }
  } else {
    targetRepos = resolveReposFromLabels(task.metadata.labels, owner);
    const isLinear = isLinearSourcedTask(identifier);
    if (targetRepos.length === 0 && !isLinear && workspacePath) {
      const workspaceRepo = await getGitHubRepo(workspacePath);
      if (workspaceRepo) targetRepos = [workspaceRepo];
    }
  }

  if (targetRepos.length === 0) {
    return {
      ok: false,
      message: `${identifier || 'Ticket'} has no repo label. Say which repo, e.g. "dispatch ${identifier || 'it'} to agents-cli".`,
    };
  }

  const safePrompt = prompt.replace(/'/g, `'\\''`);
  const term = await getOrCreateRushCloudTerminal(context, workspacePath || process.cwd());
  const repoFlags = targetRepos.map((r) => `--repo ${r}`).join(' ');
  term.sendText(`rush cloud run ${agent} ${repoFlags} -p '${safePrompt}'`);
  term.show(true);

  return {
    ok: true,
    message: `Dispatched ${identifier || task.title} to ${agent} on ${targetRepos.join(', ')}.`,
    dispatched: { id: identifier || task.id, agent, target, repos: targetRepos },
  };
}

// Headless free-form agent spawn used by Foreman's spawn_agent tool and the
// webview quickSpawn message. Unlike dispatchForForeman, this takes a raw
// prompt string instead of a ticket ID so the user can say "start a new Claude
// to fix X" without needing a Linear ticket.
async function spawnAgentForForeman(
  context: vscode.ExtensionContext,
  opts: { prompt: string; agent?: string; target?: string; repos?: string[] },
): Promise<{ ok: boolean; message: string }> {
  const agentKey = opts.agent?.trim() || 'claude';
  const target = opts.target === 'cloud' ? 'cloud' : 'local';

  if (target === 'local') {
    const def = getBuiltInByKey(agentKey);
    if (!def) return { ok: false, message: `Unknown agent: ${agentKey}.` };
    const agentConfig = configFromDef(context.extensionPath, def);
    // Attached tasks pin the working directory when they all share one repo
    // and a local clone is found; otherwise the workspace folder applies.
    const slugs = [...new Set((opts.repos ?? []).filter((r) => /^[^/]+\/[^/]+$/.test(r)))];
    const cwd = slugs.length === 1 ? await resolveLocalRepoPath(slugs[0]) : null;
    await openSingleAgentWithQueue(context, agentConfig, [opts.prompt], cwd ? { cwd } : undefined);
    return { ok: true, message: cwd ? `Started ${agentKey} locally in ${cwd}.` : `Started ${agentKey} locally.` };
  }

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const settings = getSettings(context);
  const owner = await resolveGithubOwner(workspacePath, settings);
  const workspaceRepo = workspacePath ? await getGitHubRepo(workspacePath) : null;
  if (!workspaceRepo) {
    return { ok: false, message: 'No workspace repo detected. Open a git repo first.' };
  }
  const safePrompt = opts.prompt.replace(/'/g, `'\\''`);
  const term = await getOrCreateRushCloudTerminal(context, workspacePath || process.cwd());
  const repoFlag = owner && workspaceRepo ? `--repo ${workspaceRepo}` : '';
  term.sendText(`rush cloud run ${agentKey} ${repoFlag} -p '${safePrompt}'`.trimEnd());
  term.show(true);
  return { ok: true, message: `Dispatched to ${agentKey} on Rush Cloud (${workspaceRepo}).` };
}

// Send a follow-up prompt into an ALREADY-RUNNING agent terminal, used by
// Foreman's message_agent tool. Resolves "who" against the live registry the
// same way focus does (label/kind/session prefix), then types the text in -
// handling Claude's Ink TUI quirk (needs an explicit carriage return) exactly
// like the watchdog bridge's send_to_agent does. Unlike that cross-process
// path this runs in-host, so it can address any live terminal directly.
async function messageAgentForForeman(
  opts: { who: string; prompt: string },
): Promise<{ ok: boolean; message: string; candidates?: string[] }> {
  const text = (opts.prompt ?? '').trim();
  if (!opts.who?.trim()) return { ok: false, message: 'No agent named.' };
  if (!text) return { ok: false, message: 'No message given.' };

  const agents = terminals.getAllTerminals()
    .filter((t) => t.agentConfig)
    .map((t) => ({ ...t, prefix: t.agentConfig?.prefix }));
  const resolved = resolveForemanTarget(agents, opts.who);

  if (resolved.kind === 'none') {
    return { ok: false, message: `No running agent matching "${opts.who}".`, candidates: resolved.candidates };
  }
  if (resolved.kind === 'ambiguous') {
    return { ok: false, message: `Ambiguous - ${resolved.candidates.length} agents match "${opts.who}".`, candidates: resolved.candidates };
  }

  const entry = resolved.terminal;
  try {
    // Claude's Ink TUI needs an explicit carriage return; others take \n.
    if (entry.agentType === 'claude') {
      entry.terminal.sendText(text, false);
      entry.terminal.sendText('\r', false);
    } else {
      entry.terminal.sendText(text, true);
    }
    return { ok: true, message: `Sent to ${candidateName(entry)}.` };
  } catch (err: any) {
    return { ok: false, message: `Failed to send: ${err?.message ?? String(err)}` };
  }
}

// Headless ticket creation used by Foreman's create_ticket tool. Shells out
// to the same `linear` CLI that fetchLinearTasks() uses. Defaults are intentionally bare — current cycle,
// Todo status, medium priority — so the voice flow is one command: "create
// a ticket called X". The CLI parses the resulting first line:
//   "Created RUSH-585: <title>  [<project> | <assignee>]"
const LINEAR_SCRIPT_PATH = path.join(homedir(), '.agents/skills/linear/scripts/linear');
const execFileAsync = promisify(execFile);

async function createTicketForForeman(
  opts: foreman.ForemanCreateTicketOpts,
): Promise<foreman.ForemanCreateTicketResult> {
  const title = (opts.title ?? '').trim();
  if (!title) return { ok: false, message: 'No title given.' };

  const args: string[] = ['create', title];
  if (opts.description) args.push('--description', opts.description);
  if (opts.priority) args.push('--priority', opts.priority);
  if (opts.assign) args.push('--assign', opts.assign);
  for (const label of opts.labels ?? []) args.push('--label', label);

  try {
    const { stdout } = await execFileAsync(LINEAR_SCRIPT_PATH, args, { timeout: 15_000 });
    const firstLine = (stdout || '').split('\n').find((l) => l.trim().length > 0) ?? '';
    const m = firstLine.match(/Created\s+([A-Z][A-Z0-9]*-\d+):\s*(.+?)(?:\s{2,}\[|$)/);
    if (m) {
      const identifier = m[1];
      const filedTitle = m[2].trim();
      return {
        ok: true,
        message: `Filed ${identifier}: ${filedTitle}.`,
        identifier,
        title: filedTitle,
      };
    }
    return { ok: true, message: firstLine.trim() || 'Filed.', title };
  } catch (err: any) {
    const detail = err?.stderr?.toString().trim() || err?.message || String(err);
    return { ok: false, message: `Linear create failed: ${detail.slice(0, 200)}` };
  }
}

// Factory config: read/write ~/.agents/factory/config.json.
// Kept in this module so the panel can edit it via `factoryConfigRead` /
// `factoryConfigWrite` without needing to shell out to the agents CLI. The
// CLI and panel share the exact same file, so either side sees the other's
// writes.
const DEFAULT_FACTORY_CONFIG = {
  cloud_priority: ['rush', 'codex', 'local'] as const,
  auto_detect_repo: true,
  default_planner_agent: 'codex' as const,
  supervisor_interval_seconds: 8,
};
const VALID_PROVIDERS = new Set(['rush', 'codex', 'factory', 'local']);
const VALID_AGENTS = new Set(['claude', 'codex', 'gemini', 'cursor', 'opencode', 'copilot']);

function factoryConfigFilePath(): string {
  return path.join(homedir(), '.agents', 'factory', 'config.json');
}

function sanitizeFactoryConfig(raw: Record<string, unknown>, prev: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...prev };

  const priority = raw.cloud_priority;
  if (Array.isArray(priority)) {
    const clean = priority.filter((p) => typeof p === 'string' && VALID_PROVIDERS.has(p));
    const deduped = Array.from(new Set(clean as string[]));
    if (deduped.length > 0) next.cloud_priority = deduped;
  }

  if (typeof raw.auto_detect_repo === 'boolean') {
    next.auto_detect_repo = raw.auto_detect_repo;
  }

  if (typeof raw.default_planner_agent === 'string' && VALID_AGENTS.has(raw.default_planner_agent)) {
    next.default_planner_agent = raw.default_planner_agent;
  }

  if (typeof raw.supervisor_interval_seconds === 'number' && raw.supervisor_interval_seconds >= 1) {
    next.supervisor_interval_seconds = Math.floor(raw.supervisor_interval_seconds);
  }

  return next;
}

async function readFactoryConfigSafe(): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.promises.readFile(factoryConfigFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return sanitizeFactoryConfig(parsed, { ...DEFAULT_FACTORY_CONFIG });
  } catch {
    return { ...DEFAULT_FACTORY_CONFIG };
  }
}

async function writeFactoryConfigSafe(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const current = await readFactoryConfigSafe();
  const merged = sanitizeFactoryConfig(patch, current);
  const p = factoryConfigFilePath();
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, JSON.stringify(merged, null, 2));
  return merged;
}

function resolveEditorPath(pathValue: string): string | null {
  if (!pathValue) return null;
  if (path.isAbsolute(pathValue)) return pathValue;
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) return null;
  return path.join(workspacePath, pathValue);
}

async function openFileOrDiffInEditor(pathValue: string): Promise<void> {
  const resolvedPath = resolveEditorPath(pathValue);
  if (!resolvedPath || !fs.existsSync(resolvedPath)) return;
  const fileUri = vscode.Uri.file(resolvedPath);
  const previousActiveUri = vscode.window.activeTextEditor?.document.uri;

  try {
    await vscode.commands.executeCommand('git.openChange', fileUri);
    const currentActiveUri = vscode.window.activeTextEditor?.document.uri;
    const openedDiff = Boolean(currentActiveUri && currentActiveUri.scheme === 'git');
    const openedTarget = Boolean(currentActiveUri && currentActiveUri.fsPath === fileUri.fsPath);
    const hadNoActiveEditor = !previousActiveUri && Boolean(currentActiveUri);
    if (openedDiff || openedTarget || hadNoActiveEditor) {
      return;
    }
  } catch {
  }

  await vscode.window.showTextDocument(fileUri, { preview: true });
}

// Check which agents are installed
export async function checkInstalledAgents(): Promise<Record<string, boolean>> {
  return checkInstalledAgentsViaCli();
}

async function resolveSlotAlias(slot: QuickLaunchSlot | undefined): Promise<boolean> {
  if (!slot || slot.model || !slot.modelAlias) return false;
  const resolved = await resolveAlias(slot.agent, slot.modelAlias);
  if (!resolved) return false;
  slot.model = resolved;
  return true;
}

export async function resolveQuickLaunchAliases(
  context: vscode.ExtensionContext,
  settings: AgentSettings,
): Promise<AgentSettings> {
  if (!settings.quickLaunch) return settings;
  const changes = await Promise.all([
    resolveSlotAlias(settings.quickLaunch.slot1),
    resolveSlotAlias(settings.quickLaunch.slot2),
    resolveSlotAlias(settings.quickLaunch.slot3),
  ]);
  if (changes.some(Boolean)) {
    await context.globalState.update('agentSettings', settings);
  }
  return settings;
}

// Module state
let settingsPanel: vscode.WebviewPanel | undefined;

// Session file watchers for live updates
const sessionWatchers = new Map<string, fs.FSWatcher>();
let sessionUpdateTimeout: NodeJS.Timeout | undefined;
let currentlySubscribedAgentType: string | null = null;

// Cache for getFloorThroughput, keyed by session file path. Skip the read+
// parse when the file's mtime+size are unchanged since the previous poll —
// the webview polls every 2.5s and most polls hit unchanged files.
const throughputCache = new Map<string, { mtimeMs: number; size: number; tokensPerSec: number }>();

// Notify settings panel when integration status changes
export function notifyIntegrationStatus(provider: string, connected: boolean): void {
  settingsPanel?.webview.postMessage({ type: 'integrationStatus', provider, connected });
}

// Clean up all session file watchers
function cleanupSessionWatchers(): void {
  for (const watcher of sessionWatchers.values()) {
    watcher.close();
  }
  sessionWatchers.clear();
  currentlySubscribedAgentType = null;
  if (sessionUpdateTimeout) {
    clearTimeout(sessionUpdateTimeout);
    sessionUpdateTimeout = undefined;
  }
}

// Subscribe to session file changes for live updates
async function subscribeToAgentSessions(agentType: string, workspacePath?: string): Promise<void> {
  // Clean up previous subscriptions
  cleanupSessionWatchers();
  currentlySubscribedAgentType = agentType;

  // Get all terminals of this agent type
  const terminalDetails = await terminals.getTerminalsByAgentType(agentType, workspacePath);

  // For each terminal with a session, watch the session file
  for (const terminal of terminalDetails) {
    if (!terminal.sessionId) continue;

    // Map agentType to session agent type
    const sessionAgentType = agentType as 'claude' | 'codex' | 'gemini';
    if (!['claude', 'codex', 'gemini'].includes(agentType)) continue;

    try {
      const sessionPath = await getSessionPathBySessionId(terminal.sessionId, sessionAgentType, workspacePath);
      if (!sessionPath || sessionWatchers.has(sessionPath)) continue;

      const watcher = fs.watch(sessionPath, { persistent: false }, () => {
        // Debounce updates - wait 500ms after last change
        if (sessionUpdateTimeout) clearTimeout(sessionUpdateTimeout);
        sessionUpdateTimeout = setTimeout(async () => {
          if (!settingsPanel || !settingsPanel.visible || currentlySubscribedAgentType !== agentType) return;

          // Re-fetch terminal data and push to webview
          const updatedTerminals = await terminals.getTerminalsByAgentType(agentType, workspacePath);
          settingsPanel.webview.postMessage({
            type: 'agentTerminalsData',
            agentType,
            terminals: updatedTerminals
          });
        }, 500);
      });

      sessionWatchers.set(sessionPath, watcher);
    } catch {
      // Ignore errors - session file may not exist yet
    }
  }
}

async function pushSubscribedAgentTerminalUpdate(workspacePath?: string): Promise<void> {
  if (!settingsPanel || !currentlySubscribedAgentType) return;

  const subscribedAgentType = currentlySubscribedAgentType;
  const terminalDetails = await terminals.getTerminalsByAgentType(subscribedAgentType, workspacePath);
  if (!settingsPanel || currentlySubscribedAgentType !== subscribedAgentType) return;

  settingsPanel.webview.postMessage({
    type: 'agentTerminalsData',
    agentType: subscribedAgentType,
    terminals: terminalDetails
  });

  await subscribeToAgentSessions(subscribedAgentType, workspacePath);
}

// --- Floor live streaming ---------------------------------------------------
// Instead of the webview polling every 10s, watch the session files of all
// floor terminals plus the teams config, and push allTerminalsData + tasksData
// on change (debounced). Mirrors subscribeToAgentSessions but for the whole
// Floor. New terminals are picked up by re-reconciling the watch set after each
// push (and by the existing onDidOpenTerminal listener).
const floorSessionWatchers = new Map<string, fs.FSWatcher>();
let floorUpdateTimeout: NodeJS.Timeout | undefined;
let floorSubscribed = false;

function cleanupFloorWatchers(): void {
  for (const w of floorSessionWatchers.values()) {
    try { w.close(); } catch { /* ignore */ }
  }
  floorSessionWatchers.clear();
  if (floorUpdateTimeout) {
    clearTimeout(floorUpdateTimeout);
    floorUpdateTimeout = undefined;
  }
  floorSubscribed = false;
}

async function watchFloorSessions(workspacePath?: string): Promise<void> {
  for (const w of floorSessionWatchers.values()) {
    try { w.close(); } catch { /* ignore */ }
  }
  floorSessionWatchers.clear();

  const onChange = () => {
    if (floorUpdateTimeout) clearTimeout(floorUpdateTimeout);
    floorUpdateTimeout = setTimeout(() => { void pushFloorUpdate(workspacePath); }, 500);
  };

  // Team status changes (start/stop/disband) stream in via the teams config.
  try {
    const teamsConfig = path.join(homedir(), '.agents', 'teams', 'config.json');
    if (fs.existsSync(teamsConfig)) {
      floorSessionWatchers.set(teamsConfig, fs.watch(teamsConfig, { persistent: false }, onChange));
    }
  } catch { /* ignore */ }

  // One watcher per live floor-terminal session file.
  try {
    const floorTerminals = await terminals.getFloorTerminalDetails(workspacePath);
    for (const t of floorTerminals) {
      if (!t.sessionId) continue;
      if (!['claude', 'codex', 'gemini'].includes(t.agentType)) continue;
      try {
        const sessionPath = await getSessionPathBySessionId(
          t.sessionId,
          t.agentType as 'claude' | 'codex' | 'gemini',
          workspacePath,
        );
        if (!sessionPath || floorSessionWatchers.has(sessionPath)) continue;
        floorSessionWatchers.set(sessionPath, fs.watch(sessionPath, { persistent: false }, onChange));
      } catch { /* session file may not exist yet */ }
    }
  } catch { /* ignore */ }
}

// Last successfully-fetched floor tasks. Re-served when a fetch throws so the
// webview never wedges (it flips tasksLoaded only on a tasksData reply) and the
// feed shows the last good snapshot instead of blanking on a transient error.
let lastFloorTasks: swarm.TaskSummary[] = [];

async function pushFloorUpdate(workspacePath?: string): Promise<void> {
  if (!settingsPanel || !floorSubscribed) return;
  const [floorTerminals, floorTasks] = await Promise.all([
    terminals.getFloorTerminalDetails(workspacePath),
    swarm.fetchTasks(undefined, workspacePath),
  ]);
  if (!settingsPanel || !floorSubscribed) return;
  lastFloorTasks = floorTasks;
  settingsPanel.webview.postMessage({ type: 'allTerminalsData', terminals: floorTerminals });
  settingsPanel.webview.postMessage({ type: 'tasksData', tasks: floorTasks });
  // Re-reconcile so newly-spawned terminals get watched too.
  await watchFloorSessions(workspacePath);
}

async function subscribeFloor(workspacePath?: string): Promise<void> {
  floorSubscribed = true;
  await watchFloorSessions(workspacePath);
}

// Data directory: ~/.agents/
const AGENTS_CONFIG_DIR = path.join(homedir(), '.agents');
const AGENTS_CONFIG_PATH = path.join(AGENTS_CONFIG_DIR, 'config.json');
const PROMPTS_PATH = path.join(AGENTS_CONFIG_DIR, 'prompts.json');

// Write swarm config file with enabled agents
export function writeSwarmConfig(enabledAgents: SwarmAgentType[]): void {
  try {
    fs.mkdirSync(AGENTS_CONFIG_DIR, { recursive: true });

    // Read existing config to preserve agent settings
    let existingConfig: any = { agents: {}, providers: {} };
    if (fs.existsSync(AGENTS_CONFIG_PATH)) {
      try {
        existingConfig = JSON.parse(fs.readFileSync(AGENTS_CONFIG_PATH, 'utf-8'));
      } catch {
        // If file is invalid, use empty config
      }
    }

    // Update enabled status for all agent types
    for (const agentType of ALL_SWARM_AGENTS) {
      if (!existingConfig.agents[agentType]) {
        existingConfig.agents[agentType] = { enabled: false, models: {}, provider: '' };
      }
      existingConfig.agents[agentType].enabled = enabledAgents.includes(agentType);
    }

    fs.writeFileSync(AGENTS_CONFIG_PATH, JSON.stringify(existingConfig, null, 2));
  } catch (err) {
    console.error('Failed to write swarm config:', err);
  }
}

// Read prompts from YAML file (persists across extension uninstall)
export function readPrompts(): PromptEntry[] {
  const { prompts, usedDefaults } = readPromptsFromPath(PROMPTS_PATH);
  if (usedDefaults) {
    // Save defaults to file for next time
    writePrompts(prompts);
  }
  return prompts;
}

// Write prompts to YAML file
export function writePrompts(prompts: PromptEntry[]): void {
  writePromptsToPath(PROMPTS_PATH, prompts);
}

// Load settings from global state, with migration from old format
export function getSettings(context: vscode.ExtensionContext): AgentSettings {
  const stored = context.globalState.get<AgentSettings>('agentSettings');
  if (stored) {
    // Migrate: add swarmEnabledAgents if missing or filter out old agents
    if (!stored.swarmEnabledAgents) {
      stored.swarmEnabledAgents = [...ALL_SWARM_AGENTS];
      context.globalState.update('agentSettings', stored);
    } else {
      // Filter to only include supported agents (claude, codex, gemini)
      const filtered = stored.swarmEnabledAgents.filter(a => ALL_SWARM_AGENTS.includes(a));
      if (filtered.length !== stored.swarmEnabledAgents.length) {
        stored.swarmEnabledAgents = filtered.length > 0 ? filtered : [...ALL_SWARM_AGENTS];
        context.globalState.update('agentSettings', stored);
      }
    }
    if (!stored.builtIn.opencode) {
      stored.builtIn.opencode = { login: false, instances: 2 };
      context.globalState.update('agentSettings', stored);
    }
    // Migrate: add display preferences
    if (!stored.display) {
      stored.display = { ...DEFAULT_DISPLAY_PREFERENCES };
      context.globalState.update('agentSettings', stored);
    } else {
      // Backfill any missing keys
      if (stored.display.showFullAgentNames === undefined) {
        stored.display.showFullAgentNames = DEFAULT_DISPLAY_PREFERENCES.showFullAgentNames;
      }
      if (stored.display.showLabelsInTitles === undefined) {
        stored.display.showLabelsInTitles = DEFAULT_DISPLAY_PREFERENCES.showLabelsInTitles;
      }
      if (stored.display.autoLabelInTabTitles === undefined) {
        stored.display.autoLabelInTabTitles = DEFAULT_DISPLAY_PREFERENCES.autoLabelInTabTitles;
      }
      if (stored.display.showSessionIdInTitles === undefined) {
        stored.display.showSessionIdInTitles = DEFAULT_DISPLAY_PREFERENCES.showSessionIdInTitles;
      }
      if (stored.display.labelReplacesTitle === undefined) {
        stored.display.labelReplacesTitle = DEFAULT_DISPLAY_PREFERENCES.labelReplacesTitle;
      }
      if (stored.display.showLabelOnlyOnFocus === undefined) {
        stored.display.showLabelOnlyOnFocus = DEFAULT_DISPLAY_PREFERENCES.showLabelOnlyOnFocus;
      }
      context.globalState.update('agentSettings', stored);
    }
    if (!stored.notifications) {
      stored.notifications = { ...DEFAULT_NOTIFICATION_SETTINGS };
      context.globalState.update('agentSettings', stored);
    } else {
      if (stored.notifications.enabled === undefined) {
        stored.notifications.enabled = DEFAULT_NOTIFICATION_SETTINGS.enabled;
      }
      if (!stored.notifications.style) {
        stored.notifications.style = DEFAULT_NOTIFICATION_SETTINGS.style;
      }
      if (!stored.notifications.enabledAgents || stored.notifications.enabledAgents.length === 0) {
        stored.notifications.enabledAgents = [...DEFAULT_NOTIFICATION_SETTINGS.enabledAgents];
      }
      context.globalState.update('agentSettings', stored);
    }
    if (!stored.editor) {
      stored.editor = { markdownViewerEnabled: true };
      context.globalState.update('agentSettings', stored);
    } else if (stored.editor.markdownViewerEnabled === undefined) {
      stored.editor.markdownViewerEnabled = true;
      context.globalState.update('agentSettings', stored);
    }
    // Migrate: load prompts from file (persists across uninstall)
    if (!stored.prompts || stored.prompts.length === 0) {
      stored.prompts = readPrompts();
      context.globalState.update('agentSettings', stored);
    }
    // Migrate: add aliases array if missing
    if (!stored.aliases) {
      stored.aliases = [];
      context.globalState.update('agentSettings', stored);
    }
    // Migrate: add welcome screen setting if missing (default: enabled)
    if (stored.showWelcomeScreen === undefined) {
      stored.showWelcomeScreen = true;
      context.globalState.update('agentSettings', stored);
    }
    // Migrate: add task sources if missing
    if (!stored.taskSources) {
      stored.taskSources = { ...DEFAULT_TASK_SOURCE_SETTINGS };
      context.globalState.update('agentSettings', stored);
    } else if (stored.taskSources.githubAssignedOnly === undefined) {
      stored.taskSources.githubAssignedOnly = DEFAULT_TASK_SOURCE_SETTINGS.githubAssignedOnly;
      context.globalState.update('agentSettings', stored);
    }
    // Migrate: add custom agents if missing
    if (!stored.custom) {
      stored.custom = [];
      context.globalState.update('agentSettings', stored);
    }
    // Migrate: add quick launch if missing
    if (!stored.quickLaunch) {
      stored.quickLaunch = { ...DEFAULT_QUICK_LAUNCH };
      context.globalState.update('agentSettings', stored);
    } else {
      const staleChanged = migrateStaleClaudeQuickLaunch(stored.quickLaunch);
      const legacyChanged = migrateLegacyQuickLaunchSlots(stored.quickLaunch);
      if (staleChanged || legacyChanged) {
        context.globalState.update('agentSettings', stored);
      }
    }
    return stored;
  }

  // Migrate from old settings if they exist
  const config = vscode.workspace.getConfiguration('agents');
  const claudeCount = config.get<number>('claudeCount');
  const autoStart = config.get<boolean>('autoStart', false);

  if (claudeCount !== undefined) {
    // Old settings exist, migrate them
    const migrated: AgentSettings = {
      builtIn: {
        claude: { login: autoStart, instances: config.get<number>('claudeCount', 2) },
        codex: { login: autoStart, instances: config.get<number>('codexCount', 2) },
        gemini: { login: autoStart, instances: config.get<number>('geminiCount', 2) },
        opencode: { login: autoStart, instances: 2 },
        cursor: { login: autoStart, instances: config.get<number>('cursorCount', 2) },
        shell: { login: false, instances: 1 }
      },
      custom: (config.get<{ title: string; command: string; count: number }[]>('customAgents', []) || []).map(a => ({
        name: a.title,
        command: a.command,
        login: false,
        instances: a.count
      })),
      aliases: [],
      swarmEnabledAgents: [...ALL_SWARM_AGENTS],
      prompts: readPrompts(),
      editor: { markdownViewerEnabled: true },
      display: { ...DEFAULT_DISPLAY_PREFERENCES },
      notifications: { ...DEFAULT_NOTIFICATION_SETTINGS },
      showWelcomeScreen: true,
      taskSources: { ...DEFAULT_TASK_SOURCE_SETTINGS }
    };
    context.globalState.update('agentSettings', migrated);
    return migrated;
  }

  return getDefaultSettings();
}

export function getDefaultModel(
  context: vscode.ExtensionContext,
  agentType: keyof AgentSettings['builtIn']
): string | undefined {
  const settings = getSettings(context);
  return settings.builtIn[agentType]?.defaultModel;
}

export async function setDefaultModel(
  context: vscode.ExtensionContext,
  agentType: keyof AgentSettings['builtIn'],
  model: string | undefined
): Promise<void> {
  const settings = getSettings(context);
  const current = settings.builtIn[agentType];

  // Update new config format
  const configPath = AGENTS_CONFIG_PATH;
  let config: any = { agents: {}, providers: {} };
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      // If file is invalid, use empty config
    }
  }

  const agentKey = agentType.toString();
  if (!config.agents[agentKey]) {
    config.agents[agentKey] = { enabled: false, models: {}, provider: '' };
  }

  // Update model in the appropriate effort level (default by convention)
  config.agents[agentKey].models.default = model;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Also update VS Code settings for backward compatibility
  const nextSettings: AgentSettings = {
    ...settings,
    builtIn: {
      ...settings.builtIn,
      [agentType]: {
        ...current,
        defaultModel: model || undefined
      }
    }
  };
  await saveSettings(context, nextSettings);
}

// Save settings to global state and write configs to files
export async function saveSettings(context: vscode.ExtensionContext, settings: AgentSettings): Promise<void> {
  await context.globalState.update('agentSettings', settings);
  writeSwarmConfig(settings.swarmEnabledAgents);
  // Sync prompts to file for persistence across uninstall
  if (settings.prompts) {
    writePrompts(settings.prompts);
  }
  await workbench.setMarkdownEditorAssociation(settings.editor?.markdownViewerEnabled ?? true);
}

// Open the settings webview panel
export function openPanelAndDispatch(context: vscode.ExtensionContext): void {
  const alreadyOpen = !!settingsPanel;
  openPanel(context);
  // Small delay so the webview is ready to receive messages on cold open.
  setTimeout(() => {
    settingsPanel?.webview.postMessage({ type: 'openDispatchModal' });
  }, alreadyOpen ? 0 : 500);
}

// Open the new-agent composer in the Factory panel. Bound to cmd+k while the
// panel is active (VS Code eats cmd+k as a chord prefix before the webview
// sees the keydown, so the shortcut has to be contributed at this layer).
export function openPanelAndFocusQuickSpawn(context: vscode.ExtensionContext): void {
  const alreadyOpen = !!settingsPanel;
  openPanel(context);
  setTimeout(() => {
    settingsPanel?.webview.postMessage({ type: 'focusQuickSpawn' });
  }, alreadyOpen ? 0 : 500);
}

// Cache for agent inventories. agents view --json takes 4-6s because it hits
// vendor APIs for usage stats. Within the TTL, repeat calls are instant.
// Strategy mutations bust the cache so the UI reflects the new state.
const INVENTORY_CACHE_TTL_MS = 60_000;
const INVENTORY_AGENT_KEYS = ['claude', 'codex', 'gemini', 'opencode', 'cursor', 'kimi', 'grok', 'droid', 'antigravity', 'copilot', 'amp'];
let cachedInventories: { data: Record<string, AgentInventory>; fetchedAt: number } | null = null;
let inventoryFetchInflight: Promise<Record<string, AgentInventory>> | null = null;

async function getCachedAgentInventories(force = false): Promise<Record<string, AgentInventory>> {
  if (!force && cachedInventories && Date.now() - cachedInventories.fetchedAt < INVENTORY_CACHE_TTL_MS) {
    return cachedInventories.data;
  }
  if (inventoryFetchInflight) return inventoryFetchInflight;
  inventoryFetchInflight = (async () => {
    const data = await fetchAgentInventories(INVENTORY_AGENT_KEYS);
    cachedInventories = { data, fetchedAt: Date.now() };
    return data;
  })();
  try {
    return await inventoryFetchInflight;
  } finally {
    inventoryFetchInflight = null;
  }
}

function invalidateAgentInventoryCache(): void {
  cachedInventories = null;
}

export function openPanel(context: vscode.ExtensionContext): void {
  if (settingsPanel) {
    settingsPanel.reveal();
    return;
  }

  // Close any orphaned dashboard tab (tab restored after a restart but its
  // webview never revived, e.g. by a pre-serializer extension version). A
  // fresh panel replaces it below.
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputWebview && tab.label === 'Factory') {
        void vscode.window.tabGroups.close(tab);
      }
    }
  }

  const panel = vscode.window.createWebviewPanel(
    'agentsSettings',
    'Factory',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true, // Prevent full reload when panel loses focus
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'out', 'ui'),
        vscode.Uri.joinPath(context.extensionUri, 'assets')
      ]
    }
  );
  wirePanel(panel, context);
}

// VS Code restores webview tabs across window reloads but keeps them blank
// until the owning extension reattaches through a serializer. Without this,
// a restored Factory tab stayed white forever.
export function registerPanelSerializer(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('agentsSettings', {
      async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel) {
        webviewPanel.webview.options = {
          enableScripts: true,
          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'out', 'ui'),
            vscode.Uri.joinPath(context.extensionUri, 'assets')
          ]
        };
        wirePanel(webviewPanel, context);
      }
    })
  );
}

function wirePanel(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): void {
  settingsPanel = panel;

  // Set the tab icon
  settingsPanel.iconPath = theme.buildIconPathFromUri(context.extensionUri, 'agents.png');

  // Pipe live cloud-run SSE updates straight to the webview so the activity
  // feed grows in real time, not just every 10s when fetchTasks runs.
  swarm.setCloudUpdateListener((executionId, summary, status) => {
    settingsPanel?.webview.postMessage({
      type: 'cloudSummaryUpdate',
      executionId,
      summary,
      status,
    });
  });

  const updateWebview = async () => {
    if (!settingsPanel) return;

    const wsFolder = workspaceConfig.getActiveWorkspaceFolder();
    const workspacePath = wsFolder?.uri.fsPath || null;

    // PHASE 1: Send instant data immediately - UI renders right away
    const initialSettings = await resolveQuickLaunchAliases(context, getSettings(context));
    settingsPanel.webview.postMessage({
      type: 'init',
      settings: initialSettings,
      runningCounts: terminals.countRunning(),
      workspacePath,
      dismissedTaskIds: context.globalState.get<string[]>('agents.dismissedTaskIds', []),
      // Status will be sent in phase 2
      swarmStatus: null,
      skillsStatus: null,
      githubRepo: null,
    });

    // PHASE 2: Fetch heavy data in parallel, send when ready
    const [swarmStatus, skillsStatus, githubRepo, agentInventories] = await Promise.all([
      swarm.getSwarmStatus(),
      swarm.getSkillsStatus(),
      workspacePath ? getGitHubRepo(workspacePath) : Promise.resolve(null),
      getCachedAgentInventories(),
    ]);

    if (!settingsPanel) return; // Panel may have closed during fetch
    settingsPanel.webview.postMessage({
      type: 'statusUpdate',
      swarmStatus,
      skillsStatus,
      githubRepo,
    });
    settingsPanel.webview.postMessage({
      type: 'agentInventoriesData',
      agentInventories,
    });

    // Keep top-card counts aligned with open terminal cards in dashboard
    settingsPanel.webview.postMessage({
      type: 'updateRunningCounts',
      counts: terminals.countRunning(),
    });
  };

  settingsPanel.webview.html = getWebviewContent(settingsPanel.webview, context.extensionUri);

  settingsPanel.webview.onDidReceiveMessage(async (message) => {
    switch (message.type) {
      case 'ready':
        // Post the panel's actual visibility once so the webview doesn't have
        // to assume "we mounted, so we must be visible." onDidChangeViewState
        // only fires on transitions, so without this seed a panel that opened
        // hidden would poll until the user revealed-then-hid it.
        settingsPanel?.webview.postMessage({
          type: 'panelVisibility',
          visible: settingsPanel.visible,
        });
        updateWebview();
        break;
      case 'saveSettings':
        // Compare display prefs to decide if we need to retitle open terminals
        const previous = getSettings(context);
        await saveSettings(context, message.settings);
        await maybeUpdateTerminalTitles(previous, message.settings);
        break;
      case 'setGithubOwner': {
        const owner = typeof message.owner === 'string' ? message.owner.trim() : '';
        if (!owner) break;
        const current = getSettings(context);
        await saveSettings(context, { ...current, githubOwner: owner });
        settingsPanel?.webview.postMessage({ type: 'githubOwnerUpdated', owner });
        break;
      }
      case 'fetchGithubRepos': {
        // List repos under the resolved owner so the Task Detail modal's repo
        // picker can offer suggestions. Uses `gh repo list` — inherits the
        // user's gh auth; no separate token needed.
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const settings = getSettings(context);
        const owner = await resolveGithubOwner(workspacePath, settings);
        if (!owner) {
          settingsPanel?.webview.postMessage({ type: 'githubReposList', owner: '', repos: [] });
          break;
        }
        const repos: string[] = await new Promise((resolve) => {
          exec(
            `gh repo list ${owner} --limit 200 --json nameWithOwner -q '.[].nameWithOwner'`,
            (err, stdout) => {
              if (err || !stdout) { resolve([]); return; }
              resolve(stdout.split('\n').map((s) => s.trim()).filter(Boolean));
            },
          );
        });
        settingsPanel?.webview.postMessage({ type: 'githubReposList', owner, repos });
        break;
      }
      case 'fetchGithubBranches': {
        // List branches + default branch for a single repo so the Task Detail
        // modal can surface a branch picker with the default marked.
        const repo = typeof message.repo === 'string' ? message.repo.trim() : '';
        if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
          settingsPanel?.webview.postMessage({
            type: 'githubBranchesList', repo, branches: [], defaultBranch: '',
          });
          break;
        }
        const [branches, defaultBranch] = await Promise.all([
          new Promise<string[]>((resolve) => {
            exec(
              `gh api --paginate "repos/${repo}/branches?per_page=100" -q '.[].name'`,
              { maxBuffer: 4 * 1024 * 1024 },
              (err, stdout) => {
                if (err || !stdout) { resolve([]); return; }
                resolve(stdout.split('\n').map((s) => s.trim()).filter(Boolean));
              },
            );
          }),
          new Promise<string>((resolve) => {
            exec(
              `gh api "repos/${repo}" -q '.default_branch'`,
              (err, stdout) => {
                if (err || !stdout) { resolve(''); return; }
                resolve(stdout.trim());
              },
            );
          }),
        ]);
        settingsPanel?.webview.postMessage({
          type: 'githubBranchesList', repo, branches, defaultBranch,
        });
        break;
      }
      case 'enableSwarm':
        settingsPanel?.webview.postMessage({ type: 'swarmInstallStart' });
        await swarm.setupSwarmIntegration(context, (swarmStatus) => {
          settingsPanel?.webview.postMessage({ type: 'swarmStatus', swarmStatus });
        });
        settingsPanel?.webview.postMessage({ type: 'swarmInstallDone' });
        updateWebview();
        break;
      case 'installSwarmAgent':
        settingsPanel?.webview.postMessage({ type: 'swarmInstallStart' });
        await swarm.setupSwarmIntegrationForAgent(message.agent, context, (swarmStatus) => {
          settingsPanel?.webview.postMessage({ type: 'swarmStatus', swarmStatus });
        });
        const refreshedStatus = await swarm.getSwarmStatus();
        settingsPanel?.webview.postMessage({ type: 'swarmStatus', swarmStatus: refreshedStatus });
        settingsPanel?.webview.postMessage({
          type: 'skillsStatus',
          skillsStatus: await swarm.getSkillsStatus()
        });
        settingsPanel?.webview.postMessage({ type: 'swarmInstallDone' });
        break;
      case 'installCommandPack':
        settingsPanel?.webview.postMessage({ type: 'commandPackInstallStart' });
        await swarm.installCommandPack(context);
        settingsPanel?.webview.postMessage({
          type: 'skillsStatus',
          skillsStatus: await swarm.getSkillsStatus()
        });
        settingsPanel?.webview.postMessage({
          type: 'swarmStatus',
          swarmStatus: await swarm.getSwarmStatus()
        });
        settingsPanel?.webview.postMessage({ type: 'commandPackInstallDone' });
        break;
      case 'fetchTasks': {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        try {
          const tasks = await swarm.fetchTasks(message.limit, workspacePath);
          lastFloorTasks = tasks;
          settingsPanel?.webview.postMessage({ type: 'tasksData', tasks });
        } catch (err) {
          // The webview flips tasksLoaded only on a tasksData reply, and its
          // retry guard won't refire while tasksLoading stays true — so a throw
          // here (no reply) freezes the feed permanently. Always reply: re-serve
          // the last good snapshot, and let the 30s backstop poll repopulate.
          console.error('[floor] fetchTasks failed:', err);
          settingsPanel?.webview.postMessage({ type: 'tasksData', tasks: lastFloorTasks });
        }
        break;
      }
      case 'fetchTasksBySession':
        const sessionTasks = await swarm.fetchTasksBySession(message.sessionId);
        settingsPanel?.webview.postMessage({
          type: 'sessionTasksData',
          sessionId: message.sessionId,
          tasks: sessionTasks
        });
        break;
      case 'fetchAgentTerminals':
        const terminalWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const terminalDetails = await terminals.getTerminalsByAgentType(message.agentType, terminalWorkspace);
        settingsPanel?.webview.postMessage({
          type: 'agentTerminalsData',
          agentType: message.agentType,
          terminals: terminalDetails
        });
        break;
      case 'subscribeAgentTerminals':
        // Start watching session files for live updates
        const subscribeWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        await subscribeToAgentSessions(message.agentType, subscribeWorkspace);
        break;
      case 'unsubscribeAgentTerminals':
        // Stop watching session files
        cleanupSessionWatchers();
        break;
      case 'subscribeFloor': {
        // Stream Floor updates (terminals + tasks) on session/team changes.
        const floorWs = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        await subscribeFloor(floorWs);
        break;
      }
      case 'unsubscribeFloor':
        cleanupFloorWatchers();
        break;
      case 'openGuide':
        openGuide(context, message.guide);
        break;
      case 'checkInstalledAgents':
        const installedAgents = await checkInstalledAgents();
        settingsPanel?.webview.postMessage({
          type: 'installedAgentsData',
          installedAgents
        });
        break;
      case 'fetchAgentModels':
        const agentModels = await fetchAllAgentModels();
        settingsPanel?.webview.postMessage({
          type: 'agentModelsData',
          agentModels
        });
        break;
      case 'setAgentRunStrategy': {
        const nextAgentKey = typeof message.agentKey === 'string' ? message.agentKey : '';
        const nextStrategy: AgentRunStrategy = normalizeRunStrategy(message.strategy);
        if (!nextAgentKey) break;
        writeAgentRunStrategy(nextAgentKey, nextStrategy);
        invalidateAgentInventoryCache();
        settingsPanel?.webview.postMessage({
          type: 'agentInventoriesData',
          agentInventories: await getCachedAgentInventories(true),
        });
        break;
      }
      case 'refreshAgentInventories': {
        const force = message?.force === true;
        if (force) invalidateAgentInventoryCache();
        settingsPanel?.webview.postMessage({
          type: 'agentInventoriesData',
          agentInventories: await getCachedAgentInventories(force),
        });
        break;
      }
      case 'fetchDispatchData': {
        // Data the consolidated Dispatch panel needs: installed agents (reusing the
        // cached `agents view --json` inventory — no re-exec), the unified host
        // roster with live per-host load, and projects ranked by session-index
        // usage. Host live-load also rides the separate 'hostSessions' message; this
        // one seeds the panel on open.
        try {
          const { fetchHostSessions, LOCAL_LABEL } = await import('./remoteSessions.vscode');
          const [inventories, hostResult] = await Promise.all([
            getCachedAgentInventories(),
            fetchHostSessions(Date.now(), { probeCpu: true, projectRules: getSettings(context).projectRules ?? [] }),
          ]);
          const defaultTitle = context.globalState.get<string>('agents.defaultAgentTitle', 'CC');
          const defaultAgentId = getBuiltInDefByTitle(defaultTitle)?.key ?? 'claude';
          const agents = mapInventoriesToInstalledAgents(inventories, defaultAgentId);
          // RUN ON = this machine + cloud only. The remote fleet lives in the
          // device selector (sourced from `agents devices` with correct online
          // status) — keeping remotes out of here avoids a duplicate, stale,
          // all-offline host roster.
          const hosts = buildDispatchHosts(hostResult.hosts, LOCAL_LABEL).filter((h) => h.kind !== 'remote');
          // Targets come from the CURATED managed-projects list (enriched with live
          // session `uses` + confidence + linked Linear name), so the dropdown shows
          // real repos even with nothing running. Falls back to session-derived
          // ranking only if the managed list is empty (e.g. detection produced none).
          const managed = await readManagedProjects();
          const targets = managed.length
            ? buildManagedTargets(managed, hostResult.sessions)
            : rankTargets(hostResult.sessions);
          settingsPanel?.webview.postMessage({ type: 'dispatchData', agents, hosts, targets });
        } catch (err) {
          console.error('[SETTINGS] Error fetching dispatch data:', err);
          settingsPanel?.webview.postMessage({ type: 'dispatchData', agents: [], hosts: [], targets: [] });
        }
        break;
      }
      // ---- managed projects (curated sidebar/dispatch list) ----
      case 'fetchManagedProjects': {
        const projects = await readManagedProjects();
        settingsPanel?.webview.postMessage({ type: 'managedProjectsData', projects });
        break;
      }
      case 'fetchLinearProjects': {
        const projects = await fetchLinearProjects(context);
        settingsPanel?.webview.postMessage({ type: 'linearProjectsData', projects });
        break;
      }
      case 'saveManagedProject': {
        const p = message?.project as ManagedProject | undefined;
        if (p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.path === 'string') {
          const projects = await upsertManagedProject(p);
          settingsPanel?.webview.postMessage({ type: 'managedProjectsData', projects });
        }
        break;
      }
      case 'deleteManagedProject': {
        const id = message?.id;
        if (typeof id === 'string') {
          const projects = await deleteManagedProject(id);
          settingsPanel?.webview.postMessage({ type: 'managedProjectsData', projects });
        }
        break;
      }
      case 'pickProjectFolder': {
        // Native folder picker → derive slug + name + suggest a Linear match by
        // normalized name, so the add-project form pre-fills.
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Add project',
        });
        const folder = picked?.[0]?.fsPath;
        if (folder) {
          const repoSlug = repoSlugFromPath(folder);
          const name = projectNameFromPath(folder);
          const linearProjects = await fetchLinearProjects(context);
          const suggestedLinear = matchLinearProject(repoSlug ?? name, linearProjects);
          settingsPanel?.webview.postMessage({
            type: 'projectFolderPicked',
            path: folder,
            repoSlug,
            name,
            suggestedLinear,
          });
        }
        break;
      }
      // ---- registered-device dispatch data (Dispatch panel device path) ----
      case 'listDevices': {
        // `local` is this machine's canonical device name (matches an `agents
        // devices` registry entry when the local hostname is aligned with it, as
        // agents-cli's own self-detection assumes). The sidebar folds its local
        // session bucket into this name so the machine shows once under its real
        // name instead of duplicated as 'this-mac' + the registry name.
        const local = normalizeHost(hostname());
        try {
          const devices = await listRegisteredDevices();
          settingsPanel?.webview.postMessage({ type: 'devicesData', devices, local });
        } catch (err) {
          console.error('[SETTINGS] Error listing devices:', err);
          settingsPanel?.webview.postMessage({ type: 'devicesData', devices: [], local });
        }
        break;
      }
      case 'deviceHealth': {
        // Online status comes from the agents-cli registry (tailscale.online).
        // For online devices only, fetch live load (loadAvg/mem) and running
        // agent count over their real address; skip offline hosts to avoid SSH
        // hangs.
        try {
          const devices = await listRegisteredDevices();
          const health = await Promise.all(
            devices.map(async (device) => {
              if (!device.online) {
                return { device, stats: { host: device.host, reachable: false, runningAgents: 0, fetchedAt: Date.now() } };
              }
              const isLocal = isLocalDeviceHost(device.host);
              const creds = device.secretRef ? await resolveSecret(device.secretRef) : {};
              const [stats, runningAgents] = await Promise.all([
                fetchDeviceStats(device.host, { isLocal, identityFile: creds.identityFile, user: creds.user || device.user }),
                countRunningAgents(device.host, { isLocal }),
              ]);
              return { device, stats: { ...stats, reachable: true, runningAgents } };
            }),
          );
          settingsPanel?.webview.postMessage({ type: 'deviceHealthData', health });
        } catch (err) {
          console.error('[SETTINGS] Error fetching device health:', err);
          settingsPanel?.webview.postMessage({ type: 'deviceHealthData', health: [] });
        }
        break;
      }
      case 'projectCandidates': {
        try {
          const candidates = await inferProjectCandidates();
          settingsPanel?.webview.postMessage({ type: 'projectCandidatesData', candidates });
        } catch (err) {
          console.error('[SETTINGS] Error inferring project candidates:', err);
          settingsPanel?.webview.postMessage({ type: 'projectCandidatesData', candidates: [] });
        }
        break;
      }
      case 'repos': {
        try {
          const candidates = await inferProjectCandidates();
          const repos = await rankRepos(candidates, detectProjects);
          settingsPanel?.webview.postMessage({ type: 'reposData', repos });
        } catch (err) {
          console.error('[SETTINGS] Error ranking repos:', err);
          settingsPanel?.webview.postMessage({ type: 'reposData', repos: [] });
        }
        break;
      }
      case 'repoSync': {
        const root = typeof message.root === 'string' ? message.root : '';
        const syncHost = typeof message.host === 'string' ? message.host : '';
        const syncSecretRef = typeof message.secretRef === 'string' ? message.secretRef : undefined;
        if (!root) {
          settingsPanel?.webview.postMessage({ type: 'repoSyncData', root: '', status: null });
          break;
        }
        try {
          // Check sync AS IT EXISTS ON THE SELECTED DEVICE (incl. not-cloned),
          // not on the local mac. Falls back to the local repo for this-mac.
          let status;
          if (syncHost && !isLocalDeviceHost(syncHost)) {
            const creds = syncSecretRef ? await resolveSecret(syncSecretRef) : {};
            status = await getDeviceSyncStatus(syncHost, root, { isLocal: false, identityFile: creds.identityFile, user: creds.user });
          } else {
            status = await getSyncStatus(root, { fetch: true });
          }
          settingsPanel?.webview.postMessage({ type: 'repoSyncData', root, status });
        } catch (err) {
          console.error('[SETTINGS] Error checking repo sync:', err);
          settingsPanel?.webview.postMessage({ type: 'repoSyncData', root, status: null });
        }
        break;
      }
      case 'manageDevices': {
        const term = vscode.window.createTerminal('agents devices');
        term.show();
        term.sendText('agents devices sync');
        break;
      }
      case 'fetchAgentResources': {
        const force = message?.force === true;
        if (force) invalidateAgentResourcesCache();
        const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        try {
          const repos = await getAgentResources(wsPath, force);
          settingsPanel?.webview.postMessage({ type: 'agentResourcesData', repos });
        } catch (err) {
          console.error('[SETTINGS] Error fetching agent resources:', err);
          settingsPanel?.webview.postMessage({ type: 'agentResourcesData', repos: [] });
        }
        break;
      }
      case 'getDefaultAgent':
        const defaultAgent = context.globalState.get<string>('agents.defaultAgentTitle', 'CC');
        settingsPanel?.webview.postMessage({
          type: 'defaultAgentData',
          defaultAgent
        });
        break;
      case 'getSecondaryAgent':
        const secondaryAgent = context.globalState.get<string>('agents.secondaryAgentTitle', 'CX');
        settingsPanel?.webview.postMessage({
          type: 'secondaryAgentData',
          secondaryAgent
        });
        break;
      case 'setDefaultAgent':
        // Update via command which also updates the module-level variable
        await vscode.commands.executeCommand('agents.setDefaultAgentTitle', message.agentTitle);
        break;
      case 'setSecondaryAgent':
        // Update via command which also updates the module-level variable
        await vscode.commands.executeCommand('agents.setSecondaryAgentTitle', message.agentTitle);
        break;
      case 'spawnAgent':
        // Spawn a new agent of the given type
        const agentKey = message.agentKey as string;
        if (message.isCustom) {
          // Custom agent - command ID is agents.new{Name} with non-alphanumeric chars removed
          const commandId = `agents.new${agentKey.replace(/[^a-zA-Z0-9]/g, '')}`;
          vscode.commands.executeCommand(commandId);
        } else {
          // Built-in agent - prefer explicit commandId from registry (handles casing like OpenCode)
          const builtIn = getBuiltInByKey(agentKey);
          const commandId = builtIn?.commandId || `agents.new${agentKey.charAt(0).toUpperCase() + agentKey.slice(1)}`;
          vscode.commands.executeCommand(commandId);
        }
        break;
      case 'fetchUnifiedTasks':
        try {
          const currentSettings = getSettings(context);
          const { tasks: unifiedTasks, cycleInfo } = await fetchAllTasks(context, currentSettings.taskSources);
          settingsPanel?.webview.postMessage({ type: 'unifiedTasksData', tasks: unifiedTasks, cycleInfo });
        } catch (err) {
          console.error('[SETTINGS] Error fetching unified tasks:', err);
          settingsPanel?.webview.postMessage({ type: 'unifiedTasksData', tasks: [], cycleInfo: null });
        }
        break;
      case 'saveLinearApiKey': {
        try {
          const { saveLinearApiKey } = await import('./linear.vscode');
          await saveLinearApiKey(message.key);
          settingsPanel?.webview.postMessage({ type: 'integrationStatus', provider: 'linear', connected: true });
        } catch (err) {
          console.error('[SETTINGS] Error saving Linear API key:', err);
          settingsPanel?.webview.postMessage({ type: 'integrationStatus', provider: 'linear', connected: false, error: 'Failed to save API key' });
        }
        break;
      }

      case 'checkGitHubAuth': {
        try {
          const { isGitHubAvailable } = await import('./github.vscode');
          const connected = await isGitHubAvailable(context);
          settingsPanel?.webview.postMessage({ type: 'integrationStatus', provider: 'github', connected });
        } catch {
          settingsPanel?.webview.postMessage({ type: 'integrationStatus', provider: 'github', connected: false });
        }
        break;
      }


      case 'detectTaskSources':
        try {
          // Detect which task sources are available
          const availableSources = await detectAvailableSources(context);
          settingsPanel?.webview.postMessage({ type: 'taskSourcesData', sources: availableSources });
        } catch (err) {
          console.error('[SETTINGS] Error detecting task sources:', err);
          settingsPanel?.webview.postMessage({ type: 'taskSourcesData', sources: { linear: false, github: false } });
        }
        break;
      case 'fetchSessions':
        const sessionsWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const sessions = await discoverRecentSessions(message.limit || 50, sessionsWorkspace);
        settingsPanel?.webview.postMessage({ type: 'sessionsData', sessions });
        break;
      case 'fetchHostSessions': {
        // Tier-1 cross-host aggregation: active sessions from this machine +
        // every reachable SSH/Tailscale host, in parallel. A dead host is marked
        // offline rather than failing the batch.
        try {
          const { fetchHostSessions } = await import('./remoteSessions.vscode');
          const { hosts, sessions: hostSessions, groups, fetchedAt } = await fetchHostSessions(
            Date.now(),
            { projectRules: getSettings(context).projectRules ?? [] },
          );
          settingsPanel?.webview.postMessage({
            type: 'hostSessions',
            hosts,
            sessions: hostSessions,
            groups,
            fetchedAt,
          });
        } catch (err) {
          console.error('[SETTINGS] Error fetching host sessions:', err);
          settingsPanel?.webview.postMessage({
            type: 'hostSessions',
            hosts: [],
            sessions: [],
            groups: [],
            fetchedAt: Date.now(),
          });
        }
        break;
      }
      case 'fetchLocalSessions': {
        // Local-only fast path (the 3s feed poll): this machine's sessions with no
        // SSH and no host discovery. Rides a distinct 'localSessions' message so the
        // webview replaces only the this-mac rows and leaves remote rows intact.
        try {
          const { fetchLocalSessions } = await import('./remoteSessions.vscode');
          const { sessions: localSessions, fetchedAt } = await fetchLocalSessions(
            Date.now(),
            getSettings(context).projectRules ?? [],
          );
          settingsPanel?.webview.postMessage({
            type: 'localSessions',
            sessions: localSessions,
            fetchedAt,
          });
        } catch (err) {
          console.error('[SETTINGS] Error fetching local sessions:', err);
        }
        break;
      }
      case 'fetchRecentSessions': {
        // Lazy: the Floor asks for a host's RECENT (historical) sessions only when that
        // host has 0 live agents, so an empty host filter shows recent work instead of a
        // blank pane. Rides its own 'recentSessions' message, keyed by host.
        const recentHost = typeof message.host === 'string' ? message.host : '';
        try {
          if (!recentHost) break;
          const { fetchRecentForHost, LOCAL_LABEL } = await import('./remoteSessions.vscode');
          const isLocal = recentHost === 'this-mac' || recentHost === LOCAL_LABEL;
          const sessions = await fetchRecentForHost(
            recentHost, isLocal, recentHost, 12, getSettings(context).projectRules ?? [],
          );
          settingsPanel?.webview.postMessage({ type: 'recentSessions', host: recentHost, sessions });
        } catch (err) {
          console.error('[SETTINGS] Error fetching recent sessions:', err);
          settingsPanel?.webview.postMessage({ type: 'recentSessions', host: recentHost, sessions: [] });
        }
        break;
      }
      case 'fetchPrBoard': {
        // PR board: CI + review + mergeable per PR URL (TTL-cached gh pr view).
        const urls = Array.isArray(message.urls) ? message.urls.filter((u: unknown) => typeof u === 'string') : [];
        try {
          const { fetchPrStatuses } = await import('./prBoard.vscode');
          const statuses = await fetchPrStatuses(urls);
          settingsPanel?.webview.postMessage({ type: 'prBoard', statuses });
        } catch (err) {
          console.error('[SETTINGS] Error fetching PR board:', err);
          settingsPanel?.webview.postMessage({ type: 'prBoard', statuses: [] });
        }
        break;
      }
      case 'mergePr': {
        // Board merge action. Plain --rebase, no --admin — branch protection stays
        // in force; a refusal comes back to the row as an inline error.
        const mergeUrl = typeof message.url === 'string' ? message.url : '';
        try {
          if (!mergeUrl) break;
          const { mergePr } = await import('./prBoard.vscode');
          const result = await mergePr(mergeUrl);
          settingsPanel?.webview.postMessage({ type: 'mergePrResult', url: mergeUrl, ...result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          settingsPanel?.webview.postMessage({ type: 'mergePrResult', url: mergeUrl, ok: false, error: msg });
        }
        break;
      }
      case 'fetchRecap': {
        // Recap ledger: recent (ended) sessions across the WHOLE fleet — local +
        // every online registered device — with the CLI's per-session outcome
        // metrics (duration/cost/tokens). Fetched lazily when the Recap center
        // opens; rides its own 'recapSessions' message.
        try {
          const { fetchRecapSessions } = await import('./remoteSessions.vscode');
          const sessions = await fetchRecapSessions(20, getSettings(context).projectRules ?? []);
          settingsPanel?.webview.postMessage({ type: 'recapSessions', sessions });
        } catch (err) {
          console.error('[SETTINGS] Error fetching recap sessions:', err);
          settingsPanel?.webview.postMessage({ type: 'recapSessions', sessions: [] });
        }
        break;
      }
      case 'fetchHostInventory': {
        // Host detail pane: installed agents/versions/accounts/usage/resources on
        // one host (over SSH for remotes) + registry metadata. Cached per host.
        const invHost = typeof message.host === 'string' ? message.host : '';
        const invForce = message.force === true;
        try {
          const { fetchHostInventory } = await import('../core/hostInventory');
          const inventory = await fetchHostInventory(invHost, invForce);
          settingsPanel?.webview.postMessage({ type: 'hostInventory', host: invHost, inventory });
        } catch (err) {
          console.error('[SETTINGS] Error fetching host inventory:', err);
          settingsPanel?.webview.postMessage({
            type: 'hostInventory',
            host: invHost,
            inventory: {
              host: invHost,
              reachable: false,
              error: err instanceof Error ? err.message : String(err),
              meta: null,
              agents: [],
              fetchedAt: Date.now(),
            },
          });
        }
        break;
      }
      case 'enrollHost': {
        // Configure: register a host, then re-fetch (force) so the pane reflects it.
        const enName = typeof message.host === 'string' ? message.host : '';
        const enTarget = typeof message.target === 'string' && message.target ? message.target : undefined;
        const enCaps = Array.isArray(message.caps) ? message.caps.filter((c: unknown): c is string => typeof c === 'string') : undefined;
        try {
          const { enrollHost, fetchHostInventory } = await import('../core/hostInventory');
          await enrollHost(enName, { target: enTarget, caps: enCaps });
          const inventory = await fetchHostInventory(enName, true);
          settingsPanel?.webview.postMessage({ type: 'hostInventory', host: enName, inventory });
        } catch (err) {
          settingsPanel?.webview.postMessage({
            type: 'hostConfigError', host: enName, action: 'enroll',
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      case 'removeHost': {
        const rmName = typeof message.host === 'string' ? message.host : '';
        try {
          const { removeHost, fetchHostInventory } = await import('../core/hostInventory');
          await removeHost(rmName);
          const inventory = await fetchHostInventory(rmName, true);
          settingsPanel?.webview.postMessage({ type: 'hostInventory', host: rmName, inventory });
        } catch (err) {
          settingsPanel?.webview.postMessage({
            type: 'hostConfigError', host: rmName, action: 'remove',
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      case 'fetchHostSessionDetail': {
        // Tier-2 on-demand: render one remote agent's session as markdown.
        const detailHost = typeof message.host === 'string' ? message.host : '';
        const detailSessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
        if (!detailHost || !detailSessionId) {
          settingsPanel?.webview.postMessage({
            type: 'hostSessionDetail',
            host: detailHost,
            sessionId: detailSessionId,
            markdown: '',
            error: 'host and sessionId are required',
          });
          break;
        }
        try {
          const { fetchHostSessionDetail } = await import('./remoteSessions.vscode');
          const detail = await fetchHostSessionDetail(detailHost, detailSessionId);
          settingsPanel?.webview.postMessage({ type: 'hostSessionDetail', ...detail });
        } catch (err) {
          console.error('[SETTINGS] Error fetching host session detail:', err);
          settingsPanel?.webview.postMessage({
            type: 'hostSessionDetail',
            host: detailHost,
            sessionId: detailSessionId,
            markdown: '',
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      case 'getFloorThroughput': {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const all = terminals.getAllTerminals();
        const { computeOutputTokensPerSec } = await import('../core/session.activity');
        let total = 0;
        await Promise.all(all.map(async (t) => {
          if (t.terminal.exitStatus !== undefined) return;
          const agentType = (t.agentType || '').toLowerCase() as 'claude' | 'codex' | 'gemini';
          if (!t.sessionId || (agentType !== 'claude' && agentType !== 'codex' && agentType !== 'gemini')) return;
          try {
            const sessionPath = await getSessionPathBySessionId(t.sessionId, agentType, workspacePath);
            if (!sessionPath) return;
            const stat = await fs.promises.stat(sessionPath);
            const size = stat.size;
            // Cache by (mtime, size). The webview polls every 2.5s; without
            // this cache an idle Gemini session forced a full multi-MB JSON
            // re-read every poll for an unchanged result.
            const cached = throughputCache.get(sessionPath);
            if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === size) {
              total += cached.tokensPerSec;
              return;
            }
            const fh = await fs.promises.open(sessionPath, 'r');
            try {
              const readStart = agentType === 'gemini' ? 0 : Math.max(0, size - 256 * 1024);
              const buf = Buffer.alloc(size - readStart);
              await fh.read(buf, 0, buf.length, readStart);
              const content = buf.toString('utf-8');
              const tps = computeOutputTokensPerSec(content, agentType, 60);
              total += tps;
              throughputCache.set(sessionPath, { mtimeMs: stat.mtimeMs, size, tokensPerSec: tps });
            } finally {
              await fh.close();
            }
          } catch { }
        }));
        settingsPanel?.webview.postMessage({ type: 'floorThroughputData', tokensPerSec: Math.round(total) });
        break;
      }
      case 'dispatchTask': {
        const agentType = typeof message.agentType === 'string' ? message.agentType : 'claude';
        // Device target: spawn the agent on a registered machine over SSH, in the
        // resolved project path, honoring the auto-sync policy + resolved creds.
        // Kept separate from the local/cloud branches below (which are unchanged).
        if (message.target === 'device') {
          const deviceHost = typeof message.host === 'string' ? message.host : '';
          const projectPath = typeof message.projectPath === 'string' ? message.projectPath : '';
          const secretRef = typeof message.secretRef === 'string' ? message.secretRef : undefined;
          const syncPolicy: 'off' | 'safe' | 'aggressive' =
            message.syncPolicy === 'off' || message.syncPolicy === 'aggressive' ? message.syncPolicy : 'safe';
          const deviceMode: DispatchModeMsg =
            message.mode === 'plan' || message.mode === 'edit' ? message.mode : 'auto';
          const deviceName = typeof message.deviceName === 'string' ? message.deviceName : deviceHost;
          const promptBody = typeof message.description === 'string' ? message.description : '';
          const promptIdentifier = typeof message.identifier === 'string' ? message.identifier : '';
          const devicePrompt = [promptBody.trim(), promptIdentifier ? `Attached ticket: ${promptIdentifier}` : '']
            .filter(Boolean)
            .join('\n\n') || (typeof message.title === 'string' ? message.title : '');
          if (!deviceHost) {
            vscode.window.showErrorMessage('Device dispatch: no device host provided.');
            break;
          }
          if (!devicePrompt.trim()) {
            vscode.window.showErrorMessage('Device dispatch: nothing to do — add a prompt or attach a ticket.');
            break;
          }
          // Resolve platform from the device registry so Windows hops use
          // PowerShell instead of bash -lc (RUSH-1481).
          let devicePlatform: string | undefined;
          try {
            const devices = await listRegisteredDevices();
            const match = devices.find(
              (d) => d.host === deviceHost || d.name === deviceHost || d.name === deviceName,
            );
            devicePlatform = match?.platform;
          } catch { /* best-effort; default POSIX */ }
          const err = await dispatchToDevice({
            agentType,
            host: deviceHost,
            secretRef,
            projectPath,
            repoSlug: typeof message.repoSlug === 'string' ? message.repoSlug : undefined,
            syncPolicy,
            mode: deviceMode,
            prompt: devicePrompt,
            platform: devicePlatform,
          });
          if (err) vscode.window.showErrorMessage(`${deviceName}: ${err}`);
          break;
        }
        const target = message.target === 'cloud' ? 'cloud' : 'local';
        // Cloud provider picks which backend we shell out to. 'rush' keeps
        // the legacy `rush cloud run` path so existing users see no change.
        // Any other value routes through `agents cloud run --provider X` so
        // new providers (codex, factory) go through the agents-cli
        // abstraction instead of a rush-specific binary.
        const cloudProvider: 'rush' | 'codex' | 'factory' =
          message.cloudProvider === 'codex' ? 'codex'
            : message.cloudProvider === 'factory' ? 'factory'
              : 'rush';
        const title = typeof message.title === 'string' ? message.title : '';
        const description = typeof message.description === 'string' ? message.description : '';
        const identifier = typeof message.identifier === 'string' ? message.identifier : '';
        const url = typeof message.url === 'string' ? message.url : '';
        const extraComments = typeof message.extraComments === 'string' ? message.extraComments : '';
        const labels: string[] = Array.isArray(message.labels)
          ? message.labels.filter((l: unknown): l is string => typeof l === 'string')
          : [];
        const overrideRepos: string[] = Array.isArray(message.targetRepos)
          ? message.targetRepos.filter((r: unknown): r is string => typeof r === 'string' && /^[^/]+\/[^/]+$/.test(r))
          : [];
        if (!title) {
          vscode.window.showErrorMessage('Cannot dispatch: task has no title');
          break;
        }

        const prompt = buildTaskDispatchPrompt({ title, description, identifier, url, extraComments });

        if (target === 'cloud') {
          const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const currentSettings = getSettings(context);

          let targetRepos: string[] = [];

          if (overrideRepos.length > 0) {
            targetRepos = overrideRepos;
          } else {
            const owner = await resolveGithubOwner(workspacePath, currentSettings);
            targetRepos = resolveReposFromLabels(labels, owner);
            const isLinear = isLinearSourcedTask(identifier);

            // Workspace-repo fallback is only safe for non-Linear tasks
            // (markdown, ad-hoc) where the workspace IS the target. Linear
            // tasks must resolve via explicit `repo:<name>` label or through
            // the picker — silently dispatching RUSH-* to the current
            // workspace caused RUSH-461 to go to swarmify instead of agents.
            if (targetRepos.length === 0 && !isLinear && workspacePath) {
              const workspaceRepo = await getGitHubRepo(workspacePath);
              if (workspaceRepo) targetRepos = [workspaceRepo];
            }

            if (targetRepos.length === 0 && !owner) {
              settingsPanel?.webview.postMessage({
                type: 'needGithubOwner',
                taskId: message.taskId,
                agentType,
                labels,
                title,
                description,
                identifier,
                url,
                extraComments,
              });
              break;
            }

            // Linear task with no repo label: show the picker with the
            // owner's full gh repo list so the user picks explicitly. No
            // pre-selection — forces a conscious choice, avoids the "I
            // clicked Dispatch and it went to the wrong repo" footgun.
            if (targetRepos.length === 0 && isLinear && owner) {
              const ghRepos: string[] = await new Promise((resolve) => {
                exec(
                  `gh repo list ${owner} --limit 200 --json nameWithOwner -q '.[].nameWithOwner'`,
                  (err, stdout) => {
                    if (err || !stdout) { resolve([]); return; }
                    resolve(stdout.split('\n').map((s) => s.trim()).filter(Boolean));
                  },
                );
              });
              const workspaceRepo = workspacePath ? await getGitHubRepo(workspacePath) : null;
              // Float the workspace repo to the top (common case: user is
              // working in a monorepo that IS the target) so they can
              // one-click confirm without scrolling 100+ repos.
              const ordered = workspaceRepo && ghRepos.includes(workspaceRepo)
                ? [workspaceRepo, ...ghRepos.filter((r) => r !== workspaceRepo)]
                : ghRepos.length > 0
                  ? ghRepos
                  : workspaceRepo
                    ? [workspaceRepo]
                    : [];
              if (ordered.length === 0) {
                vscode.window.showErrorMessage(
                  `Cloud dispatch: no repos found under ${owner}. Add a \`repo:<name>\` Linear label or check gh auth.`,
                );
                break;
              }
              settingsPanel?.webview.postMessage({
                type: 'pickRepos',
                taskId: message.taskId,
                agentType,
                repos: ordered,
                preSelected: [],
                title,
                description,
                identifier,
                url,
                extraComments,
                labels,
              });
              break;
            }

            if (targetRepos.length === 0) {
              vscode.window.showErrorMessage(
                'Cloud dispatch: could not resolve a target repo. Add a `repo:<name>` Linear label, or open the repo as the workspace.'
              );
              break;
            }

            if (targetRepos.length > 1) {
              settingsPanel?.webview.postMessage({
                type: 'pickRepos',
                taskId: message.taskId,
                agentType,
                repos: targetRepos,
                preSelected: targetRepos,
                title,
                description,
                identifier,
                url,
                extraComments,
                labels,
              });
              break;
            }
          }

          const safePrompt = prompt.replace(/'/g, `'\\''`);
          const term = await getOrCreateRushCloudTerminal(context, workspacePath || process.cwd());
          // Single dispatch with repeatable --repo flags. The cloud agent
          // clones each repo into /workspace/<owner>/<name>/ and can commit
          // to any of them. Firing N separate invocations would produce N
          // disconnected pods that can't coordinate.
          const repoFlags = targetRepos.map((r) => `--repo ${r}`).join(' ');
          if (cloudProvider === 'rush') {
            term.sendText(`rush cloud run ${agentType} ${repoFlags} -p '${safePrompt}'`);
          } else {
            // Route non-rush providers through the agents-cli abstraction so
            // codex/factory get the same repo-picker UX with a provider flag.
            term.sendText(
              `agents cloud run --provider ${cloudProvider} --agent ${agentType} ${repoFlags} -p '${safePrompt}'`,
            );
          }
          term.show(true);
          break;
        }

        const def = getBuiltInByKey(agentType);
        if (!def) {
          vscode.window.showErrorMessage(`Unknown agent type: ${agentType}`);
          break;
        }
        const agentConfig = configFromDef(context.extensionPath, def);
        const localWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const localOwner = await resolveGithubOwner(localWorkspace, getSettings(context));
        const localSlugs = overrideRepos.length > 0
          ? overrideRepos
          : resolveReposFromLabels(labels, localOwner);
        const localCwd = localSlugs.length === 1 ? await resolveLocalRepoPath(localSlugs[0]) : null;
        await openSingleAgentWithQueue(context, agentConfig, [prompt], localCwd ? { cwd: localCwd } : undefined);
        break;
      }
      // Draft a dispatch prompt from the attached tickets so the user doesn't have
      // to write it. Spawns a headless read-only agent (draftDispatchPrompt) and
      // posts the text back; the webview drops it into the prompt box for editing.
      case 'draftPrompt': {
        const rawTickets = Array.isArray(message.tickets) ? message.tickets : [];
        const tickets: DraftTicket[] = rawTickets
          .filter((t: unknown): t is Record<string, unknown> => !!t && typeof t === 'object')
          .map((t: Record<string, unknown>) => ({
            identifier: typeof t.identifier === 'string' ? t.identifier : undefined,
            title: typeof t.title === 'string' ? t.title : '',
            description: typeof t.description === 'string' ? t.description : undefined,
          }));
        const hint = typeof message.hint === 'string' ? message.hint : '';
        try {
          const text = await draftDispatchPrompt(tickets, hint);
          if (text) {
            settingsPanel?.webview.postMessage({ type: 'draftPromptResult', ok: true, text });
          } else {
            settingsPanel?.webview.postMessage({
              type: 'draftPromptResult', ok: false,
              error: 'Could not draft a prompt — attach a ticket with a description, or write it yourself.',
            });
          }
        } catch (err) {
          settingsPanel?.webview.postMessage({
            type: 'draftPromptResult', ok: false,
            error: err instanceof Error ? err.message : 'Draft failed',
          });
        }
        break;
      }
      // Unified dispatch from the consolidated Dispatch panel. Consumes the full
      // DispatchRequest (agent, host, project/repo, branch, mode, watchdog,
      // notify, batch) — replacing the field-by-field `dispatchTask` above.
      case 'dispatch': {
        const req = message.request as DispatchRequestMsg | undefined;
        if (!req || typeof req.prompt !== 'string' || typeof req.agent !== 'string') {
          vscode.window.showErrorMessage('Dispatch: malformed request');
          break;
        }
        const ticketIds = Array.isArray(req.ticketIds)
          ? req.ticketIds.filter((t: unknown): t is string => typeof t === 'string')
          : [];
        const attachments: DispatchAttachmentMsg[] = Array.isArray(req.attachments) ? req.attachments : [];
        const notify = req.notify;
        const watchdog: WatchdogPolicyMsg = req.watchdog === 'keep' || req.watchdog === 'handsoff' ? req.watchdog : 'off';
        const mode: DispatchModeMsg = req.mode === 'plan' || req.mode === 'edit' ? req.mode : 'auto';

        if (!req.prompt.trim() && ticketIds.length === 0) {
          vscode.window.showErrorMessage('Dispatch: nothing to do — add a prompt or attach a ticket');
          break;
        }

        // batch 'per' (with >=2 tickets) fans out one dispatch per ticket;
        // otherwise a single dispatch carries the prompt + all tickets.
        const units: { prompt: string }[] =
          req.batch === 'per' && ticketIds.length >= 2
            ? ticketIds.map((id) => ({ prompt: composeDispatchPrompt(req.prompt, [id], attachments) }))
            : [{ prompt: composeDispatchPrompt(req.prompt, ticketIds, attachments) }];

        const resolution = classifyDispatchHost(req.runOn);

        if (resolution.kind === 'remote') {
          vscode.window.showErrorMessage(
            `Dispatch: remote host "${resolution.host}" has no spawn path yet (SSH dispatch pending). Pick this machine or a cloud host.`,
          );
          break;
        }

        if (resolution.kind === 'cloud') {
          const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const repo = typeof req.repo === 'string' ? req.repo : '';
          if (!/^[^/]+\/[^/]+$/.test(repo)) {
            vscode.window.showErrorMessage('Cloud dispatch: pick a repo (owner/name) first.');
            break;
          }
          const term = await getOrCreateRushCloudTerminal(context, workspacePath || process.cwd());
          const cloudMode = cloudModeForDispatch(mode);
          const branch = typeof req.branch === 'string' ? req.branch.trim() : '';
          // The panel's default "auto (new branch)" means let the cloud create
          // one — only pass --branch for a real, explicit branch name.
          const branchFlag = branch && !branch.toLowerCase().startsWith('auto') ? ` --branch ${branch}` : '';
          for (const unit of units) {
            const safePrompt = unit.prompt.replace(/'/g, `'\\''`);
            term.sendText(
              `agents cloud run --provider ${resolution.provider} --agent ${req.agent} --repo ${repo}${branchFlag} --mode ${cloudMode} -p '${safePrompt}'`,
            );
          }
          term.show(true);
          break;
        }

        // Local machine: spawn a terminal agent per unit with the real mode flag.
        const def = getBuiltInByKey(req.agent);
        if (!def) {
          vscode.window.showErrorMessage(`Dispatch: unknown agent "${req.agent}"`);
          break;
        }
        const agentConfig = configFromDef(context.extensionPath, def);
        const projectId = typeof req.project === 'string' ? req.project : '';
        const curatedPath = typeof req.projectPath === 'string' ? req.projectPath.trim() : '';
        // A curated managed project ships its absolute path — authoritative, and the
        // only way a manual (non-"owner/repo") project resolves to its real folder.
        // Fall back to slug resolution for a bare id: "owner/repo" resolves to a local
        // clone; anything else falls through to the workspace folder (never $HOME,
        // which openSingleAgentWithQueue guarantees when no cwd is passed).
        const cwd = curatedPath && fs.existsSync(curatedPath)
          ? curatedPath
          : projectId.includes('/') ? await resolveLocalRepoPath(projectId) : null;
        for (const unit of units) {
          // Headless: run detached with NO terminal tab. It surfaces in the Floor
          // under this machine (context:'headless') and is focusable later.
          if (req.headless) {
            runHeadlessAgent(req.agent, unit.prompt, mode, cwd ?? undefined);
            continue;
          }
          // Pre-mint the session id for plan-mode Claude so we can watch that
          // exact session file for the ExitPlanMode plan afterwards.
          const preSessionId = req.agent === 'claude' && mode === 'plan' ? generateClaudeSessionId() : undefined;
          const result = await openSingleAgentWithQueue(context, agentConfig, [unit.prompt], {
            ...(cwd ? { cwd } : {}),
            mode,
            ...(preSessionId ? { sessionId: preSessionId } : {}),
          });
          if (result.sessionId) {
            dispatchSessionPolicies.set(result.sessionId, {
              watchdog,
              notify,
              agentId: result.terminalId,
              prompt: unit.prompt,
              cwd: cwd ?? undefined,
              mode,
            });
            if (req.agent === 'claude' && mode === 'plan') {
              watchForPlan(
                result.sessionId,
                result.terminalId,
                cwd || (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()),
                notify,
              );
            }
          }
        }
        break;
      }
      // Plan-review: approve the pending plan. Resumes the plan-mode agent by
      // accepting the ExitPlanMode prompt in its terminal; optional `edited`
      // steps are sent as a follow-up so the agent proceeds with the revision.
      case 'approvePlan': {
        const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
        const entry = terminals.getAllTerminals().find((t) => t.sessionId === sessionId);
        if (!entry) {
          vscode.window.showErrorMessage(`Approve plan: no live agent for session ${sessionId}`);
          break;
        }
        // Accept the highlighted "proceed" option in Claude's plan prompt.
        entry.terminal.sendText('\r', false);
        const edited = Array.isArray(message.edited) ? message.edited : null;
        if (edited && edited.length) {
          const revised = 'Use this revised plan:\n' +
            edited.map((s: { n: number; text: string }) => `${s.n}. ${s.text}`).join('\n');
          setTimeout(() => {
            entry.terminal.sendText(revised, false);
            entry.terminal.sendText('\r', false);
          }, 600);
        }
        break;
      }
      // Plan-review: send the plan back with a note (keep planning).
      case 'sendBackPlan': {
        const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
        const note = typeof message.note === 'string' ? message.note.trim() : '';
        const entry = terminals.getAllTerminals().find((t) => t.sessionId === sessionId);
        if (!entry) {
          vscode.window.showErrorMessage(`Send back plan: no live agent for session ${sessionId}`);
          break;
        }
        const text = note || 'Keep planning — revise the plan before proceeding.';
        entry.terminal.sendText(text, false);
        entry.terminal.sendText('\r', false);
        break;
      }
      // Reassign: spawn `toAgent` with the same task context the original was
      // dispatched with (reused from the captured dispatch policy).
      case 'reassignAgent': {
        const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
        const toAgent = typeof message.toAgent === 'string' ? message.toAgent : '';
        const policy = dispatchSessionPolicies.get(sessionId);
        if (!policy) {
          vscode.window.showErrorMessage(`Reassign: no captured task context for session ${sessionId}`);
          break;
        }
        const def = getBuiltInByKey(toAgent);
        if (!def) {
          vscode.window.showErrorMessage(`Reassign: unknown agent "${toAgent}"`);
          break;
        }
        const agentConfig = configFromDef(context.extensionPath, def);
        const preSessionId = toAgent === 'claude' && policy.mode === 'plan' ? generateClaudeSessionId() : undefined;
        const result = await openSingleAgentWithQueue(context, agentConfig, [policy.prompt], {
          ...(policy.cwd ? { cwd: policy.cwd } : {}),
          mode: policy.mode,
          ...(preSessionId ? { sessionId: preSessionId } : {}),
        });
        if (result.sessionId) {
          dispatchSessionPolicies.set(result.sessionId, { ...policy, agentId: result.terminalId });
          if (toAgent === 'claude' && policy.mode === 'plan') {
            watchForPlan(
              result.sessionId,
              result.terminalId,
              policy.cwd || (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()),
              policy.notify,
            );
          }
        }
        break;
      }
      // Nudge a running agent to keep going (manual Floor action).
      case 'nudgeAgent': {
        const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
        if (!sessionId) {
          vscode.window.showErrorMessage('Nudge: missing session id');
          break;
        }
        const res = await nudgeSession(
          sessionId,
          'Continue — what is the current status? If you are stuck, say why.',
          'dispatch-nudge',
        );
        if (!res.success) {
          vscode.window.showErrorMessage(`Nudge failed: ${res.error ?? 'unknown error'}`);
        }
        break;
      }
      case 'spawnAgentForTask': {
        const task = message.task as {
          title: string;
          description?: string;
          metadata?: { identifier?: string; url?: string; repo?: string };
        } | undefined;
        if (!task || !task.title) break;

        const prompt = buildTaskDispatchPrompt({
          title: task.title,
          description: task.description,
          identifier: task.metadata?.identifier,
          url: task.metadata?.url,
        });

        const defaultTitle = context.globalState.get<string>('agents.defaultAgentTitle', CLAUDE_TITLE);
        const agentConfig = getBuiltInByTitle(context.extensionPath, defaultTitle)
          ?? getBuiltInByTitle(context.extensionPath, CLAUDE_TITLE);
        if (!agentConfig) {
          vscode.window.showErrorMessage('Could not find default agent configuration');
          break;
        }

        const taskCwd = task.metadata?.repo ? await resolveLocalRepoPath(task.metadata.repo) : null;
        await openSingleAgentWithQueue(context, agentConfig, [prompt], taskCwd ? { cwd: taskCwd } : undefined);
        break;
      }
      case 'openSession':
        // Open session file in editor
        if (message.session?.path) {
          const sessionUri = vscode.Uri.file(message.session.path);
          vscode.window.showTextDocument(sessionUri, { preview: true });
        }
        break;
      case 'checkLinearAuth': {
        try {
          const { isLinearAvailable } = await import('./linear.vscode');
          const connected = await isLinearAvailable(context);
          settingsPanel?.webview.postMessage({ type: 'integrationStatus', provider: 'linear', connected });
        } catch {
          settingsPanel?.webview.postMessage({ type: 'integrationStatus', provider: 'linear', connected: false });
        }
        break;
      }


      case 'getPrewarmStatus':
        settingsPanel?.webview.postMessage({
          type: 'prewarmStatus',
          enabled: false,
          pools: []
        });
        break;
      case 'togglePrewarm':
        vscode.window.showInformationMessage('Session warming is no longer used. Session IDs are discovered after launch.');
        settingsPanel?.webview.postMessage({
          type: 'prewarmStatus',
          enabled: false,
          pools: []
        });
        break;
      case 'getWorkspaceConfig':
        const wsFolder = workspaceConfig.getActiveWorkspaceFolder();
        if (wsFolder) {
          const exists = workspaceConfig.configExists(wsFolder);
          const userExists = workspaceConfig.userConfigExists();
          const config = exists ? await workspaceConfig.loadWorkspaceConfig(wsFolder) : null;
          settingsPanel?.webview.postMessage({
            type: 'workspaceConfigData',
            config,
            exists,
            userExists
          });
        } else {
          settingsPanel?.webview.postMessage({
            type: 'workspaceConfigData',
            config: null,
            exists: false,
            userExists: workspaceConfig.userConfigExists()
          });
        }
        break;
      case 'saveWorkspaceConfig':
        const saveWsFolder = workspaceConfig.getActiveWorkspaceFolder();
        if (saveWsFolder && message.config) {
          await workspaceConfig.saveWorkspaceConfig(saveWsFolder, message.config);
          // Trigger symlink re-creation after config save
          const mergedConfig = await workspaceConfig.loadWorkspaceConfig(saveWsFolder);
          await createSymlinksCodebaseWide(saveWsFolder, mergedConfig);
          settingsPanel?.webview.postMessage({
            type: 'workspaceConfigData',
            config: message.config,
            exists: true,
            userExists: workspaceConfig.userConfigExists()
          });
        }
        break;
      case 'initWorkspaceConfig':
        const initWsFolder = workspaceConfig.getActiveWorkspaceFolder();
        if (initWsFolder) {
          const newConfig = await workspaceConfig.initWorkspaceConfig(initWsFolder);
          if (newConfig) {
            const mergedConfig = await workspaceConfig.loadWorkspaceConfig(initWsFolder);
            await createSymlinksCodebaseWide(initWsFolder, mergedConfig);
          }
          settingsPanel?.webview.postMessage({
            type: 'workspaceConfigData',
            config: newConfig,
            exists: true,
            userExists: workspaceConfig.userConfigExists()
          });
        }
        break;
      case 'fetchContextFiles':
        try {
          const contextWsFolder = workspaceConfig.getActiveWorkspaceFolder();
          if (contextWsFolder) {
            const contextFiles = await scanMemoryFiles(contextWsFolder.uri.fsPath);
            settingsPanel?.webview.postMessage({ type: 'contextFilesData', files: contextFiles });
          } else {
            settingsPanel?.webview.postMessage({ type: 'contextFilesData', files: [] });
          }
        } catch (err) {
          console.error('[SETTINGS] Error fetching context files:', err);
          settingsPanel?.webview.postMessage({ type: 'contextFilesData', files: [] });
        }
        break;
      case 'openContextFile':
        if (message.path) {
          const ctxWsFolder = workspaceConfig.getActiveWorkspaceFolder();
          if (ctxWsFolder) {
            const fileUri = vscode.Uri.file(path.join(ctxWsFolder.uri.fsPath, message.path));
            vscode.window.showTextDocument(fileUri, { preview: true });
          }
        }
        break;
      case 'openTerminalFile':
        if (message.path) {
          await openFileOrDiffInEditor(message.path);
        }
        break;
      case 'revealFolder':
        if (message.path) {
          try {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(message.path));
          } catch {
            await vscode.env.openExternal(vscode.Uri.file(message.path));
          }
        }
        break;
      case 'openSourceControl':
        await vscode.commands.executeCommand('workbench.view.scm');
        break;
      case 'fetchAllTerminals': {
        const allWs = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        settingsPanel?.webview.postMessage({
          type: 'allTerminalsData',
          terminals: await terminals.getFloorTerminalDetails(allWs),
        });
        break;
      }
      case 'focusTerminal': {
        const entry = terminals.getById(message.terminalId);
        entry?.terminal.show(false);
        break;
      }
      case 'focusRemoteSession': {
        // Open a terminal attached to a remote (or local-but-tabless) agent's tmux
        // session, so a cross-host card can be "focused in a new terminal" the same
        // way a local tab can. Reuses the tmux socket the reply channel already knows
        // (ReplyTarget.muxSocket); ssh -t for a remote host, direct tmux locally.
        const host = typeof message.host === 'string' && message.host !== 'this-mac' ? message.host : '';
        const socket = typeof message.muxSocket === 'string' ? message.muxSocket : '';
        const label = typeof message.label === 'string' && message.label ? message.label : 'session';
        if (!socket) { break; }
        const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
        const attach = `tmux -S ${shq(socket)} attach`;
        const cmd = host ? `ssh -t ${shq(host)} ${shq(attach)}` : attach;
        const term = vscode.window.createTerminal({ name: `attach ${label}` });
        term.sendText(cmd, true);
        term.show(false);
        break;
      }
      case 'revealWorktree': {
        // Reveal a local worktree in the Explorer; a remote worktree can't be shown in
        // this window's file tree, so copy its path (silent, no toast).
        const p = typeof message.path === 'string' ? message.path : '';
        const host = typeof message.host === 'string' && message.host !== 'this-mac' ? message.host : '';
        if (!p) { break; }
        if (host) {
          await vscode.env.clipboard.writeText(p);
        } else {
          await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(p));
        }
        break;
      }
      case 'focusRushCloudTerminal': {
        // Used by the Factory Floor's "dispatch timed out" banner — jumps
        // the user to the cloud terminal so they can read the actual error.
        if (rushCloudTerminal && rushCloudTerminal.exitStatus === undefined) {
          rushCloudTerminal.show(true);
        } else {
          vscode.window.showInformationMessage(
            'Rush Cloud terminal is not open. Dispatch a task to see cloud logs.',
          );
        }
        break;
      }
      case 'executeCommand':
        if (message.command && typeof message.command === 'string') {
          await vscode.commands.executeCommand(message.command);
        }
        break;
      case 'getWatchdogStatus': {
        const enabled = vscode.workspace.getConfiguration('agents.watchdog').get<boolean>('enabled', false);
        settingsPanel?.webview.postMessage({ type: 'watchdogStatus', enabled });
        break;
      }
      case 'setWatchdogEnabled': {
        const next = !!message.value;
        await vscode.workspace.getConfiguration('agents.watchdog').update('enabled', next, vscode.ConfigurationTarget.Global);
        settingsPanel?.webview.postMessage({ type: 'watchdogStatus', enabled: next });
        break;
      }
      case 'getWatchdogLog': {
        try {
          const text = fs.readFileSync(WATCHDOG_LOG_PATH, 'utf8');
          settingsPanel?.webview.postMessage({ type: 'watchdogLogData', events: parseEvents(text) });
        } catch {
          settingsPanel?.webview.postMessage({ type: 'watchdogLogData', events: [] });
        }
        break;
      }
      case 'getWatchdogPlaybookStatus': {
        settingsPanel?.webview.postMessage({
          type: 'watchdogPlaybookStatus',
          status: getWatchdogPlaybookStatus(),
        });
        break;
      }
      case 'openWatchdogPlaybook': {
        ensureWatchdogPlaybookScaffold();
        const uri = vscode.Uri.file(WATCHDOG_PLAYBOOK_PATH);
        // Open in the TipTap markdown editor when the user has it enabled
        // (matches openGuide); fall back to the plain text editor otherwise.
        const markdownViewerEnabled =
          getSettings(context).editor?.markdownViewerEnabled ?? true;
        if (markdownViewerEnabled) {
          await vscode.commands.executeCommand('vscode.openWith', uri, 'agents.markdownEditor');
        } else {
          await vscode.window.showTextDocument(uri, { preview: false });
        }
        settingsPanel?.webview.postMessage({
          type: 'watchdogPlaybookStatus',
          status: getWatchdogPlaybookStatus(),
        });
        break;
      }
      case 'retrySwarm':
      case 'killSwarm':
      case 'clearCompletedSwarms':
        vscode.window.showInformationMessage(
          message.type === 'retrySwarm'
            ? 'Retry swarm is coming soon. Dispatch a new one via /swarm for now.'
            : message.type === 'killSwarm'
              ? 'Killing swarms from the dashboard is coming soon.'
              : 'Clearing completed swarms will prune ~/.agents/swarm/agents — coming soon.'
        );
        break;
      case 'dispatchSwarm':
        await vscode.commands.executeCommand('agents.newTask');
        break;
      case 'dismissTask':
        if (message.taskId) {
          const currentDismissed = context.globalState.get<string[]>('agents.dismissedTaskIds', []);
          if (!currentDismissed.includes(message.taskId)) {
            context.globalState.update('agents.dismissedTaskIds', [...currentDismissed, message.taskId]);
          }
        }
        break;
      case 'openExternal':
        if (message.url) {
          vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        break;
      // Focus a session — open/attach a real terminal on it (handles the headless
      // "open it and step in" case). Delegates to `agents sessions focus <id>`.
      case 'focusSession': {
        const sessionId = typeof message.sessionId === 'string' ? message.sessionId.trim() : '';
        if (!sessionId) break;
        focusSessionInTerminal(sessionId);
        break;
      }
      // Stop a background (headless) run by killing its pid — sends it back to parked
      // (the transcript survives; it stays resumable via Focus / sessions resume).
      case 'stopSession': {
        const pid = typeof message.pid === 'number' ? message.pid : 0;
        if (pid > 1) {
          try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
        }
        break;
      }
      case 'quickSpawn': {
        const prompt = typeof message.prompt === 'string' ? message.prompt.trim() : '';
        if (prompt) {
          const agent = typeof message.agent === 'string' ? message.agent : undefined;
          const target = typeof message.target === 'string' ? message.target : undefined;
          const repos: string[] = Array.isArray(message.repos)
            ? message.repos.filter((r: unknown): r is string => typeof r === 'string')
            : [];
          await spawnAgentForForeman(context, { prompt, agent, target, repos });
        }
        break;
      }
      case 'factoryAnswer':
        // Forward an intake answer to the oldest input_required teammate in
        // the given team via `agents factory answer <team> <text>`. Run in a
        // terminal so output is visible and failures are obvious — matches
        // the UX of other CLI dispatches from the dashboard.
        if (typeof message.teamId === 'string' && typeof message.text === 'string' && message.text.trim()) {
          const term = vscode.window.createTerminal({
            name: `Factory answer - ${message.teamId}`,
            env: buildAgentTerminalEnv(terminals.nextId('SH'), null),
          });
          const escaped = message.text.replace(/"/g, '\\"').replace(/\$/g, '\\$');
          term.sendText(`agents factory answer "${message.teamId}" "${escaped}"`, true);
          term.show();
        }
        break;
      case 'replyToAgent': {
        // Deliver a user reply INTO a running agent, routed by the reply channel the
        // adapter computed for it (floorModel.ReplyTarget): a live terminal tab gets
        // sendText; a cloud task gets `agents cloud message`; a team gets `agents
        // factory answer`; anything else has no injectable channel. Cloud/team commands
        // ssh to the owning host when it isn't this machine. Result rides back as
        // 'replyResult' so the webview shows an inline error on failure (never a toast).
        const reply = (message.reply || {}) as {
          kind?: string; host?: string; terminalId?: string;
          muxSocket?: string; muxTarget?: string;
          cloudTaskId?: string; teamName?: string; reason?: string;
        };
        const replyAgentId = typeof message.agentId === 'string' ? message.agentId : '';
        const replyText = typeof message.text === 'string' ? message.text.trim() : '';
        // For an interactive select-list prompt (permission / plan / AskUserQuestion)
        // the agent wants a SELECTION KEYSTROKE, not the option label it would ignore:
        // a digit ('1'…) picks + confirms, 'esc' cancels/denies. Sent only for the
        // terminal + tmux rails (cloud/team are semantic-message APIs and take the label).
        const keystroke = typeof message.keystroke === 'string' ? message.keystroke.trim() : '';
        const postReplyResult = (ok: boolean, error?: string) =>
          settingsPanel?.webview.postMessage({ type: 'replyResult', agentId: replyAgentId, ok, error });
        // Single-quote for the shell (runAgents/ssh run via a shell string).
        const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
        const replyHost = reply.host && reply.host !== 'this-mac' ? reply.host : '';
        if (!replyText) { postReplyResult(false, 'Reply text is empty'); break; }
        try {
          if (reply.kind === 'terminal') {
            const term = terminals.getAllTerminals().find((t) => t.id === reply.terminalId);
            if (!term) { postReplyResult(false, 'Terminal not found — it may have closed'); break; }
            if (keystroke) {
              // Select-list prompt: 'esc' cancels/denies (no CR); a digit selects then
              // confirms with CR. Uses the same sendText rail the free-text reply does.
              if (keystroke === 'esc') {
                term.terminal.sendText('\x1b', false);
              } else {
                term.terminal.sendText(keystroke, false);
                term.terminal.sendText('\r', false);
              }
            } else if (term.agentType === 'claude') {
              // Claude's Ink TUI needs an explicit CR; other agents take a newline.
              term.terminal.sendText(replyText, false);
              term.terminal.sendText('\r', false);
            } else {
              term.terminal.sendText(replyText, true);
            }
            term.terminal.show();
            postReplyResult(true);
          } else if (reply.kind === 'tmux') {
            // Drive the agent's tmux pane: literal text, then Enter (matches the
            // Ink-friendly text-then-CR local path). Local runs tmux directly; a
            // remote host runs it over ssh. ssh flattens argv into one remote shell
            // string, so the remote command must be single-quoted piece by piece.
            if (!reply.muxSocket || !reply.muxTarget) { postReplyResult(false, 'Missing tmux socket/pane'); break; }
            const sendKeys = async (keyArgs: string[]) => {
              if (replyHost) {
                const remote = ['tmux', '-S', reply.muxSocket!, 'send-keys', '-t', reply.muxTarget!, ...keyArgs]
                  .map(shq).join(' ');
                await execFileAsync('ssh', [replyHost, remote], { timeout: 20_000 });
              } else {
                await execFileAsync('tmux', ['-S', reply.muxSocket!, 'send-keys', '-t', reply.muxTarget!, ...keyArgs], { timeout: 20_000 });
              }
            };
            if (keystroke) {
              // Select-list prompt over tmux: 'esc' sends the Escape key (cancel/deny);
              // a digit sends the literal digit then Enter to confirm.
              if (keystroke === 'esc') {
                await sendKeys(['Escape']);
              } else {
                await sendKeys(['-l', '--', keystroke]);
                await sendKeys(['Enter']);
              }
            } else {
              await sendKeys(['-l', '--', replyText]);
              await sendKeys(['Enter']);
            }
            postReplyResult(true);
          } else if (reply.kind === 'cloud') {
            if (!reply.cloudTaskId) { postReplyResult(false, 'Missing cloud task id'); break; }
            const args = `cloud message ${shq(reply.cloudTaskId)} ${shq(replyText)}`;
            if (replyHost) await execFileAsync('ssh', [replyHost, 'agents', 'cloud', 'message', reply.cloudTaskId, replyText], { timeout: 30_000 });
            else await runAgents(args);
            postReplyResult(true);
          } else if (reply.kind === 'team') {
            if (!reply.teamName) { postReplyResult(false, 'Missing team name'); break; }
            if (replyHost) await execFileAsync('ssh', [replyHost, 'agents', 'factory', 'answer', reply.teamName, replyText], { timeout: 30_000 });
            else await runAgents(`factory answer ${shq(reply.teamName)} ${shq(replyText)}`);
            postReplyResult(true);
          } else {
            postReplyResult(false, reply.reason || 'No reply channel for this agent');
          }
        } catch (err) {
          postReplyResult(false, err instanceof Error ? err.message : String(err));
        }
        break;
      }
      case 'factoryConfigRead':
        settingsPanel?.webview.postMessage({
          type: 'factoryConfigData',
          config: await readFactoryConfigSafe(),
        });
        break;
      case 'factoryConfigWrite':
        if (message.config && typeof message.config === 'object') {
          const updated = await writeFactoryConfigSafe(message.config as Record<string, unknown>);
          settingsPanel?.webview.postMessage({ type: 'factoryConfigData', config: updated });
        }
        break;
      case 'foreman.startSession': {
        if (foremanSession) {
          foremanSession.close();
          foremanSession = undefined;
        }
        // Generation guard: a quick push-to-talk release can deliver
        // foreman.stopSession while startForemanAudio is still awaiting the
        // WS handshake. The stop bumps the generation so the late-arriving
        // session is closed instead of orphaned (mic + WS leak).
        const gen = ++foremanSessionGen;
        try {
          const apiKey = foreman.getOpenAIApiKey();
          if (!apiKey) throw new Error('OpenAI API key not configured. Set agents.openaiApiKey in Settings.');
          const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const session = await startForemanAudio(apiKey, {
            onStatus: (status, detail) => {
              settingsPanel?.webview.postMessage({ type: 'foreman.status', status, detail });
            },
            onTranscript: (role, text, final, itemId) => {
              settingsPanel?.webview.postMessage({ type: 'foreman.transcript', role, text, final, itemId });
            },
            onEvent: (eventType, summary) => {
              settingsPanel?.webview.postMessage({ type: 'foreman.event', eventType, summary, at: Date.now() });
            },
            onToolCall: async (callId, name, args) => {
              try {
                const result = await foreman.runForemanTool(name, args, wsFolder, buildForemanToolDeps(context));
                foremanSession?.sendToolResult(callId, result);
              } catch (err: any) {
                foremanSession?.sendToolResult(callId, { error: err?.message ?? String(err) });
              }
            },
          }, { speakerMuted: message.speakerMuted === true });
          if (gen !== foremanSessionGen) {
            session.close();
            break;
          }
          foremanSession = session;
        } catch (err: any) {
          settingsPanel?.webview.postMessage({
            type: 'foreman.status',
            status: 'error',
            detail: err?.message ?? String(err),
          });
        }
        break;
      }
      case 'foreman.stopSession': {
        foremanSessionGen++;
        foremanSession?.close();
        foremanSession = undefined;
        break;
      }
      case 'foreman.setSpeakerMuted': {
        foremanSession?.setSpeakerMuted(message.muted === true);
        break;
      }
      case 'foreman.deleteItem': {
        if (typeof message.itemId === 'string' && message.itemId) {
          foremanSession?.deleteItem(message.itemId);
        }
        break;
      }
      // Smart mode: one turn-based text prompt (typed, or dictated via the
      // user's Superwhisper) -> OpenAI text brain + the SAME Foreman tools ->
      // streamed text answer. Reuses the foreman.transcript event path so the
      // orb renders it exactly like a spoken reply, no new UI plumbing.
      case 'foreman.smartTurn': {
        const text = typeof message.text === 'string' ? message.text.trim() : '';
        if (!text) break;
        foremanSmartAbort?.abort();
        const ac = new AbortController();
        foremanSmartAbort = ac;
        try {
          const apiKey = foreman.getOpenAIApiKey();
          if (!apiKey) throw new Error('OpenAI API key not configured. Set agents.openaiApiKey in Settings.');
          const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          settingsPanel?.webview.postMessage({ type: 'foreman.transcript', role: 'user', text, final: true });
          const { text: answer, history } = await runSmartTurn({
            apiKey,
            history: foremanSmartHistory,
            userText: text,
            runTool: (name, args) => foreman.runForemanTool(name, args, wsFolder, buildForemanToolDeps(context)),
            signal: ac.signal,
            events: {
              // Guard on abort so a straggler delta from a superseded turn
              // can't append into the next turn's transcript line.
              onText: (delta) => { if (!ac.signal.aborted) settingsPanel?.webview.postMessage({ type: 'foreman.transcript', role: 'assistant', text: delta, final: false }); },
              onToolCall: (name) => settingsPanel?.webview.postMessage({ type: 'foreman.event', eventType: 'smart.tool', summary: name, at: Date.now() }),
              onStatus: (status, detail) => settingsPanel?.webview.postMessage({ type: 'foreman.event', eventType: `smart.${status}`, summary: detail ?? '', at: Date.now() }),
            },
          });
          if (ac.signal.aborted) break;
          // Replace the streamed partial with the clean final line.
          settingsPanel?.webview.postMessage({ type: 'foreman.transcript', role: 'assistant', text: answer, final: true });
          // Cap on a safe turn boundary so the window never begins on a
          // dangling tool message (which would 400 the next turn).
          foremanSmartHistory = capHistory(history, 24);
        } catch (err: any) {
          if (!ac.signal.aborted) {
            settingsPanel?.webview.postMessage({ type: 'foreman.status', status: 'error', detail: err?.message ?? String(err) });
          }
        }
        break;
      }
    }
  }, undefined, context.subscriptions);

  // Debounce terminal updates to avoid excessive webview messages
  let terminalUpdateTimeout: ReturnType<typeof setTimeout> | undefined;
  const debouncedTerminalUpdate = () => {
    if (terminalUpdateTimeout) clearTimeout(terminalUpdateTimeout);
    terminalUpdateTimeout = setTimeout(async () => {
      if (settingsPanel) {
        const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const counts = terminals.countRunning();
        if (settingsPanel) {
          settingsPanel.webview.postMessage({
            type: 'updateRunningCounts',
            counts,
          });
        }
        await pushSubscribedAgentTerminalUpdate(wsPath);

        // Push updated allTerminals and tasks for Floor tab
        if (settingsPanel) {
          settingsPanel?.webview.postMessage({
            type: 'allTerminalsData',
            terminals: await terminals.getFloorTerminalDetails(wsPath),
          });

          const updatedTasks = await swarm.fetchTasks(undefined, wsPath);
          settingsPanel?.webview.postMessage({ type: 'tasksData', tasks: updatedTasks });
        }
      }
    }, 500);
  };

  // Update running counts when terminals change (debounced)
  const terminalListener = vscode.window.onDidOpenTerminal(debouncedTerminalUpdate);
  const terminalCloseListener = vscode.window.onDidCloseTerminal(debouncedTerminalUpdate);

  // Push a fresh playbook status whenever the user saves the watchdog playbook
  // so the Panel card's "edited Xs ago" stays accurate without manual refresh.
  const playbookSaveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (doc.uri.fsPath === WATCHDOG_PLAYBOOK_PATH) {
      settingsPanel?.webview.postMessage({
        type: 'watchdogPlaybookStatus',
        status: getWatchdogPlaybookStatus(),
      });
    }
  });

  // Pause webview polling when the panel is hidden behind another tab.
  // retainContextWhenHidden keeps the React tree alive so it can re-render
  // instantly on focus, but its setInterval-driven fetches don't need to
  // keep hitting the network/disk when the user can't see the result.
  const visibilityListener = settingsPanel.onDidChangeViewState((e) => {
    settingsPanel?.webview.postMessage({
      type: 'panelVisibility',
      visible: e.webviewPanel.visible,
    });
  });

  settingsPanel.onDidDispose(() => {
    settingsPanel = undefined;
    terminalListener.dispose();
    terminalCloseListener.dispose();
    playbookSaveListener.dispose();
    visibilityListener.dispose();
    if (terminalUpdateTimeout) clearTimeout(terminalUpdateTimeout);
    cleanupSessionWatchers();
    cleanupFloorWatchers();
    swarm.setCloudUpdateListener(null);
    swarm.stopAllCloudStreams();
    // Foreman owns ffmpeg/ffplay child processes and an OpenAI Realtime
    // WebSocket. The orb's React unmount cleanup doesn't reliably run when
    // the whole webview is destroyed, so close the session here.
    if (foremanSession) {
      foremanSession.close();
      foremanSession = undefined;
    }
  }, undefined, context.subscriptions);
}

// Open guide in markdown preview
function openGuide(context: vscode.ExtensionContext, guide: string): void {
  const guideFiles: Record<string, string> = {
    'getting-started': 'getting-started.md',
    'swarm': 'swarm-guide.md'
  };

  const filename = guideFiles[guide];
  if (!filename) {
    vscode.window.showErrorMessage(`Unknown guide: ${guide}`);
    return;
  }

  const guidePath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'guides', filename);

  // Check if file exists, if not show info message
  vscode.workspace.fs.stat(guidePath).then(
    () => {
      const markdownViewerEnabled =
        getSettings(context).editor?.markdownViewerEnabled ?? true;
      if (markdownViewerEnabled) {
        vscode.commands.executeCommand(
          'vscode.openWith',
          guidePath,
          'agents.markdownEditor'
        );
      } else {
        vscode.window.showTextDocument(guidePath, { preview: true });
      }
    },
    () => {
      // File doesn't exist yet - show info message
      vscode.window.showInformationMessage(
        `Guide "${guide}" is coming soon. Check our GitHub for documentation.`,
        'Open GitHub'
      ).then(selection => {
        if (selection === 'Open GitHub') {
          vscode.env.openExternal(
            vscode.Uri.parse('https://github.com/phnx-labs/agents-cli')
          );
        }
      });
    }
  );
}

// Update titles of existing agent terminals when display preferences change
async function maybeUpdateTerminalTitles(oldSettings: AgentSettings, newSettings: AgentSettings): Promise<void> {
  const oldDisplay = oldSettings.display ?? DEFAULT_DISPLAY_PREFERENCES;
  const newDisplay = newSettings.display ?? DEFAULT_DISPLAY_PREFERENCES;

  const changed =
    oldDisplay.showFullAgentNames !== newDisplay.showFullAgentNames ||
    oldDisplay.showLabelsInTitles !== newDisplay.showLabelsInTitles ||
    oldDisplay.autoLabelInTabTitles !== newDisplay.autoLabelInTabTitles ||
    oldDisplay.showSessionIdInTitles !== newDisplay.showSessionIdInTitles ||
    oldDisplay.labelReplacesTitle !== newDisplay.labelReplacesTitle;

  if (!changed) return;

  // renameWithArg always targets the active terminal, so we must rename sequentially.
  // Remember what was active and restore it at the end so focus isn't disturbed.
  const previouslyActive = vscode.window.activeTerminal;

  for (const entry of terminals.getAllTerminals()) {
    const prefix = entry.agentConfig?.title || parseTerminalName(entry.terminal.name).prefix;
    if (!prefix) continue;

    const label = newDisplay.showLabelsInTitles
      ? (entry.label || (newDisplay.autoLabelInTabTitles ? entry.autoLabel : null))
      : null;
    const sessionChunk = newDisplay.showSessionIdInTitles ? getSessionChunk(entry.sessionId) : null;
    const newTitle = formatTerminalTitle(prefix, {
      label,
      display: newDisplay,
      sessionChunk: sessionChunk || null
    });
    await terminals.renameTerminal(entry.terminal, newTitle);
  }

  if (previouslyActive && previouslyActive.exitStatus === undefined) {
    previouslyActive.show(true);
  }
}

// Generate webview HTML content
function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'ui', 'settings', 'main.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'ui', 'settings', 'main.css'));

  // Get asset URIs for icons
  const claudeIcon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'claude.png'));
  const codexIcon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'chatgpt.png'));
  const codexIconLight = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'chatgpt-light.png'));
  const geminiIcon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'gemini.png'));
  const opencodeIcon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'opencode.png'));
  const cursorIcon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'cursor.png'));
  const cursorIconLight = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'cursor-light.png'));
  const agentsIcon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'agents.png'));
  const githubIcon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'github.png'));
  const antigravityIcon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'antigravity.png'));
  const grokIcon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'grok.png'));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <script>
    // Inject icon paths for the React app
    window.__ICONS__ = {
      claude: "${claudeIcon}",
      codex: { dark: "${codexIcon}", light: "${codexIconLight}" },
      gemini: "${geminiIcon}",
      opencode: "${opencodeIcon}",
      cursor: { dark: "${cursorIcon}", light: "${cursorIconLight}" },
      shell: "${agentsIcon}",
      agents: "${agentsIcon}",
      github: "${githubIcon}",
      antigravity: "${antigravityIcon}",
      grok: "${grokIcon}"
    };
  </script>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
