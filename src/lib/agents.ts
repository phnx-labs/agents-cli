/**
 * Core agent configuration and detection module.
 *
 * Defines the canonical registry of all supported AI coding agents (Claude, Codex,
 * Gemini, Cursor, OpenCode, OpenClaw, Copilot, Amp, Kiro, Goose, Roo, Grok) with their
 * CLI commands, config paths, capability flags, and MCP integration points.
 *
 * Provides functions for detecting installed CLIs, resolving version-managed binaries,
 * reading account/auth info, and managing MCP server registrations across agents.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as TOML from 'smol-toml';
import chalk from 'chalk';
import type { AgentConfig, AgentId } from './types.js';
import { latestFileMtimeMs } from './fs-walk.js';
import { damerauLevenshtein } from './fuzzy.js';
import { getCacheDir, getVersionsDir, getShimsDir, getCliVersionCachePath } from './state.js';
import { resolveVersion, getVersionHomePath, getBinaryPath } from './versions.js';

/** Represents the installation state of an agent's CLI binary. */
export interface CliState {
  installed: boolean;
  version: string | null;
  path: string | null;
}

const execFileAsync = promisify(execFile);

const HOME = os.homedir();

/**
 * Minimum Codex CLI version that supports hooks.
 * Mirrored on `AGENTS.codex.capabilities.hooks.since` -- kept exported for
 * legacy import sites that haven't migrated to `supports()` yet.
 */
export const CODEX_HOOKS_MIN_VERSION = '0.116.0';

/** Minimum Gemini CLI version that supports the hooks system (v0.26.0, Jan 2026). */
export const GEMINI_HOOKS_MIN_VERSION = '0.26.0';

const CLI_VERSION_CACHE_PATH = getCliVersionCachePath();

interface CliVersionCacheEntry {
  binaryPath: string;
  mtime: number;
  version: string | null;
}

let cliVersionCache: Record<string, CliVersionCacheEntry> | null = null;

function loadCliVersionCache(): Record<string, CliVersionCacheEntry> {
  if (cliVersionCache) return cliVersionCache;
  try {
    cliVersionCache = JSON.parse(fs.readFileSync(CLI_VERSION_CACHE_PATH, 'utf-8'));
  } catch {
    /* missing or corrupt cache, rebuild */
    cliVersionCache = {};
  }
  return cliVersionCache!;
}

function saveCliVersionCache(): void {
  if (!cliVersionCache) return;
  try {
    const dir = path.dirname(CLI_VERSION_CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CLI_VERSION_CACHE_PATH, JSON.stringify(cliVersionCache));
  } catch {
    /* best-effort cache persist */
  }
}

/**
 * Synchronous PATH search -- no subprocess. Returns first matching binary path.
 *
 * Skips our own shims dir (`~/.agents/.cache/shims/`) — those shims are
 * dispatch helpers, not real installs. Counting them as installed produced a
 * false positive where agents with NO real binary on the host (e.g. a
 * never-installed Cursor whose only PATH entry was our `cursor-agent` shim
 * dispatcher) showed up under `agents view`'s "Not Managed by Agents CLI"
 * section, even though the user had nothing to import.
 */
export function findInPath(command: string): string | null {
  const pathEnv = process.env.PATH || '';
  const pathExt = process.platform === 'win32' ? (process.env.PATHEXT || '').split(';') : [''];
  const shimsDir = getShimsDir();
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    if (path.resolve(dir) === path.resolve(shimsDir)) continue;
    for (const ext of pathExt) {
      const full = path.join(dir, command + ext);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile()) return full;
      } catch {
        /* not in this dir */
      }
    }
  }
  return null;
}

/** Grok-specific binary resolution.
 * Grok does not live in node_modules/.bin. Its versioned binaries live in each
 * managed version home under `.grok/downloads/`, so detection must not follow
 * the host ~/.grok config symlink.
 */
function resolveGrokBinary(version?: string): string | null {
  if (version && version !== 'latest') {
    const binaryPath = getBinaryPath('grok', version);
    if (fs.existsSync(binaryPath)) return binaryPath;
    return null;
  }

  const resolvedVersion = resolveVersion('grok', process.cwd());
  if (resolvedVersion) {
    const binaryPath = getBinaryPath('grok', resolvedVersion);
    if (fs.existsSync(binaryPath)) return binaryPath;
  }

  const grokVersionsDir = path.join(getVersionsDir(), 'grok');
  if (!fs.existsSync(grokVersionsDir)) return null;

  let latest: string | null = null;
  let latestMtime = 0;
  for (const entry of fs.readdirSync(grokVersionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const binaryPath = getBinaryPath('grok', entry.name);
    if (!fs.existsSync(binaryPath)) continue;
    try {
      const stat = fs.statSync(binaryPath);
      if (stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs;
        latest = binaryPath;
      }
    } catch {}
  }
  return latest;
}

function splitCommandLine(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let tokenStarted = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (quote) {
      if (char === quote) {
        quote = null;
        tokenStarted = true;
      } else if (char === '\\' && quote === '"' && i + 1 < command.length) {
        current += command[++i];
        tokenStarted = true;
      } else {
        current += char;
        tokenStarted = true;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }

    if (char === '\\' && i + 1 < command.length) {
      current += command[++i];
      tokenStarted = true;
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (quote) {
    throw new Error('Unterminated quote in MCP command');
  }

  if (tokenStarted) {
    args.push(current);
  }

  if (args.length === 0) {
    throw new Error('MCP command is required');
  }

  return args;
}

/**
 * Master registry of all supported agents keyed by AgentId.
 *
 * Each entry defines the agent's CLI command, npm package, config directory layout,
 * instructions file name, slash-command format, and capability flags. This is the
 * single source of truth for agent metadata consumed throughout the codebase.
 */
export const AGENTS: Record<AgentId, AgentConfig> = {
  claude: {
    id: 'claude',
    name: 'Claude',
    color: 'magenta',
    cliCommand: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
    configDir: path.join(HOME, '.claude'),
    homeFiles: ['.claude.json'],
    commandsDir: path.join(HOME, '.claude', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.claude', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'CLAUDE.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: true,
    // Claude Code has no headless Anthropic-hosted dispatch CLI (only
    // --remote-control, which bridges a *local* session). Its cloud is Rush.
    cloudProvider: 'rush',
    capabilities: { hooks: true, mcp: true, allowlist: true, skills: true, commands: true, plugins: true, subagents: true, rules: { file: 'CLAUDE.md' }, workflows: true, modes: ['plan', 'edit', 'auto', 'skip'], rulesImports: true },
  },
  // codex hooks: gated to >= 0.116.0 (introduced [features] codex_hooks flag).
  codex: {
    id: 'codex',
    name: 'Codex',
    color: 'green',
    cliCommand: 'codex',
    npmPackage: '@openai/codex',
    configDir: path.join(HOME, '.codex'),
    commandsDir: path.join(HOME, '.codex', 'prompts'),
    commandsSubdir: 'prompts',
    skillsDir: path.join(HOME, '.codex', 'skills'),
    hooksDir: 'hooks',
    pluginManifestDir: '.codex-plugin',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: true,
    cloudProvider: 'codex',
    capabilities: { hooks: { since: '0.116.0' }, mcp: true, allowlist: false, skills: true, commands: { until: '0.117.0' }, plugins: { since: '0.128.0' }, subagents: false, rules: { file: 'AGENTS.md' }, workflows: false, modes: ['plan', 'edit', 'skip'] },
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    color: 'blue',
    cliCommand: 'gemini',
    npmPackage: '@google/gemini-cli',
    configDir: path.join(HOME, '.gemini'),
    commandsDir: path.join(HOME, '.gemini', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.gemini', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'GEMINI.md',
    format: 'toml',
    variableSyntax: '{{args}}',
    supportsHooks: true,
    nativeAgentsSkillsDir: true,
    // gemini hooks: shipped in v0.26.0 (Jan 2026); older binaries silently ignore the `hooks` key.
    capabilities: { hooks: { since: '0.26.0' }, mcp: true, allowlist: false, skills: true, commands: true, plugins: false, subagents: false, rules: { file: 'GEMINI.md' }, workflows: false, modes: ['plan', 'edit', 'skip'], rulesImports: true },
  },
  cursor: {
    id: 'cursor',
    name: 'Cursor',
    color: 'cyan',
    cliCommand: 'cursor-agent',
    npmPackage: '',
    installScript: 'curl https://cursor.com/install -fsS | bash && mv ~/.local/bin/agent ~/.local/bin/cursor-agent && grep -q "/.local/bin" ~/.zshrc || echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.zshrc',
    configDir: path.join(HOME, '.cursor'),
    commandsDir: path.join(HOME, '.cursor', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.cursor', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: '.cursorrules',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: false,
    capabilities: { hooks: false, mcp: true, allowlist: false, skills: true, commands: true, plugins: false, subagents: false, rules: { file: '.cursorrules' }, workflows: false, modes: ['edit', 'skip'] },
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    color: 'yellowBright',
    cliCommand: 'opencode',
    npmPackage: 'opencode-ai',
    configDir: path.join(HOME, '.opencode'),
    commandsDir: path.join(HOME, '.opencode', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.opencode', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: false,
    capabilities: { hooks: false, mcp: true, allowlist: false, skills: true, commands: true, plugins: false, subagents: false, rules: { file: 'AGENTS.md' }, workflows: false, modes: ['plan', 'edit'] },
  },
  openclaw: {
    id: 'openclaw',
    name: 'OpenClaw',
    color: 'redBright',
    cliCommand: 'openclaw',
    npmPackage: 'openclaw',
    configDir: path.join(HOME, '.openclaw'),
    commandsDir: '', // OpenClaw uses Gateway-based slash commands, not file-based
    commandsSubdir: '',
    skillsDir: path.join(HOME, '.openclaw', 'skills'),
    nativeCommandRuntime: true, // Gateway resolves slash commands — don't convert commands to skills

    hooksDir: 'hooks',
    instructionsFile: 'workspace/AGENTS.md', // Primary memory file (also has SOUL.md, IDENTITY.md, etc.)
    format: 'markdown',
    variableSyntax: '{{ARGUMENTS}}',
    supportsHooks: true,
    capabilities: { hooks: true, mcp: true, allowlist: false, skills: true, commands: false, plugins: true, subagents: true, rules: { file: 'workspace/AGENTS.md' }, workflows: false, modes: ['plan', 'edit', 'skip'] },
  },
  copilot: {
    id: 'copilot',
    name: 'Copilot',
    color: 'whiteBright',
    cliCommand: 'copilot',
    npmPackage: '@github/copilot',
    configDir: path.join(HOME, '.copilot'),
    commandsDir: path.join(HOME, '.copilot', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.copilot', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: false,
    capabilities: { hooks: false, mcp: true, allowlist: false, skills: true, commands: true, plugins: false, subagents: false, rules: { file: 'AGENTS.md' }, workflows: false, modes: ['plan', 'edit', 'auto', 'skip'] },
  },
  amp: {
    id: 'amp',
    name: 'Amp',
    color: 'blueBright',
    cliCommand: 'amp',
    npmPackage: '@sourcegraph/amp',
    configDir: path.join(HOME, '.config', 'amp'),
    commandsDir: path.join(HOME, '.config', 'amp', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.config', 'amp', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: false,
    capabilities: { hooks: false, mcp: true, allowlist: false, skills: true, commands: true, plugins: false, subagents: false, rules: { file: 'AGENTS.md' }, workflows: false, modes: ['plan', 'edit'] },
  },
  kiro: {
    id: 'kiro',
    name: 'Kiro',
    color: 'greenBright',
    cliCommand: 'kiro-cli',
    npmPackage: '',
    installScript: 'brew install --cask kiro-cli',
    configDir: path.join(HOME, '.kiro'),
    commandsDir: path.join(HOME, '.kiro', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.kiro', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: false,
    capabilities: { hooks: false, mcp: true, allowlist: false, skills: true, commands: true, plugins: false, subagents: false, rules: { file: 'AGENTS.md' }, workflows: false, modes: ['edit'] },
  },
  goose: {
    id: 'goose',
    name: 'Goose',
    color: 'magentaBright',
    cliCommand: 'goose',
    npmPackage: '',
    installScript: 'brew install block-goose-cli',
    configDir: path.join(HOME, '.config', 'goose'),
    commandsDir: path.join(HOME, '.config', 'goose', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.config', 'goose', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: false,
    capabilities: { hooks: false, mcp: true, allowlist: false, skills: false, commands: false, plugins: false, subagents: false, rules: { file: 'AGENTS.md' }, workflows: false, modes: ['edit'] },
  },
  roo: {
    id: 'roo',
    name: 'Roo Code',
    color: 'cyanBright',
    cliCommand: 'roo',
    npmPackage: '',
    installScript: 'curl -fsSL https://raw.githubusercontent.com/RooCodeInc/Roo-Code/main/apps/cli/install.sh | sh',
    configDir: path.join(HOME, '.roo'),
    commandsDir: path.join(HOME, '.roo', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.roo', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: false,
    capabilities: { hooks: false, mcp: true, allowlist: false, skills: true, commands: true, plugins: false, subagents: false, rules: { file: 'AGENTS.md' }, workflows: false, modes: ['plan', 'edit'] },
  },
  // Google Antigravity CLI (`agy`) — official replacement for Gemini CLI as of IO 2026.
  // configDir nests inside `~/.gemini/` since agy shares the parent dir with the Gemini
  // CLI but isolates its own state in the `antigravity-cli/` subdir. Per-version HOME
  // isolation works because the shim's configDirName carries the full nested path.
  // Auth: Google OAuth on first launch, or ANTIGRAVITY_API_KEY env var for headless.
  // Hooks: JSON entries under a top-level `hooks` key in settings.json; events are
  // before_tool_call, after_model_call, on_loop_stop, on_error. Plugins are the
  // renamed Gemini CLI extensions. Permissions live in settings.json under a
  // `permissions` key with allow/deny arrays.
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity',
    color: 'blueBright',
    cliCommand: 'agy',
    npmPackage: '',
    installScript: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    configDir: path.join(HOME, '.gemini', 'antigravity-cli'),
    commandsDir: path.join(HOME, '.gemini', 'antigravity-cli', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.gemini', 'antigravity-cli', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '{{args}}',
    supportsHooks: true,
    cloudProvider: 'antigravity',
    capabilities: { hooks: true, mcp: true, allowlist: true, skills: true, commands: true, plugins: true, subagents: false, rules: { file: 'AGENTS.md' }, workflows: false, modes: ['edit', 'skip'], rulesImports: false },
  },
  // xAI Grok Build CLI (`grok`) — early beta, SuperGrok Heavy. Auth via OAuth on
  // first launch, or XAI_API_KEY env var for headless. MCP servers configured inline
  // under [mcp_servers] in ~/.grok/config.toml. Hooks auto-discovered from
  // ~/.grok/hooks/ (+ project .grok/hooks/) — events PreToolUse, PostToolUse, etc.
  // Plugins live in ~/.grok/plugins/ with marketplaces. Permissions: --allow/--deny
  // CLI flags or [permission] TOML block in ~/.grok/config.toml.
  grok: {
    id: 'grok',
    name: 'Grok',
    color: 'cyanBright',
    cliCommand: 'grok',
    npmPackage: '',
    installScript: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    configDir: path.join(HOME, '.grok'),
    commandsDir: '', // Grok primarily uses skills + slash commands from skills
    commandsSubdir: '',
    skillsDir: path.join(HOME, '.grok', 'skills'),
    hooksDir: path.join(HOME, '.grok', 'hooks'),
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: true,
    capabilities: {
      hooks: true,
      mcp: true,
      allowlist: true, // maps to Grok's granular Bash/Edit/Write/Read/Grep/WebFetch/MCPTool rules
      skills: true,
      commands: false, // covered by skills
      plugins: true,
      subagents: false,
      rules: { file: 'AGENTS.md' },
      workflows: false,
      modes: ['plan', 'edit', 'skip'],
      rulesImports: true,
    },
  },
  // Kimi Code CLI (`kimi`) — Moonshot AI coding agent.
  // Install: `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`
  //    or: `npm install -g @moonshot-ai/kimi-code`
  // Config: `~/.kimi-code/config.toml`, `~/.kimi-code/mcp.json`,
  //         `~/.kimi-code/skills/`, `~/.kimi-code/hooks/`
  kimi: {
    id: 'kimi',
    name: 'Kimi',
    color: 'magentaBright',
    cliCommand: 'kimi',
    npmPackage: '@moonshot-ai/kimi-code',
    installScript: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
    configDir: path.join(HOME, '.kimi-code'),
    commandsDir: '',
    commandsSubdir: '',
    skillsDir: path.join(HOME, '.kimi-code', 'skills'),
    hooksDir: path.join(HOME, '.kimi-code', 'hooks'),
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: true,
    capabilities: {
      hooks: true,
      mcp: true,
      allowlist: true,
      skills: true,
      commands: false,
      plugins: true,
      subagents: false,
      rules: { file: 'AGENTS.md' },
      workflows: false,
      modes: ['plan', 'edit', 'auto', 'skip'],
      rulesImports: false,
    },
  },
  // Factory AI Droid CLI (`droid`) — agentic coding CLI from factory.ai.
  // Install: `curl -fsSL https://app.factory.ai/cli | sh` (no npm package).
  // Binary is NOT in node_modules/.bin — resolved via resolveDroidBinary().
  // Config: `~/.factory/` (settings.json, mcp.json, droids/, commands/).
  // Memory: native AGENTS.md. Subagents = custom droids (top-level .md files
  // in ~/.factory/droids/). Config isolation rides the ~/.factory symlink
  // switch (no FACTORY_HOME env var exists). Headless: `droid exec "<prompt>"`
  // with --auto low|medium|high, -o stream-json, -m <model>, -r <effort>.
  droid: {
    id: 'droid',
    name: 'Droid',
    color: 'yellowBright',
    cliCommand: 'droid',
    npmPackage: '',
    installScript: 'curl -fsSL https://app.factory.ai/cli | sh',
    configDir: path.join(HOME, '.factory'),
    commandsDir: path.join(HOME, '.factory', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: '', // no skills concept
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: false,
    // Factory Droid Computers (cloud VMs) reached via `droid computer ssh` +
    // remote headless `droid exec`.
    cloudProvider: 'factory',
    capabilities: {
      hooks: false,
      mcp: true,
      allowlist: false,
      skills: false,
      commands: true,
      plugins: false,
      subagents: true,
      rules: { file: 'AGENTS.md' },
      workflows: false,
      modes: ['plan', 'edit', 'auto', 'skip'],
      rulesImports: false,
    },
  },
};

/** All registered agent IDs derived from the AGENTS registry. */
export const ALL_AGENT_IDS: AgentId[] = Object.keys(AGENTS) as AgentId[];

// Capability-filtered agent lists used to live here as `*_CAPABLE_AGENTS`
// constants. They were a frequent source of silent-skip bugs (e.g. grok
// rules sync gated on `COMMANDS_CAPABLE_AGENTS`). Use `capableAgents(cap)`
// from `./capabilities.js` instead — it consults the AgentConfig matrix
// directly, so a single source of truth drives every gate.

/** Get the chalk color function for an agent. Works for any AgentId or SessionAgentId. */
export function colorAgent(agentId: string): (s: string) => string {
  const agent = AGENTS[agentId as AgentId];
  if (!agent) return chalk.white;
  return chalk[agent.color];
}

/** Return the agent's display name, colored. */
export function agentLabel(agentId: string): string {
  const agent = AGENTS[agentId as AgentId];
  if (!agent) return agentId;
  return chalk[agent.color](agent.name);
}

/** Check whether the given agent's CLI binary is present on PATH. */
export async function isCliInstalled(agentId: AgentId): Promise<boolean> {
  const agent = AGENTS[agentId];
  return findInPath(agent.cliCommand) !== null;
}

/** Return the installed CLI version for the given agent, or null if not found. */
export async function getCliVersion(agentId: AgentId): Promise<string | null> {
  const agent = AGENTS[agentId];
  const binaryPath = findInPath(agent.cliCommand);
  if (!binaryPath) return null;
  return getCachedVersionForBinary(agentId, binaryPath);
}

/** Return the absolute path to the agent's CLI binary on PATH, or null. */
export async function getCliPath(agentId: AgentId): Promise<string | null> {
  return findInPath(AGENTS[agentId].cliCommand);
}

/** Look up version from cache by (binary, mtime). On miss or stale, spawn `--version` and cache. */
async function getCachedVersionForBinary(agentId: AgentId, binaryPath: string): Promise<string | null> {
  let mtime = 0;
  try {
    mtime = fs.statSync(binaryPath).mtimeMs;
  } catch {
    /* binary vanished between findInPath and statSync */
    return null;
  }

  const cache = loadCliVersionCache();
  const cached = cache[agentId];
  if (cached && cached.binaryPath === binaryPath && cached.mtime === mtime) {
    return cached.version;
  }

  const agent = AGENTS[agentId];
  let version: string | null = null;
  try {
    const { stdout } = await execFileAsync(agent.cliCommand, ['--version'], { timeout: 3000 });
    if (agentId === 'openclaw') {
      const match = stdout.match(/openclaw\/(\d+\.\d+\.\d+)/);
      version = match ? match[1] : stdout.trim();
    } else {
      const match = stdout.match(/(\d+\.\d+\.\d+)/);
      version = match ? match[1] : stdout.trim();
    }
  } catch {
    /* version command failed */
    version = null;
  }

  // Skip persisting null results — the most common cause is a transient
  // `--version` failure (slow startup, stdout race, etc.). A sticky-null
  // entry kept users in a broken state where every subsequent
  // `getCachedVersionForBinary` short-circuited to null forever, even
  // after the binary started working. Re-probing on the next call costs
  // one execFile; persisting null costs the whole feature.
  if (version !== null) {
    cache[agentId] = { binaryPath, mtime, version };
    saveCliVersionCache();
  }
  return version;
}

/**
 * Resolve the full CLI state for an agent: whether it is installed, its version,
 * and the path to the binary. Checks version-managed installs first, then falls
 * back to a plain PATH lookup.
 */
export async function getCliState(agentId: AgentId): Promise<CliState> {
  // Fast path: if version-managed, derive state from filesystem (no subprocesses)
  const agent = AGENTS[agentId];
  const agentVersionsDir = path.join(getVersionsDir(), agentId);
  if (fs.existsSync(agentVersionsDir)) {
    // Use resolved version (project manifest -> global default)
    const resolvedVer = resolveVersion(agentId, process.cwd());
    if (resolvedVer) {
      const binaryPath = path.join(agentVersionsDir, resolvedVer, 'node_modules', '.bin', agent.cliCommand);
      if (fs.existsSync(binaryPath)) {
        const shimPath = path.join(getShimsDir(), agent.cliCommand);
        return {
          installed: true,
          version: resolvedVer,
          path: fs.existsSync(shimPath) ? shimPath : binaryPath,
        };
      }
    }

    // Fallback: if no default set or resolved version not installed, return first available
    const entries = fs.readdirSync(agentVersionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const binaryPath = path.join(agentVersionsDir, entry.name, 'node_modules', '.bin', agent.cliCommand);
        if (fs.existsSync(binaryPath)) {
          const shimPath = path.join(getShimsDir(), agent.cliCommand);
          return {
            installed: true,
            version: entry.name,
            path: fs.existsSync(shimPath) ? shimPath : binaryPath,
          };
        }
      }
    }
  }

  // Non-version-managed: single PATH lookup + cached version read
  // Special case for grok: it manages its own binaries in ~/.grok/downloads/
  if (agentId === 'grok') {
    const grokBin = resolveGrokBinary();
    if (!grokBin) {
      return { installed: false, version: null, path: null };
    }
    return {
      installed: true,
      version: await getCachedVersionForBinary(agentId, grokBin),
      path: grokBin,
    };
  }

  const binaryPath = findInPath(agent.cliCommand);
  if (!binaryPath) {
    return { installed: false, version: null, path: null };
  }
  return {
    installed: true,
    version: await getCachedVersionForBinary(agentId, binaryPath),
    path: binaryPath,
  };
}

/** Resolve CLI state for all registered agents in parallel. */
export async function getAllCliStates(): Promise<Partial<Record<AgentId, CliState>>> {
  const states: Partial<Record<AgentId, CliState>> = {};
  const results = await Promise.all(
    ALL_AGENT_IDS.map(async (agentId) => ({
      agentId,
      state: await getCliState(agentId),
    }))
  );
  for (const { agentId, state } of results) {
    states[agentId] = state;
  }
  return states;
}

/** Check whether the agent's config directory exists on disk. */
export function isConfigured(agentId: AgentId): boolean {
  const agent = AGENTS[agentId];
  return fs.existsSync(agent.configDir);
}

/** Info about an existing unmanaged agent installation. */
export interface UnmanagedInstall {
  agentId: AgentId;
  configDir: string;
  version: string | null;
}

/**
 * Agents that `agents setup` probes for pre-existing native installations
 * (i.e., a config dir present before agents-cli took over). Add an agent here
 * once its `cliCommand` reports a usable `--version` and its session dir is
 * wired into `getSessionDir`.
 */
export const UNMANAGED_DETECTION_CANDIDATES: AgentId[] = [
  'claude',
  'codex',
  'gemini',
  'grok',
  'copilot',
];

/**
 * Detect existing agent installations that are NOT yet managed by agents-cli.
 * Returns agents whose config dir exists as a real directory (not a symlink).
 */
export async function getUnmanagedAgentInstalls(): Promise<UnmanagedInstall[]> {
  const unmanaged: UnmanagedInstall[] = [];

  for (const agentId of UNMANAGED_DETECTION_CANDIDATES) {
    const agent = AGENTS[agentId];
    try {
      const stat = fs.lstatSync(agent.configDir);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        const version = await getCliVersion(agentId);
        unmanaged.push({ agentId, configDir: agent.configDir, version });
      }
    } catch {
      // Config dir doesn't exist
    }
  }

  return unmanaged;
}

/** Create the agent's slash-commands directory if it does not exist. */
export function ensureCommandsDir(agentId: AgentId): void {
  const agent = AGENTS[agentId];
  if (!fs.existsSync(agent.commandsDir)) {
    fs.mkdirSync(agent.commandsDir, { recursive: true });
  }
}

/** Create the agent's skills directory if it does not exist. */
export function ensureSkillsDir(agentId: AgentId): void {
  const agent = AGENTS[agentId];
  if (!fs.existsSync(agent.skillsDir)) {
    fs.mkdirSync(agent.skillsDir, { recursive: true });
  }
}

/**
 * The agent's config-dir name relative to $HOME — e.g. '.claude',
 * '.gemini/antigravity-cli', '.config/amp', '.kimi-code'.
 *
 * Path segment to join onto a (version) home root when locating an agent's
 * commands/skills/plugins. Do NOT hardcode `.${agentId}`: it is wrong for
 * every agent whose config dir is nested or under ~/.config — antigravity
 * (~/.gemini/antigravity-cli), amp (~/.config/amp), goose (~/.config/goose),
 * kimi (~/.kimi-code). Mirrors the shim configDirName derivation in shims.ts.
 *
 * Relativized against the module-level HOME constant (the same value used to
 * build every `configDir`), NOT a fresh `os.homedir()` — so the result stays a
 * clean relative name even when HOME is overridden after module load (tests,
 * sandboxes). Using `os.homedir()` here would yield `../../real/home/.claude`.
 */
export function agentConfigDirName(agentId: AgentId): string {
  return path.relative(HOME, AGENTS[agentId].configDir);
}

/** Account identity and billing information extracted from an agent's auth config. */
export interface AccountInfo {
  accountKey: string | null;
  usageKey: string | null;
  accountId: string | null;
  organizationId: string | null;
  userId: string | null;
  email: string | null;
  plan: string | null;
  usageStatus: 'available' | 'rate_limited' | 'out_of_credits' | null;
  overageCredits: { amount: number; currency: string } | null;
  lastActive: Date | null;
}

/** Return the email address associated with the agent's auth config, or null. */
export async function getAccountEmail(
  agentId: AgentId,
  home?: string
): Promise<string | null> {
  const info = await getAccountInfo(agentId, home);
  return info.email;
}

/**
 * Extract full account information (identity, plan, usage status, credits) from
 * the agent's local auth/config files. Supports Claude, Codex, and Gemini.
 */
export async function getAccountInfo(
  agentId: AgentId,
  home?: string
): Promise<AccountInfo> {
  const base = home || os.homedir();
  const empty: AccountInfo = {
    accountKey: null,
    usageKey: null,
    accountId: null,
    organizationId: null,
    userId: null,
    email: null,
    plan: null,
    usageStatus: null,
    overageCredits: null,
    lastActive: null,
  };

  const configFiles: Partial<Record<AgentId, string>> = {
    claude: path.join(base, '.claude.json'),
    codex: path.join(base, '.codex', 'auth.json'),
    gemini: path.join(base, '.gemini', 'google_accounts.json'),
  };
  const lastActive = resolveLastActive(agentId, base, configFiles[agentId]);

  try {
    switch (agentId) {
      case 'claude': {
        // Claude reads/writes config at $CLAUDE_CONFIG_DIR/.claude.json when set,
        // falling back to $HOME/.claude.json. Our shim sets CLAUDE_CONFIG_DIR to
        // the per-version .claude dir, so prefer that file; fall back to home-level
        // for versions ever launched without the shim (IDE extension, direct binary).
        const configDirFile = path.join(base, '.claude', '.claude.json');
        const homeLevelFile = path.join(base, '.claude.json');
        const activeFile = fs.existsSync(configDirFile) ? configDirFile : homeLevelFile;
        const data = JSON.parse(await fs.promises.readFile(activeFile, 'utf-8'));
        const oa = data.oauthAccount;
        const accountId = normalizeIdentityPart(oa?.accountUuid);
        const organizationId = normalizeIdentityPart(oa?.organizationUuid);
        const email = oa?.emailAddress || null;
        const accountKey = buildIdentityKey(agentId, [
          ['account', accountId],
          ['org', organizationId],
        ]);
        const usageKey = buildIdentityKey(agentId, [['org', organizationId]]);

        // Plan is derived from .claude.json's billingType only. Reading
        // subscriptionType from the keychain item ("Claude Code-credentials-<hash>")
        // forces a macOS Keychain ACL prompt on every `agents run` (one prompt per
        // installed version under balanced rotation) because Claude Code writes its
        // credentials with its own process in the ACL — our helper isn't trusted by
        // that item. Callers that genuinely need subscriptionType (e.g. detailed
        // `agents view`) should call loadClaudeOauth() directly.
        let plan: string | null = null;
        if (oa?.billingType === 'stripe_subscription') {
          plan = 'Pro';
        } else if (oa?.billingType) {
          plan = oa.billingType;
        }

        // usageStatus is NOT derived from cachedExtraUsageDisabledReason. That
        // field reports why pay-as-you-go overage is off (out_of_credits = no
        // overage credits purchased; org_level_disabled = admin turned overage
        // off), which says nothing about whether the account is throttled — a
        // Pro account at 5% weekly usage with overage disabled is fully usable.
        // Real throttle state comes from the live usage windows; callers derive
        // it via deriveUsageStatusFromSnapshot(). Here we only report whether
        // the account is signed in at all. Overage state stays visible through
        // overageCredits below.
        const usageStatus: AccountInfo['usageStatus'] = email ? 'available' : null;

        let overageCredits: AccountInfo['overageCredits'] = null;
        const orgId = oa?.organizationUuid;
        const creditCache = orgId && data.overageCreditGrantCache?.[orgId];
        if (creditCache?.info?.available && creditCache.info.amount_minor_units) {
          overageCredits = {
            amount: creditCache.info.amount_minor_units / 100,
            currency: creditCache.info.currency || 'USD',
          };
        }

        return {
          accountKey,
          usageKey,
          accountId,
          organizationId,
          userId: null,
          email,
          plan,
          usageStatus,
          overageCredits,
          lastActive,
        };
      }
      case 'codex': {
        const data = JSON.parse(await fs.promises.readFile(path.join(base, '.codex', 'auth.json'), 'utf-8'));
        const token = data.tokens?.id_token || data.tokens?.access_token;
        if (!token) return { ...empty, lastActive };
        const decoded = decodeJwtPayload(token);
        if (!decoded) return { ...empty, lastActive };
        const email = decoded.email || null;

        // Plan and subscription from OpenAI auth claim
        const authClaim = decoded['https://api.openai.com/auth'] || {};
        const accountId = normalizeIdentityPart(authClaim.chatgpt_account_id);
        const userId = normalizeIdentityPart(authClaim.chatgpt_user_id || authClaim.user_id);
        const organizationId = normalizeIdentityPart(getCodexDefaultOrgId(authClaim));
        const accountKey = buildIdentityKey(agentId, [
          ['account', accountId],
          ['user', userId],
          ['org', organizationId],
        ]);
        const rawPlan = authClaim.chatgpt_plan_type;
        const plan = rawPlan ? rawPlan.charAt(0).toUpperCase() + rawPlan.slice(1) : null;

        // Subscription status: expired = out_of_credits
        let usageStatus: AccountInfo['usageStatus'] = null;
        const activeUntil = authClaim.chatgpt_subscription_active_until;
        if (activeUntil) {
          const expired = new Date(activeUntil).getTime() < Date.now();
          usageStatus = expired ? 'out_of_credits' : 'available';
        }

        return {
          accountKey,
          usageKey: accountKey,
          accountId,
          organizationId,
          userId,
          email,
          plan,
          usageStatus,
          overageCredits: null,
          lastActive,
        };
      }
      case 'gemini': {
        const data = JSON.parse(await fs.promises.readFile(path.join(base, '.gemini', 'google_accounts.json'), 'utf-8'));
        return { ...empty, email: data.active || null, lastActive };
      }
      case 'grok': {
        // Grok stores auth in ~/.grok/auth.json
        try {
          const authPath = path.join(base, '.grok', 'auth.json');
          if (fs.existsSync(authPath)) {
            const data = JSON.parse(await fs.promises.readFile(authPath, 'utf-8'));
            const email = data.email || data.user?.email || data.account?.email || null;
            return { ...empty, email, lastActive };
          }
        } catch {}
        return { ...empty, lastActive };
      }
      default:
        return { ...empty, lastActive };
    }
  } catch {
    /* auth/config file missing or unreadable */
    return { ...empty, lastActive };
  }
}

// Fresh window for the cached session walk. Matches USAGE_CACHE_FRESH_MS in
// usage.ts so a launch storm reuses both probes for the same period.
const LAST_ACTIVE_CACHE_FRESH_MS = 2 * 60 * 1000;

const getLastActiveCachePath = () => path.join(getCacheDir(), 'last-active.json');

interface LastActiveCacheEntry {
  /** Newest session-file mtime (ms), or null when the home had no sessions. */
  mtimeMs: number | null;
  /** When the walk that produced this entry ran (ms since epoch). */
  computedAt: number;
}

/**
 * Determine when the agent was last used by checking session file mtimes,
 * falling back to config mtime.
 *
 * The session walk stats every transcript under the home's session dir —
 * thousands of files on long-lived installs — and `agents run` rotation calls
 * this once per installed version on every launch. The walk result is cached
 * on disk for a short window so back-to-back launches skip it entirely.
 * Cache read/write is best-effort: any failure falls back to walking.
 */
export function resolveLastActive(
  agentId: AgentId,
  base: string,
  configPath?: string,
  cachePath = getLastActiveCachePath(),
  now = new Date()
): Date | null {
  const sessionDir = getSessionDir(agentId, base);
  const sessionExt = getSessionExtension(agentId);
  if (sessionDir && sessionExt) {
    const key = `${agentId}:${base}`;
    const cache = readLastActiveCacheFile(cachePath);
    const entry = cache[key];
    const fresh =
      entry &&
      typeof entry.computedAt === 'number' &&
      now.getTime() - entry.computedAt >= 0 &&
      now.getTime() - entry.computedAt < LAST_ACTIVE_CACHE_FRESH_MS;

    if (fresh) {
      if (entry.mtimeMs !== null) return new Date(entry.mtimeMs);
      // Fresh entry with no sessions: fall through to the config mtime below.
    } else {
      const mtimeMs = latestFileMtimeMs(sessionDir, sessionExt);
      cache[key] = { mtimeMs, computedAt: now.getTime() };
      // Stale entries are never served, so drop them on write — keeps homes
      // that no longer exist (removed versions, test temp dirs) from
      // accumulating in the file.
      for (const [k, v] of Object.entries(cache)) {
        if (k !== key && !(typeof v?.computedAt === 'number' && now.getTime() - v.computedAt < LAST_ACTIVE_CACHE_FRESH_MS)) {
          delete cache[k];
        }
      }
      writeLastActiveCacheFile(cache, cachePath);
      if (mtimeMs !== null) return new Date(mtimeMs);
    }
  }

  if (!configPath) return null;
  try {
    return fs.statSync(configPath).mtime;
  } catch {
    return null;
  }
}

/** Read the entire last-active cache file. Missing or corrupt file reads as empty. */
function readLastActiveCacheFile(cachePath: string): Record<string, LastActiveCacheEntry> {
  if (!fs.existsSync(cachePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as Record<string, LastActiveCacheEntry>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Write the entire last-active cache. Best-effort; a failed write just means the next call walks again. */
function writeLastActiveCacheFile(cache: Record<string, LastActiveCacheEntry>, cachePath: string): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf-8');
  } catch {
    /* best-effort */
  }
}

/** Return the root directory where the agent stores session files, or null if unknown. */
function getSessionDir(agentId: AgentId, base: string): string | null {
  switch (agentId) {
    case 'claude':
      return path.join(base, '.claude', 'projects');
    case 'codex':
      return path.join(base, '.codex', 'sessions');
    case 'gemini':
      return path.join(base, '.gemini', 'tmp');
    case 'grok':
      return path.join(base, '.grok', 'sessions');
    case 'copilot':
      // Copilot persists sessions at ~/.copilot/session-state/<id>/events.jsonl.
      // The events.jsonl is the canonical NDJSON event stream per session.
      return path.join(base, '.copilot', 'session-state');
    default:
      return null;
  }
}

/** Return the file extension used for session files by the given agent. */
function getSessionExtension(agentId: AgentId): string | null {
  switch (agentId) {
    case 'claude':
    case 'codex':
    case 'copilot':
      return '.jsonl';
    case 'gemini':
      return '.json';
    case 'grok':
      return '.json'; // sessions contain summary.json, events.jsonl, etc.
    default:
      return null;
  }
}

/**
 * Quick count of session files for an agent (without full DB scan).
 * Used during init to show approximate session count to user.
 */
export function countSessionFiles(agentId: AgentId): number {
  const sessionDir = getSessionDir(agentId, HOME);
  const ext = getSessionExtension(agentId);
  if (!sessionDir || !ext || !fs.existsSync(sessionDir)) return 0;

  let count = 0;
  const walk = (dir: string): void => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name));
        } else if (entry.isFile() && entry.name.endsWith(ext)) {
          count++;
        }
      }
    } catch {
      // Permission denied or other error
    }
  };
  walk(sessionDir);
  return count;
}

/** Decode the payload section of a JWT token without verifying its signature. */
function decodeJwtPayload(token: string): Record<string, any> | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
}

/** Extract the default organization ID from a Codex/OpenAI auth claim. */
function getCodexDefaultOrgId(authClaim: any): string | null {
  const organizations = authClaim?.organizations;
  if (!Array.isArray(organizations)) return null;
  const first = organizations[0];
  return typeof first?.id === 'string' ? first.id : null;
}

/** Trim and normalize an identity string, returning null for empty or non-string values. */
function normalizeIdentityPart(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** Build a composite identity key like "claude:account=abc:org=xyz" from labeled parts. */
function buildIdentityKey(
  agentId: AgentId,
  parts: Array<[label: string, value: string | null]>
): string | null {
  const encoded = parts
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}=${value}`);
  if (encoded.length === 0) return null;
  return `${agentId}:${encoded.join(':')}`;
}

/** Check whether a named MCP server is registered with the agent's CLI. */
export async function isMcpRegistered(agentId: AgentId, mcpName: string): Promise<boolean> {
  const agent = AGENTS[agentId];
  if (!agent.capabilities.mcp || !(await isCliInstalled(agentId))) {
    return false;
  }
  try {
    const { stdout } = await execFileAsync(agent.cliCommand, ['mcp', 'list']);
    return stdout.toLowerCase().includes(mcpName.toLowerCase());
  } catch {
    /* mcp list command failed */
    return false;
  }
}

/** Register an MCP server with an agent's CLI via `mcp add`. */
export async function registerMcp(
  agentId: AgentId,
  name: string,
  command: string,
  scope: 'user' | 'project' = 'user',
  transport: string = 'stdio',
  options?: { home?: string; binary?: string; headers?: Record<string, string> }
): Promise<{ success: boolean; error?: string }> {
  const agent = AGENTS[agentId];
  if (!agent.capabilities.mcp) {
    return { success: false, error: 'Agent does not support MCP' };
  }
  if (transport === 'http' && agentId !== 'claude' && agentId !== 'codex' && agentId !== 'gemini') {
    return { success: false, error: 'skipped: agent does not support HTTP MCP registration' };
  }
  if (transport === 'http' && options?.headers && Object.keys(options.headers).length > 0 && agentId !== 'claude') {
    return { success: false, error: 'skipped: HTTP MCP headers are only supported for Claude registration' };
  }
  if (!options?.binary && !(await isCliInstalled(agentId))) {
    return { success: false, error: 'CLI not installed' };
  }

  try {
    // Use explicit binary path when provided (bypasses shim for version-managed agents)
    const bin = options?.binary || agent.cliCommand;
    let args: string[];
    if (transport === 'http') {
      if (agentId === 'codex') {
        args = ['mcp', 'add', name, '--url', command];
      } else {
        const headerArgs = Object.entries(options?.headers || {}).flatMap(([key, value]) => ['--header', `${key}: ${value}`]);
        args = ['mcp', 'add', '--transport', 'http', '--scope', scope, name, command, ...headerArgs];
      }
    } else if (agentId === 'claude') {
      const commandArgs = splitCommandLine(command);
      args = ['mcp', 'add', '--transport', transport, '--scope', scope, name, '--', ...commandArgs];
    } else {
      const commandArgs = splitCommandLine(command);
      args = ['mcp', 'add', name, '--', ...commandArgs];
    }
    // When home is specified, override HOME so MCP config writes to the version's config dir
    const env = options?.home ? { ...process.env, HOME: options.home } : undefined;
    await execFileAsync(bin, args, env ? { env } : undefined);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** Unregister (remove) a named MCP server from an agent's CLI config. */
export async function unregisterMcp(
  agentId: AgentId,
  name: string,
  options?: { home?: string; binary?: string }
): Promise<{ success: boolean; error?: string }> {
  const agent = AGENTS[agentId];
  if (!agent.capabilities.mcp) {
    return { success: false, error: 'Agent does not support MCP' };
  }
  if (!options?.binary && !(await isCliInstalled(agentId))) {
    return { success: false, error: 'CLI not installed' };
  }

  try {
    const bin = options?.binary || agent.cliCommand;
    const env = options?.home ? { ...process.env, HOME: options.home } : undefined;
    await execFileAsync(bin, ['mcp', 'remove', name], env ? { env } : undefined);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** Result of an MCP registration or removal operation targeting a specific agent and optional version. */
export interface McpTargetOperationResult {
  agentId: AgentId;
  version?: string;
  success: boolean;
  error?: string;
}

/**
 * Register an MCP server across multiple agent targets, including both direct
 * (non-version-managed) agents and specific version-managed installs.
 */
export async function registerMcpToTargets(
  targets: { directAgents: AgentId[]; versionSelections: Map<AgentId, string[]> },
  name: string,
  command: string,
  scope: 'user' | 'project' = 'user',
  transport: string = 'stdio',
  options: { headers?: Record<string, string> } = {}
): Promise<McpTargetOperationResult[]> {
  const results: McpTargetOperationResult[] = [];

  for (const agentId of targets.directAgents) {
    const result = await registerMcp(agentId, name, command, scope, transport, options);
    results.push({ agentId, success: result.success, error: result.error });
  }

  for (const [agentId, versions] of targets.versionSelections) {
    for (const version of versions) {
      const result = await registerMcp(agentId, name, command, scope, transport, {
        ...options,
        home: getVersionHomePath(agentId, version),
        binary: getBinaryPath(agentId, version),
      });
      results.push({ agentId, version, success: result.success, error: result.error });
    }
  }

  return results;
}

/**
 * Unregister an MCP server from multiple agent targets, including both direct
 * agents and specific version-managed installs.
 */
export async function unregisterMcpFromTargets(
  targets: { directAgents: AgentId[]; versionSelections: Map<AgentId, string[]> },
  name: string
): Promise<McpTargetOperationResult[]> {
  const results: McpTargetOperationResult[] = [];

  for (const agentId of targets.directAgents) {
    const result = await unregisterMcp(agentId, name);
    results.push({ agentId, success: result.success, error: result.error });
  }

  for (const [agentId, versions] of targets.versionSelections) {
    for (const version of versions) {
      const result = await unregisterMcp(agentId, name, {
        home: getVersionHomePath(agentId, version),
        binary: getBinaryPath(agentId, version),
      });
      results.push({ agentId, version, success: result.success, error: result.error });
    }
  }

  return results;
}

/** Scope at which an MCP server is registered: user-global or per-project. */
export type McpScope = 'user' | 'project';

/** Describes an MCP server discovered in an agent's config, with its scope and command. */
export interface InstalledMcp {
  name: string;
  scope: McpScope;
  command?: string;
  version?: string;
}

interface McpConfigEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
}

/**
 * Extract version from npm package specification.
 * Examples: @scope/package@latest -> latest
 *           @scope/package@1.2.3 -> 1.2.3
 *           some-package -> undefined
 */
function extractNpmVersion(args: string[]): string | undefined {
  // Find npm package argument (looks like @scope/package@version or package@version)
  for (const arg of args) {
    // Match @scope/package@version or package@version
    const match = arg.match(/@([^@]+)$|^([^@]+)@(.+)$/);
    if (match) {
      // @scope/package@version pattern
      const versionMatch = arg.match(/@([^@/]+)$/);
      if (versionMatch) {
        return versionMatch[1];
      }
    }
  }
  return undefined;
}

/**
 * Strip JSON comments for JSONC parsing.
 * Only removes comments outside of strings.
 */
function stripJsonComments(content: string): string {
  let result = '';
  let inString = false;
  let escape = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    const next = content[i + 1];

    if (escape) {
      result += char;
      escape = false;
      i++;
      continue;
    }

    if (char === '\\' && inString) {
      result += char;
      escape = true;
      i++;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      result += char;
      i++;
      continue;
    }

    if (!inString) {
      // Check for single-line comment
      if (char === '/' && next === '/') {
        // Skip until end of line
        while (i < content.length && content[i] !== '\n') {
          i++;
        }
        continue;
      }
      // Check for multi-line comment
      if (char === '/' && next === '*') {
        i += 2;
        while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) {
          i++;
        }
        i += 2; // Skip */
        continue;
      }
    }

    result += char;
    i++;
  }

  return result;
}

/**
 * Parse MCP servers from a JSON/JSONC config file.
 */
function parseMcpFromJsonConfig(configPath: string): Record<string, McpConfigEntry> {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    let content = fs.readFileSync(configPath, 'utf-8');
    // Handle JSONC (JSON with comments)
    if (configPath.endsWith('.jsonc')) {
      content = stripJsonComments(content);
    }
    const config = JSON.parse(content);

    // Claude uses mcpServers, others may use mcp_servers or mcp
    return config.mcpServers || config.mcp_servers || config.mcp || {};
  } catch {
    /* JSON config corrupt or unreadable */
    return {};
  }
}

/**
 * Parse MCP servers from a TOML config file (Codex).
 * Codex stores MCPs as [mcp_servers.ServerName] sections.
 */
function parseMcpFromTomlConfig(configPath: string): Record<string, McpConfigEntry> {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = TOML.parse(content) as Record<string, unknown>;

    // Codex uses mcp_servers as a table with server names as keys
    const mcpServers = config.mcp_servers as Record<string, McpConfigEntry> | undefined;
    return mcpServers || {};
  } catch {
    /* TOML config corrupt or unreadable */
    return {};
  }
}

/**
 * Parse MCP servers from OpenCode's JSONC config.
 * OpenCode stores MCPs in the "mcp" object with different structure.
 */
function parseMcpFromOpenCodeConfig(configPath: string): Record<string, McpConfigEntry> {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const content = stripJsonComments(fs.readFileSync(configPath, 'utf-8'));
    const config = JSON.parse(content);
    const mcpConfig = config.mcp as Record<string, {
      type?: string;
      command?: string[];
      url?: string;
      enabled?: boolean;
    }> | undefined;

    if (!mcpConfig) return {};

    // Convert OpenCode format to our McpConfigEntry format
    const result: Record<string, McpConfigEntry> = {};
    for (const [name, entry] of Object.entries(mcpConfig)) {
      if (entry.type === 'local' && entry.command) {
        // Local MCP: command is an array like ["npx", "-y", "@pkg@version"]
        result[name] = {
          command: entry.command[0],
          args: entry.command.slice(1),
        };
      } else if (entry.type === 'remote' && entry.url) {
        // Remote MCP: HTTP URL
        result[name] = {
          url: entry.url,
        };
      }
    }
    return result;
  } catch {
    /* OpenCode JSONC config corrupt or unreadable */
    return {};
  }
}

/**
 * Get user-scoped MCP config path for an agent.
 */
export function getUserMcpConfigPath(agentId: AgentId): string {
  const agent = AGENTS[agentId];

  switch (agentId) {
    case 'claude':
      // Claude user-scoped MCPs are in ~/.claude.json (global user config)
      return path.join(HOME, '.claude.json');
    case 'codex':
      // Codex uses TOML config
      return path.join(agent.configDir, 'config.toml');
    case 'opencode':
      // OpenCode uses JSONC config
      return path.join(agent.configDir, 'opencode.jsonc');
    case 'cursor':
      // Cursor uses mcp.json
      return path.join(agent.configDir, 'mcp.json');
    case 'openclaw':
      // OpenClaw uses openclaw.json
      return path.join(agent.configDir, 'openclaw.json');
    case 'copilot':
      // GitHub Copilot CLI uses mcp-config.json (matches versioned + project paths)
      return path.join(agent.configDir, 'mcp-config.json');
    case 'antigravity':
      // agy uses mcp_config.json inside its nested config dir (~/.gemini/antigravity-cli/)
      return path.join(agent.configDir, 'mcp_config.json');
    case 'grok':
      // grok mcp.json — exact field schema verified at first install
      return path.join(agent.configDir, 'mcp.json');
    case 'droid':
      // Factory AI Droid stores MCPs in ~/.factory/mcp.json
      return path.join(agent.configDir, 'mcp.json');
    default:
      // Gemini and others use settings.json
      return path.join(agent.configDir, 'settings.json');
  }
}

/**
 * Get MCP config path for a specific HOME directory (used for version-managed agents).
 */
export function getMcpConfigPathForHome(agentId: AgentId, home: string): string {
  switch (agentId) {
    case 'claude':
      return path.join(home, '.claude.json');
    case 'codex':
      return path.join(home, '.codex', 'config.toml');
    case 'opencode':
      return path.join(home, '.opencode', 'opencode.jsonc');
    case 'cursor':
      return path.join(home, '.cursor', 'mcp.json');
    case 'openclaw':
      return path.join(home, '.openclaw', 'openclaw.json');
    case 'copilot':
      return path.join(home, '.copilot', 'mcp-config.json');
    case 'amp':
      return path.join(home, '.config', 'amp', 'settings.json');
    case 'kiro':
      return path.join(home, '.kiro', 'settings', 'mcp.json');
    case 'goose':
      return path.join(home, '.config', 'goose', 'config.yaml');
    case 'roo':
      return path.join(home, '.roo', 'mcp.json');
    case 'antigravity':
      return path.join(home, '.gemini', 'antigravity-cli', 'mcp_config.json');
    case 'grok':
      return path.join(home, '.grok', 'config.toml');
    case 'droid':
      return path.join(home, '.factory', 'mcp.json');
    default:
      return path.join(home, agentConfigDirName(agentId), 'settings.json');
  }
}

/**
 * Get project-scoped MCP config path for an agent.
 */
function getProjectMcpConfigPath(agentId: AgentId, cwd: string = process.cwd()): string {
  switch (agentId) {
    case 'claude':
      // Claude uses .mcp.json at project root for project-scoped MCPs
      return path.join(cwd, '.mcp.json');
    case 'codex':
      return path.join(cwd, `.${agentId}`, 'config.toml');
    case 'opencode':
      return path.join(cwd, `.${agentId}`, 'opencode.jsonc');
    case 'cursor':
      return path.join(cwd, `.${agentId}`, 'mcp.json');
    case 'openclaw':
      return path.join(cwd, `.${agentId}`, 'openclaw.json');
    case 'gemini':
      return path.join(cwd, `.${agentId}`, 'settings.json');
    case 'copilot':
      return path.join(cwd, '.copilot', 'mcp-config.json');
    case 'amp':
      return path.join(cwd, '.amp', 'settings.json');
    case 'kiro':
      return path.join(cwd, '.kiro', 'settings', 'mcp.json');
    case 'goose':
      return path.join(cwd, '.goose', 'config.yaml');
    case 'roo':
      return path.join(cwd, '.roo', 'mcp.json');
    case 'antigravity':
      return path.join(cwd, '.gemini', 'antigravity-cli', 'mcp_config.json');
    case 'grok':
      return path.join(cwd, '.grok', 'config.toml');
    case 'droid':
      return path.join(cwd, '.factory', 'mcp.json');
    default:
      return path.join(cwd, `.${agentId}`, 'settings.json');
  }
}

/**
 * Parse MCP servers from OpenClaw's JSON config.
 * OpenClaw stores MCPs under mcp.servers with a similar structure to other agents.
 */
function parseMcpFromOpenClawConfig(configPath: string): Record<string, McpConfigEntry> {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);

    // OpenClaw uses mcp.servers for MCP configuration
    const mcpServers = config.mcp?.servers as Record<string, {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      transport?: string;
    }> | undefined;

    if (!mcpServers) return {};

    const result: Record<string, McpConfigEntry> = {};
    for (const [name, entry] of Object.entries(mcpServers)) {
      if (entry.command) {
        result[name] = {
          command: entry.command,
          args: entry.args,
          env: entry.env,
        };
      } else if (entry.url) {
        result[name] = {
          url: entry.url,
          type: entry.transport || 'sse',
        };
      }
    }
    return result;
  } catch {
    /* OpenClaw JSON config corrupt or unreadable */
    return {};
  }
}

/**
 * Parse MCP config based on agent type.
 */
export function parseMcpConfig(agentId: AgentId, configPath: string): Record<string, McpConfigEntry> {
  switch (agentId) {
    case 'codex':
      return parseMcpFromTomlConfig(configPath);
    case 'opencode':
      return parseMcpFromOpenCodeConfig(configPath);
    case 'openclaw':
      return parseMcpFromOpenClawConfig(configPath);
    default:
      return parseMcpFromJsonConfig(configPath);
  }
}

/**
 * List installed MCP servers with scope information.
 * Pass options.home to read from a version-managed agent's home directory.
 */
export function listInstalledMcpsWithScope(
  agentId: AgentId,
  cwd: string = process.cwd(),
  options?: { home?: string }
): InstalledMcp[] {
  const results: InstalledMcp[] = [];

  // Helper to build full command string
  const buildCommand = (config: McpConfigEntry): string | undefined => {
    if (config.command && config.args?.length) {
      return `${config.command} ${config.args.join(' ')}`;
    }
    return config.command || (config.args ? config.args.join(' ') : undefined);
  };

  // User-scoped MCPs (version-aware when home is provided)
  const userConfigPath = options?.home
    ? getMcpConfigPathForHome(agentId, options.home)
    : getUserMcpConfigPath(agentId);
  const userMcps = parseMcpConfig(agentId, userConfigPath);
  for (const [name, config] of Object.entries(userMcps)) {
    results.push({
      name,
      scope: 'user',
      command: buildCommand(config),
      version: config.args ? extractNpmVersion(config.args) : undefined,
    });
  }

  // Project-scoped MCPs
  const projectConfigPath = getProjectMcpConfigPath(agentId, cwd);
  const projectMcps = parseMcpConfig(agentId, projectConfigPath);
  for (const [name, config] of Object.entries(projectMcps)) {
    // Skip if already in user scope (project can override, but we show both)
    results.push({
      name,
      scope: 'project',
      command: buildCommand(config),
      version: config.args ? extractNpmVersion(config.args) : undefined,
    });
  }

  return results;
}

/** Map of agent name aliases and shorthand identifiers to canonical AgentId values. */
export const AGENT_NAME_ALIASES: Record<string, AgentId> = {
  claude: 'claude',
  'claude-code': 'claude',
  cc: 'claude',
  codex: 'codex',
  'openai-codex': 'codex',
  cx: 'codex',
  gemini: 'gemini',
  'gemini-cli': 'gemini',
  gx: 'gemini',
  cursor: 'cursor',
  'cursor-agent': 'cursor',
  cr: 'cursor',
  opencode: 'opencode',
  oc: 'opencode',
  openclaw: 'openclaw',
  claw: 'openclaw',
  ocl: 'openclaw',
  copilot: 'copilot',
  'copilot-cli': 'copilot',
  'github-copilot': 'copilot',
  gh: 'copilot',
  amp: 'amp',
  sourcegraph: 'amp',
  kiro: 'kiro',
  'kiro-cli': 'kiro',
  goose: 'goose',
  'block-goose': 'goose',
  roo: 'roo',
  'roo-code': 'roo',
  roocode: 'roo',
  antigravity: 'antigravity',
  'google-antigravity': 'antigravity',
  agy: 'antigravity',
  ag: 'antigravity',
  grok: 'grok',
  'grok-build': 'grok',
  'xai-grok': 'grok',
  gk: 'grok',
  kimi: 'kimi',
  'kimi-code': 'kimi',
};

/**
 * Resolve a user-provided agent name (alias, shorthand, or canonical) to its AgentId.
 * Tolerates a single typo (insertion/deletion/substitution/transposition) against
 * canonical ids and aliases — `cladue` -> claude, `kim` -> kimi, `codx` -> codex —
 * but only when the correction is unambiguous (all distance-1 candidates agree on
 * one agent). Two-letter shorthands are excluded as fuzzy candidates.
 */
export function resolveAgentName(input: string): AgentId | null {
  const lower = input.toLowerCase();
  const exact = AGENT_NAME_ALIASES[lower] ?? (AGENTS[lower as AgentId] ? (lower as AgentId) : null);
  if (exact || lower.length < 3) return exact;

  const hits = new Set<AgentId>();
  for (const id of ALL_AGENT_IDS) {
    if (damerauLevenshtein(lower, id) === 1) hits.add(id);
  }
  for (const [key, id] of Object.entries(AGENT_NAME_ALIASES)) {
    if (key.length >= 3 && damerauLevenshtein(lower, key) === 1) hits.add(id);
  }
  return hits.size === 1 ? hits.values().next().value! : null;
}

/** Check whether the input string matches any known agent name or alias. */
export function isAgentName(input: string): boolean {
  return resolveAgentName(input) !== null;
}

/** Format an error message for an unrecognized agent name, listing valid options. */
export function formatAgentError(agentName: string, validAgents: AgentId[] = ALL_AGENT_IDS): string {
  return `Unknown agent '${agentName}'. Valid agents: ${validAgents.join(', ')}`;
}
