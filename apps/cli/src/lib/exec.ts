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
import { writePidSessionEntry, extractSessionIdArg } from './session/pid-registry.js';
import { recordRunName } from './session/run-names.js';
import { mailboxDir, isValidMailboxId } from './mailbox.js';
import { composeWin32CommandLine } from './platform/index.js';
import { isTmuxInstalled } from './tmux/binary.js';
import { shellQuote } from './ssh-exec.js';

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
  /**
   * Durable `agents run --name <slug>` handle. Exported to the agent's env as
   * `AGENT_SESSION_NAME` (companion to `AGENT_SESSION_ID`) and, when a session
   * id is known at launch, recorded in the run-name index so `agents sessions
   * <name>` resolves the run. Absent for unnamed runs — no behavior change.
   */
  name?: string;
  /**
   * Resume the conversation named by `sessionId` using the agent's NATIVE resume
   * form (claude `--resume`, codex `resume`) instead of the default `--session-id`
   * create. Only set for agents where `nativeResume` returns true; other agents
   * resume via a `/continue <id>` first message (Tier 2), which needs no flag and
   * leaves this unset.
   */
  resume?: boolean;
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
  /**
   * Escape hatch for the interactive tmux spawn-wrap (see shouldWrapInTmux):
   * when true, spawn the agent directly instead of inside a shared-socket tmux
   * session. Also forced off by AGENTS_NO_TMUX=1. No effect on headless runs.
   */
  raw?: boolean;
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
      // A managed pin lives in a per-version dir; Claude Code's own background
      // auto-updater would rewrite that pinned binary in place (and has left it
      // half-swapped and broken). Disable it so a pin stays a pin. Honor an
      // explicit user value — from process.env (already in result) or from
      // options.env (spread over result below).
      if (result.DISABLE_AUTOUPDATER === undefined) {
        result.DISABLE_AUTOUPDATER = '1';
      }
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

  // Point the agent at its own mailbox so the PreToolUse `mailbox-inject` hook
  // knows which box to drain and inject mid-run. Keyed by the session id — the
  // same id the writer resolves via mailboxIdForActiveSession(). A loop run
  // overrides this to its run-level box via options.env (spread below), so all
  // iterations share one inbox.
  if (options.sessionId && isValidMailboxId(options.sessionId)) {
    result.AGENTS_MAILBOX_DIR = mailboxDir(options.sessionId);
  }

  // Export the run's durable name (companion to AGENT_SESSION_ID) so a
  // SessionStart hook / the agent can associate its transcript with the handle
  // the user gave the run. Only set when --name was passed.
  if (options.name) {
    result.AGENT_SESSION_NAME = options.name;
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
  /**
   * How this agent natively resumes a prior conversation. Presence here is the
   * single source of truth for `nativeResume(agent)` — agents without it fall
   * back to the universal `/continue <id>` replay (Tier 2). Two shapes:
   *   { flag }       — append `<flag> <id>` (e.g. claude `--resume <id>`)
   *   { subcommand } — replace the headless base subcommand with `<subcommand> <id>`
   *                    (codex: `codex exec` -> `codex exec resume <id>`)
   */
  resume?: { flag: string } | { subcommand: string };
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
    resume: { flag: '--resume' },
  },
  codex: {
    base: ['codex', 'exec'],
    promptFlag: 'positional',
    resume: { subcommand: 'resume' },
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
    // opencode's native resume is `opencode --session <id>` (NOT under `run`), so
    // it does not compose with this headless `run` base. Until that's verified on
    // a box with opencode installed, opencode resumes via Tier-2 `/continue`.
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

/**
 * Whether `agent` has a native resume form (Tier 1). Derived solely from the
 * command template's `resume` field — the single source of truth. Agents that
 * return false resume via the universal Tier-2 `/continue` replay instead.
 */
export function nativeResume(agent: AgentId): boolean {
  return AGENT_COMMANDS[agent]?.resume !== undefined;
}

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

  // Native resume with a `{ subcommand }` shape (codex) appends the resume verb
  // to the base: `codex exec` -> `codex exec resume` (headless) and, after the
  // interactive drop above, `codex` -> `codex resume` (TUI). The session id is
  // pushed later as the first positional (before any prompt). `{ flag }` agents
  // (claude) need no base change — the flag is appended with the id below.
  const resumeSpec = options.resume ? template.resume : undefined;
  if (resumeSpec && 'subcommand' in resumeSpec) {
    cmd.push(resumeSpec.subcommand);
  }

  // Use versioned alias if a specific version was requested (e.g., claude@2.1.98).
  // Resolve to the absolute path of the shim so spawn doesn't depend on PATH —
  // on Linux installs where the shims dir isn't on PATH, spawning the bare
  // versioned name fails with ENOENT even though `agents view` shows the agent.
  //
  // On Windows the alias is materialized as a `.cmd` only (see
  // createVersionedAlias — a bash alias next to it would shadow the `.cmd` in
  // cmd.exe/PowerShell name resolution); the extensionless existsSync branch
  // below still matches a legacy install's bash alias. When no shim exists on
  // disk we fall back to the bare versioned name, which spawnAgent() resolves
  // via PATH (+ PATHEXT/shell on Windows).
  if (options.version && cmd.length > 0) {
    const versionedName = `${cmd[0]}@${options.version}`;
    const absPath = path.join(getShimsDir(), versionedName);
    if (process.platform === 'win32' && fs.existsSync(absPath + '.cmd')) {
      cmd[0] = absPath + '.cmd';
    } else if (fs.existsSync(absPath)) {
      cmd[0] = absPath;
    } else {
      cmd[0] = versionedName;
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
  if (resumeSpec && 'subcommand' in resumeSpec) {
    // codex `exec resume` / `resume` does NOT accept `--sandbox <mode>` (only the
    // bypass flag, verified against `codex exec resume --help`). So the standard
    // codex modeFlags can't be reused on resume. A non-plan HEADLESS resume needs
    // the bypass or it stalls on approval prompts; plan and interactive resume
    // inherit codex's default sandbox and pass no flag.
    if (!interactive && resolvedMode !== 'plan') {
      cmd.push('--dangerously-bypass-approvals-and-sandbox');
    }
  } else if (options.agent === 'kimi' && !interactive) {
    // kimi's headless prompt mode (`-p`/`--prompt`) is self-contained and REFUSES
    // to be combined with any startup-mode flag: `--plan`, `--auto`, and `--yolo`
    // all abort with "Cannot combine --prompt with --X" (verified against the live
    // kimi CLI). The write-capable modes (edit/auto/skip) all collapse to kimi's
    // default `-p` behavior, which already auto-approves tool calls, so we emit no
    // mode flag. Plan (read-only) has no headless equivalent, so fail closed rather
    // than silently letting a plan-mode run mutate the workspace.
    if (resolvedMode === 'plan') {
      throw new Error(
        'kimi has no headless read-only mode: `--prompt` cannot be combined with `--plan`. ' +
          'Run kimi in plan mode interactively (omit the prompt), or use --mode edit, auto, or skip.',
      );
    }
    // edit/auto/skip: emit no mode flag — `kimi -p` auto-runs.
  } else {
    cmd.push(...modeFlags);
  }

  // Add print/headless flags only when a prompt is provided. Without a prompt
  // the caller wants an interactive REPL -- passing --print would immediately
  // wait on stdin and never render the TUI.
  if (!interactive && options.headless && template.printFlags) {
    cmd.push(...template.printFlags);
  }

  // Resume vs. create. With `resume`, emit the agent's NATIVE resume reference:
  // `{ flag }` agents append `<flag> <id>` (claude `--resume <id>`); `{ subcommand }`
  // agents (codex) already pushed the verb above, so the id is the first
  // positional here — placed before the prompt positional appended later. Without
  // `resume`, the legacy claude-only `--session-id` CREATES a session with that id.
  if (options.resume && options.sessionId && resumeSpec) {
    if ('flag' in resumeSpec) {
      cmd.push(resumeSpec.flag, options.sessionId);
    } else {
      cmd.push(options.sessionId);
    }
  } else if (options.sessionId && options.agent === 'claude') {
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
 * Resolve how to spawn a shim target for a platform. Pure — testable on any host.
 *
 * POSIX always execs the binary directly (no shell). On Windows a bare
 * (non-absolute) name or a `.cmd` companion goes through the shell so cmd.exe
 * resolves it via PATHEXT — the common, `.cmd`-present path; an absolute `.cmd`
 * or extensionless path is exec'd through the shell / directly. npm always ships
 * a `<cmd>.cmd` companion on Windows, so the runnable target `execShimPassthrough`
 * hands us is the `.cmd` (never a bare `.ps1`).
 */
export function resolveShimSpawn(
  platform: NodeJS.Platform,
  binary: string,
  extraArgs: string[],
): { command: string; args: string[]; shell: boolean } {
  if (platform === 'win32') {
    // Use win32 path semantics regardless of the host running this (the platform
    // is the parameter, not process.platform) so `C:\...` reads as absolute.
    const useShell = !path.win32.isAbsolute(binary) || binary.endsWith('.cmd');
    if (useShell) {
      // DEP0190-safe: hand cmd.exe ONE fully-quoted command line with an EMPTY
      // args array, so Node never concatenates `extraArgs` (which carry the
      // user's raw prompt/flags) into the shell line unescaped — that concat is
      // both the deprecation and a command-injection surface.
      return { command: composeWin32CommandLine(binary, extraArgs), args: [], shell: true };
    }
    return { command: binary, args: extraArgs, shell: false };
  }
  return { command: binary, args: extraArgs, shell: false };
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
  const { command, args, shell } = resolveShimSpawn(process.platform, binary, [...launchArgs, ...rawArgs]);

  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env, shell });
    // Record the launch so `ag sessions --active` can attribute the agent
    // process to its cwd (and exact session when the caller passed
    // --session-id). Vital on Windows, where there is no lsof to recover a
    // foreign process's cwd. On the shell path this pid is the cmd.exe
    // wrapper, not the agent binary — the active scan resolves that by
    // walking the candidate's ancestors (readAncestorSessionEntry).
    if (child.pid) {
      writePidSessionEntry({
        pid: child.pid,
        agent,
        sessionId: extractSessionIdArg(rawArgs),
        cwd,
        startedAtMs: Date.now(),
      });
    }
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

/** Inputs that decide whether an interactive spawn is wrapped in a shared-socket tmux session. */
export interface TmuxWrapContext {
  /** resolveInteractive() result — only interactive REPL launches are wrapped. */
  interactive: boolean;
  /** process.platform — Windows has no tmux path, always spawns bare. */
  platform: NodeJS.Platform;
  /** True when the launcher itself already runs inside tmux ($TMUX set) — never double-wrap. */
  inTmux: boolean;
  /** The `--raw` escape hatch. */
  raw: boolean;
  /** The AGENTS_NO_TMUX=1 escape hatch. */
  noTmuxEnv: boolean;
  /** Whether a tmux binary is on PATH. */
  tmuxAvailable: boolean;
}

/**
 * Decide whether to run an interactive agent INSIDE a detached tmux session on
 * the shared socket (then attach the current TTY) instead of a bare spawn.
 *
 * tmux-wrapping gives every interactive agent an exact, unique `%pane` handle so
 * `agents sessions --active` can tell co-located agents apart, and lets `agents
 * focus` re-attach a live session without forking it. Pure so the gate is unit-
 * tested independently of the (side-effecting) spawn.
 *
 * All five guards must pass:
 *   - interactive     — a headless `-p` run has no TTY to attach; keep bare spawn.
 *   - not Windows     — no tmux path on win32.
 *   - not already in tmux — nesting tmux-in-tmux is pointless and confusing.
 *   - not --raw       — explicit opt-out.
 *   - not AGENTS_NO_TMUX=1 — env opt-out (CI, scripts, the shim passthrough path).
 *   - tmux installed  — otherwise there is nothing to wrap with.
 */
export function shouldWrapInTmux(ctx: TmuxWrapContext): boolean {
  if (!ctx.interactive) return false;
  if (ctx.platform === 'win32') return false;
  if (ctx.inTmux) return false;
  if (ctx.raw) return false;
  if (ctx.noTmuxEnv) return false;
  if (!ctx.tmuxAvailable) return false;
  return true;
}

/**
 * Build the shell command that runs an agent inside a tmux pane with the exact
 * env the bare spawn would use. tmux runs it via `sh -c <cmd>`; we `exec env
 * K=V … <agent> <args…>` so:
 *   - `env` materializes the full agent env INTO the pane, independent of the
 *     (possibly stale, shared) tmux server environment — additive, so tmux's own
 *     $TMUX / $TMUX_PANE still reach the agent for provenance detection;
 *   - `exec` replaces the shell so the agent is the pane's leaf process (clean
 *     `#{pane_pid}`, clean signal delivery on detach/kill).
 * Keys are filtered to valid identifiers so exported shell functions
 * (`BASH_FUNC_*%%`) can't make `env` choke.
 */
export function buildTmuxAgentCommand(executable: string, args: string[], env: NodeJS.ProcessEnv): string {
  const envPrefix = Object.entries(env)
    .filter(([k, v]) => v !== undefined && EXEC_ENV_KEY_PATTERN.test(k))
    .map(([k, v]) => `${k}=${shellQuote(String(v))}`)
    .join(' ');
  const agentCmd = [executable, ...args].map(shellQuote).join(' ');
  return `exec env ${envPrefix} ${agentCmd}`;
}

/**
 * Trim a raw `tmux capture-pane` dump to its last `maxLines` non-empty lines
 * (right-stripping each). Used by runInTmux to recap a fast-failed agent's
 * output into the caller's shell so a launch crash (e.g. a gutted install that
 * dies with ENOENT the instant it spawns) isn't swallowed by the bare
 * `[detached]` the pane-died hook otherwise leaves behind.
 */
export function formatPaneTail(raw: string, maxLines = 30): string {
  return raw
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => l.length > 0)
    .slice(-maxLines)
    .join('\n');
}

/**
 * Run an interactive agent inside a detached tmux session on the shared socket,
 * attach the current TTY, and propagate the wrapped agent's exit code.
 *
 * Lifecycle:
 *   1. createSession() launches `sh -c 'exec env … agent'` detached, remain-on-exit
 *      on (global), and returns the pane id.
 *   2. A per-session `pane-died` hook detaches the attach client the instant the
 *      AGENT pane exits, so attach returns instead of parking on a dead pane. The
 *      hook is guarded on `#{hook_pane}` so it fires ONLY for the agent pane —
 *      user-created splits (Ctrl-b " / %) that the user exits are closed in place
 *      (`kill-pane`) instead of tearing down the whole client, so exiting one
 *      split leaves the agent running full-window rather than kicking you out.
 *   3. We record the agent pane's pid → session mapping (WITH the tmux pane) so the
 *      headless active-scan attributes it, then attach the TTY (blocking).
 *   4. On return: if the pane is dead the agent exited — read its status, tear the
 *      session down, return that code. If the pane is still alive the user detached
 *      (Ctrl-b d) — return 0 and LEAVE the session for `agents focus` to re-attach.
 */
async function runInTmux(options: ExecOptions, executable: string, args: string[]): Promise<SpawnResult> {
  const { createSession, killSession, paneExitStatus, setSessionHook, slugifyName } = await import('./tmux/session.js');
  const { getDefaultSocketPath } = await import('./tmux/paths.js');
  const { attachTmux, runTmux } = await import('./tmux/binary.js');

  const socket = getDefaultSocketPath();
  const cwd = options.cwd || process.cwd();
  const idSeed = (options.sessionId ?? randomUUID()).slice(0, 8);
  const name = slugifyName(`ag-${options.agent}-${idSeed}`);
  const cmd = buildTmuxAgentCommand(executable, args, buildExecEnv(options));

  const labels: Record<string, string> = { agent: options.agent };
  if (options.sessionId) labels.sessionId = options.sessionId;

  const meta = await createSession({ name, cmd, cwd, socket, source: 'cli', labels });
  const pane = meta.pane;

  if (pane) {
    // When the AGENT pane dies, detach the client (don't kill) so the session
    // survives just long enough to read the dead pane's exit status below. The
    // `#{hook_pane}` guard scopes this to the agent pane only: if the user splits
    // the window and exits one of THEIR panes, the else-branch `kill-pane` closes
    // that split in place instead of detaching everyone (the pane-died hook runs
    // in the dead pane's context, so bare `kill-pane` targets it). Without the
    // guard, exiting any split kicked the user clean out of tmux.
    await setSessionHook(
      name,
      'pane-died',
      `if -F '#{==:#{hook_pane},${pane}}' 'detach-client -s =${name}' 'kill-pane'`,
      socket,
    );

    // Record the agent's OS pid (the pane leaf, thanks to `exec`) WITH its tmux
    // pane so the active-scan attributes it exactly and shows the %pane.
    let panePid = 0;
    try {
      const r = await runTmux({ socket, args: ['display-message', '-pt', pane, '-p', '#{pane_pid}'], throwOnError: false });
      panePid = parseInt(r.stdout.trim(), 10) || 0;
    } catch { /* best-effort */ }
    writePidSessionEntry({
      pid: panePid,
      agent: options.agent,
      sessionId: options.sessionId,
      cwd,
      tmuxPane: pane,
      startedAtMs: Date.now(),
    });
  }

  // Recap a dead pane's tail into THIS shell's stderr. The pane-died hook
  // detaches the client the instant the agent exits, so a fast failure (a
  // gutted install that dies with ENOENT, a bad flag, a crash on startup) would
  // otherwise leave only a bare `[detached]` with no clue why. Must run BEFORE
  // killSession — capture-pane needs the session still alive (remain-on-exit
  // keeps the dead pane readable until we tear it down). Best-effort throughout.
  const surfacePaneFailure = async (status: number | undefined, headline: string): Promise<void> => {
    if (!pane) return;
    let tail = '';
    try {
      const r = await runTmux({ socket, args: ['capture-pane', '-p', '-t', pane, '-S', '-200'], throwOnError: false });
      if (r.code === 0) tail = formatPaneTail(r.stdout);
    } catch { /* best-effort — a missing pane just means no recap */ }
    const RED = '\x1b[31m', GRAY = '\x1b[90m', OFF = '\x1b[0m';
    process.stderr.write(`\n${RED}agents: ${headline} (exit ${status ?? 1}).${OFF}\n`);
    if (tail) {
      process.stderr.write(`${GRAY}  ── last output from ${options.agent} ──${OFF}\n`);
      process.stderr.write(tail.replace(/^/gm, '  ') + '\n');
      process.stderr.write(`${GRAY}  ${'─'.repeat(30)}${OFF}\n`);
    }
    process.stderr.write(`${GRAY}  Tip: re-run with --no-tmux to launch the agent directly and see its full output.${OFF}\n\n`);
  };

  // The agent could exit before we attach (fast failure). Don't attach to an
  // already-dead pane — surface its output + status directly and tear down.
  const before = pane ? await paneExitStatus(pane, socket) : { dead: false };
  if (before.dead) {
    // Only recap a FAILURE. A clean (0) exit before we attached is a successful
    // quick run, not a crash — a red banner there would be spurious (mirrors the
    // post-attach guard below).
    if ((before.status ?? 0) !== 0) {
      await surfacePaneFailure(before.status, `${options.agent} exited before it could start`);
    }
    await killSession(name, socket).catch(() => {});
    return { exitCode: before.status ?? 0, stderr: '' };
  }

  await attachTmux({ socket, args: ['attach-session', '-t', name] });

  const after = pane ? await paneExitStatus(pane, socket) : { dead: false };
  if (after.dead) {
    // Nonzero exit after attach → the agent crashed rather than the user
    // detaching cleanly (a clean detach leaves the pane ALIVE, handled below).
    // The pane-died hook may have yanked the view before the error was readable,
    // so recap it into the shell. A clean (0) exit stays quiet — nothing to say.
    if ((after.status ?? 0) !== 0) {
      await surfacePaneFailure(after.status, `${options.agent} exited`);
    }
    await killSession(name, socket).catch(() => {});
    return { exitCode: after.status ?? 0, stderr: '' };
  }
  // Pane still alive → the user detached; keep the session for `agents focus`.
  return { exitCode: 0, stderr: '' };
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
  // Assign a known session id up front for agents that accept one, so the
  // launcher can record an EXACT pid -> session mapping (see pid-registry) —
  // otherwise the headless `ag sessions --active` path can only guess
  // "newest .jsonl in the cwd" and collapses co-located agents onto one row.
  // Claude: `--session-id <uuid>` CREATES the session with that id (wired in
  // buildExecCommand). Skip on resume — the id is the one being resumed.
  if (options.agent === 'claude' && !options.resume && !options.sessionId) {
    options = { ...options, sessionId: randomUUID() };
  }
  // Record the run's --name against its session id (when both are known at
  // launch) so `agents sessions <name>` resolves it. Best-effort; unnamed runs
  // and agents whose id isn't known up front simply skip this.
  if (options.name && options.sessionId) {
    recordRunName({ sessionId: options.sessionId, name: options.name, agent: options.agent, cwd: options.cwd });
  }
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

  // Interactive spawn-wrap: on macOS/Linux, run the agent INSIDE a shared-socket
  // tmux session (then attach this TTY) so it gets a unique, addressable %pane.
  // Headless runs, Windows, already-in-tmux, --raw, and AGENTS_NO_TMUX=1 keep the
  // bare spawn below. See shouldWrapInTmux / runInTmux.
  if (shouldWrapInTmux({
    interactive,
    platform: process.platform,
    inTmux: !!process.env.TMUX,
    raw: options.raw === true,
    noTmuxEnv: process.env.AGENTS_NO_TMUX === '1',
    tmuxAvailable: isTmuxInstalled(),
  })) {
    timer.mark('startup');
    try {
      const result = await runInTmux(options, executable, args);
      timer.end({ exitCode: result.exitCode, status: result.exitCode === 0 ? 'success' : 'failed' });
      return result;
    } catch (err) {
      timer.end({ error: (err as Error).message, exitCode: -1, status: 'error' });
      throw err;
    }
  }

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
    // whether addressed by name or absolute path. On that shell path, compose a
    // single fully-quoted command line and pass an EMPTY args array (see
    // composeWin32CommandLine) so Node never concatenates the args array — which
    // carries the user's prompt — into the cmd.exe line unescaped (DEP0190 +
    // command injection).
    const useShell = process.platform === 'win32' && (
      !path.isAbsolute(executable) || executable.endsWith('.cmd')
    );
    const spawnCommand = useShell ? composeWin32CommandLine(executable, args) : executable;
    const spawnArgs = useShell ? [] : args;
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: options.cwd || process.cwd(),
      stdio,
      env: buildExecEnv(options),
      shell: useShell,
    });

    // Record this launch so `ag sessions --active` can map the pid to its exact
    // session (sessionId is set for Claude above) instead of guessing the newest
    // .jsonl in the cwd — the collapse that made co-located agents indistinguishable.
    // Best-effort: pruned when the pid dies; a failed write just degrades to the heuristic.
    writePidSessionEntry({
      pid: child.pid ?? 0,
      agent: options.agent,
      sessionId: options.sessionId,
      cwd: options.cwd || process.cwd(),
      tmuxPane: process.env.TMUX_PANE,
      startedAtMs: Date.now(),
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
  /**
   * Env vars merged over options.env for THIS attempt only. Used by profiles
   * with `fallback_model` to swap the model env key (e.g. ANTHROPIC_MODEL) on
   * a same-agent retry without touching auth or base URL.
   */
  envOverride?: Record<string, string>;
}

/** ExecOptions extended with a fallback chain for rate-limit cascading. */
export interface FallbackOptions extends ExecOptions {
  /** Ordered list of agents to try if the primary (options.agent) hits a rate limit. */
  fallback: FallbackEntry[];
  /** Fallback requires a prompt -- chain handoff doesn't apply to interactive sessions. */
  prompt: string;
  /**
   * Optional out-param the caller reads AFTER the call to learn which chain
   * entry actually executed — updated to each entry as it is attempted, so on
   * return it holds the agent+version whose exit code is returned. Lets the
   * audit log record the fallback that really ran, not always the primary
   * (issue #347).
   */
  dispatchSink?: { agent?: AgentId; version?: string };
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
    const { agent, version, envOverride } = chain[i];
    // Record the entry we're about to attempt so the caller (audit log) sees the
    // agent+version that actually ran, even after a rate-limit handoff.
    if (options.dispatchSink) { options.dispatchSink.agent = agent; options.dispatchSink.version = version; }
    const pinnedSessionId = agent === 'claude' ? randomUUID() : undefined;

    // Same-host retry (same agent+version as previous entry — used by profile
    // `fallback_model` swaps) keeps the original prompt: the model changed,
    // not the CLI, so a `/continue` handoff prompt would be misleading.
    const prev = i > 0 ? chain[i - 1] : undefined;
    const sameHostRetry = !!prev && prev.agent === agent && prev.version === version;
    const prompt = prevAgent && !sameHostRetry
      ? buildFallbackPrompt(prevAgent, prevSessionId, agent, options.prompt)
      : options.prompt;

    const execOpts: ExecOptions = {
      ...options,
      agent,
      version,
      prompt,
      env: envOverride ? { ...(options.env ?? {}), ...envOverride } : options.env,
      sessionId: pinnedSessionId ?? (i === 0 ? options.sessionId : undefined),
    };

    const label = version ? `${agent}@${version}` : agent;
    const modelSwapNote = sameHostRetry && envOverride
      ? ` (retry with ${Object.entries(envOverride).map(([k, v]) => `${k}=${v}`).join(', ')})`
      : '';
    const banner = i === 0
      ? `[agents] running ${label}`
      : sameHostRetry
        ? `[agents] retry → ${label}${modelSwapNote}`
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
    const nextSameHost = next.agent === agent && next.version === version;
    const handoffVerb = nextSameHost ? 'Retrying on same host' : 'Handing off';
    process.stderr.write(`[agents] ${label} hit rate limit. ${handoffVerb} to ${nextLabel}...\n`);
    prevAgent = agent;
    prevSessionId = pinnedSessionId;
  }

  return 1;
}
