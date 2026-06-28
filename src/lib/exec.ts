/**
 * Agent execution -- command building, process spawning, and rate-limit fallback.
 *
 * Translates high-level ExecOptions into CLI invocations for each supported agent,
 * manages environment isolation per agent, and chains fallback agents on rate limits.
 */
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId, Mode } from './types.js';
import { ALL_MODES } from './types.js';
import { AGENTS } from './agents.js';
import { parseTimeout } from './routines.js';
import { getBinaryPath, getVersionHomePath, isVersionInstalled, resolveVersion } from './versions.js';
import { resolveModel, buildReasoningFlags } from './models.js';
import { emitStart, maybeRotate, createTimer, redactPrompt, redactArgs } from './events.js';
import { sanitizeProcessEnv } from './secrets/bundles.js';
import { getShimsDir } from './state.js';

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
 * Detect the headless-plan stall footgun.
 *
 * A slash command (e.g. `/code:commit`) run headless under the IMPLICIT default
 * `plan` mode hangs forever: plan is read-only, so the agent calls ExitPlanMode
 * to start working, and in a headless run there is no TTY to approve it. The
 * process just sits there. Callers use this to fail fast with a fix instead.
 *
 * Returns the offending command token (e.g. `/code:commit`) when the run should
 * be blocked, else null. Guards are deliberately narrow:
 *   - interactive runs / no prompt        -> not headless, never blocks
 *   - explicit --mode (modeIsDefault false) -> respected; `--mode plan` is a
 *     legitimate read-only command run and must not be blocked
 *   - resolved mode is not `plan`          -> only plan stalls at ExitPlanMode
 *   - prompt is not a slash command        -> natural-language read-only prompts
 *     ("summarize commits") are a valid default-plan use and must not be blocked
 */
export function headlessPlanStallCommand(args: {
  prompt: string | undefined;
  interactive: boolean | undefined;
  mode: string;
  modeIsDefault: boolean;
}): string | null {
  const { prompt, interactive, mode, modeIsDefault } = args;
  if (interactive === true || prompt === undefined) return null;
  if (!modeIsDefault) return null;
  if (normalizeMode(mode) !== 'plan') return null;
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith('/')) return null;
  return trimmed.split(/\s+/)[0];
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

/**
 * The mode an agent should run in when the caller has no preference.
 *
 * Returns the first entry in the agent's `capabilities.modes` table — the
 * declaration order is the source of truth for "the safest mode this agent
 * supports." Agents that include `plan` list it first; agents like
 * antigravity that have no read-only mode list `edit` first.
 *
 * Use this when the user did not pass `--mode` explicitly. When the user
 * *did* pass `--mode plan` and the agent doesn't support it, call
 * `resolveMode` instead so the user sees a loud error rather than a silent
 * elevation from read-only to writable.
 */
export function defaultModeFor(agent: AgentId): Mode {
  return AGENTS[agent].capabilities.modes[0];
}

/** Reasoning effort levels passed to agents that support them. 'auto' defers to the agent's default. */
export type ExecEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

/** Options for spawning an agent process. Omitting `prompt` launches the CLI interactively. */
export interface ExecOptions {
  agent: AgentId;
  version?: string;
  /** Omit to launch the CLI interactively -- no prompt, no --print, stdio fully inherited. */
  prompt?: string;
  /** Force interactive mode even when a prompt is provided. Wins over `headless`. */
  interactive?: boolean;
  mode: ExecMode;
  effort: ExecEffort;
  cwd?: string;
  /** Force headless mode even when no prompt is provided (e.g. piping via stdin). */
  headless?: boolean;
  json?: boolean;
  model?: string;
  addDirs?: string[];
  timeout?: string;
  sessionId?: string;
  verbose?: boolean;
  env?: Record<string, string>;
  /**
   * Workflow capability scoping (Claude only). Sourced from WORKFLOW.md
   * frontmatter `tools:` / `mcpServers:` and translated to Claude headless
   * flags in buildExecCommand. Other agents ignore these.
   *
   * `toolsRestrict` is the AVAILABLE-tool allowlist: it maps to `--tools`, which
   * restricts the built-in tool set the run can use at all (NOT `--allowedTools`,
   * which only auto-approves without restricting availability). Declaring
   * `[Read, Grep]` makes Write/Bash/Edit unavailable for the whole run.
   */
  toolsRestrict?: string[];
  /**
   * Path to an ephemeral mcp-config JSON. Emitted as `--mcp-config <path>`
   * together with `--strict-mcp-config` so ONLY the named servers load (the
   * flag alone merely ADDS to the existing server set).
   */
  mcpConfigPath?: string;
  /** Raw args captured after `--` on the command line, forwarded verbatim to the underlying agent CLI. */
  passthroughArgs?: string[];
}

/**
 * Resolve interactive vs headless. Explicit flags are definitive and win over
 * inference: `--interactive` forces interactive, `--headless` forces headless.
 * With neither flag, prompt presence decides (prompt -> headless, none -> interactive).
 * `--interactive` takes precedence over `--headless`; the CLI layer rejects passing both.
 */
export function resolveInteractive(
  options: Pick<ExecOptions, 'interactive' | 'headless' | 'prompt'>,
): boolean {
  if (options.interactive === true) return true;
  if (options.headless === true) return false;
  return options.prompt === undefined;
}

/**
 * Decide whether spawnAgent must capture (PIPE + tee) the child's stdout so the
 * live budget watcher can parse it (issue #346, FIX 3).
 *
 * The bug this fixes: stdout used to be PIPED only when downstream output was
 * piped (`piped = !isTTY`). For a normal headless run AT A TERMINAL, stdout was
 * 'inherit', so `child.stdout` was null and the watcher — hence the mid-run
 * hard-cap kill — was silently skipped. We now tap stdout for ALL
 * non-interactive runs when caps are active, regardless of TTY, and tee it back
 * so the user still sees output. Interactive REPLs are never tapped (the human
 * owns the TTY; they rely on the pre-flight gate).
 *
 * @param interactive  resolveInteractive() result for the run
 * @param piped        true when the parent's stdout is NOT a TTY (output piped)
 * @param capsActive   true when a budget watcher is attached (caps configured)
 */
export function shouldTapStdout(interactive: boolean, piped: boolean, capsActive: boolean): boolean {
  if (interactive) return false;
  // Always pipe when the caller pipes us downstream (preserve composability),
  // OR when caps are active so the watcher can read the stream at a TTY.
  return piped || capsActive;
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
    delete result.KIMI_CODE_HOME;
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
    delete result.KIMI_CODE_HOME;
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
    delete result.KIMI_CODE_HOME;
  } else if (options.agent === 'kimi') {
    // Kimi honors KIMI_CODE_HOME (relocates ~/.kimi-code, including config,
    // skills, hooks, sessions). Pin it at the per-version home.
    const cwd = options.cwd || process.cwd();
    const resolvedVersion = options.version ?? resolveVersion('kimi', cwd);
    const version = options.version
      ? resolvedVersion
      : (resolvedVersion && isVersionInstalled('kimi', resolvedVersion) ? resolvedVersion : null);
    if (version) {
      result.KIMI_CODE_HOME = path.join(getVersionHomePath('kimi', version), '.kimi-code');
    }
    delete result.CLAUDE_CONFIG_DIR;
    delete result.CODEX_HOME;
    delete result.COPILOT_HOME;
  } else {
    delete result.CLAUDE_CONFIG_DIR;
    delete result.CODEX_HOME;
    delete result.COPILOT_HOME;
    delete result.KIMI_CODE_HOME;
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
      edit: ['--sandbox', 'workspace-write', '--dangerously-bypass-approvals-and-sandbox'],
      // skip drops the sandbox entirely; --dangerously-bypass-approvals-and-sandbox then approves anything.
      skip: ['--dangerously-bypass-approvals-and-sandbox'],
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
    printFlags: ['--print'],
    modelFlag: '--model',
  },
  grok: {
    base: ['grok'],
    promptFlag: '-p',
    modeFlags: {
      // grok --help lists `--permission-mode plan`; the TUI defaults to ask.
      plan: ['--permission-mode', 'plan'],
      edit: [],
      skip: ['--always-approve'],
    },
    jsonFlags: ['--output-format', 'streaming-json'],
    modelFlag: '--model',
  },
  kimi: {
    base: ['kimi'],
    promptFlag: '-p',
    modeFlags: {
      plan: ['--plan'],
      edit: [],
      auto: ['--auto'],
      skip: ['--yolo'],
    },
    jsonFlags: ['--output-format', 'stream-json'],
    modelFlag: '--model',
  },
  // Factory AI Droid (`droid exec` for headless, `droid` for TUI). Flags from
  // docs.factory.ai CLI reference: prompt is positional; --auto low|medium|high
  // escalates autonomy (default is read-only); --skip-permissions-unsafe drops
  // all guardrails; -o stream-json streams JSONL events; -m selects the model.
  // The `exec` subcommand is dropped for interactive runs (see buildExecCommand).
  droid: {
    base: ['droid', 'exec'],
    promptFlag: 'positional',
    modeFlags: {
      plan: [],                          // droid's default exec mode is read-only
      edit: ['--auto', 'low'],           // create/edit files, non-destructive
      auto: ['--auto', 'high'],          // full autonomy
      skip: ['--skip-permissions-unsafe'],
    },
    jsonFlags: ['-o', 'stream-json'],
    modelFlag: '-m',
  },
};

/** Assemble the full CLI argument array for an agent invocation. */
export function buildExecCommand(options: ExecOptions): string[] {
  const template = AGENT_COMMANDS[options.agent];
  const cmd: string[] = [...template.base];
  const interactive = resolveInteractive(options);

  // For Codex and Droid, 'exec' is the headless subcommand; for OpenCode, 'run'
  // is. Drop it for interactive mode so we launch the TUI (`codex` / `droid` /
  // `opencode`, each agent's default command) instead of the one-shot headless
  // subcommand ('codex exec' / 'droid exec' / 'opencode run').
  if (interactive) {
    if ((options.agent === 'codex' || options.agent === 'droid') && cmd[1] === 'exec') {
      cmd.splice(1, 1);
    } else if (options.agent === 'opencode' && cmd[1] === 'run') {
      cmd.splice(1, 1);
    }
  }

  // Use versioned alias if a specific version was requested (e.g., claude@2.1.98).
  // Resolve to the absolute path of the shim so spawn doesn't depend on PATH —
  // on Linux installs where the shims dir isn't on PATH, spawning the bare
  // versioned name fails with ENOENT even though `agents view` shows the agent.
  //
  // On Windows, shims are bash scripts and cannot be executed by spawn() directly.
  // buildExecEnv() already sets the isolation env vars (CLAUDE_CONFIG_DIR, CODEX_HOME,
  // etc.) that the bash shim would set, so we can skip the shim entirely and resolve
  // straight to the real binary via getBinaryPath.
  if (options.version && cmd.length > 0) {
    if (process.platform === 'win32') {
      const binaryPath = getBinaryPath(options.agent, options.version);
      const binaryPathCmd = binaryPath + '.cmd';
      if (fs.existsSync(binaryPathCmd)) {
        cmd[0] = binaryPathCmd;
      } else if (fs.existsSync(binaryPath)) {
        cmd[0] = binaryPath;
      }
    } else {
      const versionedName = `${cmd[0]}@${options.version}`;
      const absPath = path.join(getShimsDir(), versionedName);
      cmd[0] = fs.existsSync(absPath) ? absPath : versionedName;
    }
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
    if (interactive && options.agent === 'opencode') {
      // The OpenCode TUI takes an initial prompt via --prompt; a bare positional
      // on the default command is parsed as a project path, not a message.
      cmd.push('--prompt', options.prompt);
    } else if (template.promptFlag === 'positional') {
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

  // Claude-specific: workflow capability scoping. WORKFLOW.md frontmatter
  // `tools:` / `mcpServers:` is translated to the headless flags that ACTUALLY
  // restrict the run (verified against `claude --help` on the installed CLI):
  //
  //   tools:       -> `--tools <names...>` — restricts the AVAILABLE built-in
  //                   tool set. This is the security boundary: tools NOT named
  //                   here (e.g. Write, Bash, Edit) are unavailable for the whole
  //                   run. `--allowedTools` would only auto-approve without
  //                   restricting, so it is the WRONG flag for sandboxing.
  //                   We also emit `--allowedTools <names...>` for the same set so
  //                   the permitted tools don't prompt in headless `-p` mode.
  //   mcpServers:  -> `--mcp-config <path>` PLUS `--strict-mcp-config`. The
  //                   config flag alone ADDS servers to the existing set; only
  //                   `--strict-mcp-config` makes the run use *only* the named
  //                   servers, which is what scoping means.
  //
  // The command layer gates this behind the `allowlist` capability and assembles
  // the mcp-config file; buildExecCommand stays a pure string-builder.
  //
  // `<tools...>` is variadic. Emit the names as separate argv tokens. The flags
  // here are appended AFTER the positional prompt (added above), so the variadic
  // never swallows the prompt; the trailing `--allowedTools` / `--strict-mcp-config`
  // tokens also terminate the `--tools` variadic cleanly.
  if (options.agent === 'claude') {
    if (options.toolsRestrict && options.toolsRestrict.length > 0) {
      cmd.push('--tools', ...options.toolsRestrict);
      cmd.push('--allowedTools', ...options.toolsRestrict);
    }
    if (options.mcpConfigPath) {
      cmd.push('--mcp-config', options.mcpConfigPath);
      cmd.push('--strict-mcp-config');
    }
  }

  // Forward arbitrary native flags supplied after `--` verbatim. Appended last
  // so they cannot be misinterpreted as values for earlier flags or as the prompt.
  if (options.passthroughArgs && options.passthroughArgs.length > 0) {
    cmd.push(...options.passthroughArgs);
  }

  return cmd;
}

/** Spawn an agent and return its exit code. Convenience wrapper over spawnAgent. */
export async function execAgent(options: ExecOptions): Promise<number> {
  const { exitCode } = await spawnAgent(options);
  return exitCode;
}

/**
 * Transparent passthrough exec for generated shims — the node-side delegate that
 * Windows `.cmd` shims call. Resolves the active version (explicit pin, else
 * project/default) and execs the real binary with the user's RAW args and the
 * per-version env isolation, WITHOUT injecting mode/model/reasoning flags. This
 * mirrors what the POSIX bash shim does inline (`exec $BINARY $launchArgs "$@"`),
 * keeping version resolution in one place instead of reimplementing it in batch.
 */
export async function execShimPassthrough(
  agent: AgentId,
  rawArgs: string[],
  cwd: string,
  pinnedVersion?: string,
): Promise<number> {
  const version = pinnedVersion ?? resolveVersion(agent, cwd) ?? undefined;
  if (!version || !isVersionInstalled(agent, version)) {
    process.stderr.write(`agents: no installed default for ${agent}. Set one with: agents use ${agent} <version>\n`);
    return 127;
  }

  let binary = getBinaryPath(agent, version);
  if (process.platform === 'win32') {
    // npm ships <cmd>.cmd alongside the bare script on Windows; that's the runnable form.
    const cmdPath = binary + '.cmd';
    if (fs.existsSync(cmdPath)) binary = cmdPath;
  }

  // The only flag the bash shim injects (codex); everything else is transparent.
  const launchArgs = agent === 'codex' ? ['-c', 'check_for_update_on_startup=false'] : [];
  // mode/effort are required by ExecOptions but unused by buildExecEnv (which only
  // derives the per-version config-dir env); pass the agent's default to satisfy the type.
  const env = buildExecEnv({ agent, version, cwd, mode: defaultModeFor(agent), effort: 'auto' });
  const useShell = process.platform === 'win32' && (!path.isAbsolute(binary) || binary.endsWith('.cmd'));

  return new Promise((resolve) => {
    const child = spawn(binary, [...launchArgs, ...rawArgs], { cwd, stdio: 'inherit', env, shell: useShell });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on('error', (err) => {
      process.stderr.write(`agents: failed to launch ${agent}: ${err.message}\n`);
      resolve(127);
    });
  });
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
  const interactive = resolveInteractive(options);

  // Budget live kill-switch (issue #346). For headless runs we incrementally
  // parse stream-json usage off stdout, accumulate cost, and kill the child the
  // moment a configured cap is crossed — exactly like the --timeout path, but
  // resolving with a DISTINCT exit code so CI/headless can tell budget-kill from
  // timeout. Spend is recorded to the shared ledger in the close handler. The
  // watcher is dormant (and zero-cost) when no caps are configured.
  const cwd = options.cwd || process.cwd();
  const runId = randomUUID();
  const watcherState = await setupBudgetWatcher(options, cwd, runId);

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
    // PIPE (and later tee) stdout whenever the live budget watcher must read it
    // — for ALL non-interactive runs when caps are active, regardless of TTY.
    // See shouldTapStdout() for the rationale (FIX 3, issue #346).
    const tapStdout = shouldTapStdout(interactive, piped, watcherState !== null);
    const stdio: ('inherit' | 'pipe')[] = interactive
      ? ['inherit', 'inherit', 'inherit']
      : ['inherit', tapStdout ? 'pipe' : 'inherit', 'pipe'];

    // On Windows, .cmd batch wrappers (npm-installed CLIs) require shell:true
    // whether addressed by name or absolute path.
    const useShell = process.platform === 'win32' && (
      !path.isAbsolute(executable) || executable.endsWith('.cmd')
    );
    const child = spawn(executable, args, {
      cwd: options.cwd || process.cwd(),
      stdio,
      env: buildExecEnv(options),
      shell: useShell,
    });

    // Mark startup time (time from function call to process spawn)
    timer.mark('startup');

    let budgetKilled = false;
    let budgetKillTimer: ReturnType<typeof setTimeout> | undefined;
    if (!interactive && tapStdout && child.stdout) {
      // TEE the child's stdout back to the parent's so the user still sees
      // output (mirrors stdio:'inherit') while we tap the same stream for usage.
      child.stdout.pipe(process.stdout);
      // Tap the same stream for budget usage events without consuming the pipe
      // (a 'data' listener and .pipe() both receive every chunk). Kill on breach.
      if (watcherState) {
        let pendingLine = '';
        child.stdout.on('data', (chunk: Buffer) => {
          const { events, rest } = watcherState.extract(chunk.toString('utf-8'), pendingLine);
          pendingLine = rest;
          for (const ev of events) watcherState.watcher.feedUsage(ev);
          if (watcherState.watcher.breached() && !budgetKilled) {
            budgetKilled = true;
            process.stderr.write(`[budget] hard cap exceeded — terminating ${options.agent} run\n`);
            child.kill('SIGTERM');
            budgetKillTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
          }
        });
      }
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
      // Clear the budget-kill SIGKILL escalation timer (mirror the --timeout
      // timer cleanup) so a programmatic caller reusing execAgent (the #332 loop
      // driver) never sees a stray 5s kill event fire after the child has exited.
      if (budgetKillTimer) clearTimeout(budgetKillTimer);
      // Record final spend to the shared ledger (issue #346). Best-effort: a
      // ledger write must never mask the run's own outcome.
      if (watcherState) {
        try { watcherState.finalize(); } catch { /* ledger write is non-critical */ }
        // Release the watcher's references / stop accepting events (symmetry).
        try { watcherState.watcher.dispose(); } catch { /* dispose is best-effort */ }
      }
      // Budget kill resolves with a DISTINCT non-zero exit so CI/headless and
      // teams/cloud can tell a budget termination apart from a normal failure.
      const exitCode = budgetKilled ? BUDGET_KILL_EXIT_CODE : (code ?? 0);
      timer.end({ exitCode, status: budgetKilled ? 'budget_killed' : code === 0 ? 'success' : 'failed' });
      resolve({ exitCode, stderr: stderrBuffer });
    });
  });
}

/** Exit code spawnAgent resolves with when a run is killed for crossing a budget cap. */
export const BUDGET_KILL_EXIT_CODE = 7;

/**
 * Resolve the budget watcher for a run. Returns null (watcher dormant) when no
 * caps are configured, so non-budget users pay nothing. When caps exist, builds
 * a live watcher seeded with the day/project spend already on the ledger, plus
 * a finalize() that appends this run's accumulated spend.
 */
async function setupBudgetWatcher(
  options: ExecOptions,
  cwd: string,
  runId: string,
): Promise<{
  watcher: import('./budget/enforce.js').LiveSpendWatcher;
  extract: (chunk: string, pending: string) => { events: import('./budget/enforce.js').UsageEvent[]; rest: string };
  finalize: () => void;
} | null> {
  const interactive = resolveInteractive(options);
  if (interactive) return null;
  const [{ resolveBudgetConfig, hasAnyCap }, { makeLiveSpendWatcher, capsFromConfig, extractUsageEvents }, ledger] =
    await Promise.all([
      import('./budget/config.js'),
      import('./budget/enforce.js'),
      import('./budget/ledger.js'),
    ]);
  const cfg = resolveBudgetConfig(cwd);
  if (!hasAnyCap(cfg)) return null;

  const today = ledger.localDay();
  const entries = ledger.loadLedger();
  const caps = capsFromConfig(cfg, {
    daySpend: ledger.spendForDay(today, entries),
    projectSpend: ledger.spendForProject(cwd, entries),
    agentDaySpend: { [options.agent]: ledger.spendForAgentDay(options.agent, today, entries) },
  });
  const watcher = makeLiveSpendWatcher({ caps, onBreach: () => { /* kill handled in stdout tap */ } });

  // Accumulate per-(model) usage for a clean final ledger record.
  const seen: Array<{ model: string; usage: import('./budget/ledger.js').UsageObservation }> = [];
  const model = options.model ?? `${options.agent}-default`;

  return {
    watcher,
    extract: (chunk: string, pending: string) => {
      const res = extractUsageEvents(chunk, pending, model, options.agent);
      for (const ev of res.events) {
        seen.push({
          model: ev.model ?? model,
          usage: {
            inputTokens: ev.inputTokens,
            outputTokens: ev.outputTokens,
            cacheReadTokens: ev.cacheReadTokens,
            cacheCreationTokens: ev.cacheCreationTokens,
          },
        });
      }
      return res;
    },
    finalize: () => {
      for (const s of seen) {
        ledger.recordSpend({
          runId,
          agent: options.agent,
          project: cwd,
          model: s.model,
          usage: s.usage,
          source: 'run',
        });
      }
    },
  };
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

  // Workflow capability scoping only takes effect on claude (buildExecCommand
  // guards `--tools` / `--mcp-config` / `--strict-mcp-config` on agent==='claude').
  // A fallback to any non-claude agent would run with NONE of that scoping — the
  // declared sandbox silently evaporates. Warn loudly so a rate-limit handoff to
  // an unscoped agent is never silent (issue #324 fail-open).
  const scopingActive = (options.toolsRestrict && options.toolsRestrict.length > 0)
    || !!options.mcpConfigPath;
  if (scopingActive) {
    const unscoped = options.fallback.filter(f => f.agent !== 'claude').map(f => f.agent);
    if (unscoped.length > 0) {
      process.stderr.write(
        `[agents] WARNING: workflow tool/MCP scoping is enforced on claude only. ` +
        `Fallback agent(s) ${[...new Set(unscoped)].join(', ')} would run UNSCOPED ` +
        `(no --tools / --strict-mcp-config restriction) if claude hits a rate limit.\n`,
      );
    }
  }

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
