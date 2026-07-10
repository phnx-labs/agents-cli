// Swarm MCP configuration - VS Code dependent functions

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readTailLines } from './sessions.vscode';
import {
  AgentCli,
  PromptPackAgent,
  isAgentCliAvailable,
  isAgentMcpEnabled,
  isAgentCommandInstalled,
  getAgentCommandPath,
  getPromptPackCommandPath,
  isPromptPackTargetAvailable,
  isPromptPackInstalled,
  isAgentsCliAvailable,
  getAgentsCliVersion,
} from '../core/swarm.detect';

// Re-export for consumers that need the union type
export type { AgentCli } from '../core/swarm.detect';
export type { PromptPackAgent } from '../core/swarm.detect';
import { readRushTokenCached } from '../core/rushToken';
import { parseGhChecks, type CiStatus } from '../core/prChecks';
import { mapCloudStatus } from '../core/cloudStatus';

const execAsync = promisify(exec);

// PR CI status, polled via `gh pr checks`, cached per-PR. Drives self-promotion
// (a PR that goes green climbs into Needs You) and the CI badge. Non-blocking:
// getPrCiCached returns immediately and refreshes in the background, so the hot
// fetchTasks path never waits on a gh subprocess.
const CI_TTL_MS = 30000;
const ciCache = new Map<string, { at: number; status: CiStatus }>();
const ciInFlight = new Set<string>();

function refreshPrCi(prUrl: string): void {
  if (ciInFlight.has(prUrl)) return;
  ciInFlight.add(prUrl);
  execAsync(`gh pr checks ${JSON.stringify(prUrl)} --json bucket,state`, { timeout: 8000 })
    .then(({ stdout }) => ciCache.set(prUrl, { at: Date.now(), status: parseGhChecks(stdout) }))
    .catch((err: unknown) => {
      // gh exits non-zero when checks are pending (8) or failing (1) — the JSON is
      // still on stdout, so parse it. parseGhChecks('') is null, so a genuinely
      // absent/erroring gh records null (and the TTL still lets it retry later).
      const out = err && typeof (err as { stdout?: unknown }).stdout === 'string' ? (err as { stdout: string }).stdout : '';
      ciCache.set(prUrl, { at: Date.now(), status: parseGhChecks(out) });
    })
    .finally(() => ciInFlight.delete(prUrl));
}

function getPrCiCached(prUrl: string | null | undefined): CiStatus {
  if (!prUrl) return null;
  const cached = ciCache.get(prUrl);
  if (!cached || Date.now() - cached.at > CI_TTL_MS) refreshPrCi(prUrl);
  return cached ? cached.status : null;
}

// Agent data directories
// agents-cli teams writes to ~/.agents/teams/agents/
// Legacy ~/.agents/swarm/agents/ kept as a read source for older installs.
const AGENT_SWARM_DIR = path.join(os.homedir(), '.agents', 'swarm', 'agents');
const AGENT_TEAMS_DIR = path.join(os.homedir(), '.agents', 'teams', 'agents');


export interface AgentInstallStatus {
  installed: boolean;
  cliAvailable: boolean;
  mcpEnabled: boolean;
  commandInstalled: boolean;
}

export interface SwarmStatus {
  agentsCliAvailable: boolean;
  agentsCliVersion: string | null;
  mcpEnabled: boolean;
  commandInstalled: boolean;
  agents: {
    claude: AgentInstallStatus;
    codex: AgentInstallStatus;
    gemini: AgentInstallStatus;
    opencode: AgentInstallStatus;
  };
}

export type SkillName =
  | 'plan'
  | 'splan'
  | 'debug'
  | 'sdebug'
  | 'sconfirm'
  | 'clean'
  | 'sclean'
  | 'test'
  | 'stest'
  | 'ship'
  | 'sship'
  | 'recap'
  | 'srecap'
  | 'simagine';

export interface SkillDefinition {
  name: SkillName;
  description: string;
  assets: {
    claude?: string | 'builtin';
    codex?: string;
    cursor?: string;
    gemini?: string;
  };
}

export interface SkillAgentStatus {
  installed: boolean;
  cliAvailable: boolean;
  builtIn: boolean;
  supported: boolean;
}

export interface SkillsStatus {
  commands: Array<{
    name: SkillName;
    description: string;
    agents: Record<PromptPackAgent, SkillAgentStatus>;
  }>;
}

const SKILL_DEFS: SkillDefinition[] = [
  {
    name: 'plan',
    description: 'Create a concise implementation plan',
    assets: { claude: 'builtin', codex: 'plan.md', gemini: 'plan.toml' },
  },
  {
    name: 'splan',
    description: 'Sprint-sized plan with parallel steps',
    assets: { claude: 'splan.md', codex: 'splan.md', cursor: 'splan.md', gemini: 'splan.toml' },
  },
  {
    name: 'debug',
    description: 'Diagnose the root cause before fixing',
    assets: { claude: 'debug.md', codex: 'debug.md', cursor: 'debug.md', gemini: 'debug.toml' },
  },
  {
    name: 'sdebug',
    description: 'Parallelize the debugging investigation',
    assets: { claude: 'sdebug.md', codex: 'sdebug.md', cursor: 'sdebug.md', gemini: 'sdebug.toml' },
  },
  {
    name: 'sconfirm',
    description: 'Confirm with parallel checks',
    assets: { claude: 'sconfirm.md', codex: 'sconfirm.md', cursor: 'sconfirm.md', gemini: 'sconfirm.toml' },
  },
  {
    name: 'clean',
    description: 'Refactor safely for clarity',
    assets: { claude: 'clean.md', codex: 'clean.md', cursor: 'clean.md', gemini: 'clean.toml' },
  },
  {
    name: 'sclean',
    description: 'Parallel refactor plan',
    assets: { claude: 'sclean.md', codex: 'sclean.md', cursor: 'sclean.md', gemini: 'sclean.toml' },
  },
  {
    name: 'test',
    description: 'Design a lean test plan',
    assets: { claude: 'test.md', codex: 'test.md', cursor: 'test.md', gemini: 'test.toml' },
  },
  {
    name: 'stest',
    description: 'Parallelize test creation',
    assets: { claude: 'stest.md', codex: 'stest.md', cursor: 'stest.md', gemini: 'stest.toml' },
  },
  {
    name: 'ship',
    description: 'Pre-launch verification',
    assets: { claude: 'ship.md', codex: 'ship.md', cursor: 'ship.md', gemini: 'ship.toml' },
  },
  {
    name: 'sship',
    description: 'Ship with independent assessment',
    assets: { claude: 'sship.md', codex: 'sship.md', cursor: 'sship.md', gemini: 'sship.toml' },
  },
  {
    name: 'recap',
    description: 'Facts + grounded hypotheses for handoff',
    assets: { claude: 'recap.md', codex: 'recap.md', cursor: 'recap.md', gemini: 'recap.toml' },
  },
  {
    name: 'srecap',
    description: 'Agents investigate gaps before handoff',
    assets: { claude: 'srecap.md', codex: 'srecap.md', cursor: 'srecap.md', gemini: 'srecap.toml' },
  },
  {
    name: 'simagine',
    description: 'Swarm visual asset prompting',
    assets: { codex: 'simagine.md' },
  },
];

// Get full swarm integration status (per-agent, not globally shared)
export async function getSwarmStatus(): Promise<SwarmStatus> {
  // Run ALL CLI availability checks in parallel (including agents-cli)
  const [
    agentsCliAvail,
    agentsCliVer,
    claudeCliAvailable,
    codexCliAvailable,
    geminiCliAvailable,
    opencodeCliAvailable,
  ] = await Promise.all([
    isAgentsCliAvailable(),
    getAgentsCliVersion(),
    isAgentCliAvailable('claude'),
    isAgentCliAvailable('codex'),
    isAgentCliAvailable('gemini'),
    isAgentCliAvailable('opencode'),
  ]);

  // Run MCP checks in parallel (only for available CLIs)
  const [claudeMcp, codexMcp, geminiMcp, opencodeMcp] = await Promise.all([
    claudeCliAvailable ? isAgentMcpEnabled('claude') : Promise.resolve(false),
    codexCliAvailable ? isAgentMcpEnabled('codex') : Promise.resolve(false),
    geminiCliAvailable ? isAgentMcpEnabled('gemini') : Promise.resolve(false),
    opencodeCliAvailable ? isAgentMcpEnabled('opencode') : Promise.resolve(false),
  ]);

  // Command checks are sync (fs.existsSync) - no need to parallelize
  const claudeCmd = claudeCliAvailable ? isAgentCommandInstalled('claude', 'swarm') : false;
  const codexCmd = codexCliAvailable ? isAgentCommandInstalled('codex', 'swarm') : false;
  const geminiCmd = geminiCliAvailable ? isAgentCommandInstalled('gemini', 'swarm') : false;
  const opencodeCmd = opencodeCliAvailable ? isAgentCommandInstalled('opencode', 'swarm') : false;

  const mcpEnabled = (!claudeCliAvailable || claudeMcp) &&
    (!codexCliAvailable || codexMcp) &&
    (!geminiCliAvailable || geminiMcp) &&
    (!opencodeCliAvailable || opencodeMcp);

  const commandInstalled = (!claudeCliAvailable || claudeCmd) &&
    (!codexCliAvailable || codexCmd) &&
    (!geminiCliAvailable || geminiCmd) &&
    (!opencodeCliAvailable || opencodeCmd);

  return {
    agentsCliAvailable: agentsCliAvail,
    agentsCliVersion: agentsCliVer,
    mcpEnabled,
    commandInstalled,
    agents: {
      claude: {
        installed: claudeMcp && claudeCmd && claudeCliAvailable,
        cliAvailable: claudeCliAvailable,
        mcpEnabled: claudeMcp,
        commandInstalled: claudeCmd,
      },
      codex: {
        installed: codexMcp && codexCmd && codexCliAvailable,
        cliAvailable: codexCliAvailable,
        mcpEnabled: codexMcp,
        commandInstalled: codexCmd,
      },
      gemini: {
        installed: geminiMcp && geminiCmd && geminiCliAvailable,
        cliAvailable: geminiCliAvailable,
        mcpEnabled: geminiMcp,
        commandInstalled: geminiCmd,
      },
      opencode: {
        installed: opencodeMcp && opencodeCmd && opencodeCliAvailable,
        cliAvailable: opencodeCliAvailable,
        mcpEnabled: opencodeMcp,
        commandInstalled: opencodeCmd,
      },
    },
  };
}

// Check if swarm is fully enabled (MCP registered and commands installed)
export async function isSwarmEnabled(): Promise<boolean> {
  const status = await getSwarmStatus();
  return status.mcpEnabled && status.commandInstalled;
}

export async function getSkillsStatus(): Promise<SkillsStatus> {
  const results: SkillsStatus['commands'] = [];

  // Run ALL availability checks in parallel
  const [claude, codex, gemini, cursor] = await Promise.all([
    isPromptPackTargetAvailable('claude'),
    isPromptPackTargetAvailable('codex'),
    isPromptPackTargetAvailable('gemini'),
    isPromptPackTargetAvailable('cursor'),
  ]);
  const availability = { claude, codex, gemini, cursor };

  for (const skill of SKILL_DEFS) {
    const claudeAsset = skill.assets.claude;
    const codexAsset = skill.assets.codex;
    const cursorAsset = skill.assets.cursor;
    const geminiAsset = skill.assets.gemini;

    const agents: Record<PromptPackAgent, SkillAgentStatus> = {
      claude: {
        cliAvailable: availability.claude,
        builtIn: claudeAsset === 'builtin',
        supported: !!claudeAsset,
        installed:
          claudeAsset === 'builtin' ||
          (!!claudeAsset && availability.claude && isPromptPackInstalled('claude', skill.name)),
      },
      codex: {
        cliAvailable: availability.codex,
        builtIn: false,
        supported: !!codexAsset,
        installed: !!codexAsset && availability.codex && isPromptPackInstalled('codex', skill.name),
      },
      cursor: {
        cliAvailable: availability.cursor,
        builtIn: false,
        supported: !!cursorAsset,
        installed: !!cursorAsset && availability.cursor && isPromptPackInstalled('cursor', skill.name),
      },
      gemini: {
        cliAvailable: availability.gemini,
        builtIn: false,
        supported: !!geminiAsset,
        installed: !!geminiAsset && availability.gemini && isPromptPackInstalled('gemini', skill.name),
      },
    };

    results.push({ name: skill.name, description: skill.description, agents });
  }

  return { commands: results };
}

export async function installSkillCommand(
  skill: SkillName,
  agent: PromptPackAgent,
  context: vscode.ExtensionContext
): Promise<boolean> {
  const def = SKILL_DEFS.find(s => s.name === skill);
  if (!def) return false;

  const assetName = def.assets[agent];
  if (!assetName) {
    vscode.window.showWarningMessage(`${skill} is not available for ${agent}.`);
    return false;
  }
  if (assetName === 'builtin') return true;

  const targetAvailable = await isPromptPackTargetAvailable(agent);
  if (!targetAvailable) {
    vscode.window.showWarningMessage(`${agent} not found. Install it first.`);
    return false;
  }

  const agentDir = agent === 'codex' ? 'prompts' : 'commands';
  const source = path.join(context.extensionPath, '..', 'prompts', agent, agentDir, assetName);
  if (!fs.existsSync(source)) {
    vscode.window.showErrorMessage(`Missing skill asset: ${assetName}`);
    return false;
  }

  const target = getPromptPackCommandPath(agent, skill);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    return true;
  } catch (err) {
    const error = err as Error;
    vscode.window.showErrorMessage(`Failed to install ${skill} for ${agent}: ${error.message}`);
    return false;
  }
}

// Build Gemini TOML command content from markdown source
function buildGeminiToml(markdown: string): string {
  return [
    'name = "swarm"',
    'description = "Run Swarm MCP tasks"',
    'prompt = """',
    markdown.trimEnd(),
    '"""',
    ''
  ].join('\n');
}

async function installPromptPacksForAgent(
  agent: PromptPackAgent,
  context: vscode.ExtensionContext
): Promise<string[]> {
  const installed: string[] = [];
  const targetAvailable = await isPromptPackTargetAvailable(agent);
  if (!targetAvailable) {
    return installed;
  }

  for (const skill of SKILL_DEFS) {
    const assetName = skill.assets[agent];
    if (!assetName || assetName === 'builtin') {
      continue;
    }

    const agentDir = agent === 'codex' ? 'prompts' : 'commands';
  const source = path.join(context.extensionPath, '..', 'prompts', agent, agentDir, assetName);
    if (!fs.existsSync(source)) {
      vscode.window.showErrorMessage(`Missing skill asset: ${assetName}`);
      continue;
    }

    if (isPromptPackInstalled(agent, skill.name)) {
      continue;
    }

    const target = getPromptPackCommandPath(agent, skill.name);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      installed.push(skill.name);
    } catch (err) {
      const error = err as Error;
      vscode.window.showErrorMessage(`Failed to install ${skill.name} for ${agent}: ${error.message}`);
    }
  }

  return installed;
}

function installSwarmCommandForPromptPackAgent(agent: PromptPackAgent, context: vscode.ExtensionContext): boolean {
  const agentDir = agent === 'codex' ? 'prompts' : 'commands';
  const extension = agent === 'gemini' ? 'toml' : 'md';
  const sourcePath = path.join(context.extensionPath, '..', 'prompts', agent, agentDir, `swarm.${extension}`);
  if (!fs.existsSync(sourcePath)) {
    return false;
  }

  const target = getPromptPackCommandPath(agent, 'swarm');
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(sourcePath, target);
    return true;
  } catch {
    return false;
  }
}

const AGENTS_CLI_PACKAGE = '@swarmify/agents-cli';

// Install agents-cli if not present
async function ensureAgentsCli(): Promise<boolean> {
  if (await isAgentsCliAvailable()) {
    return true;
  }

  try {
    vscode.window.showInformationMessage('Installing agents CLI...');
    await execAsync(`npm install -g ${AGENTS_CLI_PACKAGE}`);
    return true;
  } catch (err) {
    const error = err as Error & { stderr?: string };
    vscode.window.showErrorMessage(`Failed to install agents CLI: ${error.stderr || error.message}`);
    return false;
  }
}

// Setup agent using agents-cli pull command
async function setupWithAgentsCli(agent: AgentCli): Promise<boolean> {
  try {
    // Run agents pull with --yes to auto-confirm
    const { runAgents } = await import('../core/agentsBin');
    await runAgents(`pull ${agent} --yes`, { timeout: 120000 });
    return true;
  } catch (err) {
    const error = err as Error & { stderr?: string };
    vscode.window.showErrorMessage(`agents pull failed for ${agent}: ${error.stderr || error.message}`);
    return false;
  }
}

export async function setupSwarmIntegration(
  context: vscode.ExtensionContext,
  onUpdate?: (status: SwarmStatus) => void
): Promise<void> {
  await setupSwarmIntegrationForAgents(['claude', 'codex', 'gemini', 'opencode'], context, onUpdate);
}

export async function setupSwarmIntegrationForAgent(
  agent: AgentCli,
  context: vscode.ExtensionContext,
  onUpdate?: (status: SwarmStatus) => void
): Promise<void> {
  await setupSwarmIntegrationForAgents([agent], context, onUpdate);
}

export async function installCommandPack(context: vscode.ExtensionContext): Promise<void> {
  const promptPackAgents: PromptPackAgent[] = ['claude', 'codex', 'gemini', 'cursor'];
  for (const agent of promptPackAgents) {
    installSwarmCommandForPromptPackAgent(agent, context);
    await installPromptPacksForAgent(agent, context);
  }
}

async function setupSwarmIntegrationForAgents(
  agents: AgentCli[],
  context: vscode.ExtensionContext,
  onUpdate?: (status: SwarmStatus) => void
): Promise<void> {
  const sendStatus = async () => {
    if (onUpdate) {
      onUpdate(await getSwarmStatus());
    }
  };

  // Check if already enabled for all requested agents
  const status = await getSwarmStatus();
  const allReady = agents.every((a) => {
    const s = status.agents[a];
    return s.cliAvailable ? (s.mcpEnabled && s.commandInstalled) : false;
  });
  if (allReady) {
    await sendStatus();
    vscode.window.showInformationMessage('Swarm is already enabled.');
    return;
  }

  // Ensure agents-cli is installed (auto-install if needed)
  const agentsCliReady = await ensureAgentsCli();
  if (!agentsCliReady) {
    vscode.window.showErrorMessage('Failed to install agents CLI. Run: npm install -g @swarmify/agents-cli');
    return;
  }

  // Use agents-cli to setup each agent
  const configured: string[] = [];
  const failed: string[] = [];

  for (const agent of agents) {
    // Skip agents without CLI installed (agents pull requires the CLI to be present)
    const agentStatus = status.agents[agent];
    if (!agentStatus.cliAvailable) {
      continue;
    }

    const ok = await setupWithAgentsCli(agent);
    if (ok) {
      configured.push(agent.charAt(0).toUpperCase() + agent.slice(1));
    } else {
      failed.push(agent);
    }
    await sendStatus();
  }

  if (configured.length > 0) {
    vscode.window.showInformationMessage(`Configured ${configured.join(', ')} via agents CLI. Reload your IDE agents.`);
  }
  if (failed.length > 0 && configured.length === 0) {
    vscode.window.showWarningMessage('Setup failed. Check that agent CLIs are installed.');
  }
  await sendStatus();
}


// Types for task listing
export interface AgentMeta {
  agent_id: string;
  task_name: string;
  agent_type: string;
  prompt: string;
  cwd: string | null;
  mode: string;
  pid: number | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  cloud_session_id?: string | null;
  cloud_provider?: string | null;
  pr_url?: string | null;
}

export interface AgentDetail {
  agent_id: string;
  agent_type: string;
  status: string;
  duration: string | null;
  started_at: string;
  completed_at: string | null;
  prompt: string;
  cwd: string | null;
  mode?: string;
  files_created: string[];
  files_modified: string[];
  files_deleted: string[];
  bash_commands: string[];
  last_messages: string[];
  cloud_session_id?: string | null;
  cloud_provider?: string | null;
  pr_url?: string | null;
  ci_status?: CiStatus | null;
  repo_owner?: string | null;
  repo_name?: string | null;
  cloud_summary?: string | null;
  branch?: string | null;
  linear_issue?: string | null;
  // Factory metadata (propagated from agents-cli meta.json via teams status).
  task_type?: 'plan' | 'implement' | 'test' | 'review' | 'bugfix' | 'docs' | null;
  name?: string | null;
  after?: string[];
}

export interface TaskSummary {
  task_name: string;
  agent_count: number;
  status_counts: { running: number; completed: number; failed: number; stopped: number };
  latest_activity: string;
  agents: AgentDetail[];
}

interface SwarmStatusAgent {
  agent_id?: string;
  agentId?: string;
  task_name?: string;
  taskName?: string;
  agent_type?: string;
  agentType?: string;
  status?: string;
  started_at?: string;
  startedAt?: string;
  completed_at?: string | null;
  completedAt?: string | null;
  duration?: string | null;
  prompt?: string;
  cwd?: string | null;
}

// Calculate duration string from dates
function calcDuration(startedAt: Date, completedAt: Date | null, status: string): string | null {
  let seconds: number | null = null;

  if (completedAt) {
    seconds = (completedAt.getTime() - startedAt.getTime()) / 1000;
  } else if (status === 'running') {
    seconds = (Date.now() - startedAt.getTime()) / 1000;
  } else if (status === 'completed') {
    // Completed without an end time recorded; avoid inflating duration.
    return null;
  }

  if (seconds === null || seconds < 0) {
    return null;
  }

  if (seconds < 60) {
    return `${Math.floor(seconds)}s`;
  }

  const minutes = seconds / 60;
  if (minutes < 60) {
    const rounded = Math.max(1, Math.round(minutes));
    return `${rounded}m`;
  }

  const hours = minutes / 60;
  if (hours < 48) {
    const rounded = hours >= 10 ? Math.round(hours) : Number(hours.toFixed(1));
    return `${rounded}h`;
  }

  const days = hours / 24;
  const roundedDays = days >= 10 ? Math.round(days) : Number(days.toFixed(1));
  return `${roundedDays}d`;
}

// How many trailing lines of stdout.log to parse for the dashboard. The log
// can grow to many MB for a long-running agent; the UI only shows recent
// activity (last few messages / file ops), so we tail instead of reading the
// whole file off the main thread.
const LOG_TAIL_LINES = 400;

// Parse stdout.log to extract file operations and commands. Reads only the
// last LOG_TAIL_LINES lines via an async backward scan (readTailLines), never
// the whole file.
async function parseAgentLog(logPath: string): Promise<{
  filesCreated: string[];
  filesModified: string[];
  filesDeleted: string[];
  bashCommands: string[];
  lastMessages: string[];
}> {
  const result = {
    filesCreated: [] as string[],
    filesModified: [] as string[],
    filesDeleted: [] as string[],
    bashCommands: [] as string[],
    lastMessages: [] as string[],
  };

  const lines = await readTailLines(logPath, LOG_TAIL_LINES);
  if (lines.length === 0) {
    return result;
  }

  try {
    const messages: string[] = [];

    for (const line of lines) {
      try {
        const event = JSON.parse(line);

        // Handle different event formats
        // Claude format
        if (event.type === 'tool_use' || event.type === 'tool') {
          const toolName = event.tool || event.name || '';
          const input = event.input || event.content?.input || {};

          if (toolName === 'Write' && input.file_path) {
            result.filesCreated.push(input.file_path);
          } else if (toolName === 'Edit' && input.file_path) {
            result.filesModified.push(input.file_path);
          } else if (toolName === 'Bash' && input.command) {
            const cmd = input.command.length > 80
              ? input.command.substring(0, 77) + '...'
              : input.command;
            result.bashCommands.push(cmd);
          }
        }

        // Codex/Cursor format
        if (event.type === 'function_call') {
          const name = event.name || '';
          const args = typeof event.arguments === 'string'
            ? JSON.parse(event.arguments)
            : event.arguments || {};

          if (name === 'write_file' && args.path) {
            result.filesCreated.push(args.path);
          } else if (name === 'edit_file' && args.path) {
            result.filesModified.push(args.path);
          } else if (name === 'shell' && args.command) {
            const cmd = args.command.length > 80
              ? args.command.substring(0, 77) + '...'
              : args.command;
            result.bashCommands.push(cmd);
          }
        }

        // Collect assistant messages
        if (event.type === 'assistant' || event.type === 'message' || event.role === 'assistant') {
          const text = event.content || event.text || event.message || '';
          if (typeof text === 'string' && text.trim()) {
            const truncated = text.length > 200 ? text.substring(0, 197) + '...' : text;
            messages.push(truncated);
          }
        }

        // Streamed deltas (Claude/Codex) often arrive as text_delta/content_block_delta
        if (event.delta?.text) {
          const text = String(event.delta.text);
          if (text.trim()) {
            const truncated = text.length > 200 ? text.substring(0, 197) + '...' : text;
            messages.push(truncated);
          }
        }

        if (Array.isArray(event.content)) {
          for (const block of event.content) {
            if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
              const truncated = block.text.length > 200
                ? block.text.substring(0, 197) + '...'
                : block.text;
              messages.push(truncated);
            }
          }
        }
      } catch {
        // Skip non-JSON lines
      }
    }

    // Get last 3 messages
    result.lastMessages = messages.slice(-3);
  } catch {
    // Ignore read errors
  }

  return result;
}

function normalizeSwarmStatusAgents(response: unknown): SwarmStatusAgent[] {
  if (!response) return [];

  if (Array.isArray(response)) {
    return response as SwarmStatusAgent[];
  }

  if (typeof response === 'object') {
    const asRecord = response as Record<string, unknown>;
    if (Array.isArray(asRecord.agents)) {
      return asRecord.agents as SwarmStatusAgent[];
    }
    if (Array.isArray(asRecord.items)) {
      return asRecord.items as SwarmStatusAgent[];
    }
    if (Array.isArray(asRecord.data)) {
      return asRecord.data as SwarmStatusAgent[];
    }
    if (Array.isArray(asRecord.tasks)) {
      const tasks = asRecord.tasks as Array<Record<string, unknown>>;
      const flattened: SwarmStatusAgent[] = [];
      for (const task of tasks) {
        const taskName = (task.task_name || task.taskName) as string | undefined;
        const agents = Array.isArray(task.agents) ? (task.agents as SwarmStatusAgent[]) : [];
        for (const agent of agents) {
          flattened.push({ ...agent, task_name: agent.task_name || taskName });
        }
      }
      return flattened;
    }
  }

  return [];
}

function buildTaskSummariesFromAgents(agents: SwarmStatusAgent[]): TaskSummary[] {
  const taskMap = new Map<string, AgentDetail[]>();
  const taskTimes = new Map<string, Date>();

  for (const agent of agents) {
    const taskName = agent.task_name || agent.taskName;
    if (!taskName) continue;

    const status = agent.status ?? 'unknown';
    const startedAtRaw = agent.started_at || agent.startedAt;
    const completedAtRaw = agent.completed_at ?? agent.completedAt ?? null;
    const startedAt = startedAtRaw ? new Date(startedAtRaw) : null;
    const completedAt = completedAtRaw ? new Date(completedAtRaw) : null;

    const detail: AgentDetail = {
      agent_id: agent.agent_id || agent.agentId || 'unknown',
      agent_type: agent.agent_type || agent.agentType || 'unknown',
      status,
      duration: agent.duration ?? (startedAt ? calcDuration(startedAt, completedAt, status) : null),
      started_at: startedAtRaw || new Date().toISOString(),
      completed_at: completedAtRaw ?? null,
      prompt: agent.prompt ? (agent.prompt.length > 150 ? agent.prompt.substring(0, 147) + '...' : agent.prompt) : '',
      cwd: agent.cwd ?? null,
      files_created: [],
      files_modified: [],
      files_deleted: [],
      bash_commands: [],
      last_messages: [],
    };

    const existing = taskMap.get(taskName) || [];
    existing.push(detail);
    taskMap.set(taskName, existing);

    const activityTime = completedAt && !Number.isNaN(completedAt.getTime())
      ? completedAt
      : startedAt && !Number.isNaN(startedAt.getTime())
        ? startedAt
        : new Date();
    const currentLatest = taskTimes.get(taskName);
    if (!currentLatest || activityTime > currentLatest) {
      taskTimes.set(taskName, activityTime);
    }
  }

  const tasks: TaskSummary[] = [];
  for (const [taskName, taskAgents] of taskMap) {
    const statusCounts = { running: 0, completed: 0, failed: 0, stopped: 0 };
    for (const agent of taskAgents) {
      if (agent.status === 'running') statusCounts.running++;
      else if (agent.status === 'completed') statusCounts.completed++;
      else if (agent.status === 'failed') statusCounts.failed++;
      else if (agent.status === 'stopped') statusCounts.stopped++;
    }

    taskAgents.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());

    tasks.push({
      task_name: taskName,
      agent_count: taskAgents.length,
      status_counts: statusCounts,
      latest_activity: (taskTimes.get(taskName) || new Date()).toISOString(),
      agents: taskAgents,
    });
  }

  tasks.sort((a, b) => new Date(b.latest_activity).getTime() - new Date(a.latest_activity).getTime());
  return tasks;
}

export async function fetchTasksBySession(sessionId: string): Promise<TaskSummary[]> {
  if (!sessionId) return [];

  const argsJson = JSON.stringify({ parent_session_id: sessionId });
  const safeArgs = argsJson.replace(/'/g, `'\\''`);
  const agents: AgentCli[] = ['claude', 'codex', 'gemini'];

  for (const agent of agents) {
    try {
      const { stdout } = await execAsync(
        `${agent} mcp call Swarm status --args '${safeArgs}'`,
        { timeout: 15000 }
      );

      const response = JSON.parse(stdout.trim());
      const statusAgents = normalizeSwarmStatusAgents(response);
      return buildTaskSummariesFromAgents(statusAgents);
    } catch {
      // Try next agent
    }
  }

  return [];
}

// Fetch all tasks from both agent directories (swarm + teams)
export async function fetchTasks(limit?: number, filterCwd?: string): Promise<TaskSummary[]> {
  const agentDirs: Array<{ dir: string; agentId: string }> = [];

  for (const baseDir of [AGENT_SWARM_DIR, AGENT_TEAMS_DIR]) {
    let agentIds: string[];
    try {
      agentIds = await fsp.readdir(baseDir);
    } catch {
      continue; // directory missing or unreadable
    }
    for (const agentId of agentIds) {
      agentDirs.push({ dir: baseDir, agentId });
    }
  }

  if (agentDirs.length === 0) return [];

  const taskMap = new Map<string, AgentDetail[]>();
  const taskTimes = new Map<string, Date>();

  for (const { dir, agentId } of agentDirs) {
    const agentDir = path.join(dir, agentId);
    const metaPath = path.join(agentDir, 'meta.json');
    const logPath = path.join(agentDir, 'stdout.log');

    try {
      let metaContent: string;
      try {
        metaContent = await fsp.readFile(metaPath, 'utf-8');
      } catch {
        continue; // meta.json missing or unreadable
      }
      const meta: AgentMeta = JSON.parse(metaContent);

      // Filter by workspace cwd if specified (allow null cwd through)
      if (filterCwd && meta.cwd && meta.cwd !== filterCwd) continue;

      const startedAt = new Date(meta.started_at);
      const completedAt = meta.completed_at ? new Date(meta.completed_at) : null;
      const logData = await parseAgentLog(logPath);

      const detail: AgentDetail = {
        agent_id: meta.agent_id,
        agent_type: meta.agent_type,
        status: meta.status,
        duration: calcDuration(startedAt, completedAt, meta.status),
        started_at: meta.started_at,
        completed_at: meta.completed_at,
        prompt: meta.prompt.length > 150 ? meta.prompt.substring(0, 147) + '...' : meta.prompt,
        cwd: meta.cwd,
        mode: meta.mode,
        files_created: [...new Set(logData.filesCreated)],
        files_modified: [...new Set(logData.filesModified)],
        files_deleted: [...new Set(logData.filesDeleted)],
        bash_commands: logData.bashCommands.slice(-10),
        last_messages: logData.lastMessages,
        cloud_session_id: meta.cloud_session_id || null,
        cloud_provider: meta.cloud_provider || null,
        pr_url: meta.pr_url || null,
        ci_status: getPrCiCached(meta.pr_url),
        task_type: (meta as { task_type?: AgentDetail['task_type'] }).task_type ?? null,
        name: (meta as { name?: string | null }).name ?? null,
        after: Array.isArray((meta as { after?: string[] }).after) ? (meta as { after?: string[] }).after : [],
      };

      const existing = taskMap.get(meta.task_name) || [];
      existing.push(detail);
      taskMap.set(meta.task_name, existing);

      // Track latest activity time for task
      const activityTime = completedAt || startedAt;
      const currentLatest = taskTimes.get(meta.task_name);
      if (!currentLatest || activityTime > currentLatest) {
        taskTimes.set(meta.task_name, activityTime);
      }
    } catch {
      // Skip invalid entries
    }
  }

  // Build task summaries
  const tasks: TaskSummary[] = [];
  for (const [taskName, agents] of taskMap) {
    const statusCounts = { running: 0, completed: 0, failed: 0, stopped: 0 };
    for (const agent of agents) {
      if (agent.status === 'running') statusCounts.running++;
      else if (agent.status === 'completed') statusCounts.completed++;
      else if (agent.status === 'failed') statusCounts.failed++;
      else if (agent.status === 'stopped') statusCounts.stopped++;
    }

    // Sort agents by started_at (most recent first)
    agents.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());

    tasks.push({
      task_name: taskName,
      agent_count: agents.length,
      status_counts: statusCounts,
      latest_activity: (taskTimes.get(taskName) || new Date()).toISOString(),
      agents,
    });
  }

  // Sort tasks by latest activity (most recent first)
  tasks.sort((a, b) => new Date(b.latest_activity).getTime() - new Date(a.latest_activity).getTime());

  // Merge cloud runs from Prix API
  try {
    const cloudTasks = await fetchCloudRuns();
    tasks.push(...cloudTasks);
    tasks.sort((a, b) => new Date(b.latest_activity).getTime() - new Date(a.latest_activity).getTime());
  } catch {
    // Cloud runs unavailable — continue with local data only
  }

  return limit ? tasks.slice(0, limit) : tasks;
}

// Rush Cloud runs from Prix API
const RUSH_USER_YAML = path.join(os.homedir(), '.rush', 'user.yaml');
const PRIX_API_URL = 'https://api.prix.dev';

// Bound the cloud-runs HTTP call: the floor poll (10s) and terminal open/close
// bursts (debounced 500ms) all funnel through fetchTasks -> fetchCloudRuns. A
// short TTL collapses bursts onto one request, and an in-flight guard prevents
// overlapping requests when the API is slow (#95). The token itself is read +
// parsed at most once until ~/.rush/user.yaml changes (see readRushTokenCached).
const CLOUD_RUNS_TTL_MS = 5000;
let cloudRunsCache: { at: number; tasks: TaskSummary[] } | undefined;
let cloudRunsInFlight: Promise<TaskSummary[]> | undefined;

async function fetchCloudRuns(): Promise<TaskSummary[]> {
  const now = Date.now();
  if (cloudRunsCache && now - cloudRunsCache.at < CLOUD_RUNS_TTL_MS) {
    return cloudRunsCache.tasks;
  }
  if (cloudRunsInFlight) return cloudRunsInFlight;

  const p = computeCloudRuns()
    .then((tasks) => {
      cloudRunsCache = { at: Date.now(), tasks };
      return tasks;
    })
    .catch((err) => {
      // A transient failure (5s timeout / abort / network blip) must not make
      // cloud agents vanish from the feed. Serve the last good snapshot if we
      // have one; leave its timestamp stale so the TTL check lets the next call
      // retry a fresh fetch rather than pinning the stale copy.
      console.error('[floor] cloud-runs fetch failed:', err);
      return cloudRunsCache ? cloudRunsCache.tasks : [];
    })
    .finally(() => {
      if (cloudRunsInFlight === p) cloudRunsInFlight = undefined;
    });
  cloudRunsInFlight = p;
  return p;
}

async function computeCloudRuns(): Promise<TaskSummary[]> {
  const token = await readRushTokenCached(RUSH_USER_YAML);
  if (!token) return [];

  const resp = await fetch(`${PRIX_API_URL}/api/v1/cloud-runs`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) return [];

  const data = (await resp.json()) as { executions?: CloudExecution[] };
  if (!data.executions?.length) {
    reconcileCloudStreams(new Set(), token);
    return [];
  }

  // Open SSE streams for running agents; close streams for non-running.
  // The stream buffer is the source of truth for live output; ex.summary is
  // a backstop only for completed runs (and is API-capped, so unreliable).
  const runningIds = new Set(
    data.executions
      .filter((ex) => mapCloudStatus(ex.status) === 'running')
      .map((ex) => ex.execution_id),
  );
  reconcileCloudStreams(runningIds, token);

  return data.executions.map((ex) => {
    const status = mapCloudStatus(ex.status);
    const startedAt = ex.created_at;
    const completedAt = status !== 'running' ? ex.updated_at : null;
    const duration = calcDuration(new Date(startedAt), completedAt ? new Date(completedAt) : null, status);

    // Prefer the live SSE buffer over the (capped) stored summary.
    const buffered = getCloudStreamBuffer(ex.execution_id);
    const summary = buffered || ex.summary || null;

    const detail: AgentDetail = {
      agent_id: ex.execution_id,
      agent_type: ex.agent || 'claude',
      status,
      duration,
      started_at: startedAt,
      completed_at: completedAt,
      prompt: ex.prompt || '',
      cwd: null,
      mode: 'cloud',
      files_created: [],
      files_modified: [],
      files_deleted: [],
      bash_commands: [],
      last_messages: summary ? [summary] : [],
      cloud_session_id: ex.execution_id,
      cloud_provider: 'rush',
      pr_url: ex.pr_url || null,
      ci_status: getPrCiCached(ex.pr_url),
      repo_owner: ex.repo_owner || null,
      repo_name: ex.repo_name || null,
      cloud_summary: summary,
      branch: ex.branch || null,
      linear_issue: ex.linear_issue || null,
    };

    const taskName = `cloud:${ex.execution_id}`;
    return {
      task_name: taskName,
      agent_count: 1,
      status_counts: {
        running: status === 'running' ? 1 : 0,
        completed: status === 'completed' ? 1 : 0,
        failed: status === 'failed' ? 1 : 0,
        stopped: status === 'stopped' ? 1 : 0,
      },
      latest_activity: ex.updated_at || ex.created_at,
      agents: [detail],
    };
  });
}

interface CloudExecution {
  execution_id: string;
  agent: string;
  prompt: string;
  status: string;
  repo_owner: string;
  repo_name: string;
  branch: string | null;
  pr_url: string | null;
  summary: string | null;
  linear_issue: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * SSE streaming for cloud runs.
 *
 * The list endpoint (`/cloud-runs`) returns each run's `summary` field, but
 * the API caps it at a few KB — usually exhausted by the verbose system.init
 * event before any tool_use lines arrive. The `/cloud-runs/{id}/stream`
 * endpoint pushes the full uncapped output as Server-Sent Events.
 *
 * Strategy: open one long-lived stream per running cloud run, append each
 * `output` event to an in-memory buffer, and notify the webview so it can
 * re-render. Streams are reconciled against the polled list — opened on
 * first sight, closed when the run leaves the running set or a `done`
 * event arrives.
 */
interface CloudStreamState {
  buffer: string;
  status: string;
  controller: AbortController;
  done: boolean;
  // Throttle webview pushes — many output events can arrive per second.
  pendingNotify: NodeJS.Timeout | null;
}

const cloudStreams = new Map<string, CloudStreamState>();

type CloudUpdateListener = (executionId: string, summary: string, status: string) => void;
let cloudUpdateListener: CloudUpdateListener | null = null;

export function setCloudUpdateListener(cb: CloudUpdateListener | null): void {
  cloudUpdateListener = cb;
}

export function stopAllCloudStreams(): void {
  for (const id of Array.from(cloudStreams.keys())) {
    stopCloudStream(id);
  }
}

function getCloudStreamBuffer(executionId: string): string | null {
  const s = cloudStreams.get(executionId);
  return s && s.buffer ? s.buffer : null;
}

function reconcileCloudStreams(runningIds: Set<string>, token: string): void {
  for (const id of runningIds) {
    if (!cloudStreams.has(id)) startCloudStream(id, token);
  }
  for (const id of Array.from(cloudStreams.keys())) {
    if (!runningIds.has(id)) stopCloudStream(id);
  }
}

function startCloudStream(executionId: string, token: string): void {
  if (cloudStreams.has(executionId)) return;
  const controller = new AbortController();
  const state: CloudStreamState = {
    buffer: '',
    status: 'running',
    controller,
    done: false,
    pendingNotify: null,
  };
  cloudStreams.set(executionId, state);

  // Detached: don't await. Errors mark the stream done; reconcile will
  // restart it on the next poll cycle if the run is still listed running.
  void runCloudStream(executionId, state, token);
}

async function runCloudStream(executionId: string, state: CloudStreamState, token: string): Promise<void> {
  try {
    const resp = await fetch(`${PRIX_API_URL}/api/v1/cloud-runs/${executionId}/stream`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
      },
      signal: state.controller.signal,
    });
    if (!resp.ok || !resp.body) {
      state.done = true;
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let idx;
      while ((idx = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, idx);
        pending = pending.slice(idx + 2);
        handleSseFrame(executionId, state, frame);
      }
    }
    flushNotify(executionId, state);
  } catch (err) {
    // Aborted (stop) or network error — leave buffer intact for next poll.
    if ((err as Error)?.name !== 'AbortError') {
      state.done = true;
    }
  }
}

function handleSseFrame(executionId: string, state: CloudStreamState, frame: string): void {
  let event = '';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!event || !data) return;

  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { return; }
  const obj = (parsed && typeof parsed === 'object') ? (parsed as Record<string, unknown>) : {};

  if (event === 'output') {
    const content = typeof obj.content === 'string' ? obj.content : '';
    if (content) {
      state.buffer += content;
      scheduleNotify(executionId, state);
    }
  } else if (event === 'status') {
    if (typeof obj.status === 'string') state.status = obj.status;
    scheduleNotify(executionId, state);
  } else if (event === 'done') {
    state.done = true;
    if (typeof obj.output === 'string' && obj.output.length > state.buffer.length) {
      // Final 'done' may include the canonical full output — adopt it if longer.
      state.buffer = obj.output;
    }
    scheduleNotify(executionId, state);
  }
}

function scheduleNotify(executionId: string, state: CloudStreamState): void {
  if (state.pendingNotify) return;
  state.pendingNotify = setTimeout(() => {
    state.pendingNotify = null;
    if (cloudUpdateListener) cloudUpdateListener(executionId, state.buffer, mapCloudStatus(state.status));
  }, 750);
}

function flushNotify(executionId: string, state: CloudStreamState): void {
  if (state.pendingNotify) {
    clearTimeout(state.pendingNotify);
    state.pendingNotify = null;
  }
  if (cloudUpdateListener) cloudUpdateListener(executionId, state.buffer, mapCloudStatus(state.status));
}

function stopCloudStream(executionId: string): void {
  const s = cloudStreams.get(executionId);
  if (!s) return;
  s.controller.abort();
  if (s.pendingNotify) {
    clearTimeout(s.pendingNotify);
    s.pendingNotify = null;
  }
  cloudStreams.delete(executionId);
}
