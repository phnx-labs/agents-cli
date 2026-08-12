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
import { AGENTS, findInPath } from './agents.js';
import { parseTimeout } from './routines.js';
import { compareVersions, getBinaryPath, getVersionHomePath, isVersionInstalled, listInstalledVersions, resolveVersion } from './versions.js';
import { resolveModel, buildReasoningFlags } from './models.js';
import { isTierToken, resolveTier } from './model-tiers.js';
import { emitStart, createTimer, redactPrompt, redactArgs } from './events.js';
import { sanitizeProcessEnv } from './secrets/bundles.js';
import { resolveActor, actorEnv } from './actor.js';
import { expandLocalHome } from './project-root.js';
import { getShimsDir, getHistoryDir, getUserAgentsDir, getRuntimeStateDir } from './state.js';
import { resolveCodexHome } from './codex-home.js';
import { readCodexConfiguredModel } from './shims.js';
import { writePidSessionEntry, extractSessionIdArg } from './session/pid-registry.js';
import { writeSessionActorRecord, writeSessionAliasRecord } from './session/actor-sidecar.js';
import { loadHookSessionIndex, resolveHookSessionId } from './session/hook-sessions.js';
import { sessionIdMarkerLine } from './hosts/session-marker.js';
import { recordRunName } from './session/run-names.js';
import { mailboxDir, isValidMailboxId } from './mailbox.js';
import { composeWin32CommandLine } from './platform/index.js';
import { isTmuxInstalled } from './tmux/binary.js';
import { isTmuxEnabled } from './device-config.js';
import { machineId } from './machine-id.js';
import { shellQuote } from './ssh-exec.js';
import { resolveClaudeSetupToken } from './claude-account-token.js';
import { codexEditWritableRoots, codexPolicyArgs } from './codex-policy.js';
import { applyAddDirs } from './add-dir.js';
import { applyActiveRulesPresetAtRun } from './rules/run-sync.js';

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
 * - `plan` on an agent without a read-only mode degrades to the agent's
 *   safest native mode (`capabilities.modes[0]`, typically `edit`). Agents
 *   like antigravity/kiro have no plan flag; hard-failing made
 *   multi-agent scripts (`--mode plan` for everyone) unusable and diverged
 *   from `agents teams add`, which already defaults to `edit`. Callers that
 *   care (the `agents run` CLI) must surface a warning when requested ≠
 *   resolved so the elevation is not silent.
 * - `skip` on an agent without skip support throws with a clear message
 *   naming the agent's supported modes. No silent fallback — the user
 *   explicitly asked to bypass permissions; pretending we did is unsafe.
 */
export function resolveMode(agent: AgentId, requested: Mode): Mode {
  const supported = AGENTS[agent].capabilities.modes;
  if (supported.includes(requested)) return requested;

  if (requested === 'auto') {
    // Fall back to edit — guaranteed to exist on every agent (every agent has
    // at least 'edit' in its modes table, since that's the default behavior).
    return 'edit';
  }

  if (requested === 'plan') {
    // No read-only mode on this agent. modes[0] is the declared safest mode
    // (edit for antigravity/kiro/…). Prefer that over hard-fail so
    // uniform multi-agent `--mode plan` dispatches still run.
    return supported[0];
  }

  throw new Error(
    `${agent} does not support '${requested}' mode. Supported modes: ${supported.join(', ')}.`,
  );
}

/**
 * Resolve a requested mode for a run, honoring whether the run is HEADLESS.
 *
 * Wraps resolveMode with one extra rule: an agent may list `plan` in its modes
 * (so interactive plan works) yet declare `capabilities.headlessPlan === false`
 * because plan is broken in a headless `--prompt`/`-p` run — kimi refuses
 * `--prompt` + `--plan`, and grok's `--permission-mode plan` silently stalls at
 * its ExitPlanMode gate. For those agents, a headless plan request degrades to
 * `auto` (kimi -p auto-runs; grok maps auto→edit via resolveMode) with a visible
 * one-line stderr warning, mirroring the graceful plan→edit degrade antigravity
 * and kiro get for having no plan flag at all. Interactive runs are never
 * downgraded. This is the single source of truth shared by buildExecCommand
 * (agents run / teams) and the routine runner.
 */
export function resolveHeadlessMode(
  agent: AgentId,
  requested: Mode,
  interactive: boolean,
  warningContext?: string,
  warningState?: ModeWarningState,
): Mode {
  const mode = resolveMode(agent, requested);
  const warn = (message: string): void => {
    if (warningState?.quiet) return;
    if (warningState) {
      warningState.emitted ??= new Set();
      if (warningState.emitted.has(agent)) return;
      warningState.emitted.add(agent);
    }
    process.stderr.write(message);
  };
  if (mode !== requested) {
    const subject = warningContext ? `${warningContext}: ` : '';
    if (requested === 'plan') {
      warn(
        `[agents] ${subject}${agent} has no read-only 'plan' mode; ` +
        `running '${mode}' (writable) instead. Pass --mode ${mode} to silence this.\n`,
      );
    } else {
      warn(`[agents] ${subject}${agent} has no '${requested}' mode; using '${mode}'.\n`);
    }
  }
  if (!interactive && mode === 'plan' && AGENTS[agent].capabilities.headlessPlan === false) {
    warn(`warning: ${agent} has no headless plan mode; running --mode auto instead\n`);
    return resolveMode(agent, 'auto');
  }
  return mode;
}

export interface ModeWarningState {
  /** Agents already warned about, so one run warns once per agent. A fallback
   *  chain degrades each agent independently and the agent that actually ran is
   *  usually not the first, so this cannot be a single boolean. */
  emitted?: Set<AgentId>;
  quiet?: boolean;
}

/**
 * The mode an agent should run in when the caller has no preference.
 *
 * Returns the first entry in the agent's `capabilities.modes` table — the
 * declaration order is the source of truth for "the safest mode this agent
 * supports." Agents that include `plan` list it first; agents like
 * antigravity that have no read-only mode list `edit` first.
 *
 * Prefer this over a hard-coded `'plan'` when the agent is known. `resolveMode`
 * also maps an unsupported `'plan'` request onto this same value.
 */
export function defaultModeFor(agent: AgentId): Mode {
  return AGENTS[agent].capabilities.modes[0];
}

/** Safe mode used when the user did not provide --mode or a configured default. */
export function implicitModeFor(agent: AgentId): ExecMode {
  return agent === 'codex' ? 'edit' : 'plan';
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
  /** True when the caller omitted --mode; fallback agents resolve their own safe default. */
  modeWasImplicit?: boolean;
  effort: ExecEffort;
  cwd?: string;
  /** Force headless mode even when no prompt is provided (e.g. piping via stdin). */
  headless?: boolean;
  /** Prefix for mode-degradation warnings emitted by shared headless paths. */
  modeWarningContext?: string;
  /** Shared across command previews/spawns/loop iterations so degradation warns once. */
  modeWarningState?: ModeWarningState;
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
   * Tee-and-tail the child's stdout even when no budget cap is active, so the
   * caller can scan it for rate/usage-limit messages. Claude prints billing
   * refusals ("monthly spend limit", "out of usage credits") to STDOUT, not
   * stderr — a fallback chain that only inspects stderr never cascades on
   * them. Set by runWithFallback for every chain entry; harmless elsewhere
   * (output is mirrored to the parent's stdout exactly like stdio:'inherit').
   */
  captureStdoutTail?: boolean;
  /**
   * Print the run's resolved session id to stdout as a one-line sentinel once the
   * child exits (see hosts/session-marker.ts). Set by the `--host` dispatch so the
   * LAUNCHER can relate the remote-created session back to itself — Claude's id is
   * forced up front, but every other agent coins its own id on the remote box, and
   * this marker is how that id rides the followed log home. Headless-only and inert
   * for interactive runs (no combined log to parse).
   */
  emitSessionId?: boolean;
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
 * True when a run resolved to *inferred* interactive intent — no prompt and no
 * explicit `--interactive` — but there is no terminal to host the REPL. Launching
 * would attach a TUI to a dead stdin and hang forever, so the caller should fail
 * fast with the headless alternatives instead (RUSH-1829).
 *
 * An explicit `--interactive` is the caller's deliberate choice and is never
 * blocked (they may be driving a PTY we can't detect). Pure — the TTY state is a
 * parameter so this is unit-testable without touching `process.std*`.
 */
export function inferredInteractiveWithoutTty(
  options: Pick<ExecOptions, 'interactive' | 'headless' | 'prompt'>,
  isTty: boolean,
): boolean {
  if (options.interactive === true) return false;
  return resolveInteractive(options) && !isTty;
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
export function shouldTapStdout(interactive: boolean, piped: boolean, capsActive: boolean, captureTail = false): boolean {
  if (interactive) return false;
  // Always pipe when the caller pipes us downstream (preserve composability),
  // when caps are active so the watcher can read the stream at a TTY, or when
  // a fallback chain needs a stdout tail for rate-limit detection.
  return piped || capsActive || captureTail;
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
 * Resolve the launch id a run exports as `AGENT_LAUNCH_ID`.
 *
 * The launch id is the stable correlation key the SessionStart hook records
 * alongside the agent's real session id (terminals/sessions/<pid>.json), so it
 * is what maps a launch to its exact session even when the hook runs under a
 * different pid (tmux pane leaf / cmd.exe wrapper) — and, across an SSH hop, what
 * lets a `--host` launcher resolve the remote-coined id for agents that never
 * accept a forced `--session-id`.
 *
 * ADOPT a caller-supplied `AGENT_LAUNCH_ID` (a `--host` launcher forwards one via
 * `--env` so it controls the key end-to-end); MINT a fresh one otherwise (every
 * local run, which passes none). A malformed inbound value is ignored in favour
 * of a fresh mint — the key must be a real correlation id, never an empty string.
 */
export function resolveLaunchId(envLaunchId: string | undefined): string {
  const inbound = envLaunchId?.trim();
  return inbound ? inbound : randomUUID();
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
    // The per-account `claude setup-token` only resolves when there is a version
    // home to key it to; version===null (claude unresolved / not installed) yields
    // null, exactly as the routines path treats it (`runner.ts:1017-1021`). The
    // token decision below runs even then, so an ambient inherited value is stripped
    // on the routines/provisioned path regardless of whether a version resolved.
    const versionHome = version ? getVersionHomePath('claude', version) : null;
    const setupToken = versionHome ? resolveClaudeSetupToken(versionHome) : null;
    if (versionHome) {
      result.CLAUDE_CONFIG_DIR = path.join(versionHome, '.claude');
      // A managed pin lives in a per-version dir; Claude Code's own background
      // auto-updater would rewrite that pinned binary in place (and has left it
      // half-swapped and broken). Disable it so a pin stays a pin. Honor an
      // explicit user value — from process.env (already in result) or from
      // options.env (spread over result below).
      if (result.DISABLE_AUTOUPDATER === undefined) {
        result.DISABLE_AUTOUPDATER = '1';
      }
    }
    // The `auth` bundle's setup-token exists so a run with NO human present
    // authenticates without the Touch-ID-gated login item — usage probes,
    // routines, dispatched runs (claude-account-token.ts). An interactive run
    // has a human at the TTY, and their own per-version login is the credential
    // they established and expect; overriding it made `/status` report
    // `Auth token: CLAUDE_CODE_OAUTH_TOKEN` on a personal machine and took every
    // hand-driven session off that login. macOS cannot cheaply confirm a home's
    // login first (probing the Keychain raises an authorization sheet per
    // installed version on the `agents run` hot path — agents.ts
    // `isClaudeCredentialFileBlank`), so interactive simply defers to Claude
    // Code, which prompts a present human to log in if the login is missing.
    if (resolveInteractive(options)) {
      // Drop an INHERITED copy of OUR OWN setup-token: an interactive launch from
      // inside a headless agent's shell inherits that agent's injected value via
      // sanitizeProcessEnv(process.env) and would keep authenticating as it.
      // Matched by VALUE, so a token the user exported deliberately is a different
      // string and is left alone (#2383). This is NARROWER than the non-interactive
      // path below, which overwrites-or-deletes unconditionally and never inspects
      // the inherited value — a DIFFERENT account's inherited setup-token passing
      // through this equality check is the adjacent hole RUSH-2360 leaves as
      // follow-up (it does not silently run on a *shared, rotating* token, which is
      // what caused the RUSH-1822 logout storm).
      if (setupToken && result.CLAUDE_CODE_OAUTH_TOKEN === setupToken) {
        delete result.CLAUDE_CODE_OAUTH_TOKEN;
      }
    } else {
      // Non-interactive (routines, dispatched, provisioned box): mirror the routines
      // path (`runner.ts:1017-1021`) UNCONDITIONALLY. Inject the per-account
      // setup-token when one resolves — it replaces any ambient shared value
      // inherited from the launcher. When NONE resolves, STRIP the ambient
      // CLAUDE_CODE_OAUTH_TOKEN so a run on a provisioned box can never silently
      // authenticate as the shared, rotating token an earlier version of this path
      // let through — the RUSH-1822 fleet-wide-logout hazard, tracked by RUSH-2360.
      // A missing login then fails loud (401) against this home's own credential
      // instead of quietly borrowing another's. options.env still wins below for an
      // explicit caller override.
      if (setupToken) {
        result.CLAUDE_CODE_OAUTH_TOKEN = setupToken;
      } else {
        delete result.CLAUDE_CODE_OAUTH_TOKEN;
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
      // On macOS the deep versioned home overflows the Unix-socket SUN_LEN
      // limit for codex's app-server control socket; resolve to a short,
      // SUN_LEN-safe home (migrating once if needed). See codex-home.ts.
      const versionedHome = path.join(getVersionHomePath('codex', version), '.codex');
      const agentsUserDir = path.dirname(getHistoryDir());
      result.CODEX_HOME = resolveCodexHome(versionedHome, agentsUserDir, version);
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
  } else if (options.agent === 'muse') {
    // Muse has no MUSE_CONFIG_DIR. Config is XDG-based:
    //   $XDG_CONFIG_HOME/muse  (settings, skills, hooks, auth)
    //   $XDG_DATA_HOME/muse    (sessions, plugins)
    // Pin both into the version home so multi-version isolation matches
    // Claude's CLAUDE_CONFIG_DIR / Codex's CODEX_HOME, and so Muse never
    // resolves through the adopt-time ~/.config/muse symlink (SymlinkOrReparse).
    const cwd = options.cwd || process.cwd();
    const resolvedVersion = options.version ?? resolveVersion('muse', cwd);
    const version = options.version
      ? resolvedVersion
      : (resolvedVersion && isVersionInstalled('muse', resolvedVersion) ? resolvedVersion : null);
    if (version) {
      const versionHome = getVersionHomePath('muse', version);
      result.XDG_CONFIG_HOME = path.join(versionHome, '.config');
      result.XDG_DATA_HOME = path.join(versionHome, '.local', 'share');
    }
    delete result.CLAUDE_CONFIG_DIR;
    delete result.CODEX_HOME;
    delete result.COPILOT_HOME;
    delete result.KIMI_CODE_HOME;
  } else if (options.agent === 'cursor') {
    // Cursor has no config-dir env var (only CURSOR_API_KEY / CURSOR_API_ENDPOINT).
    // Its OAuth token — the login gate — lives at $XDG_CONFIG_HOME/cursor/auth.json
    // (verified empirically: relocating XDG_CONFIG_HOME relocates the login;
    // ~/.cursor/cli-config.json holds only account metadata, not the token). Pin
    // XDG_CONFIG_HOME into the version home so each installed Cursor account
    // authenticates from its own token, isolated per run — no global ~/.cursor
    // symlink swap, so concurrent runs on different accounts never clobber one
    // another. cli-config.json (HOME-relative) has no override and stays on the
    // shared home; only the token is per-account, which is what gates the login.
    const cwd = options.cwd || process.cwd();
    const resolvedVersion = options.version ?? resolveVersion('cursor', cwd);
    const version = options.version
      ? resolvedVersion
      : (resolvedVersion && isVersionInstalled('cursor', resolvedVersion) ? resolvedVersion : null);
    if (version) {
      result.XDG_CONFIG_HOME = path.join(getVersionHomePath('cursor', version), '.config');
    }
    delete result.CLAUDE_CONFIG_DIR;
    delete result.CODEX_HOME;
    delete result.COPILOT_HOME;
    delete result.KIMI_CODE_HOME;
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
    // Full session id for agent-callable tools (`agents feed post`, etc.).
    result.AGENT_SESSION_ID = options.sessionId;
    result.AGENTS_SESSION_ID = options.sessionId;
  }
  // Lineage edge: the child's parent is THIS process's session (the spawner), so a
  // sub-agent's events carry a walkable edge back to who spawned it. The event floor
  // (events.ts::resolveProvenance) reads AGENTS_PARENT_SESSION_ID and stamps it on
  // every event the child emits. `options.sessionId` is the CHILD's id, so read the
  // spawner from the live env; guard a same-session resume from naming itself parent.
  // Local-spawn scope here; forwarding it across the `--host` SSH hop is Phase 4.
  const spawnerSessionId = process.env.AGENTS_SESSION_ID || process.env.AGENT_SESSION_ID;
  if (spawnerSessionId && spawnerSessionId !== options.sessionId) {
    result.AGENTS_PARENT_SESSION_ID = spawnerSessionId;
  }
  result.AGENTS_RUNTIME = resolveInteractive(options) ? 'terminal' : 'headless';
  // Durable SessionStart metadata. The hook joins these launch facts to the
  // harness-provided real session id and writes them under the shared history
  // directory, so a later resume can restore the permission boundary without
  // re-parsing harness-specific transcripts.
  result.AGENTS_RUN_MODE = resolveHeadlessMode(
    options.agent,
    normalizeMode(options.mode),
    resolveInteractive(options),
    options.modeWarningContext,
    options.modeWarningState,
  );
  result.AGENTS_HISTORY_DIR = getHistoryDir();
  // So activity / feed posts stamp the right harness without re-detecting.
  if (options.agent) {
    result.AGENTS_AGENT_NAME = options.agent;
  }
  if (options.cwd) {
    result.AGENTS_CWD = options.cwd;
  }

  // Export the run's durable name (companion to AGENT_SESSION_ID) so a
  // SessionStart hook / the agent can associate its transcript with the handle
  // the user gave the run. Only set when --name was passed.
  if (options.name) {
    result.AGENT_SESSION_NAME = options.name;
  }

  // Actor provenance -- who initiated this run. Rides the env so the whole spawn
  // tree shares one actor, and (for a resolved human) so the agent's own git
  // commits are credited to the person instead of the shared account. options.env
  // (spread last) overrides any of these keys a caller sets explicitly.
  Object.assign(result, actorEnv(resolveActor()));

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
  resume?: (
    { flag: string; interactiveFlag?: string; headlessFlag?: string } |
    { subcommand: string }
  ) & { since?: string };
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
      // Native Codex modes are assembled by codexPolicyArgs below. Named
      // permission profiles keep filesystem access and network access
      // independent; legacy --sandbox flags cannot express that combination.
      plan: [],
      edit: [],
      // skip = codex --yolo: drops the sandbox entirely and approves anything.
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
      plan: ['--plan'],
      edit: [],
      skip: ['-f'],
    },
    jsonFlags: ['--output-format', 'stream-json'],
    modelFlag: '--model',
    resume: { flag: '--resume', since: '2026.7.23' },
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
  // Oh My Pi (`omp`). Headless is the positional MESSAGES arg + `-p/--print`.
  // Approval modes map to omp's `--approval-mode`: always-ask (read-only tools
  // auto-approved, writes gated -> our `plan`), write (read + workspace writes
  // auto-approved -> `edit`), yolo (all tiers auto-approved -> `skip`). JSON is
  // omp's `--mode json` event stream. `--model` fuzzy-matches a provider/model
  // selector. Native resume is `-r/--resume <id-prefix>`.
  pi: {
    base: ['omp'],
    promptFlag: 'positional',
    modeFlags: {
      plan: ['--approval-mode', 'always-ask'],
      edit: ['--approval-mode', 'write'],
      skip: ['--approval-mode', 'yolo'],
    },
    jsonFlags: ['--mode', 'json'],
    modelFlag: '--model',
    printFlags: ['-p'],
    resume: { flag: '--resume' },
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
    // Standalone hooks live under ~/.kiro/hooks/*.json and only fire on the
    // v3 engine (opt-in via --v3; see https://kiro.dev/docs/cli/v3/hooks/).
    // Without this flag agents-cli would write v3 hook files that never run.
    base: ['kiro-cli', '--v3'],
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
    resume: { flag: '--resume', since: '0.2.91' },
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
    resume: { flag: '--session', since: '0.19.2' },
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
    resume: { flag: '--resume', headlessFlag: '--session-id', since: '0.186.0' },
  },
  hermes: {
    base: ['hermes', 'chat'],
    promptFlag: 'positional',
    modeFlags: {
      edit: [],
    },
    modelFlag: '--model',
  },
  // Meta Muse Code (`muse exec` headless, `muse` TUI). Flags from
  // `muse --help` / `muse exec --help` (v0.1.0): prompt is positional;
  // --model selects muse-spark-*; --reasoning-effort is the effort dial;
  // --disable-write approximates plan (no non-shell writes); --disable-approval
  // keeps the sandbox (auto); --yolo drops approval+sandbox and trusts the
  // workspace (skip). --json emits JSONL on stdout. Interactive resume is
  // `muse resume <id>`; headless resume is `muse exec --session-id <id>` —
  // see the muse resume branch in buildExecCommand.
  muse: {
    base: ['muse', 'exec'],
    promptFlag: 'positional',
    modeFlags: {
      plan: ['--disable-write'],
      edit: [],
      auto: ['--disable-approval'],
      skip: ['--yolo'],
    },
    jsonFlags: ['--json'],
    modelFlag: '--model',
    // Flag form covers headless (`--session-id`). Interactive uses the
    // `resume` subcommand — special-cased in buildExecCommand.
    resume: { flag: '--session-id' },
  },
  // Warp Agent CLI (`warp`) — the interactive TUI. It has NO headless one-shot
  // form: the documented flags are --api-key/--auto-approve/--resume <token>/
  // --set-provider-api-key/--clear-provider-api-key/--version/--help — no
  // -p/--prompt, no --model (model is the `/model` picker), no JSON output. So
  // bare `warp` opens the TUI and the single `edit` mode maps to no flags
  // (mirrors hermes); there are no jsonFlags/modelFlag to declare. No `resume`:
  // `warp --resume <token>` reopens a SERVER-SIDE conversation by token, but
  // warp is not session-tracked (absent from SESSION_AGENTS) so agents-cli has
  // no local id to feed — declaring it would make nativeResume(warp) true
  // against an unreachable path.
  warp: {
    base: ['warp'],
    promptFlag: 'positional',
    modeFlags: {
      edit: [],
    },
  },
};

/**
 * Whether `agent` has a native resume form (Tier 1). Derived solely from the
 * command template's `resume` field — the single source of truth. Agents that
 * return false resume via the universal Tier-2 `/continue` replay instead.
 */
export function nativeResume(agent: AgentId, version?: string): boolean {
  const resume = AGENT_COMMANDS[agent]?.resume;
  if (!resume) return false;
  if (!resume.since) return true;
  return !!version && compareVersions(version, resume.since) >= 0;
}

/**
 * Build the `-c` value that adds `dir` to codex's workspace-write writable
 * roots. Codex parses the value as TOML, so it's a single-element TOML array of
 * one quoted string. Used on codex resume forms, which reject `--add-dir` and
 * only accept `-c` config overrides.
 */
export function codexWritableRootsConfig(dir: string): string {
  return `sandbox_workspace_write.writable_roots=[${JSON.stringify(dir)}]`;
}

/**
 * Resolve the executable `buildExecCommand` will put in `cmd[0]`, or null when
 * that resolution finds nothing on disk.
 *
 * This is an EXISTENCE probe, not an "is it managed by us" check. A harness the
 * user installed themselves (Homebrew, a vendor `curl | sh`, a distro package)
 * has no version home at all, and running it is a supported state — so with no
 * version pinned we answer with a PATH lookup of the bare launch command, the
 * same thing `spawnAgent` would resolve.
 *
 * `findInPath` deliberately excludes our own shims dir, because a shim is a
 * dispatcher rather than an install. That exclusion alone is too strong here:
 * the shim DOES launch whenever agents-cli owns at least one version of the
 * agent — it resolves the version itself, and when no default is pinned it
 * prints its own accurate `no default set … agents use <agent> <version>`
 * guidance. Pre-empting that with "not installed" would name the wrong fix
 * (`agents add`) for a machine that already has the harness. So the shim counts
 * only when a managed version exists; with zero managed versions it is the dead
 * end this probe was written to catch (RUSH-2339).
 *
 * The version-pinned branch mirrors buildExecCommand exactly: versioned shim
 * first, then the version home's real binary. It deliberately does NOT fall back
 * to PATH — with a version pinned, buildExecCommand spawns the literal
 * `<cli>@<version>`, which is not on PATH, so a PATH hit here would be a lie
 * that still exits 127.
 */
export function resolveLaunchBinary(agent: AgentId, version?: string): string | null {
  const command = AGENT_COMMANDS[agent].base[0];
  if (version) {
    const versionedShim = path.join(getShimsDir(), `${command}@${version}`);
    if (process.platform === 'win32' && fs.existsSync(versionedShim + '.cmd')) {
      return versionedShim + '.cmd';
    }
    if (fs.existsSync(versionedShim)) return versionedShim;
    const binary = getBinaryPath(agent, version);
    return binary && fs.existsSync(binary) ? binary : null;
  }
  const native = findInPath(command);
  if (native) return native;
  if (listInstalledVersions(agent).length === 0) return null;
  // Re-scan PATH accepting the shim: point findInPath's exclusion at a path that
  // matches nothing, so the real shims dir participates like any other PATH entry.
  return findInPath(command, { shimsDir: path.join(getShimsDir(), '.no-such-dir') });
}

/** Assemble the full CLI argument array for an agent invocation. */
export function buildExecCommand(options: ExecOptions): string[] {
  const template = AGENT_COMMANDS[options.agent];
  const cmd: string[] = [...template.base];
  const interactive = resolveInteractive(options);

  // For Codex, Droid, and Muse, 'exec' is the headless subcommand; for OpenCode,
  // 'run' is. Drop it for interactive mode so we launch the TUI (`codex` /
  // `droid` / `muse` / `opencode`) instead of the one-shot headless subcommand
  // ('codex exec' / 'droid exec' / 'muse exec' / 'opencode run').
  if (interactive) {
    if (
      (options.agent === 'codex' || options.agent === 'droid' || options.agent === 'muse') &&
      cmd[1] === 'exec'
    ) {
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
  //
  // Muse interactive resume is also a subcommand (`muse resume <id>`), but the
  // session id MUST sit immediately after the verb — mode/model flags come
  // after. So for interactive muse we push both `resume` and the id here, and
  // skip the later generic resume flag path.
  const resumeSpec = options.resume ? template.resume : undefined;
  let museInteractiveResumeDone = false;
  if (options.agent === 'muse' && options.resume && interactive && options.sessionId) {
    cmd.push('resume', options.sessionId);
    museInteractiveResumeDone = true;
  } else if (resumeSpec && 'subcommand' in resumeSpec) {
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
      // No versioned shim on disk. Prefer the version's REAL launch binary
      // (node_modules/.bin/<cli>) over the bare `<cli>@<version>` name — that
      // literal is not on PATH and spawns as ENOENT (the `kimi@0.19.2` failure).
      // Fall back to the literal only if the binary is absent (the run path's
      // ensureAgentRunnable normally repairs/creates the alias before we reach here).
      const realBinary = options.agent ? getBinaryPath(options.agent, options.version) : undefined;
      cmd[0] = realBinary && fs.existsSync(realBinary) ? realBinary : versionedName;
    }
  }

  // Resolve the model up front so the reasoning-flag block can honor a cost tier
  // that maps to reasoning effort on a single-model harness (e.g. Grok, where the
  // tier IS the effort dial). `modelVersion` is null when no version resolves;
  // `tierModel` is the concrete model a tier resolved to (null => drop the flag).
  const effectiveModel = options.model
    ?? (options.agent === 'codex' ? readCodexConfiguredModel() : undefined);
  const modelVersion = effectiveModel && template.modelFlag
    ? (options.version || resolveVersion(options.agent, options.cwd || process.cwd()))
    : null;
  const tierResolved = effectiveModel && modelVersion && isTierToken(effectiveModel)
    ? resolveTier(options.agent, modelVersion, effectiveModel)
    : null;
  // An explicit --effort wins; otherwise a single-model tier's effort applies.
  const effortLevel = options.effort !== 'auto' ? options.effort : (tierResolved?.effort ?? options.effort);

  // Add reasoning effort flags (before mode flags for codex -c positioning)
  // For codex, -c must come before 'exec' subcommand, so we insert at position 1
  if (effortLevel !== 'auto') {
    const reasoningFlags = buildReasoningFlags(options.agent, effortLevel);
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
  // - `plan` on an agent without a read-only mode → degrades to modes[0]
  // - headless `plan` on an agent with headlessPlan:false (kimi, grok) →
  //   degrades to `auto` with a stderr warning (see resolveHeadlessMode)
  // - `skip` on an unsupported agent → throws a clear error
  // After resolution, the chosen mode is guaranteed to be in template.modeFlags.
  const resolvedMode = resolveHeadlessMode(
    options.agent,
    normalizeMode(options.mode),
    interactive,
    options.modeWarningContext,
    options.modeWarningState,
  );
  const modeFlags = template.modeFlags[resolvedMode];
  if (!modeFlags) {
    // Defense in depth: would only fire if AGENTS.capabilities.modes and
    // AGENT_COMMANDS.modeFlags drifted apart. Tests assert they agree.
    throw new Error(
      `Internal error: ${options.agent} declares '${resolvedMode}' in capabilities.modes but has no entry in AGENT_COMMANDS.modeFlags.${resolvedMode}.`,
    );
  }
  if (options.agent === 'cursor' && resolvedMode === 'edit' && !interactive) {
    // A configured headless run is the workspace trust decision. Keep this
    // narrower than --yolo/-f, which also bypasses permission checks.
    cmd.push('--trust');
  }
  if (options.agent === 'codex') {
    const policyMode = resolvedMode === 'plan' || resolvedMode === 'skip' ? resolvedMode : 'edit';
    const writableRoots = [
      ...codexEditWritableRoots(options.cwd ?? process.cwd()),
      ...(options.addDirs ?? []).map(expandLocalHome),
    ];
    cmd.push(...codexPolicyArgs(policyMode, writableRoots));
  } else if (resumeSpec && 'subcommand' in resumeSpec) {
    if (resolvedMode === 'skip') {
      // skip = yolo on resume too; both `codex resume` (TUI) and
      // `codex exec resume` accept the bypass flag.
      cmd.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (interactive) {
      cmd.push(...modeFlags);
    } else {
      // `codex exec resume` rejects `--sandbox <mode>` (verified against
      // `codex exec resume --help` on 0.142.5), but takes -c config overrides —
      // map the mode through sandbox_mode so a non-skip resume never gets the
      // approval/sandbox bypass.
      cmd.push(...modeFlags);
    }
  } else if (options.agent === 'kimi' && !interactive) {
    // kimi's headless prompt mode (`-p`/`--prompt`) is self-contained and REFUSES
    // to be combined with any startup-mode flag: `--plan`, `--auto`, and `--yolo`
    // all abort with "Cannot combine --prompt with --X" (verified against the live
    // kimi CLI). The write-capable modes (edit/auto/skip) all collapse to kimi's
    // default `-p` behavior, which already auto-approves tool calls, so we emit no
    // mode flag. Plan can't reach here headless — resolveHeadlessMode already
    // downgraded it to auto (kimi's headlessPlan:false); this asserts that
    // invariant so a plan-mode run can never silently mutate the workspace.
    if (resolvedMode === 'plan') {
      throw new Error(
        `Internal error: kimi reached headless command build with resolved mode 'plan'; ` +
          `resolveHeadlessMode should have downgraded it to auto (capabilities.headlessPlan is false).`,
      );
    }
    // edit/auto/skip: emit no mode flag — `kimi -p` auto-runs.
  } else {
    cmd.push(...modeFlags);
  }

  // Add print/headless flags whenever the run RESOLVED headless -- gate on the
  // resolved state (`!interactive`), not the raw `--headless` flag. Headless is
  // inferred from prompt presence (resolveInteractive), and `--headless` defaults
  // to `false` at the CLI layer, so gating on `options.headless` skipped these
  // flags for a bare `agents run <agent> "prompt"`. For antigravity that meant
  // `agy <prompt>` with no `--print`, launching the TUI and dying on `/dev/tty`
  // in any non-terminal shell. `!interactive` is true for both an explicit
  // `--headless` and a prompt-inferred headless run; an interactive run (no
  // prompt, or `--interactive`) still skips them so the CLI opens its REPL.
  if (!interactive && template.printFlags) {
    cmd.push(...template.printFlags);
  }

  // Resume vs. create. With `resume`, emit the agent's NATIVE resume reference:
  // `{ flag }` agents append `<flag> <id>` (claude `--resume <id>`); `{ subcommand }`
  // agents (codex) already pushed the verb above, so the id is the first
  // positional here — placed before the prompt positional appended later. Without
  // `resume`, the legacy claude-only `--session-id` CREATES a session with that id.
  if (options.resume && options.sessionId && resumeSpec && !museInteractiveResumeDone) {
    if ('flag' in resumeSpec) {
      const flag = interactive
        ? (resumeSpec.interactiveFlag ?? resumeSpec.flag)
        : (resumeSpec.headlessFlag ?? resumeSpec.flag);
      cmd.push(flag, options.sessionId);
    } else {
      cmd.push(options.sessionId);
    }
  } else if (options.sessionId && options.agent === 'claude') {
    cmd.push('--session-id', options.sessionId);
  }

  // Add model. Prefer the user's explicit --model. Otherwise, for Codex, fall
  // back to the model configured in the user's active ~/.codex/config.toml:
  // Codex runs under a per-version CODEX_HOME (see buildExecEnv) that may not
  // carry that setting, so without this it silently defaults to gpt-5.3-codex,
  // which a ChatGPT-tier account can't use (HTTP 400). Forwarding keeps the
  // user's default model setup for both `agents run` and `agents teams`.
  if (effectiveModel && template.modelFlag) {
    if (tierResolved) {
      // Cost tier (cheap|default|best|ultra) -> a concrete model this harness+
      // version actually ships. Covers `agents run` and `agents teams` (both
      // funnel here). A null model means nothing resolved -> drop the flag and
      // let the harness pick its default.
      if (tierResolved.model) {
        cmd.push(template.modelFlag, tierResolved.model);
        if (tierResolved.note) process.stderr.write(`[agents] --model ${effectiveModel} -> ${tierResolved.model} (${tierResolved.note})\n`);
      } else {
        process.stderr.write(`[agents] no model for tier "${effectiveModel}" on ${options.agent}@${modelVersion}; using harness default\n`);
      }
    } else if (modelVersion) {
      const resolved = resolveModel(options.agent, modelVersion, effectiveModel);
      if (resolved.warning) {
        process.stderr.write(`[agents] ${resolved.warning}\n`);
      }
      cmd.push(template.modelFlag, resolved.forwarded);
    } else if (!isTierToken(effectiveModel)) {
      cmd.push(template.modelFlag, effectiveModel);
    } else {
      // Tier token but no version resolved -> forwarding the literal "best"/etc.
      // would be rejected by the CLI, so drop the flag (harness default).
      process.stderr.write(`[agents] cannot resolve tier "${effectiveModel}" without a version; using harness default\n`);
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
    } else if (interactive && options.agent === 'claude') {
      // Claude's -p is --print, not a prompt-value flag. In an interactive run
      // the initial prompt is positional; emitting `-p /continue <id>` turns a
      // focus recovery into a one-shot print process that immediately exits.
      cmd.push(options.prompt);
    } else if (template.promptFlag === 'positional') {
      cmd.push(options.prompt);
    } else {
      cmd.push(template.promptFlag, options.prompt);
    }
  }

  // Project / --add-dir grants. Codex folds them into the named edit profile
  // above (workspace_roots); resume rejects the native --add-dir flag.
  // Everything else is strategy-driven in applyAddDirs:
  //   native-flag  — claude, kimi, cursor (`--add-dir`)
  //   grok-sandbox — rules + project sandbox profile when sandboxed
  //   none         — ignored (no multi-root surface)
  //
  // `~` is expanded in normalizeAddDirs (via expandLocalHome), because no shell
  // does it for us: a forwarded grant crosses the SSH boundary single-quoted
  // (`shellQuote` in ssh-exec.ts), so the remote login shell leaves `~/…`
  // literal and the harness resolves it as a directory actually named `~`.
  // Expanding on the side that runs the harness is what lets one home-relative
  // grant re-root per machine.
  applyAddDirs(options.agent, cmd, options.addDirs, {
    cwd: options.cwd ?? process.cwd(),
  });

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

  // Match the POSIX shim: direct Codex launches default to the safe writable
  // profile, while later user arguments can still override native settings.
  const launchArgs = agent === 'codex'
    ? ['-c', 'check_for_update_on_startup=false', ...codexPolicyArgs('edit', codexEditWritableRoots(cwd))]
    : [];
  // Mint a launch id and export it as AGENT_LAUNCH_ID so the agent's SessionStart
  // hook records the same id — the join key that maps this launch to its exact
  // session even though the recorded pid here is the cmd.exe wrapper (Windows) or
  // a shell, while the hook runs under the agent descendant. This is the primary
  // attribution path on Windows (no lsof), so the launchId join matters most here.
  const launchId = randomUUID();
  // mode/effort are required by ExecOptions but do not affect the env buildExecEnv
  // derives; pass the agent's default to satisfy the type. Passing no prompt makes
  // this resolve INTERACTIVE, so the launch authenticates from the per-version
  // login rather than the headless `auth` setup-token (EXEC-2a) — right for the
  // common case, someone invoking the harness binary directly. Known limit: we do
  // not parse `rawArgs`, so a `-p "task"` passthrough is headless in fact and
  // interactive by this classification, and loses the token. Windows-only in
  // practice (POSIX uses the bash shim, which execs the binary and never reaches
  // buildExecEnv — `shims.ts:749`, `shims.ts:761-764`).
  const env = buildExecEnv({ agent, version, cwd, mode: defaultModeFor(agent), effort: 'auto', env: { AGENT_LAUNCH_ID: launchId } });
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
      const passthroughSessionId = extractSessionIdArg(rawArgs);
      writePidSessionEntry({
        pid: child.pid,
        agent,
        sessionId: passthroughSessionId,
        cwd,
        actor: resolveActor().id,
        initiatedBy: resolveActor().kind,
        launchId,
        terminalId: process.env.AGENT_TERMINAL_ID,
        startedAtMs: Date.now(),
      });
      // Durable sessionId -> actor record (RUSH-2019) so the scanner can attribute
      // this session to a person after the pid dies. Best-effort; no-ops without id.
      if (passthroughSessionId) {
        writeSessionActorRecord({
          sessionId: passthroughSessionId,
          actor: resolveActor().id,
          initiatedBy: resolveActor().kind,
          startedAtMs: Date.now(),
        });
      }
    }
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on('error', (err) => {
      process.stderr.write(`agents: failed to launch ${agent}: ${err.message}\n`);
      resolve(127);
    });
  });
}

/** Exit code and captured output from a spawned agent process. */
interface SpawnResult {
  exitCode: number;
  stderr: string;
  /**
   * Rolling tail of the child's stdout, captured only when the stream was
   * tapped (budget watcher, piped caller, or captureStdoutTail). Empty when
   * stdout was inherited. Used by runWithFallback to detect billing refusals
   * Claude prints to stdout rather than stderr.
   */
  stdout: string;
}

/**
 * Whether a dead pane's failure should be recapped to stderr (RUSH-2185 / EXEC-23a).
 *
 * For headless runs only a nonzero exit is a failure worth surfacing — a
 * clean 0 means the agent finished the task before we could attach.
 * For interactive runs ANY exit (including 0) is a failure: an instant clean
 * exit means the harness has no bare REPL and the user would see only a mute
 * `[detached]` with no explanation.
 */
export function shouldRecapDeadPane(status: number | undefined, interactive: boolean): boolean {
  return (status ?? 0) !== 0 || interactive;
}

/**
 * The exit code a tmux-wrapped run resolves with (RUSH-2185 / EXEC-23b).
 *
 * Three inputs, one rule: report success ONLY for an outcome tmux actually told
 * us about. A clean user detach (`knownAlive`) is 0; a dead pane reports the
 * status tmux read off it; everything else — pane unreadable because the server
 * or session went away, or dead with no status — is UNKNOWN and resolves to
 * {@link UNKNOWN_OUTCOME_EXIT_CODE}, never 0.
 *
 * Why this is not `status ?? 0`: an interactive run whose tmux server died mid-
 * work landed on exactly those unknown branches and returned 0, so `agents run`
 * printed a failure banner while handing its caller a success code. The same
 * "1 if unknown" rule already governs the `--host` follow path
 * (`docs/specifications.md` §Agent execution, exit-code table).
 *
 * @param pane       What `paneExitStatus` read back for the agent pane.
 * @param knownAlive Positive proof the pane is still alive (see
 *                   {@link isPaneKnownAliveFromQueryResult}) — a clean detach.
 */
export function tmuxRunExitCode(
  pane: { dead: boolean; status?: number },
  knownAlive: boolean,
): number {
  if (knownAlive) return 0;
  if (pane.dead && pane.status !== undefined) return pane.status;
  return UNKNOWN_OUTCOME_EXIT_CODE;
}

/**
 * True only when a `display-message #{pane_dead}` tmux query explicitly returned
 * "0" (pane alive). Used to distinguish "pane alive" from "query failed" in
 * situations where `paneExitStatus` conservatively returns `{dead: false}` for
 * both (RUSH-2185 / EXEC-23a / F3).
 *
 * @param code   The exit code of the `tmux display-message` command.
 * @param stdout Its stdout (expected to be "0" when the pane is alive).
 */
export function isPaneKnownAliveFromQueryResult(code: number, stdout: string): boolean {
  return code === 0 && stdout.trim() === '0';
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
  /** This device's `tmux.enabled` config — false turns the wrap off for every launch on this box. */
  configEnabled: boolean;
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
 * All seven guards must pass:
 *   - interactive     — a headless `-p` run has no TTY to attach; keep bare spawn.
 *   - not Windows     — no tmux path on win32.
 *   - not already in tmux — nesting tmux-in-tmux is pointless and confusing.
 *   - not --raw       — explicit opt-out.
 *   - not AGENTS_NO_TMUX=1 — env opt-out (CI, scripts, the shim passthrough path).
 *   - tmux.enabled    — this device's durable opt-out, for a box whose tmux is broken.
 *   - tmux installed  — otherwise there is nothing to wrap with.
 */
export function shouldWrapInTmux(ctx: TmuxWrapContext): boolean {
  if (!ctx.interactive) return false;
  if (ctx.platform === 'win32') return false;
  if (ctx.inTmux) return false;
  if (ctx.raw) return false;
  if (ctx.noTmuxEnv) return false;
  if (!ctx.configEnabled) return false;
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
 *
 * `redactEnvValues` replaces every value with a `<redacted>` marker while keeping
 * the KEY names. The env map here carries resolved secrets bundles (options.env),
 * so the real string would embed secret VALUES — which get persisted verbatim
 * into SessionMeta.cmd on disk (tmux/session.ts). The launched command uses the
 * real values; the stored/informational copy uses the redacted form (RUSH-1758).
 */
export function buildTmuxAgentCommand(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: { redactEnvValues?: boolean; envFile?: string } = {},
): string {
  const agentCmd = [executable, ...args].map(shellQuote).join(' ');
  // envFile: source the values instead of inlining them, so no VALUE ever lands
  // in the pane's argv. `exec env K=V …` put every resolved secret into the
  // process table, readable by any process of this user — on one fleet box six
  // live processes carried the secrets-store master passphrase, which decrypts
  // every file-backed bundle including the Claude OAuth tokens (RUSH-2100).
  // `set -a` exports what the file assigns; the file is unlinked before `exec`,
  // so it exists only for the sourcing itself. A missing file aborts the pane
  // rather than silently launching with a half-built env.
  if (opts.envFile) {
    const f = shellQuote(opts.envFile);
    // Remove the file whether or not sourcing succeeds — a bare `. f || exit 1`
    // strands the plaintext env (incl. the secrets-store master passphrase) on
    // disk on any source failure, worse than the argv leak this replaces
    // (RUSH-2100). Capture the source rc, unlink, then honor it.
    return `set -a; . ${f}; __agents_rc=$?; set +a; rm -f ${f}; [ "$__agents_rc" -eq 0 ] || exit 1; exec ${agentCmd}`;
  }
  const envPrefix = Object.entries(env)
    .filter(([k, v]) => v !== undefined && EXEC_ENV_KEY_PATTERN.test(k))
    .map(([k, v]) => `${k}=${opts.redactEnvValues ? '<redacted>' : shellQuote(String(v))}`)
    .join(' ');
  return `exec env ${envPrefix} ${agentCmd}`;
}

/**
 * Serialize the pane env to a shell-sourceable file, created 0600 and exclusively
 * (`wx`) so it can never adopt a pre-existing file's mode or content.
 *
 * EVERY key goes in the file, not a curated "secret-bearing" subset: a denylist
 * has to be updated for each new credential and is wrong the moment someone
 * forgets, whereas routing all of it through the file makes the guarantee hold by
 * construction. Keys are filtered to valid shell identifiers for the same reason
 * `env` needed it — an exported function (`BASH_FUNC_x%%`) is not assignable.
 */
export function writeTmuxEnvFile(env: NodeJS.ProcessEnv, filePath: string): void {
  const body = Object.entries(env)
    .filter(([k, v]) => v !== undefined && EXEC_ENV_KEY_PATTERN.test(k))
    .map(([k, v]) => `${k}=${shellQuote(String(v))}`)
    .join('\n');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeSync(fd, `${body}\n`);
  } finally {
    fs.closeSync(fd);
  }
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
  const { createSession, killSession, paneExitStatus, prepareSessionForResume, setSessionHook, slugifyName, agentPaneDiedHook, markSessionHookSchema } = await import('./tmux/session.js');
  const { getDefaultSocketPath } = await import('./tmux/paths.js');
  const { attachTmux, runTmux } = await import('./tmux/binary.js');

  const socket = getDefaultSocketPath();
  const cwd = options.cwd || process.cwd();
  const idSeed = (options.sessionId ?? randomUUID()).slice(0, 8);
  const name = slugifyName(`ag-${options.agent}-${idSeed}`);

  const RED = '\x1b[31m', GRAY = '\x1b[90m', OFF = '\x1b[0m';
  const NO_TMUX_TIP = `${GRAY}  Tip: re-run with --no-tmux to launch the agent directly and see its full output.\n  If tmux is broken on this machine, turn the wrap off for good: agents config set devices.${machineId()}.tmux off${OFF}\n\n`;

  // Recap a dead pane's tail into THIS shell's stderr. The pane-died hook
  // detaches the client the instant the agent exits, so a fast failure (a
  // gutted install that dies with ENOENT, a bad flag, a crash on startup) would
  // otherwise leave only a bare `[detached]` with no clue why. Must run BEFORE
  // killSession — capture-pane needs the session still alive (remain-on-exit
  // keeps the dead pane readable until we tear it down). Best-effort throughout.
  const surfacePaneFailure = async (pane: string | undefined, status: number | undefined, headline: string): Promise<void> => {
    if (!pane) return;
    let tail = '';
    try {
      const r = await runTmux({ socket, args: ['capture-pane', '-p', '-t', pane, '-S', '-200'], throwOnError: false });
      if (r.code === 0) tail = formatPaneTail(r.stdout);
    } catch { /* best-effort — a missing pane just means no recap */ }
    process.stderr.write(`\n${RED}agents: ${headline} (exit ${status ?? UNKNOWN_OUTCOME_EXIT_CODE}).${OFF}\n`);
    if (tail) {
      process.stderr.write(`${GRAY}  ── last output from ${options.agent} ──${OFF}\n`);
      process.stderr.write(tail.replace(/^/gm, '  ') + '\n');
      process.stderr.write(`${GRAY}  ${'─'.repeat(30)}${OFF}\n`);
    }
    process.stderr.write(NO_TMUX_TIP);
  };

  // F3 (RUSH-2185 / EXEC-23a): paneExitStatus returns {dead:false} for BOTH
  // "pane is alive" and "tmux query failed (race / pane already gone)". Require
  // POSITIVE proof before taking the keep-session path — a separate direct query
  // that only returns true when tmux explicitly confirms pane_dead=0.
  const checkPaneKnownAlive = async (p: string): Promise<boolean> => {
    try {
      const r = await runTmux({ socket, args: ['display-message', '-pt', p, '-p', '#{pane_dead}'], throwOnError: false });
      return isPaneKnownAliveFromQueryResult(r.code, r.stdout);
    } catch { return false; }
  };

  /**
   * Resolve what an attach client's return actually means, for EVERY path that
   * attaches (the fresh wrapper below AND the resume-attach above). Asking tmux
   * is the only way to tell "the user detached" from "the agent exited" from
   * "the session went away underneath us", so an attach that skips this cannot
   * do better than assume success — which is exactly the defect EXEC-23b fixes.
   */
  const resolveAfterAttach = async (pane: string | undefined): Promise<{ exitCode: number; stderr: string; stdout: string }> => {
    const after = pane ? await paneExitStatus(pane, socket) : { found: false, dead: false, status: undefined };
    if (after.dead) {
      // Nonzero exit after attach → the agent crashed rather than the user
      // detaching cleanly (a clean detach leaves the pane ALIVE, handled below).
      // F2: for interactive runs, also recap a clean exit-0 — the harness exited
      // without error but without starting a REPL, which is still a failure.
      if (shouldRecapDeadPane(after.status, resolveInteractive(options))) {
        await surfacePaneFailure(pane, after.status, `${options.agent} exited`);
      }
      await killSession(name, socket).catch(() => {});
      // A dead pane whose status tmux never reported is UNKNOWN, not success —
      // and surfacePaneFailure already printed `exit 1` for it, so the old
      // `?? 0` made the message and the returned code disagree (EXEC-23b).
      return { exitCode: tmuxRunExitCode(after, false), stderr: '', stdout: '' };
    }
    // after.dead===false, but that could be a stale/unreadable-pane result.
    // Require positive proof before keeping the session as "user detached".
    if (pane && await checkPaneKnownAlive(pane)) {
      // Confirmed alive: the user pressed Ctrl-b d; keep the session for `agents focus`.
      return { exitCode: tmuxRunExitCode(after, true), stderr: '', stdout: '' };
    }
    // F4 (EXEC-23b): the outcome is UNKNOWN — tmux could not tell us whether the
    // agent finished or was killed. MUST NOT be reported as success: a caller
    // scripting `agents run` would count a run killed mid-work as a clean
    // finish. Tear down so no orphan session is left, say so, and exit non-zero
    // — the same "1 if unknown" rule the `--host` follow path already uses.
    await killSession(name, socket).catch(() => {});
    // One computation feeds both the banner and the return value — printing a
    // code the caller does not receive is the same defect in miniature.
    const exitCode = tmuxRunExitCode(after, false);
    // Two distinct causes reach here, and the banner must not assert the wrong
    // one: a pane we HAD (the session went away under it) versus a run whose
    // pane id tmux never reported at creation, which had nothing to read from.
    const cause = pane
      ? 'The tmux session went away before its exit status could be read, so this run may have been killed mid-work.'
      : 'This run had no readable tmux pane, so its exit status could never be read.';
    process.stderr.write(
      `\n${RED}agents: ${options.agent} outcome unknown (exit ${exitCode}).${OFF}\n` +
      `${GRAY}  ${cause}${OFF}\n` + NO_TMUX_TIP,
    );
    return { exitCode, stderr: '', stdout: '' };
  };

  // A native resume must not create a competing wrapper for a live session.
  // A retained dead pane is reaped before the harness resumes normally.
  const resumePrep = options.resume ? await prepareSessionForResume(name, socket) : { decision: 'create' as const };
  if (resumePrep.decision === 'attach') {
    if (options.sessionId) writeSessionAliasRecord(options.sessionId, name);
    await attachTmux({ socket, args: ['attach-session', '-t', name] });
    // EXEC-23b: a resume-attach is an attach like any other — it must ask tmux
    // what happened rather than assume 0. Before this it returned a hardcoded
    // success, so a resumed run whose server died under it reported a clean
    // finish, the identical defect on the identical shape.
    return resolveAfterAttach(resumePrep.pane);
  }

  // SessionStart learns some harness IDs only after launch. Carry the wrapper
  // name into that hook so it can bind both identities durably.
  const execEnv = { ...buildExecEnv(options), AGENT_TMUX_SESSION_NAME: name };
  // The pane sources its env from a 0600 file it unlinks before exec, so no
  // resolved secret VALUE reaches the process table (RUSH-2100). SessionMeta.cmd
  // keeps the value-redacted inline form — the human-readable record of what ran,
  // which never carried real values anyway (RUSH-1758).
  const envFile = path.join(
    getRuntimeStateDir(), 'tmux-env', `${name}-${randomUUID().slice(0, 8)}.env`,
  );
  writeTmuxEnvFile(execEnv, envFile);
  const cmd = buildTmuxAgentCommand(executable, args, execEnv, { envFile });
  const metaCmd = buildTmuxAgentCommand(executable, args, execEnv, { redactEnvValues: true });

  const labels: Record<string, string> = { agent: options.agent };
  if (options.sessionId) labels.sessionId = options.sessionId;

  // Only a launched pane sources-and-unlinks the env file. If createSession
  // throws, the pane never runs, so the resolved secrets (incl. the master
  // passphrase) would linger on disk — remove it on that failure path
  // (RUSH-2100). On success the detached pane owns the unlink.
  let meta;
  try {
    meta = await createSession({ name, cmd, metaCmd, cwd, socket, source: 'cli', labels });
  } catch (err) {
    try { fs.rmSync(envFile, { force: true }); } catch { /* best-effort */ }
    throw err;
  }
  const pane = meta.pane;

  if (options.sessionId) writeSessionAliasRecord(options.sessionId, name);

  if (pane) {
    // When the AGENT pane dies, detach the client (don't kill) so the session
    // survives just long enough to read the dead pane's exit status below. The
    // `#{hook_pane}` guard scopes this to the agent pane only: if the user splits
    // the window and exits one of THEIR panes, the else-branch closes that split
    // in place instead of detaching everyone (`run-shell -C` executes the
    // targeted kill inside tmux's server command queue, avoiding a second
    // client racing the same socket under load, #965). Without the guard,
    // exiting any split kicked the user clean out of tmux.
    const hookInstalled = await setSessionHook(name, 'pane-died', agentPaneDiedHook(name, pane), socket);
    // Stamp the schema marker only after tmux accepted the hook. A failed
    // install stays unmarked so daemon reconciliation retries it later.
    if (hookInstalled) await markSessionHookSchema(name, socket);

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
      actor: resolveActor().id,
      initiatedBy: resolveActor().kind,
      // spawnAgent injected AGENT_LAUNCH_ID into options.env before delegating
      // here; record the same id so the hook (running under the pane-leaf agent
      // pid) reconciles by launchId. This pane's pid usually IS the agent pid,
      // but the launchId join is robust even when it isn't.
      launchId: options.env?.AGENT_LAUNCH_ID,
      terminalId: process.env.AGENT_TERMINAL_ID,
      tmuxPane: pane,
      startedAtMs: Date.now(),
    });
    if (options.sessionId) {
      writeSessionActorRecord({
        sessionId: options.sessionId,
        actor: resolveActor().id,
        initiatedBy: resolveActor().kind,
        startedAtMs: Date.now(),
      });
    }
  }

  // The agent could exit before we attach (fast failure). Don't attach to an
  // already-dead pane — surface its output + status directly and tear down.
  const before = pane ? await paneExitStatus(pane, socket) : { found: false, dead: false, status: undefined };
  if (before.dead) {
    // F2 (RUSH-2185 / EXEC-23a): for interactive runs, ALWAYS recap — a clean
    // exit-0 before attach means the harness has no interactive REPL and the
    // user would see only a bare `[detached]` with no clue why. For headless
    // runs the old quiet behaviour stands: exit-0 is a successful quick run.
    if (shouldRecapDeadPane(before.status, resolveInteractive(options))) {
      await surfacePaneFailure(pane, before.status, `${options.agent} exited before it could start`);
    }
    await killSession(name, socket).catch(() => {});
    // A dead pane whose status tmux never reported is an UNKNOWN outcome, not a
    // success — and the banner one line up already printed `exit 1` for it, so
    // the old `?? 0` also made the message and the returned code disagree.
    return { exitCode: tmuxRunExitCode(before, false), stderr: '', stdout: '' };
  }

  await attachTmux({ socket, args: ['attach-session', '-t', name] });
  return resolveAfterAttach(pane);
}

/**
 * Print the run's resolved session id as a one-line stdout sentinel so a `--host`
 * launcher can relate the remote-created session back to itself (see the
 * `emitSessionId` option and hosts/session-marker.ts).
 *
 * For Claude the id was forced up front (`options.sessionId`, wired as
 * `--session-id`), so it's authoritative with no lookup. Every other agent coined
 * its OWN id, which its SessionStart hook recorded under this run's launchId — the
 * exact join key `agents sessions --active` uses — so we read it back from the hook
 * index by launchId (falling back to the child pid the hook may have recorded
 * under). Nothing to emit when the hook hasn't landed an id (hookless harness):
 * the launcher simply keeps the un-mapped task, never a fabricated id.
 */
function emitResolvedSessionId(options: ExecOptions, launchId: string, childPid: number | undefined): void {
  let sessionId = options.sessionId;
  if (!sessionId) {
    try {
      sessionId = resolveHookSessionId(loadHookSessionIndex(), {
        pid: childPid ?? 0,
        kind: options.agent,
        launchId,
      });
    } catch {
      /* hook index unreadable — emit nothing rather than a guess */
    }
  }
  if (sessionId) process.stdout.write(sessionIdMarkerLine(sessionId));
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
  // Resolve the launch id once. It doubles as the budget watcher's run id AND is
  // exported to the child as AGENT_LAUNCH_ID, so the agent's SessionStart hook
  // records the SAME id in its own state file (terminals/sessions/<pid>.json).
  // That id is the join key that reconciles this launch's pid-registry entry
  // with the hook's authoritative session id even when the hook runs under a
  // different pid (tmux pane leaf / cmd.exe wrapper) — see pid-registry.ts and
  // session/hook-sessions.ts. ADOPT a launch id a `--host` launcher already
  // forwarded (via `--env AGENT_LAUNCH_ID=…`) so ONE correlation key spans the
  // SSH hop and the launcher can resolve this run's real session id for every
  // agent, not just Claude (RUSH-2034); mint a fresh one for every local run.
  // Injected into options.env so every downstream env build (the bare spawn
  // below AND the tmux env prefix in runInTmux) carries it.
  const launchId = resolveLaunchId(options.env?.AGENT_LAUNCH_ID);
  const runId = launchId;
  options = { ...options, env: { ...options.env, AGENT_LAUNCH_ID: launchId } };
  const watcherState = await setupBudgetWatcher(options, cwd, runId);

  const timer = createTimer('agent.run', {
    agent: options.agent,
    version: options.version,
    cwd: options.cwd || process.cwd(),
    // The mode that ran, not the one requested — `agents run` passes the
    // requested mode so the resolver can warn, but telemetry must agree with
    // the audit log. See RUSH-2106 for removing that ambiguity at the source.
    mode: resolveMode(options.agent, normalizeMode(options.mode)),
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
    configEnabled: isTmuxEnabled(),
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
    const tapStdout = shouldTapStdout(interactive, piped, watcherState !== null, options.captureStdoutTail);
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
      actor: resolveActor().id,
      initiatedBy: resolveActor().kind,
      launchId,
      terminalId: process.env.AGENT_TERMINAL_ID,
      tmuxPane: process.env.TMUX_PANE,
      startedAtMs: Date.now(),
    });
    if (options.sessionId) {
      writeSessionActorRecord({
        sessionId: options.sessionId,
        actor: resolveActor().id,
        initiatedBy: resolveActor().kind,
        startedAtMs: Date.now(),
      });
    }

    // Mark startup time (time from function call to process spawn)
    timer.mark('startup');

    let budgetKilled = false;
    let budgetKillTimer: ReturnType<typeof setTimeout> | undefined;
    let stdoutTail = '';
    const STDOUT_TAIL_CAP = 16 * 1024;
    if (!interactive && tapStdout && child.stdout) {
      // TEE the child's stdout back to the parent's so the user still sees
      // output (mirrors stdio:'inherit') while we tap the same stream for usage.
      child.stdout.pipe(process.stdout);
      // Keep a rolling TAIL (billing refusals arrive at the very end of a run)
      // for the fallback chain's rate-limit scan.
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutTail = (stdoutTail + chunk.toString('utf-8')).slice(-STDOUT_TAIL_CAP);
      });
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
      // Relate the session id back to a `--host` launcher (see the emitSessionId
      // doc). Claude's id is the one we forced; every other agent coined its own,
      // which the SessionStart hook recorded under this run's launchId — resolve
      // and print it as a one-line sentinel that rides the followed log home.
      if (options.emitSessionId) emitResolvedSessionId(options, launchId, child.pid);
      timer.end({ exitCode, status: budgetKilled ? 'budget_killed' : code === 0 ? 'success' : 'failed' });
      resolve({ exitCode, stderr: stderrBuffer, stdout: stdoutTail });
    });
  });
}

/** Exit code spawnAgent resolves with when a run is killed for crossing a budget cap. */
export const BUDGET_KILL_EXIT_CODE = 7;

/**
 * Exit code a tmux-wrapped run resolves with when tmux cannot tell us how the
 * agent finished — the pane is unreadable, or it is dead with no reported status
 * (EXEC-23b). Never 0: an unknown outcome reported as success is how a run killed
 * mid-work gets counted as a clean finish by whatever scripted it.
 */
export const UNKNOWN_OUTCOME_EXIT_CODE = 1;

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
  // Claude billing refusals — "You've hit your org's monthly spend limit" and
  // "You're out of usage credits". Both end the run with exit 1 and are exactly
  // the condition a fallback chain exists to recover from. Printed to STDOUT,
  // hence the stdout tail in SpawnResult.
  /spend[\s-]?limit/i,
  /out of (?:usage )?credits/i,
];

/** Return true if the text contains any known rate-limit or overload indicator. */
export function detectRateLimit(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * Patterns that indicate an authentication failure — the agent is logged out,
 * its token was revoked, or the session expired. These are the user-visible
 * strings a logged-out agent surfaces (observed across the routine-run corpus).
 * Unlike a rate limit, an auth failure is NOT self-healing by failover — every
 * chain entry on the same account fails identically — so it is classified
 * separately and never triggers a fallback attempt.
 *
 * The bare `401` is deliberately paired with an auth keyword: a plain "401" can
 * appear in legitimate output (an HTTP-status table, a log line), so it only
 * counts when it co-occurs with OAuth/authentication/credentials/Unauthorized.
 */
export const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /OAuth (?:access token has been revoked|session expired)/i,
  /(?:Please run|run) \/login/i,
  /Please run 'agent login' first/i,
  /\bNot logged in\b/i,
  /Invalid authentication credentials/i,
  /Failed to authenticate/i,
  /organization has (?:disabled|revoked) .*(?:subscription|access)/i,
  /401\b[^\n]*(?:OAuth|authenticat|credential|Unauthorized)/i,
];

/**
 * Return true if the text contains any known authentication-failure indicator.
 * Agent-agnostic: matches the user-visible error string wherever it surfaces
 * (stdout tail, a captured error message, a plain-text agent's output).
 */
export function detectAuthFailure(text: string): boolean {
  return AUTH_FAILURE_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * Return true if a stream-json log carries the structural markers of an auth
 * failure. This is the authoritative signal for Claude: a logged-out run emits
 *   {"type":"system","subtype":"api_retry","error":"authentication_failed",…}
 *   {"type":"assistant",…,"error":"authentication_failed"}
 *   {"type":"result","is_error":true,"result":"Failed to authenticate…"}
 * Note `terminal_reason` is "completed" on such a run, so exit-code / terminal-
 * reason logic can never catch it — the `error:"authentication_failed"` marker
 * and the `result`+`is_error` text are the reliable signals.
 *
 * Gated on the Claude-compatible stream-json shape emitted by Claude and Cursor;
 * callers pass their agent so unrelated stream formats cannot match by accident.
 */
export function detectAuthFailureEvent(logText: string, agent: AgentId): boolean {
  if (agent !== 'claude' && agent !== 'cursor') return false;
  const lines = logText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed?.error === 'authentication_failed') return true;
    if (
      parsed?.type === 'result' &&
      parsed?.is_error === true &&
      typeof parsed?.result === 'string' &&
      detectAuthFailure(parsed.result)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Return the first human-readable auth-failure phrase found in the text, for use
 * as a stable, short run `errorMessage` reason. Falls back to null when the only
 * signal was the structural `error:"authentication_failed"` marker with no
 * user-visible string.
 */
export function authFailureReason(text: string): string | null {
  for (const pattern of AUTH_FAILURE_PATTERNS) {
    const m = text.match(pattern);
    if (m) return m[0];
  }
  return null;
}

/**
 * Decide whether a run's stream-json log is an authentication failure. The
 * single source of truth for both the foreground and detached run paths.
 *
 * The structural marker (`detectAuthFailureEvent`, gated on `is_error:true`) is
 * authoritative and safe on ANY exit — it catches a logged-out Claude that exits
 * 0 (its `result` event carries `is_error:true` while `terminal_reason` is
 * "completed"). The raw user-visible string (`detectAuthFailure`) is only
 * consulted when the process actually FAILED, as a fallback for a run that died
 * mid-stream before emitting a `result` event. That gate is what prevents a
 * genuinely-completed run whose output merely *mentions* an auth phrase (e.g. a
 * routine documenting a login flow) from being misclassified and having its
 * legitimate report suppressed.
 */
export function isAuthFailureFromLog(
  logText: string,
  agent: AgentId,
  opts: { processFailed: boolean },
): boolean {
  if (detectAuthFailureEvent(logText, agent)) return true;
  if (opts.processFailed && detectAuthFailure(logText)) return true;
  return false;
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
    // Every fallback entry can target a different harness/version home. Sync
    // its active preset immediately before dispatch so entries 2..N cannot
    // inherit the stale rules file left by the primary entry.
    const rulesVersion = version ?? resolveVersion(agent);
    if (rulesVersion) {
      applyActiveRulesPresetAtRun(agent, rulesVersion, getVersionHomePath(agent, rulesVersion));
    }
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
      mode: options.modeWasImplicit ? implicitModeFor(agent) : options.mode,
      prompt,
      env: envOverride ? { ...(options.env ?? {}), ...envOverride } : options.env,
      sessionId: pinnedSessionId ?? (i === 0 ? options.sessionId : undefined),
      // Claude prints billing refusals (spend limit / out of credits) to
      // stdout; tail it so the cascade check below can see them.
      captureStdoutTail: true,
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

    if (!detectRateLimit(result.stderr) && !detectRateLimit(result.stdout)) {
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
