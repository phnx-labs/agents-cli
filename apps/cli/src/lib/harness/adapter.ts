/**
 * Harness adapter registry — the behavior axis of a supported harness.
 *
 * The declarative FLAG table lives in `AGENTS` (lib/agents.ts): what a harness
 * *is* (cliCommand, configDir, capabilities). A HarnessAdapter carries what a
 * harness *does* at the execution boundary — the per-harness quirks that four
 * call sites otherwise each re-express as a `if (agent === 'x') … else if …`
 * name-chain:
 *
 *   - config-dir env pins        → exec.ts buildExecEnv + shims.ts shim script
 *   - launch-arg quirks          → exec.ts buildExecCommand + runner.ts buildJobCommand
 *
 * One adapter per harness is the single source of truth for that harness's
 * behavior across every consuming site, mirroring the ChannelProvider
 * (lib/channels/registry.ts), HostProvider (lib/hosts/types.ts), and
 * AccountProviderAdapter (lib/account-provider-registry.ts) registries this repo
 * already proves.
 *
 * NOT here: transcript parsing and live team-event normalization. Those are
 * registry-dispatched too — a `Record` table in `session/parse.ts`
 * (`TRANSCRIPT_PARSERS`) and one in `teams/parsers.ts` (`TEAM_EVENT_NORMALIZERS`)
 * — but kept beside the parser functions they dispatch (which live in those
 * files) rather than on this `AgentId` registry, because their id domains differ:
 * the offline transcript reader keys on `SessionAgentId` (which includes `rush`,
 * not an `AgentId`), and the live team-event normalizer keys on the teams
 * `AgentType`. They stay separate functions — offline transcript vs live team
 * events — deliberately.
 */
import type { AgentId, Mode } from '../types.js';
import type { JobConfig } from '../scheduling/routines.js';

/**
 * Context for the exec-time config-env pin (mapping A, exec.ts side). The caller
 * resolves the interactive/version facts once; the adapter only expresses the
 * harness-specific env manipulation, operating on the accumulating `result` env
 * exactly as the old per-agent branch did.
 */
export interface ExecConfigEnvCtx {
  agent: AgentId;
  /** The version to pin, pre-resolved by the caller (null = unresolved/not installed). */
  version: string | null;
  /** That version's home, pre-resolved by the caller (null when version is null). */
  versionHome: string | null;
  /** resolveInteractive(options) — computed once by the caller. */
  interactive: boolean;
  /**
   * claude-account-token's resolveClaudeSetupToken, injected. The adapters MUST
   * stay import-leaf: claude-account-token pulls in the secrets stack, which
   * transitively imports sqlite.ts (top-level await). Importing it inside an
   * adapter drags that into shims.ts's module graph (shims imports the harness
   * barrel), and subprocess-spawning tests that load shims via tsx then fail the
   * cjs transform. Only claude uses it.
   */
  resolveClaudeSetupToken: (versionHome: string) => string | null;
}

/** Context for the shim-script config-env block (mapping A, shims.ts side). */
export interface ShimConfigEnvCtx {
  /**
   * The config-dir path relative to `$HOME` (e.g. `.claude`, or the nested
   * `.gemini/antigravity-cli`), derived by the caller from the AGENTS registry.
   */
  configDirName: string;
}

/**
 * Context for the exec-time launch-arg quirks (mapping B, exec.ts side). Mirrors
 * the locals buildExecCommand already computed at the emission point.
 */
export interface ExecLaunchArgsCtx {
  resolvedMode: Mode;
  interactive: boolean;
  cwd: string;
  /** Extra writable roots (`--add-dir`) requested for this run, home-expanded. */
  addDirs: string[];
}

/**
 * Context for the routine (daemon-job) launch-arg quirks (mapping B, runner.ts
 * side). This idiom mutates a pre-baked token array from ROUTINE_AGENT_COMMANDS,
 * distinct from buildExecCommand's declarative modeFlags — so it is a separate
 * method on the same adapter, one source of truth per harness across both.
 */
export interface RoutineLaunchCtx {
  /** normalizeMode(config.mode) — the canonicalized mode. */
  mode: Mode;
  config: JobConfig;
  /**
   * exec.ts resolveHeadlessMode, injected to avoid an import cycle (exec.ts
   * imports this registry). Kimi calls it for its plan→auto downgrade warning.
   */
  resolveHeadlessMode: (agent: AgentId, mode: Mode, interactive: boolean) => void;
}

export interface HarnessAdapter {
  id: AgentId;

  // --- Mapping A: config-dir env, two call sites, one source of truth --------

  /**
   * Apply this harness's config-dir env pins to the live process env for an
   * `agents run` invocation (exec.ts buildExecEnv). Mutates `result` in place,
   * exactly as the old per-agent branch did. The caller has already stripped the
   * shared config-dir keys (CONFIG_DIR_ENV_KEYS), so an adapter only sets its own
   * vars (plus any harness-specific extra it must delete, e.g. Claude's inherited
   * OAuth token). Omitted for a harness with no config-dir env (the old `else`).
   */
  applyExecConfigEnv?(result: NodeJS.ProcessEnv, ctx: ExecConfigEnvCtx): void;

  /**
   * The config-env bash block for this harness's generated shim (shims.ts). The
   * returned string is spliced verbatim into the shim script. Omitted (⇒ '') for
   * a harness with no managed config-dir env.
   */
  shimConfigEnvBash?(ctx: ShimConfigEnvCtx): string;

  // --- Mapping B: launch-arg quirks, exec + shim + routine sites -------------

  /**
   * Launch args appended to this harness's shim `exec` line (shims.ts). Codex
   * pins `check_for_update_on_startup=false` + its edit-profile policy args here.
   * Returns '' for a harness with no shim launch args.
   */
  shimLaunchArgs?(): string;

  /**
   * The shim's `exec` tail for this harness (shims.ts). Codex resolves the repo's
   * `.agents` dir from `$PWD` at run time and appends `--add-dir`. Omitted ⇒ the
   * default `exec "$BINARY"<launchArgs> "$@"`.
   */
  shimExecTail?(launchArgs: string): string;

  /**
   * Additive launch args emitted BEFORE mode-flag resolution in buildExecCommand
   * (exec.ts). Cursor's `--trust` for a configured headless edit lives here.
   * Returns undefined when this harness adds nothing.
   */
  execPreModeArgs?(ctx: ExecLaunchArgsCtx): string[] | undefined;

  /**
   * This harness's mode-flag emission for buildExecCommand (exec.ts), overriding
   * the generic `template.modeFlags` / resume-subcommand path. Codex returns its
   * policy args; Kimi returns [] for a headless run (and throws on an invariant
   * violation). Returns undefined to defer to the generic path.
   */
  execModeArgs?(ctx: ExecLaunchArgsCtx): string[] | undefined;

  /**
   * This harness's routine (daemon-job) launch-arg quirks for buildJobCommand
   * (runner.ts). Mutates the ROUTINE_AGENT_COMMANDS token array in place, exactly
   * as the old per-agent arm did; runner appends model/reasoning flags after.
   * Omitted for a harness with no routine launch quirks.
   */
  routineModeArgs?(cmd: string[], ctx: RoutineLaunchCtx): void;
}

/**
 * The four config-dir env keys a harness pins to its version home. Every
 * per-harness branch in the old buildExecEnv deleted the ones it does NOT set,
 * so its own config pointer never leaks into a foreign harness's invocation.
 * (XDG_CONFIG_HOME / XDG_DATA_HOME — Muse/Cursor — are deliberately absent: the
 * old code sets them but never strips them, and this preserves that exactly.)
 */
export const CONFIG_DIR_ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'COPILOT_HOME',
  'KIMI_CODE_HOME',
] as const;

/**
 * Strip every config-dir env key except the one(s) this harness sets. `keep=[]`
 * (the default / no-config-dir harness) deletes all four — the old `else` arm.
 */
export function stripForeignConfigDir(result: NodeJS.ProcessEnv, keep: readonly string[] = []): void {
  for (const key of CONFIG_DIR_ENV_KEYS) {
    if (!keep.includes(key)) delete result[key];
  }
}

const REGISTRY = new Map<AgentId, HarnessAdapter>();

/**
 * The no-behavior adapter — a harness with no managed config-dir env and no
 * launch-arg quirks. buildExecEnv strips all four config-dir keys for it (the old
 * `else` arm) by falling back to {@link stripForeignConfigDir} when an adapter
 * omits `applyExecConfigEnv`.
 */
function defaultAdapter(id: AgentId): HarnessAdapter {
  return { id };
}

export function registerHarnessAdapter(adapter: HarnessAdapter): void {
  REGISTRY.set(adapter.id, adapter);
}

/**
 * The behavior adapter for a harness. Every `AgentId` resolves to an adapter —
 * one with real behavior when registered, else the id-only default (the old
 * `else` arm). Callers therefore never name-check a harness.
 */
export function resolveHarnessAdapter(id: AgentId): HarnessAdapter {
  return REGISTRY.get(id) ?? defaultAdapter(id);
}

export function listHarnessAdapters(): AgentId[] {
  return [...REGISTRY.keys()].sort();
}
