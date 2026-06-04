/**
 * Agent execution -- command building, process spawning, and rate-limit fallback.
 *
 * Translates high-level ExecOptions into CLI invocations for each supported agent,
 * manages environment isolation per agent, and chains fallback agents on rate limits.
 */
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as path from 'path';
import type { AgentId, Mode } from './types.js';
import { ALL_MODES } from './types.js';
import { AGENTS } from './agents.js';
import { parseTimeout } from './routines.js';
import { getVersionHomePath, isVersionInstalled, resolveVersion } from './versions.js';
import { resolveModel, buildReasoningFlags } from './models.js';
import { emitStart, maybeRotate, createTimer, redactPrompt, redactArgs } from './events.js';
import { sanitizeProcessEnv } from './secrets/bundles.js';

/**
 * Agent execution modes. Canonical name `skip` (dangerously skip permissions);
 * `full` is accepted as a permanent silent alias via normalizeMode().
 */
export type ExecMode = Mode;

/**
 * Map a raw mode string (CLI flag, YAML field, env var) to the canonical Mode.
 *
 * Accepts the historical `full` spelling and rewrites it to `skip`. Throws on
 * anything outside the four canonical values so bad input fails loud at the
 * boundary rather than silently picking a wrong code path.
 */
export function normalizeMode(input: string | null | undefined): Mode {
  if (!input) {
    throw new Error(`Mode is required. Use one of: ${ALL_MODES.join(', ')}.`);
  }
  const v = input.trim().toLowerCase();
  if (v === 'full') return 'skip';
  if ((ALL_MODES as readonly string[]).includes(v)) return v as Mode;
  throw new Error(`Invalid mode '${input}'. Use one of: ${ALL_MODES.join(', ')} (or 'full' as a deprecated alias for 'skip').`);
}

/**
 * Resolve a requested mode against an agent's capability table.
 *
 * - `auto` on an agent without auto support silently degrades to `edit`
 *   (every agent supports edit-like behavior as its default).
 * - `skip` on an agent without skip support throws with a clear message
 *   naming the agent's supported modes. No silent fallback — the user
 *   explicitly asked to bypass permissions; pretending we did is unsafe.
 * - `plan` on an agent without plan support throws the same way.
 */
export function resolveMode(agent: AgentId, requested: Mode): Mode {
  const supported = AGENTS[agent].capabilities.modes;
  if (supported.includes(requested)) return requested;

  if (requested === 'auto') {
    // Fall back to edit — guaranteed to exist on every agent (every agent has
    // at least 'edit' in its modes table, since that's the default behavior).
    return 'edit';
  }

  throw new Error(
    `${agent} does not support '${requested}' mode. Supported modes: ${supported.join(', ')}.`,
  );
}

/** Reasoning effort levels passed to agents that support them. 'auto' defers to the agent's default. */
export type ExecEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

/** Options for spawning an agent process. Omitting `prompt` launches the CLI interactively. */
export interface ExecOptions {
  agent: AgentId;
  version?: string;
  /** Omit to launch the CLI interactively -- no prompt, no --print, stdio fully inherited. */
  prompt?: string;
  /** Force interactive mode even when a prompt is provided. */
  interactive?: boolean;
  mode: ExecMode;
  effort: ExecEffort;
  cwd?: string;
  headless?: boolean;
  json?: boolean;
  model?: string;
  addDirs?: string[];
  timeout?: string;
  sessionId?: string;
  verbose?: boolean;
  env?: Record<string, string>;
}

/** Pattern for valid environment variable names (C identifier rules). */
const EXEC_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse a single KEY=VALUE string into a tuple, validating the key name. */
function parseExecEnvEntry(entry: string): [string, string] {
  const separatorIndex = entry.indexOf('=');
  if (separatorIndex <= 0) {
    throw new Error(`Invalid --env value "${entry}". Use KEY=VALUE.`);
  }

  const key = entry.slice(0, separatorIndex).trim();
  const value = entry.slice(separatorIndex + 1);

  if (!EXEC_ENV_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid environment variable name "${key}".`);
  }

  return [key, value];
}

/** Parse an array of KEY=VALUE strings into an env record. Returns undefined for empty input. */
export function parseExecEnv(entries: string[]): Record<string, string> | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries.map(parseExecEnvEntry));
}

/**
 * Build the process environment for an agent invocation.
 * Pins CLAUDE_CONFIG_DIR for Claude, CODEX_HOME for Codex, and COPILOT_HOME
 * for GitHub Copilot; strips the other agents' env vars so they don't leak
 * into unrelated invocations.
 */
export function buildExecEnv(options: ExecOptions): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...sanitizeProcessEnv(process.env) };

  // Config-dir env vars are agent-specific. When the caller is running inside
  // an agent-managed shell, process.env already carries one; spreading into a
  // different agent's env would leak a config pointer the target CLI doesn't
  // understand. Strip foreign vars and pin the right one to the versioned home.
  if (options.agent === 'claude') {
    const cwd = options.cwd || process.cwd();
    const resolvedVersion = options.version ?? resolveVersion('claude', cwd);
    // Use an explicitly pinned version unconditionally; for auto-resolved versions
    // only inject the path when the version is actually installed on disk.
    const version = options.version
      ? resolvedVersion
      : (resolvedVersion && isVersionInstalled('claude', resolvedVersion) ? resolvedVersion : null);
    if (version) {
      result.CLAUDE_CONFIG_DIR = path.join(getVersionHomePath('claude', version), '.claude');
    }
    delete result.CODEX_HOME;
    delete result.COPILOT_HOME;
  } else if (options.agent === 'codex') {
    const cwd = options.cwd || process.cwd();
    const resolvedVersion = options.version ?? resolveVersion('codex', cwd);
    const version = options.version
      ? resolvedVersion
      : (resolvedVersion && isVersionInstalled('codex', resolvedVersion) ? resolvedVersion : null);
    if (version) {
      result.CODEX_HOME = path.join(getVersionHomePath('codex', version), '.codex');
    }
    delete result.CLAUDE_CONFIG_DIR;
    delete result.COPILOT_HOME;
  } else if (options.agent === 'copilot') {
    // Copilot honors COPILOT_HOME (relocates ~/.copilot, including settings,
    // mcp-config.json, sessions, logs). Pin it at the per-version home so
    // version switches isolate MCP servers, auth, and session history.
    const cwd = options.cwd || process.cwd();
    const resolvedVersion = options.version ?? resolveVersion('copilot', cwd);
    const version = options.version
      ? resolvedVersion
      : (resolvedVersion && isVersionInstalled('copilot', resolvedVersion) ? resolvedVersion : null);
    if (version) {
      result.COPILOT_HOME = path.join(getVersionHomePath('copilot', version), '.copilot');
    }
    delete result.CLAUDE_CONFIG_DIR;
    delete result.CODEX_HOME;
  } else {
    delete result.CLAUDE_CONFIG_DIR;
    delete result.CODEX_HOME;
    delete result.COPILOT_HOME;
  }

  return {
    ...result,
    ...options.env,
  };
}


/**
 * Describes how to translate ExecOptions into CLI arguments for a specific agent.
 *
 * `modeFlags` only declares modes this agent natively supports. Keys must agree
 * with AGENTS[agent].capabilities.modes — resolveMode() routes a request to a
 * supported mode (or throws), then buildExecCommand looks up the flags here.
 */
export interface AgentCommandTemplate {
  base: string[];
  promptFlag: 'positional' | string;
  modeFlags: Partial<Record<Mode, string[]>>;
  jsonFlags?: string[];
  modelFlag?: string;
  printFlags?: string[];
  verboseFlag?: string;
}

/**
 * CLI command templates for every supported agent.
 *
 * Each agent's `modeFlags` keys MUST match the modes listed in
 * AGENTS[agent].capabilities.modes. A test in exec.test.ts asserts this.
 */
export const AGENT_COMMANDS: Record<AgentId, AgentCommandTemplate> = {
  claude: {
    base: ['claude'],
    promptFlag: '-p',
    modeFlags: {
      plan: ['--permission-mode', 'plan'],
      edit: ['--permission-mode', 'acceptEdits'],
      auto: ['--permission-mode', 'auto'],
      skip: ['--dangerously-skip-permissions'],
    },
    jsonFlags: ['--output-format', 'stream-json', '--verbose'],
    modelFlag: '--model',
    printFlags: ['--print'],
    verboseFlag: '--verbose',
  },
  codex: {
    base: ['codex', 'exec'],
    promptFlag: 'positional',
    modeFlags: {
      // NOTE: codex has no read-only mode in --sandbox; 'plan' here means
      // "workspace-write but no auto-approval" — closer to plan-as-restraint.
      // True read-only requires --sandbox read-only which we haven't wired.
      plan: ['--sandbox', 'workspace-write'],
      edit: ['--sandbox', 'workspace-write', '--full-auto'],
      // skip drops the sandbox entirely; --full-auto then approves anything.
      skip: ['--full-auto'],
    },
    jsonFlags: ['--json'],
    modelFlag: '--model',
  },
  gemini: {
    base: ['gemini'],
    promptFlag: 'positional',
    modeFlags: {
      plan: ['--approval-mode', 'plan'],
      edit: ['--approval-mode', 'auto_edit'],
      skip: ['--yolo'],
    },
    jsonFlags: ['--output-format', 'stream-json'],
    modelFlag: '--model',
  },
  cursor: {
    base: ['cursor-agent'],
    promptFlag: '-p',
    modeFlags: {
      // cursor-agent has no read-only flag; we only expose edit + skip.
      edit: [],
      skip: ['-f'],
    },
    jsonFlags: ['--output-format', 'stream-json'],
    modelFlag: '--model',
  },
  opencode: {
    base: ['opencode', 'run'],
    promptFlag: 'positional',
    modeFlags: {
      plan: ['--agent', 'plan'],
      edit: ['--agent', 'build'],
    },
    jsonFlags: ['--format', 'json'],
    modelFlag: '--model',
  },
  openclaw: {
    base: ['openclaw'],
    promptFlag: 'positional',
    modeFlags: {
      plan: ['--mode', 'plan'],
      edit: ['--mode', 'edit'],
      skip: ['--mode', 'full'],
    },
    jsonFlags: ['--output-format', 'stream-json'],
    modelFlag: '--model',
  },
  // GitHub Copilot CLI (`@github/copilot`, GA 2026-02-25). Flags verified
  // against `copilot --help` from v0.0.413+:
  //   -p, --prompt <text>          non-interactive one-shot
  //   --mode <interactive|plan|autopilot>
  //   --autopilot                  start in autopilot (smart-classifier) mode
  //   --allow-all-tools            required for non-interactive tool exec
  //   --allow-all (alias --yolo)   tools + paths + URLs
  //   --output-format <text|json>  json => JSONL, one object per line
  //   --model <model>
  // Plan mode is read-only so it does not need an allow-tools grant; edit
  // needs --allow-all-tools so headless runs don't stall on prompts.
  copilot: {
    base: ['copilot'],
    promptFlag: '-p',
    modeFlags: {
      plan: ['--mode', 'plan'],
      edit: ['--allow-all-tools'],
      auto: ['--autopilot'],
      skip: ['--allow-all'],
    },
    jsonFlags: ['--output-format', 'json'],
    modelFlag: '--model',
  },
  amp: {
    base: ['amp'],
    promptFlag: 'positional',
    modeFlags: {
      plan: ['--mode', 'plan'],
      edit: ['--mode', 'edit'],
    },
    modelFlag: '--model',
  },
  kiro: {
    base: ['kiro-cli'],
    promptFlag: 'positional',
    modeFlags: {
      // kiro-cli has no permission flags — edit is the default behavior.
      edit: [],
    },
    modelFlag: '--model',
  },
  goose: {
    base: ['goose', 'run'],
    promptFlag: 'positional',
    modeFlags: {
      // goose has no permission flags — edit is the default behavior.
      edit: [],
    },
  },
  roo: {
    base: ['roo'],
    promptFlag: 'positional',
    modeFlags: {
      plan: ['--mode', 'architect'],
      edit: ['--mode', 'code'],
    },
    modelFlag: '--model',
  },
  // TODO: --output-format json is documented but currently broken upstream
  // ("flags provided but not defined: -output-format"). Track resolution at
  // https://github.com/google-antigravity/antigravity-cli/issues/7 before
  // adding `jsonFlags` here.
  antigravity: {
    base: ['agy'],
    promptFlag: 'positional',
    modeFlags: {
      // agy --help shows no plan/edit flags; default behavior is edit-like
      // (prompts on tool use). Only skip has an explicit flag.
      edit: [],
      skip: ['--dangerously-skip-permissions'],
    },
    modelFlag: '--model',
  },
  grok: {
    base: ['grok'],
    promptFlag: '-p',
    modeFlags: {
      // grok defaults to plan mode; --permission-mode <MODE> exists in --help
      // (modes not enumerated). Preserve historical --mode plan behavior until
      // someone with a working grok install can verify the canonical spelling.
      plan: ['--mode', 'plan'],
      edit: [],
      skip: ['--always-approve'],
    },
    jsonFlags: ['--output-format', 'streaming-json'],
    modelFlag: '--model',
  },
};

/** Assemble the full CLI argument array for an agent invocation. */
export function buildExecCommand(options: ExecOptions): string[] {
  const template = AGENT_COMMANDS[options.agent];
  const cmd: string[] = [...template.base];
  const interactive = options.interactive === true || options.prompt === undefined;

  // For Codex, 'exec' is the headless subcommand -- drop it for interactive mode
  // so we run 'codex' (TUI) instead of 'codex exec' (one-shot)
  if (options.agent === 'codex' && interactive && cmd[1] === 'exec') {
    cmd.splice(1, 1);
  }

  // Use versioned alias if a specific version was requested (e.g., claude@2.1.98)
  if (options.version && cmd.length > 0) {
    cmd[0] = `${cmd[0]}@${options.version}`;
  }

  // Add reasoning effort flags (before mode flags for codex -c positioning)
  // For codex, -c must come before 'exec' subcommand, so we insert at position 1
  if (options.effort !== 'auto') {
    const reasoningFlags = buildReasoningFlags(options.agent, options.effort);
    if (reasoningFlags.length > 0) {
      if (options.agent === 'codex') {
        // Insert after 'codex' (or 'codex@version') but before 'exec'
        cmd.splice(1, 0, ...reasoningFlags);
      } else {
        // For other agents, append after base
        cmd.push(...reasoningFlags);
      }
    }
  }

  // Resolve the requested mode against the agent's capability table.
  // - `auto` on an agent without auto support → silently degrades to `edit`
  // - `skip`/`plan` on an unsupported agent → throws a clear error
  // After resolveMode, the chosen mode is guaranteed to be in template.modeFlags.
  const resolvedMode = resolveMode(options.agent, normalizeMode(options.mode));
  const modeFlags = template.modeFlags[resolvedMode];
  if (!modeFlags) {
    // Defense in depth: would only fire if AGENTS.capabilities.modes and
    // AGENT_COMMANDS.modeFlags drifted apart. Tests assert they agree.
    throw new Error(
      `Internal error: ${options.agent} declares '${resolvedMode}' in capabilities.modes but has no entry in AGENT_COMMANDS.modeFlags.${resolvedMode}.`,
    );
  }
  cmd.push(...modeFlags);

  // Add print/headless flags only when a prompt is provided. Without a prompt
  // the caller wants an interactive REPL -- passing --print would immediately
  // wait on stdin and never render the TUI.
  if (!interactive && options.headless && template.printFlags) {
    cmd.push(...template.printFlags);
  }

  // Add session ID (Claude only)
  if (options.sessionId && options.agent === 'claude') {
    cmd.push('--session-id', options.sessionId);
  }

  // Add model (only if explicitly provided by user)
  if (options.model && template.modelFlag) {
    const effectiveVersion = options.version || resolveVersion(options.agent, options.cwd || process.cwd());
    if (effectiveVersion) {
      const resolved = resolveModel(options.agent, effectiveVersion, options.model);
      if (resolved.warning) {
        process.stderr.write(`[agents] ${resolved.warning}\n`);
      }
      cmd.push(template.modelFlag, resolved.forwarded);
    } else {
      cmd.push(template.modelFlag, options.model);
    }
  }

  // Add JSON output flags if requested
  if (options.json && template.jsonFlags) {
    cmd.push(...template.jsonFlags);
  }

  // Add verbose flag independently of JSON
  if (options.verbose && template.verboseFlag) {
    // Avoid duplicate if jsonFlags already included --verbose
    if (!(options.json && template.jsonFlags?.includes(template.verboseFlag))) {
      cmd.push(template.verboseFlag);
    }
  }

  // Add prompt when provided. In pure interactive mode (no prompt) we skip this
  // so the CLI launches its TUI. When --interactive is passed alongside a prompt
  // we still forward the prompt so the agent receives it as the first message.
  if (options.prompt !== undefined) {
    if (template.promptFlag === 'positional') {
      cmd.push(options.prompt);
    } else {
      cmd.push(template.promptFlag, options.prompt);
    }
  }

  // Claude-specific: add dirs
  if (options.agent === 'claude' && options.addDirs) {
    for (const dir of options.addDirs) {
      cmd.push('--add-dir', dir);
    }
  }

  return cmd;
}

/** Spawn an agent and return its exit code. Convenience wrapper over spawnAgent. */
export async function execAgent(options: ExecOptions): Promise<number> {
  const { exitCode } = await spawnAgent(options);
  return exitCode;
}

/** Exit code and captured stderr from a spawned agent process. */
interface SpawnResult {
  exitCode: number;
  stderr: string;
}

/**
 * Spawn an agent process and return its exit code plus a tee'd copy of stderr.
 *
 * Stderr is always piped so the caller can inspect it (e.g., for rate-limit
 * detection) while also forwarding every chunk to process.stderr in real time --
 * the user sees the same output they would with stdio: 'inherit'. Stdout keeps
 * the original behavior: 'pipe' when downstream output is piped (so `agents
 * run ... | ...` composes cleanly), otherwise 'inherit' so TTY output is
 * unbuffered.
 */
async function spawnAgent(options: ExecOptions): Promise<SpawnResult> {
  const cmd = buildExecCommand(options);
  const [executable, ...args] = cmd;

  const timeoutMs = options.timeout ? parseTimeout(options.timeout) : undefined;
  const piped = !process.stdout.isTTY;
  const interactive = options.interactive === true || options.prompt === undefined;

  maybeRotate();
  const timer = createTimer('agent.run', {
    agent: options.agent,
    version: options.version,
    cwd: options.cwd || process.cwd(),
    mode: options.mode,
    model: options.model,
    interactive,
    sessionId: options.sessionId,
    ...redactPrompt(options.prompt),
    command: executable,
    args: redactArgs(args.slice(0, 10)),
  });

  return new Promise((resolve, reject) => {
    // Interactive mode inherits all stdio so the CLI owns the TTY (TUI
    // rendering, raw-mode keystrokes, colored output). Headless mode pipes
    // stderr so we can scan for rate limits and feed fallback. stdout stays
    // inherited for TTY, piped when the caller pipes us downstream.
    const stdio: ('inherit' | 'pipe')[] = interactive
      ? ['inherit', 'inherit', 'inherit']
      : ['inherit', piped ? 'pipe' : 'inherit', 'pipe'];

    const child = spawn(executable, args, {
      cwd: options.cwd || process.cwd(),
      stdio,
      env: buildExecEnv(options),
      shell: false,
    });

    // Mark startup time (time from function call to process spawn)
    timer.mark('startup');

    if (!interactive && piped && child.stdout) {
      child.stdout.pipe(process.stdout);
    }

    let stderrBuffer = '';
    const STDERR_BUFFER_CAP = 64 * 1024;
    if (!interactive && child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk);
        if (stderrBuffer.length < STDERR_BUFFER_CAP) {
          stderrBuffer += chunk.toString('utf-8');
          if (stderrBuffer.length > STDERR_BUFFER_CAP) {
            stderrBuffer = stderrBuffer.slice(-STDERR_BUFFER_CAP);
          }
        }
      });
    }

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      timeoutTimer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
      }, timeoutMs);
    }

    child.on('error', (err) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timer.end({ error: err.message, exitCode: -1, status: 'error' });
      reject(err);
    });
    child.on('close', (code) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timer.end({ exitCode: code ?? 0, status: code === 0 ? 'success' : 'failed' });
      resolve({ exitCode: code ?? 0, stderr: stderrBuffer });
    });
  });
}

/**
 * Patterns that indicate a rate/usage limit. Matching is intentionally broad
 * because providers phrase these differently -- Anthropic uses "5-hour limit"
 * and "rate limit", OpenAI surfaces 429s, Google says "quota exceeded".
 * False positives here just trigger a fallback attempt; false negatives leave
 * the original error unhandled, which is worse.
 */
export const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate[\s-]?limit/i,
  /usage[\s-]?limit/i,
  /quota\s*(exceeded|reached|limit)/i,
  /\b429\b/,
  /5[\s-]?hour[\s-]?limit/i,
  /too many requests/i,
  /api[\s_-]?overloaded/i,
  /\boverloaded\b/i,
];

/** Return true if the text contains any known rate-limit or overload indicator. */
export function detectRateLimit(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some(pattern => pattern.test(text));
}

/** An agent (with optional pinned version) in a fallback chain. */
export interface FallbackEntry {
  agent: AgentId;
  /** Optional pinned version (e.g. '0.116.0'). When set, takes precedence over the active default. */
  version?: string;
}

/** ExecOptions extended with a fallback chain for rate-limit cascading. */
export interface FallbackOptions extends ExecOptions {
  /** Ordered list of agents to try if the primary (options.agent) hits a rate limit. */
  fallback: FallbackEntry[];
  /** Fallback requires a prompt -- chain handoff doesn't apply to interactive sessions. */
  prompt: string;
}

/**
 * Build the prompt handed to the fallback agent when the primary was stopped
 * mid-task by a rate limit.
 *
 * When the prior agent was Claude we pin its session ID via `--session-id` so
 * `prevSessionId` is always defined; for other primaries we pass undefined and
 * get a simpler retry-with-context prompt. Claude understands `/continue <id>`
 * via its shipped skill -- other agents fall through to an explicit instruction
 * that points at the version-agnostic `agents sessions <id>` reader.
 */
export function buildFallbackPrompt(
  prevAgent: AgentId,
  prevSessionId: string | undefined,
  nextAgent: AgentId,
  originalPrompt: string,
): string {
  if (nextAgent === 'claude' && prevSessionId) {
    return `/continue ${prevSessionId}`;
  }
  const lines: string[] = [
    `The previous ${prevAgent} session was interrupted by a rate limit.`,
  ];
  if (prevSessionId) {
    lines.push(
      ``,
      `Prior session ID: ${prevSessionId}`,
      `Read the transcript by running: agents sessions ${prevSessionId}`,
    );
  }
  lines.push(
    ``,
    `Original request: ${originalPrompt}`,
    ``,
    `Continue from where the prior agent left off.`,
  );
  return lines.join('\n');
}

/**
 * Run an agent and, on rate-limit failure, cascade through the fallback chain.
 *
 * The primary agent gets the original prompt. Subsequent agents get a
 * `/continue <id>`-style handoff (see buildFallbackPrompt) when we can pin a
 * session ID -- which today means Claude as primary (supports `--session-id`).
 * For other primaries, fallbacks run with the original prompt plus a
 * retry-with-context note, since we can't deterministically resolve their
 * auto-generated session IDs.
 *
 * Only rate-limit failures cascade. Other errors (missing flag, auth failure,
 * compile error) bubble up from the primary so the caller sees the real cause
 * instead of an opaque "all agents failed" message.
 */
export async function runWithFallback(options: FallbackOptions): Promise<number> {
  const chain: FallbackEntry[] = [
    { agent: options.agent, version: options.version },
    ...options.fallback,
  ];
  let prevAgent: AgentId | undefined;
  let prevSessionId: string | undefined;

  for (let i = 0; i < chain.length; i++) {
    const { agent, version } = chain[i];
    const pinnedSessionId = agent === 'claude' ? randomUUID() : undefined;

    const prompt = prevAgent
      ? buildFallbackPrompt(prevAgent, prevSessionId, agent, options.prompt)
      : options.prompt;

    const execOpts: ExecOptions = {
      ...options,
      agent,
      version,
      prompt,
      sessionId: pinnedSessionId ?? (i === 0 ? options.sessionId : undefined),
    };

    const label = version ? `${agent}@${version}` : agent;
    const banner = i === 0
      ? `[agents] running ${label}`
      : `[agents] fallback → ${label}`;
    process.stderr.write(`${banner}${pinnedSessionId ? ` (session ${pinnedSessionId.slice(0, 8)})` : ''}\n`);

    let result: SpawnResult;
    try {
      result = await spawnAgent(execOpts);
    } catch (err: any) {
      if (err.code === 'ENOENT' && i > 0) {
        process.stderr.write(`[agents] ${label} not installed, skipping\n`);
        continue;
      }
      throw err;
    }

    if (result.exitCode === 0) return 0;

    const isLast = i === chain.length - 1;
    if (isLast) return result.exitCode;

    if (!detectRateLimit(result.stderr)) {
      return result.exitCode;
    }

    const next = chain[i + 1];
    const nextLabel = next.version ? `${next.agent}@${next.version}` : next.agent;
    process.stderr.write(`[agents] ${label} hit rate limit. Handing off to ${nextLabel}...\n`);
    prevAgent = agent;
    prevSessionId = pinnedSessionId;
  }

  return 1;
}
