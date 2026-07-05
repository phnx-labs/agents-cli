/**
 * Agent execution command.
 *
 * Registers the `agents run` command which spawns agent CLIs interactively
 * or headlessly. Supports profile resolution, version rotation, secrets
 * injection, and multi-agent fallback chains for rate-limit resilience.
 */

import { Option, type Command } from 'commander';
import chalk from 'chalk';
import type { ExecOptions, ExecMode, ExecEffort, FallbackEntry } from '../lib/exec.js';
import type { AgentId } from '../lib/types.js';
import type { ResolvedRunDefaults } from '../lib/run-defaults.js';
import { setHelpSections } from '../lib/help.js';
import { parseLoopInterval } from '../lib/loop.js';
import type { RotateResult } from '../lib/rotate.js';
import { AGENTS } from '../lib/agents.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface ExecCommandActionOptions {
  mode: ExecMode;
  effort: ExecEffort;
  model?: string;
  cwd?: string;
  addDir: string[];
  env: string[];
  secrets: string[];
  noAutoSecrets?: boolean;
  json?: boolean;
  quiet?: boolean;
  headless?: boolean;
  interactive?: boolean;
  /** --resume [id]: string id/prefix, or `true` for the bare flag (interactive picker). */
  resume?: string | boolean;
  sessionId?: string;
  verbose?: boolean;
  timeout?: string;
  fallback?: string;
  balanced?: boolean;
  strategy?: string;
  acp?: boolean;
  yes?: boolean;
  loop?: boolean;
  resumeCheckpoint?: string;
  maxIterations?: string;
  budget?: string;
  until?: string;
  interval?: string;
  // Host dispatch: run on a registered agent host instead of locally.
  // `--host` is canonical; `--on`/`--computer` are hidden aliases.
  host?: string;
  device?: string;
  on?: string;
  computer?: string;
  remoteCwd?: string;
  follow?: boolean; // --no-follow sets this false
  any?: boolean;
  lease?: string | boolean; // --lease [backend]: true when bare, backend string when given
  keepBox?: boolean; // --keep-box: don't tear down the leased box after the run
}

/** Type guard that narrows a string to a known AgentId. */
function isValidAgent(agent: string): agent is AgentId {
  return agent in AGENTS;
}

/** Build a one-line banner describing which version the strategy picked. */
function formatRotationBanner(result: RotateResult, verb: string = 'balanced'): string {
  const { picked, healthy, excluded } = result;
  const label = picked.email ? `${picked.email} · ${picked.agent}@${picked.version}` : `${picked.agent}@${picked.version}`;
  const ratio = `${healthy.length} of ${healthy.length + excluded.length} healthy`;
  return `[agents] ${verb} picked ${label} (${ratio})`;
}

/**
 * Build the LoopConfig the driver consumes from CLI flags and/or a workflow's
 * `loop:` frontmatter block (issue #332). Returns undefined when neither source
 * activates a loop (the common single-shot run). CLI flags take precedence over
 * the workflow's declared values field-by-field, so `--max-iterations 5`
 * overrides a workflow's `max_iterations: 3`.
 *
 * `--loop` with no sub-options is a valid bare loop (driver applies its own
 * maxIterations safety cap). A workflow `loop:` block activates a loop even
 * without `--loop` so `agents run <workflow>` honors a declared loop.
 */
export function buildLoopConfig(
  flags: { loop?: boolean; maxIterations?: string; budget?: string; until?: string; interval?: string },
  workflowLoop?: import('../lib/workflows.js').LoopConfigRaw,
): import('../lib/loop.js').LoopConfig | undefined {
  const active = flags.loop === true || workflowLoop !== undefined;
  if (!active) return undefined;

  const cfg: import('../lib/loop.js').LoopConfig = {};

  // until: CLI > workflow. Only `signal` is supported.
  const until = flags.until ?? workflowLoop?.until;
  if (until !== undefined) {
    if (until !== 'signal') {
      throw new Error(`Invalid --until '${until}'. Only 'signal' is supported.`);
    }
    cfg.until = 'signal';
  }

  // max_iterations: CLI > workflow.
  if (flags.maxIterations !== undefined) {
    const n = Number(flags.maxIterations);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`Invalid --max-iterations '${flags.maxIterations}'. Use a positive integer.`);
    }
    cfg.maxIterations = n;
  } else if (workflowLoop?.max_iterations !== undefined) {
    cfg.maxIterations = workflowLoop.max_iterations;
  }

  // budget (tokens): CLI > workflow.
  if (flags.budget !== undefined) {
    const b = Number(flags.budget);
    if (!Number.isFinite(b) || b <= 0) {
      throw new Error(`Invalid --budget '${flags.budget}'. Use a positive token count.`);
    }
    cfg.budget = b;
  } else if (workflowLoop?.budget !== undefined) {
    cfg.budget = workflowLoop.budget;
  }

  // interval: CLI > workflow. Validate eagerly — an unparseable interval
  // (e.g. "30s", "5", "abc") must be rejected here, not silently coalesced to
  // 0ms (back-to-back) at run time. "0" is the one accepted non-duration value.
  const interval = flags.interval ?? workflowLoop?.interval;
  if (interval !== undefined) {
    try {
      parseLoopInterval(interval);
    } catch {
      throw new Error(
        `Invalid --interval '${interval}'. Use "0" for back-to-back or a duration like "30m", "1h", "2h30m" (units: w/d/h/m).`,
      );
    }
    cfg.interval = interval;
  }

  return cfg;
}

/** Map a loop stop reason to a process exit code. condition-met/max are clean exits. */
export function loopExitCode(stoppedBy: import('../lib/loop.js').LoopStoppedBy): number {
  switch (stoppedBy) {
    case 'condition-met':
    case 'max':
      return 0;
    case 'budget':
      return 7; // mirrors BUDGET_KILL_EXIT_CODE so CI can tell a budget stop apart
    case 'signal':
      return 130; // 128 + SIGINT(2)
    case 'stalled':
    case 'error':
    default:
      return 1;
  }
}

/** Register the `agents run <agent> [prompt]` command. */
export function registerRunCommand(program: Command): void {
  const runCmd = program
    .command('run <agent> [prompt]')
    .description('Execute an agent. Pass a prompt for headless runs; omit it to launch the agent interactively.')
    .option('-m, --mode <mode>', 'How much the agent can do: plan (read-only), edit (can write files), auto (smart classifier auto-approves safe ops, prompts for risky), skip (bypass all permission prompts). \'full\' accepted as alias for skip.', 'plan')
    .option('-e, --effort <effort>', 'Reasoning effort: low | medium | high | xhigh | max | auto (claude and codex only)', 'auto')
    .option('--model <model>', 'Override the model directly (e.g., claude-opus-4-6)')
    .option(
      '--env <key=value>',
      'Pass environment variable to the agent (repeatable, e.g., --env DEBUG=1 --env API_KEY=xyz)',
      (val: string, prev: string[]) => [...prev, val],
      []
    )
    .option(
      '--secrets <bundle>',
      'Inject a secrets bundle (repeatable). Values resolve from macOS Keychain at run time. See `agents secrets`.',
      (val: string, prev: string[]) => [...prev, val],
      []
    )
    .option(
      '--no-auto-secrets',
      'Skip auto-injection of secrets declared by a workflow\'s frontmatter `secrets:` field. Has no effect on bare-agent runs.',
    )
    .option('--cwd <dir>', 'Working directory for the agent (defaults to current directory)')
    .option(
      '--add-dir <dir>',
      'Grant access to an additional directory outside the project (Claude only, repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      []
    )
    .option('--json', 'Stream events as JSON lines (for parsing by other tools)')
    .option('--quiet', 'Suppress preamble (rotation banner, "Running:" line). Useful when piping JSON events to a parser.', false)
    .option('--headless', 'Force headless mode. Auto-enabled when a prompt is provided; pass explicitly to stay headless with no prompt (reads the prompt from stdin).', false)
    .option('-i, --interactive', 'Force interactive mode even when a prompt is provided. Mutually exclusive with --headless.')
    .option('--resume [id]', 'Resume a previous conversation. Accepts a full or partial session id (prefix-matched against the index); omit the id to pick from recent sessions interactively. Resumes under the version that started the session. claude/codex resume natively; other agents replay via a /continue first message. Pair with a prompt to continue headlessly.')
    .option('--session-id <id>', 'Force a NEW conversation to use this exact session UUID (Claude only). This CREATES a session — to resume an existing one, use --resume.')
    .option('--verbose', 'Show detailed execution logs')
    .option('--timeout <duration>', 'Kill the agent after this duration (e.g., 30m, 1h, 2h30m)')
    .option(
      '--fallback <agents>',
      'Comma-separated agents to try on rate-limit failure. Each entry accepts an optional @version pin (e.g., codex@0.116.0,gemini). The primary runs first; if it exits with a rate-limit error, the next agent picks up via /continue handoff.',
    )
    .option(
      '-b, --balanced',
      'Shortcut for --strategy balanced. Ignored when @version is pinned.',
    )
    .option(
      '--strategy <strategy>',
      'Version/account selection strategy: pinned | available | balanced. Defaults to run.<agent>.strategy, then pinned. (Legacy `rotate` accepted as alias for `balanced`.)',
    )
    .option(
      '--acp',
      'Route through the Agent Client Protocol instead of direct exec. Supported for gemini, claude (via @zed-industries/claude-code-acp adapter). Unified event stream; emits ndjson when --json.',
    )
    .option(
      '-y, --yes',
      'Skip the interactive budget-confirm prompt (require_confirm_over). Never skips a hard budget block.',
      false,
    )
    .option(
      '--loop',
      'Re-inject the prompt/entrypoint each iteration until a stop condition (issue #332). Guards (--max-iterations, --budget, --until) are enforced outside the agent. Writes a checkpoint after every iteration for --resume-checkpoint.',
    )
    .option(
      '--resume-checkpoint <file>',
      'Resume a killed loop run from its checkpoint.json. Continues from the last completed iteration, reusing the same runId, session id, prompt, and loop config.',
    )
    .option(
      '--max-iterations <n>',
      'Loop hard cap: stop after N iterations (stoppedBy: max). Loop only.',
    )
    .option(
      '--budget <tokens>',
      'Loop token hard-cap: stop once cumulative tokens reach this (stoppedBy: budget), enforced outside the agent. Loop only.',
    )
    .option(
      '--until <signal>',
      'Loop stop condition. `signal` reads <runDir>/loop-signal.json {continue,reason} each iteration; absent or continue:false stops (fail-closed). Loop only.',
    )
    .option(
      '--interval <dur>',
      'Loop delay between iterations ("0" back-to-back, "30m" paces). Loop only.',
    )
    .option(
      '--host <name>',
      'Offload this run onto another machine over SSH instead of running locally — a device, a registered agent host, or user@host. See `agents devices` / `agents hosts`.',
    )
    .option(
      '--device <name>',
      'Alias of --host: offload this run onto a registered device (from `agents devices`).',
    )
    .option('--remote-cwd <dir>', 'Working directory on the host for --host runs.')
    .option('--no-follow', 'With --host, dispatch detached and return immediately (track via `agents hosts ps/logs`).')
    .option('--any', 'With --host <cap> (a capability tag), pick any matching host instead of erroring when several match.')
    .option(
      '--lease [backend]',
      'Invent a disposable cloud box for this run and tear it down after (via crabbox). Optional backend selects the cloud (hetzner/aws/do). Unlike --host, no machine is registered.',
    )
    .option('--keep-box', 'With --lease, keep the box after the run instead of stopping it.');

  // `--on` and `--computer` are hidden aliases of `--host` — same behavior.
  runCmd.addOption(new Option('--on <name>', 'Alias of --host.').hideHelp());
  runCmd.addOption(new Option('--computer <name>', 'Alias of --host.').hideHelp());

  setHelpSections(runCmd, {
    examples: `
      # Headless, read-only: investigate or summarize without writing files
      agents run claude "summarize recent git commits" --mode plan

      # Headless, can edit: have the agent make changes
      agents run claude "fix lint errors in src/" --mode edit

      # Interactive (TUI) with the pinned default version
      agents run claude

      # Pipe JSON events to a parser (--quiet drops the preamble)
      agents run claude "..." --json --quiet | jq

      # Bounded run — kill the agent after 30 minutes
      agents run claude "generate sales report for yesterday" --mode plan --timeout 30m

      # Inject a keychain-backed secrets bundle
      agents run claude "deploy the worker" --secrets prod --mode edit

      # Pass arbitrary native flags to the underlying CLI via -- separator
      agents run kimi -- --plan --some-kimi-option value
      agents run claude "fix the bug" -- --custom-flag
    `,
    notes: `
      Modes (not every agent supports every mode — check agents.yaml capabilities):
        plan  read-only investigation; no writes, no shell side-effects
        edit  may edit files; prompts for shell / risky operations
        auto  smart classifier auto-approves safe ops, prompts for risky (claude, copilot)
        skip  bypass every permission prompt (dangerously-skip-permissions)
        Legacy 'full' is silently rewritten to 'skip'.

      Run strategy (set via --strategy or run.<agent>.strategy in agents.yaml):
        pinned     use the workspace/global pinned version (default)
        available  use pinned if usage available; otherwise switch to another signed-in version
        balanced   distribute load across healthy accounts by remaining capacity
        --balanced is shorthand for --strategy balanced. Ignored when @version is pinned, when a profile is used, or with --fallback.

      Fallback: --fallback codex,gemini retries on rate-limit failure via /continue handoff. Each entry accepts @version.

      Resume: --resume <id> continues a prior conversation (full or partial id; omit to pick interactively). claude/codex resume natively; others replay via a /continue first message. Add a prompt to continue headlessly.

      Passthrough: everything after -- is forwarded verbatim to the underlying agent CLI.
        agents run kimi -- --plan --some-native-flag value
    `,
  });

  runCmd.action(async (agentSpec: string, prompt: string | undefined, options: ExecCommandActionOptions, command: Command) => {
      // Capture everything after -- as passthrough args forwarded verbatim to the underlying CLI.
      // Use command.args (all positional strings) and strip the declared positional args from the front.
      const declaredArgCount = prompt !== undefined ? 2 : 1;
      const passthroughArgs = command.args.slice(declaredArgCount);

      // --lease: invent a disposable cloud box for this run (via crabbox), run
      // the agent there, then tear it down. Unlike --host, nothing is registered.
      if (options.lease) {
        if (prompt === undefined) {
          console.error(chalk.red('A prompt is required for leased runs: agents run <agent> "<task>" --lease'));
          process.exit(1);
        }
        const backend = typeof options.lease === 'string' ? options.lease : undefined;
        const { detectSignedInRuntimes, pickRuntimes } = await import('../lib/crabbox/runtimes.js');
        const { leaseAndRun } = await import('../lib/crabbox/lease.js');
        const { confirm } = await import('@inquirer/prompts');

        const detected = await detectSignedInRuntimes();
        const runtimes = await pickRuntimes(detected);
        if (runtimes.length === 0) {
          console.error(chalk.yellow('No runtimes selected. Sign into one locally (e.g. run `claude` once) then retry.'));
          process.exit(1);
        }

        // Security gate: copying auth tokens to an ephemeral cloud box is opt-in
        // per run. Name the runtimes + accounts so the user sees what ships.
        const names = runtimes
          .map((id) => {
            const d = detected.find((x) => x.id === id);
            return `${d?.label ?? id}${d?.email ? ` (${d.email})` : ''}`;
          })
          .join(', ');
        const ok = await confirm({
          message: `Copy credentials for ${names} to a disposable cloud box, run there, then destroy it?`,
          default: false,
        });
        if (!ok) {
          console.error(chalk.yellow('Aborted — no credentials pushed, no box leased.'));
          process.exit(1);
        }

        try {
          const { exitCode, box, toreDown } = await leaseAndRun({
            agent: agentSpec.split('@')[0],
            prompt,
            mode: options.mode,
            model: options.model,
            backend,
            runtimes,
            detected,
            secretsBundle: process.env.AGENTS_LEASE_SECRETS_BUNDLE,
            keep: options.keepBox,
          });
          console.error(chalk.gray(toreDown ? `Box ${box.slug} destroyed.` : `Box ${box.slug} kept${box.ip ? ` (${box.ip})` : ''}. Stop it: crabbox stop --id ${box.slug}`));
          process.exit(exitCode === null ? 1 : exitCode);
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
      }

      // --host/--on/--computer: offload this run onto a registered agent host
      // over SSH instead of running locally. The three flags are aliases.
      const hostGiven = [options.host, options.device, options.on, options.computer].filter((v): v is string => !!v);
      if (hostGiven.length > 0) {
        if (new Set(hostGiven).size > 1) {
          console.error(chalk.red('Conflicting --host/--device values — pass just one.'));
          process.exit(1);
        }
        const hostName = hostGiven[0];
        if (prompt === undefined) {
          console.error(chalk.red('A prompt is required for host runs: agents run <agent> "<task>" --host <name>'));
          process.exit(1);
        }
        const { resolveHost, resolveHostByCap, DeviceOffloadUnsupportedError } = await import('../lib/hosts/registry.js');
        const { dispatchToHost } = await import('../lib/hosts/dispatch.js');
        let host = await resolveHost(hostName).catch((e) => {
          // A password-auth device can't offload over BatchMode ssh — surface the
          // actionable message instead of a stack trace, and don't fall through to
          // capability routing (the name did resolve, it just can't be used).
          if (e instanceof DeviceOffloadUnsupportedError) {
            console.error(chalk.red(e.message));
            process.exit(1);
          }
          throw e;
        });
        if (!host) {
          // Not a host name — try capability routing (e.g. --host gpu). A
          // "Multiple hosts tagged…" error is actionable and must surface;
          // only "no host tagged" falls through to the generic unknown-host msg.
          try {
            host = await resolveHostByCap(hostName, options.any);
          } catch (e) {
            const msg = (e as Error).message ?? '';
            if (msg.startsWith('Multiple hosts')) {
              console.error(chalk.red(msg));
              process.exit(1);
            }
          }
        }
        if (!host) {
          console.error(chalk.red(`Unknown host "${hostName}". List hosts: agents hosts list`));
          process.exit(1);
        }
        try {
          const { exitCode } = await dispatchToHost(host, {
            agent: agentSpec.split('@')[0],
            prompt,
            mode: options.mode,
            model: options.model,
            remoteCwd: options.remoteCwd,
            follow: options.follow !== false,
          });
          if (options.follow === false) {
            console.log(chalk.green(`Dispatched to ${host.name}.`) + chalk.gray(' Track: agents hosts ps · Follow: agents hosts logs <id> -f'));
            process.exit(0);
          }
          // -1 = the follow window closed but the run continues on the host (the
          // reattach hint is already printed). That's a detach, not a failure —
          // exit 0. Any real remote code passes through.
          if (exitCode === -1) process.exit(0);
          process.exit(exitCode ?? 1);
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
      }

      // --resume-checkpoint short-circuits normal dispatch entirely: the
      // checkpoint already carries the agent, version, prompt, session id,
      // iteration, and loop config of the killed run. Reconstruct ExecOptions
      // straight from it and continue the loop from the last completed
      // iteration, reusing the SAME runId/runDir (issue #332).
      if (options.resumeCheckpoint) {
        const { readCheckpoint } = await import('../lib/checkpoint.js');
        const { runLoop } = await import('../lib/loop.js');
        const { getRunsDir } = await import('../lib/state.js');
        const cp = readCheckpoint(options.resumeCheckpoint);
        if (!cp) {
          console.error(chalk.red(`Checkpoint not found or unreadable: ${options.resumeCheckpoint}`));
          process.exit(1);
        }
        const runDir = path.join(getRunsDir(), cp.id);
        fs.mkdirSync(runDir, { recursive: true });
        const resumeExec: ExecOptions = {
          agent: cp.agent,
          version: cp.version,
          prompt: cp.prompt,
          mode: options.mode,
          effort: options.effort,
          cwd: options.cwd,
          sessionId: cp.sessionId,
          json: true,
          headless: true,
        };
        // Resume honors the checkpoint's loop config, but lets the resume
        // command RAISE the bounds field-by-field — `--max-iterations 4` on a
        // checkpoint capped at 2 is the natural "continue, run more" gesture.
        // Flags override; unspecified fields fall through from the checkpoint.
        const resumeLoop = { ...cp.loop };
        if (options.maxIterations !== undefined) {
          const n = Number(options.maxIterations);
          if (!Number.isInteger(n) || n <= 0) {
            console.error(chalk.red(`Invalid --max-iterations '${options.maxIterations}'. Use a positive integer.`));
            process.exit(1);
          }
          resumeLoop.maxIterations = n;
        }
        if (options.budget !== undefined) {
          const b = Number(options.budget);
          if (!Number.isFinite(b) || b <= 0) {
            console.error(chalk.red(`Invalid --budget '${options.budget}'. Use a positive token count.`));
            process.exit(1);
          }
          resumeLoop.budget = b;
        }
        if (options.interval !== undefined) {
          try {
            parseLoopInterval(options.interval);
          } catch {
            console.error(chalk.red(`Invalid --interval '${options.interval}'. Use "0" for back-to-back or a duration like "30m", "1h", "2h30m" (units: w/d/h/m).`));
            process.exit(1);
          }
          resumeLoop.interval = options.interval;
        }
        if (options.until !== undefined) {
          if (options.until !== 'signal') {
            console.error(chalk.red(`Invalid --until '${options.until}'. Only 'signal' is supported.`));
            process.exit(1);
          }
          resumeLoop.until = 'signal';
        }
        process.stderr.write(chalk.gray(`[loop] resuming ${cp.agent} run ${cp.id} from iteration ${cp.iteration + 1} (session ${(cp.sessionId ?? '').slice(0, 8)})\n`));
        const result = await runLoop(resumeExec, resumeLoop, {
          runId: cp.id,
          runDir,
          agent: cp.agent,
          version: cp.version,
          startIteration: cp.iteration + 1,
          startTokens: cp.cumulativeTokens ?? 0,
          sessionId: cp.sessionId,
        });
        process.stderr.write(chalk.gray(`[loop] stopped: ${result.stoppedBy} after ${result.iterations} iteration(s), ${result.tokens} tokens\n`));
        process.exit(loopExitCode(result.stoppedBy));
      }

      const [
        { buildExecCommand, parseExecEnv, execAgent, runWithFallback, normalizeMode, resolveMode, defaultModeFor, headlessPlanStallCommand, nativeResume, resolveInteractive },
        { ALL_AGENT_IDS },
        { profileExists, resolveProfileForRun },
        { readAndResolveBundleEnv, describeBundle },
        { splitBundleRef, resolveSshTarget, remoteResolveEnv },
        { getConfiguredRunStrategy, normalizeRunStrategy, resolveRunVersion, RUN_STRATEGIES },
        { getGlobalDefault, getVersionHomePath, resolveVersion, resolveVersionAlias },
        { buildDiscoveredPlugin, loadPluginManifest, syncPluginToVersion },
        { parseWorkflowFrontmatter, resolveWorkflowRef, resolveAllowedSubagents },
        { resolveRunDefaults },
        { getMcpServersByName, buildWorkflowMcpConfig },
        { supports },
      ] = await Promise.all([
        import('../lib/exec.js'),
        import('../lib/agents.js'),
        import('../lib/profiles.js'),
        import('../lib/secrets/bundles.js'),
        import('../lib/secrets/remote.js'),
        import('../lib/rotate.js'),
        import('../lib/versions.js'),
        import('../lib/plugins.js'),
        import('../lib/workflows.js'),
        import('../lib/run-defaults.js'),
        import('../lib/mcp.js'),
        import('../lib/capabilities.js'),
      ]);
      const isValidAgent = (agent: string): agent is AgentId => ALL_AGENT_IDS.includes(agent as AgentId);

      // Parse agent@version
      const [rawAgent, rawVersion] = agentSpec.split('@');
      let agent: AgentId;
      let version: string | undefined = rawVersion || undefined;
      let profileEnv: Record<string, string> | undefined;
      let fromProfile = false;
      let workflowModel: string | undefined;
      // WORKFLOW.md capability scoping, translated to Claude headless flags below.
      let workflowToolsRestrict: string[] | undefined;
      let workflowMcpConfigPath: string | undefined;
      // WORKFLOW.md `loop:` block (issue #332). When a workflow declares it,
      // `agents run <workflow>` honors the loop without a --loop flag.
      let workflowLoop: import('../lib/workflows.js').LoopConfigRaw | undefined;
      const cwd = options.cwd ?? process.cwd();

      if (isValidAgent(rawAgent)) {
        agent = rawAgent;
      } else if (profileExists(rawAgent)) {
        // Not a known agent id, but a profile by this name exists. Profiles
        // bind (host agent, version, env overrides, keychain-backed auth)
        // so Chinese models (Kimi, DeepSeek, Qwen, GLM) can run inside
        // Claude Code without a local proxy.
        try {
          const resolved = resolveProfileForRun(rawAgent);
          agent = resolved.agent;
          if (!version) version = resolved.version;
          profileEnv = resolved.env;
          fromProfile = true;
          process.stderr.write(chalk.gray(`Resolved profile '${resolved.profileName}' -> ${agent}${version ? `@${version}` : ''}\n`));
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
      } else if (resolveWorkflowRef(rawAgent, cwd)) {
        // Workflow: explicit directory, project .agents/workflows/<name>, user, system, or extra repo.
        // Resolution follows resource precedence: direct path, then project > user > system > extras.
        // Structure:
        //   WORKFLOW.md        ← orchestrator instructions fed to claude as system prompt
        //   subagents/*.md     ← flat .md files copied to ~/.claude/agents/ for Agent tool discovery
        const workflowDir = resolveWorkflowRef(rawAgent, cwd)!;
        agent = 'claude';
        const workflowFrontmatter = parseWorkflowFrontmatter(workflowDir);
        if (typeof workflowFrontmatter?.model === 'string' && workflowFrontmatter.model.trim() !== '') {
          workflowModel = workflowFrontmatter.model.trim();
        }
        workflowLoop = workflowFrontmatter?.loop;

        const resolvedVersion = resolveVersionAlias('claude', version);
        const versionHome = getVersionHomePath('claude', resolvedVersion ?? getGlobalDefault('claude') ?? '');
        const claudeAgentsDir = path.join(versionHome, '.claude', 'agents');

        // Copy subagents/*.md into ~/.claude/agents/ so Claude's Agent tool finds
        // them. allowedAgents enforcement (issue #324): when the workflow declares
        // `allowedAgents:`, copy ONLY those subagent files (matched by filename
        // stem, e.g. security.md -> "security"). A subagent whose definition isn't
        // on disk can't be dispatched — this is the actual, fail-closed mechanism.
        // (Claude's `--agents` flag DEFINES custom agents; it does not restrict
        // which subagents may be dispatched, so it is not used here.)
        const subagentsDir = path.join(workflowDir, 'subagents');
        const allowedAgents = workflowFrontmatter?.allowedAgents;
        if (fs.existsSync(subagentsDir)) {
          fs.mkdirSync(claudeAgentsDir, { recursive: true });
          // Fail-closed subagent scoping (issue #324). resolveAllowedSubagents
          // distinguishes "allowedAgents absent" (undefined -> copy all) from
          // "present but empty" (=> copy ZERO). An explicit `allowedAgents: []`
          // must mean "allow none", never silently widen to "allow all".
          const allFiles = fs.readdirSync(subagentsDir).filter(f => f.endsWith('.md'));
          const { allowedStems, missing } = resolveAllowedSubagents(allFiles, allowedAgents);
          const allowStemSet = new Set(allowedStems);
          let copied = 0;
          let skipped = 0;
          for (const file of allFiles) {
            const stem = file.replace(/\.md$/, '');
            if (!allowStemSet.has(stem)) {
              skipped++;
              continue;
            }
            fs.copyFileSync(path.join(subagentsDir, file), path.join(claudeAgentsDir, file));
            copied++;
          }
          if (allowedAgents !== undefined) {
            // Surface any allowedAgents entry with no matching subagent file, and
            // report how many were filtered out, so the scope is auditable.
            if (missing.length > 0) {
              process.stderr.write(chalk.yellow(`[workflow] allowedAgents not found in subagents/: ${missing.join(', ')}\n`));
            }
            process.stderr.write(chalk.gray(`[workflow] subagents restricted to allowedAgents: copied ${copied}, withheld ${skipped}\n`));
          }
        }

        // Feed WORKFLOW.md body (strip frontmatter) as orchestrator system context.
        const workflowMd = path.join(workflowDir, 'WORKFLOW.md');
        const orchestratorBody = fs.existsSync(workflowMd)
          ? fs.readFileSync(workflowMd, 'utf-8').replace(/^---[\s\S]*?---\n/, '').trim()
          : '';
        if (orchestratorBody && prompt !== undefined) {
          prompt = `${orchestratorBody}\n\n---\n\n${prompt}`;
        }

        // Sync workflow-scoped skills into the version home's skills dir.
        const workflowSkillsDir = path.join(workflowDir, 'skills');
        if (fs.existsSync(workflowSkillsDir)) {
          const skillsTarget = path.join(claudeAgentsDir, '..', 'skills');
          fs.mkdirSync(skillsTarget, { recursive: true });
          for (const entry of fs.readdirSync(workflowSkillsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            fs.cpSync(path.join(workflowSkillsDir, entry.name), path.join(skillsTarget, entry.name), { recursive: true });
          }
        }

        // Sync workflow-scoped plugins into the version home.
        const workflowPluginsDir = path.join(workflowDir, 'plugins');
        if (fs.existsSync(workflowPluginsDir)) {
          for (const entry of fs.readdirSync(workflowPluginsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const pluginRoot = path.join(workflowPluginsDir, entry.name);
            const manifest = loadPluginManifest(pluginRoot);
            if (!manifest) continue;
            syncPluginToVersion(
              buildDiscoveredPlugin(pluginRoot, manifest),
              'claude',
              versionHome,
            );
          }
        }

        // Auto-inject secrets bundles declared in the workflow's frontmatter `secrets:` field.
        // Union with any --secrets flags the user passed; dedupe. Skip when --no-auto-secrets is set.
        if (!options.noAutoSecrets) {
          const declared = workflowFrontmatter?.secrets ?? [];
          if (declared.length > 0) {
            const existing = new Set(options.secrets);
            const added: string[] = [];
            for (const b of declared) {
              if (!existing.has(b)) {
                options.secrets.push(b);
                existing.add(b);
                added.push(b);
              }
            }
            if (added.length > 0) {
              process.stderr.write(chalk.gray(`[workflow] auto-injecting secrets from ${rawAgent}: ${added.join(', ')}\n`));
            }
          }
        }

        // Capability scoping: translate WORKFLOW.md `tools:` / `mcpServers:` into
        // the Claude headless flags that ACTUALLY restrict the run (verified
        // against `claude --help`): tools -> `--tools` (restricts the available
        // built-in tool set), mcpServers -> `--mcp-config` + `--strict-mcp-config`
        // (loads ONLY the named servers). `allowedAgents:` is enforced separately,
        // above, by copying only the allowed subagent definition files. Gated
        // behind the `allowlist` capability — if the resolved agent lacks it, warn
        // loudly rather than silently dropping the declaration (issue #324).
        const scopeVersion = resolveVersionAlias('claude', version) ?? getGlobalDefault('claude') ?? undefined;
        const allowlist = supports('claude', 'allowlist', scopeVersion);
        const tools = workflowFrontmatter?.tools;
        const mcpServerNames = workflowFrontmatter?.mcpServers;
        const hasScoping = (tools && tools.length > 0)
          || (mcpServerNames && mcpServerNames.length > 0)
          || (allowedAgents && allowedAgents.length > 0);

        if (hasScoping && !allowlist.ok) {
          process.stderr.write(chalk.yellow(
            `[workflow] tools/mcpServers declared but unenforceable on claude${scopeVersion ? `@${scopeVersion}` : ''} (allowlist ${allowlist.reason ?? 'unsupported'}) — running unscoped\n`,
          ));
        } else if (hasScoping) {
          if (tools && tools.length > 0) {
            workflowToolsRestrict = tools;
            process.stderr.write(chalk.gray(`[workflow] restricting available tools to: ${tools.join(', ')} (Write/Bash/Edit unavailable unless listed)\n`));
          }
          if (mcpServerNames && mcpServerNames.length > 0) {
            const servers = getMcpServersByName(mcpServerNames, { cwd });
            const found = new Set(servers.map(s => s.name));
            const missing = mcpServerNames.filter(n => !found.has(n));
            if (missing.length > 0) {
              process.stderr.write(chalk.yellow(`[workflow] mcpServers not found in registry, skipped: ${missing.join(', ')}\n`));
            }
            // Fail-closed: `mcpServers:` was declared, so the run MUST be scoped to
            // a config — never fall through to the user's ambient MCP set. When
            // zero declared names resolve to installed servers, write a locked-down
            // empty config (`{ "mcpServers": {} }`); with `--strict-mcp-config` the
            // run gets NO MCP servers, which is LESS access than ambient (issue #324).
            const mcpConfig = buildWorkflowMcpConfig(servers);
            const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-workflow-mcp-'));
            workflowMcpConfigPath = path.join(configDir, 'mcp-config.json');
            // 0o600: the config embeds server `env` which can carry tokens.
            // Cleaned up after the run (finally block below).
            fs.writeFileSync(workflowMcpConfigPath, mcpConfig, { mode: 0o600 });
            if (servers.length > 0) {
              process.stderr.write(chalk.gray(`[workflow] scoping MCP servers to ONLY: ${servers.map(s => s.name).join(', ')}\n`));
            } else {
              process.stderr.write(chalk.yellow(`[workflow] no declared mcpServers resolved — scoping run to NO MCP servers (fail-closed)\n`));
            }
          }
        }

        // Count the subagents THIS workflow made available (after allowedAgents
        // filtering), not every file in the shared agents dir. Same fail-closed
        // semantics as the copy above: `allowedAgents: []` -> 0.
        const subagentCount = fs.existsSync(subagentsDir)
          ? resolveAllowedSubagents(
              fs.readdirSync(subagentsDir).filter(f => f.endsWith('.md')),
              allowedAgents,
            ).allowedStems.length
          : 0;
        process.stderr.write(chalk.gray(`Workflow '${rawAgent}' → claude (${subagentCount} subagents)\n`));
      } else {
        // Smart pick: auto-correct a single typo (insertion/deletion/substitution/transposition)
        // against the known agent ids before giving up. Example: `cladue` -> `claude`, `grk` -> `grok`.
        const { fuzzyMatch, FUZZY_PRESETS } = await import('../lib/fuzzy.js');
        const suggested = fuzzyMatch(rawAgent, ALL_AGENT_IDS, FUZZY_PRESETS.agents);
        if (suggested && isValidAgent(suggested)) {
          process.stderr.write(chalk.gray(`Resolved '${rawAgent}' -> '${suggested}' (single-edit match)\n`));
          agent = suggested;
        } else {
          console.error(chalk.red(`Unknown agent: ${rawAgent}`));
          console.error(chalk.gray(`Available agents: ${ALL_AGENT_IDS.join(', ')}`));
          console.error(chalk.gray(`Or add a profile: agents profiles add <name>`));
          process.exit(1);
        }
      }

      version = resolveVersionAlias(agent, version);

      // --resume: resolve a prior conversation and rewrite the run target to
      // continue it. `version` here is already the alias-resolved candidate-version
      // FILTER (undefined for default/any, concrete for @latest/@oldest/@x.y.z);
      // it is replaced below by the chosen session's OWN version (isolation).
      let resumeNative = false;
      let resumeSessionId: string | undefined;
      let forceInteractive = false;
      if (options.resume !== undefined) {
        if (options.sessionId) {
          console.error(chalk.red('--resume and --session-id are mutually exclusive. --session-id CREATES a session with a fixed id; --resume continues an existing one.'));
          process.exit(1);
        }
        if (options.loop || options.fallback || options.resumeCheckpoint) {
          console.error(chalk.red('--resume cannot be combined with --loop, --fallback, or --resume-checkpoint (those are separate continuation mechanisms).'));
          process.exit(1);
        }

        const { findSessionsById } = await import('../lib/session/db.js');
        const { discoverSessions } = await import('../lib/session/discover.js');
        const { pickSessionInteractive } = await import('./sessions.js');
        const { buildContinuePrompt } = await import('../lib/loop.js');

        // Freshen the index for this agent before any lookup (incremental, cached).
        // AgentId is wider than SessionAgentId (cursor/amp/… keep no transcripts);
        // those simply yield no matches and fall through to the not-found error.
        const sessionAgent = agent as import('../lib/session/types.js').SessionAgentId;
        await discoverSessions({ agent: sessionAgent, version });

        // Resume is interactive unless a follow-on prompt makes it headless.
        const wantsInteractive = resolveInteractive({ interactive: options.interactive, headless: options.headless, prompt });
        const idArg = typeof options.resume === 'string' ? options.resume.trim() : '';
        let scopeCwd: string | undefined;
        try { scopeCwd = fs.realpathSync(cwd); } catch { scopeCwd = cwd; }

        let session: import('../lib/session/types.js').SessionMeta | undefined;
        if (idArg) {
          let matches = findSessionsById(idArg, { agent: sessionAgent, version, cwd: scopeCwd });
          if (matches.length === 0) {
            const wide = findSessionsById(idArg, { agent: sessionAgent, version });
            if (wide.length > 0) {
              if (!options.quiet) process.stderr.write(chalk.gray(`No match for "${idArg}" in this project; widened to all projects.\n`));
              matches = wide;
            }
          }
          if (matches.length === 0) {
            console.error(chalk.red(`No ${agent} session matching "${idArg}".`));
            console.error(chalk.gray(`Browse sessions: agents sessions ${idArg}`));
            process.exit(1);
          } else if (matches.length === 1) {
            session = matches[0];
          } else if (wantsInteractive) {
            const picked = await pickSessionInteractive(matches, `Multiple sessions match "${idArg}":`);
            if (!picked) process.exit(0);
            session = picked.session;
          } else {
            console.error(chalk.red(`"${idArg}" is ambiguous — ${matches.length} sessions match:`));
            for (const m of matches.slice(0, 10)) {
              console.error(chalk.gray(`  ${m.shortId}  ${m.timestamp.slice(0, 16).replace('T', ' ')}  ${m.topic ?? m.label ?? ''}`));
            }
            console.error(chalk.gray('Pass more of the id, or resume interactively (drop the prompt).'));
            process.exit(1);
          }
        } else {
          // Bare --resume: pick from recent sessions in scope. Needs a TTY.
          if (!wantsInteractive) {
            console.error(chalk.red('--resume with no id needs an interactive terminal. Pass a session id (full or prefix), or run without --headless.'));
            process.exit(1);
          }
          const recent = await discoverSessions({ agent: sessionAgent, version, limit: 200 });
          if (recent.length === 0) {
            console.error(chalk.red(`No ${agent} sessions found to resume in this project.`));
            console.error(chalk.gray('Browse all: agents sessions'));
            process.exit(1);
          }
          const picked = await pickSessionInteractive(recent, `Resume which ${agent} session?`);
          if (!picked) process.exit(0);
          session = picked.session;
          forceInteractive = true; // bare resume always lands in the agent's TUI
        }

        // Pin to the chosen session's own version (the isolated HOME the transcript
        // lives in) and route by tier.
        version = session.version;
        if (nativeResume(agent)) {
          resumeNative = true;
          resumeSessionId = session.id;
          if (!options.quiet) process.stderr.write(chalk.gray(`Resuming ${agent} ${session.shortId} (native)${version ? ` @${version}` : ''}\n`));
        } else {
          // Tier-2: launch fresh with a /continue <id> first message; the agent
          // loads the transcript via `agents sessions <id>` and picks up.
          prompt = buildContinuePrompt(session.id, prompt);
          if (prompt.trim() === `/continue ${session.id}`) forceInteractive = true;
          if (!options.quiet) process.stderr.write(chalk.gray(`Resuming ${agent} ${session.shortId} (/continue replay)${version ? ` @${version}` : ''}\n`));
        }
      }

      const configuredStrategy = getConfiguredRunStrategy(agent, cwd);
      const explicitStrategy = options.strategy ? normalizeRunStrategy(options.strategy) : null;
      if (options.strategy && !explicitStrategy) {
        console.error(chalk.red(`Invalid strategy: ${options.strategy}. Use ${RUN_STRATEGIES.join(', ')}.`));
        process.exit(1);
      }
      if (options.balanced && explicitStrategy && explicitStrategy !== 'balanced') {
        console.error(chalk.red('--balanced conflicts with --strategy. Use one strategy override.'));
        process.exit(1);
      }
      const strategy = options.balanced ? 'balanced' : explicitStrategy ?? configuredStrategy;

      // Strategy only applies to bare agent invocations. Explicit @version,
      // profiles, and fallback chains already define their execution target.
      if (strategy !== 'pinned' || options.balanced || explicitStrategy) {
        if (version) {
          process.stderr.write(chalk.yellow(`[agents] strategy ${strategy} ignored: version ${version} is pinned\n`));
        } else if (fromProfile) {
          process.stderr.write(chalk.yellow(`[agents] strategy ${strategy} ignored: profile pins its own version/auth\n`));
        } else if (options.fallback) {
          process.stderr.write(chalk.yellow(`[agents] strategy ${strategy} ignored: --fallback pins versions directly\n`));
        } else {
          try {
            const resolved = await resolveRunVersion(agent, strategy, cwd);
            if (resolved.version) {
              version = resolved.version;
              if (resolved.rotation && !options.quiet) {
                const banner = formatRotationBanner(resolved.rotation, strategy);
                process.stderr.write(chalk.gray(banner + '\n'));
              }
            } else if (!options.quiet) {
              process.stderr.write(chalk.yellow(`[agents] strategy ${strategy} found no usable ${agent} version; falling back to defaults\n`));
            }
          } catch (err) {
            if (!options.quiet) {
              process.stderr.write(chalk.yellow(`[agents] strategy ${strategy} skipped: ${(err as Error).message}\n`));
            }
          }
        }
      }

      const defaultVersion = version ?? resolveVersion(agent, cwd);
      const runDefaults: ResolvedRunDefaults = fromProfile
        ? { sources: {} }
        : resolveRunDefaults(agent, defaultVersion, cwd);

      // Accept the four canonical modes plus 'full' as a permanent silent
      // alias for 'skip' (rewritten downstream by normalizeMode in exec.ts).
      let mode = options.mode as ExecMode;
      const modeSource = runCmd.getOptionValueSource('mode');
      const modeFromRunDefault = modeSource === 'default' && !!runDefaults.mode;
      if (modeFromRunDefault) {
        mode = runDefaults.mode as ExecMode;
      }
      if (!['plan', 'edit', 'auto', 'skip', 'full'].includes(mode)) {
        console.error(chalk.red(`Invalid mode: ${mode}. Use plan, edit, auto, or skip ('full' accepted as alias for skip).`));
        process.exit(1);
      }

      // When the user did not pass --mode explicitly, the default is the
      // generic 'plan'. Some agents (antigravity: edit/skip only, grok in some
      // configurations) do not support plan. For implicit defaults, degrade
      // silently to the agent's first listed mode rather than throwing — the
      // user did not ask for read-only, they asked for "just run it." An
      // explicit --mode plan still throws (see resolveMode), because silently
      // elevating an explicit read-only request to edit is unsafe.
      const modeIsDefault = modeSource === 'default';
      try {
        resolveMode(agent, normalizeMode(mode));
      } catch (err) {
        if (modeIsDefault && !modeFromRunDefault) {
          mode = defaultModeFor(agent) as ExecMode;
          if (!options.quiet) {
            process.stderr.write(chalk.gray(`[agents] ${agent} has no '${options.mode}' mode; using '${mode}'\n`));
          }
        } else {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
      }

      // Fail fast on the headless-plan stall footgun: a slash command run
      // headless under the implicit default 'plan' mode hangs forever at
      // ExitPlanMode (no TTY to approve the plan). Tell the user how to fix it
      // instead of leaving them staring at a frozen process. Explicit
      // `--mode plan` is respected for genuine read-only command runs.
      const stallCmd = headlessPlanStallCommand({
        prompt,
        interactive: options.interactive,
        mode,
        modeIsDefault,
      });
      if (stallCmd) {
        console.error(
          chalk.red(`Refusing to run ${stallCmd} headless in read-only 'plan' mode — it would hang at ExitPlanMode (no TTY to approve the plan).`)
        );
        console.error(
          chalk.yellow(`Re-run with an explicit mode: --mode auto (recommended — auto-approves safe ops, blocks risky ones), --mode edit, or --mode full.`)
        );
        console.error(
          chalk.gray(`Pass --mode plan explicitly if you really want a read-only run.`)
        );
        process.exit(1);
      }

      const effort = options.effort as ExecEffort;
      if (!['low', 'medium', 'high', 'xhigh', 'max', 'auto'].includes(effort)) {
        console.error(chalk.red(`Invalid effort: ${effort}. Use 'low', 'medium', 'high', 'xhigh', 'max', or 'auto'`));
        process.exit(1);
      }

      let userEnv: Record<string, string> | undefined;
      try {
        userEnv = parseExecEnv(options.env);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }

      // Resolve --secrets bundles in flag order. Later bundles override earlier
      // ones. Any resolution failure (missing keychain item, blocked exec ref)
      // aborts before spawn so the agent never sees a partial env.
      let secretsEnv: Record<string, string> = {};
      for (const bundleRef of options.secrets) {
        try {
          const { bundle: bundleName, host } = splitBundleRef(bundleRef);
          if (host) {
            // Remote bundle (`bundle@host`): resolve over SSH and inject
            // ephemerally — values never touch this machine's keychain or disk.
            const target = await resolveSshTarget(host);
            const bundleEnv = await remoteResolveEnv(target, bundleName);
            console.log(chalk.gray(`[secrets] Resolved ${bundleName}@${host}: ${Object.keys(bundleEnv).length} keys (remote, ephemeral)`));
            secretsEnv = { ...secretsEnv, ...bundleEnv };
          } else {
            const { bundle, env: bundleEnv } = readAndResolveBundleEnv(bundleName, { caller: `agent ${agent}` });
            const entries = describeBundle(bundle);
            const counts: Record<string, number> = {};
            for (const e of entries) {
              counts[e.kind] = (counts[e.kind] || 0) + 1;
            }
            const breakdown = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
            console.log(chalk.gray(`[secrets] Resolved ${bundleName}: ${entries.length} keys (${breakdown})`));
            secretsEnv = { ...secretsEnv, ...bundleEnv };
          }
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
      }

      // Merge order (later wins): profile env < secrets bundles < --env K=V.
      // Profile carries provider auth; secrets bundles carry user-defined
      // values; --env is the per-invocation override.
      const hasOverrides = profileEnv || options.secrets.length > 0 || userEnv;
      const env: Record<string, string> | undefined = hasOverrides
        ? { ...(profileEnv ?? {}), ...secretsEnv, ...(userEnv ?? {}) }
        : undefined;

      const modelSource = runCmd.getOptionValueSource('model');
      const model = options.model
        ?? (!fromProfile && modelSource === undefined
          ? (workflowModel ?? (options.fallback ? undefined : runDefaults.model))
          : undefined);

      const execOptions: ExecOptions = {
        agent,
        version,
        prompt,
        interactive: options.interactive || forceInteractive,
        mode,
        effort,
        cwd: options.cwd,
        model,
        addDirs: options.addDir,
        json: options.json,
        headless: options.headless,
        sessionId: resumeSessionId ?? options.sessionId,
        resume: resumeNative,
        verbose: options.verbose,
        timeout: options.timeout,
        env,
        toolsRestrict: workflowToolsRestrict,
        mcpConfigPath: workflowMcpConfigPath,
        passthroughArgs,
      };

      if (options.interactive && options.headless) {
        console.error(chalk.red('--interactive and --headless are mutually exclusive. Pass one, or neither (mode is inferred from prompt presence).'));
        process.exit(1);
      }

      if (options.interactive) {
        if (options.fallback) {
          console.error(chalk.red('--interactive is not compatible with --fallback. Fallback only works for headless prompt runs.'));
          process.exit(1);
        }
        if (options.acp) {
          console.error(chalk.red('--interactive is not compatible with --acp. ACP is a headless protocol.'));
          process.exit(1);
        }
      }

      const fallback: FallbackEntry[] = [];
      if (options.fallback) {
        if (prompt === undefined) {
          console.error(chalk.red('--fallback requires a prompt. Fallback hands off headless runs only — interactive sessions can\'t be resumed on a different CLI.'));
          process.exit(1);
        }
        const entries = options.fallback.split(',').map(s => s.trim()).filter(Boolean);
        const { fuzzyMatch: fuzzyFb, FUZZY_PRESETS: PRESETS_FB } = await import('../lib/fuzzy.js');
        for (const entry of entries) {
          const [rawFbAgent, fbVersion] = entry.split('@');
          let fbAgent: AgentId;
          if (isValidAgent(rawFbAgent)) {
            fbAgent = rawFbAgent;
          } else {
            const suggested = fuzzyFb(rawFbAgent, ALL_AGENT_IDS, PRESETS_FB.agents);
            if (suggested && isValidAgent(suggested)) {
              process.stderr.write(chalk.gray(`Resolved fallback '${rawFbAgent}' -> '${suggested}' (single-edit match)\n`));
              fbAgent = suggested;
            } else {
              console.error(chalk.red(`Unknown fallback agent: ${rawFbAgent}`));
              console.error(chalk.gray(`Available: ${ALL_AGENT_IDS.join(', ')}`));
              process.exit(1);
            }
          }
          if (fbAgent === agent) {
            console.error(chalk.red(`Fallback cannot include the primary agent (${agent}). Rate-limit fallback only helps when switching providers.`));
            process.exit(1);
          }
          fallback.push({ agent: fbAgent, version: resolveVersionAlias(fbAgent, fbVersion || undefined) });
        }
      }

      if (options.acp) {
        if (prompt === undefined) {
          console.error(chalk.red('--acp requires a prompt. ACP is a programmatic protocol; interactive TUI sessions still use the native CLI.'));
          process.exit(1);
        }
        if (fallback.length > 0) {
          console.error(chalk.red('--acp is not compatible with --fallback yet. Drop one.'));
          process.exit(1);
        }
        const { supportsAcp } = await import('../lib/acp/harnesses.js');
        if (!supportsAcp(agent)) {
          console.error(chalk.red(`Agent '${agent}' does not support ACP. Drop --acp to use direct exec.`));
          process.exit(1);
        }
        const { runAcpHeadless } = await import('../lib/acp/run.js');
        try {
          const exitCode = await runAcpHeadless({
            agent,
            prompt,
            cwd: options.cwd ?? process.cwd(),
            mode,
            json: options.json ?? false,
          });
          process.exit(exitCode);
        } catch (err) {
          console.error(chalk.red(`ACP run failed for ${agent}: ${(err as Error).message}`));
          process.exit(1);
        }
      }

      // Budget pre-flight gate (issue #346). Estimate the run's cost and, when a
      // cap is configured with on_exceed:block, refuse to launch if it would push
      // a cap over the line — exiting non-zero so CI/headless inherit the block.
      // --yes skips ONLY the interactive confirm threshold, never a hard block.
      {
        const { runPreflightGate } = await import('../lib/budget/preflight.js');
        const { resolveEffectiveModel } = await import('../lib/models.js');
        // Estimate against the model that will ACTUALLY run, not an unpriced
        // `${agent}-default` placeholder (which made estimateCost return $0 and
        // silently neutered the per_run/per_day gate for the common no-`--model`
        // case). When `model` is undefined the spawned CLI uses its built-in
        // default, which we recover from the extracted catalog. If we still can't
        // resolve a concrete model, pass the placeholder — the gate now treats an
        // unpriced estimate under active caps as needing confirmation, so it is
        // never a silent $0 wave-through.
        const effectiveModel = resolveEffectiveModel(agent, version ?? '', model) ?? `${agent}-default`;
        const gate = runPreflightGate({
          agent,
          model: effectiveModel,
          mode,
          prompt,
          project: cwd,
          cwd,
        });
        if (!gate.dormant) {
          if (!options.quiet) {
            process.stderr.write(chalk.gray(gate.banner + '\n'));
          }
          if (!gate.decision.allow) {
            // Hard block. --yes does NOT override (acceptance criterion).
            console.error(chalk.red(`[budget] BLOCKED: ${gate.decision.reason}`));
            console.error(chalk.gray(`Raise the cap in agents.yaml budget: or set on_exceed: warn to proceed.`));
            process.exit(2);
          }
          if (gate.decision.needsConfirm && !options.yes) {
            if (!process.stdin.isTTY) {
              // Non-interactive (CI/headless) and no --yes: cannot confirm — refuse.
              console.error(chalk.red(`[budget] ${gate.decision.reason}`));
              console.error(chalk.gray(`Re-run with --yes to confirm the spend, or lower require_confirm_over.`));
              process.exit(2);
            }
            const { confirm } = await import('@inquirer/prompts');
            const proceed = await confirm({
              message: `${gate.decision.reason}. Proceed?`,
              default: false,
            });
            if (!proceed) {
              console.error(chalk.yellow('[budget] aborted by user.'));
              process.exit(2);
            }
          } else if (gate.decision.blockedCap && gate.decision.allow && !options.quiet) {
            // on_exceed:warn overrun notice (allowed but reported).
            process.stderr.write(chalk.yellow(`[budget] WARN: ${gate.decision.reason}\n`));
          }
        }
      }

      const cmd = buildExecCommand(execOptions);
      if (!options.quiet) {
        process.stderr.write(chalk.gray(`Running: ${cmd.join(' ')}\n\n`));
      }

      // Remove the ephemeral mcp-config (and its temp dir) after the run. It is
      // written at mode 0o600 but still embeds server `env` (possibly tokens),
      // so it must not linger in tmp. Synchronous so it completes before exit.
      const cleanupWorkflowMcpConfig = () => {
        if (!workflowMcpConfigPath) return;
        try {
          fs.rmSync(path.dirname(workflowMcpConfigPath), { recursive: true, force: true });
        } catch {
          // best-effort: nothing actionable if the temp dir is already gone.
        }
      };

      // Loop dispatch (issue #332). Active when --loop is passed OR a workflow
      // declares a `loop:` block. The loop path runs AFTER the #346 pre-flight
      // gate above (which fired once) — the loop's token budget is an ADDITIONAL
      // guard, not a replacement. Composable, not bypassing.
      let loopConfig: import('../lib/loop.js').LoopConfig | undefined;
      try {
        loopConfig = buildLoopConfig(options, workflowLoop);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
      if (loopConfig) {
        if (prompt === undefined) {
          console.error(chalk.red('--loop requires a prompt (or a workflow whose loop is paired with a prompt). The loop re-injects the prompt each iteration.'));
          process.exit(1);
        }
        if (options.interactive) {
          console.error(chalk.red('--loop is headless-only. The loop re-injects programmatically; an interactive TUI cannot be re-driven.'));
          process.exit(1);
        }
        if (fallback.length > 0) {
          console.error(chalk.red('--loop is not compatible with --fallback yet. Drop one.'));
          process.exit(1);
        }
        const { runLoop } = await import('../lib/loop.js');
        const { getRunsDir } = await import('../lib/state.js');
        const runId = `loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const runDir = path.join(getRunsDir(), runId);
        fs.mkdirSync(runDir, { recursive: true });
        process.stderr.write(chalk.gray(`[loop] run ${runId} — max ${loopConfig.maxIterations ?? '∞'}${loopConfig.budget ? `, budget ${loopConfig.budget} tokens` : ''}${loopConfig.until ? `, until ${loopConfig.until}` : ''}${loopConfig.interval ? `, interval ${loopConfig.interval}` : ''}\n`));
        try {
          const result = await runLoop({ ...execOptions, json: true, headless: true }, loopConfig, {
            runId,
            runDir,
            agent,
            version,
          });
          cleanupWorkflowMcpConfig();
          process.stderr.write(chalk.gray(`[loop] stopped: ${result.stoppedBy} after ${result.iterations} iteration(s), ${result.tokens} tokens (checkpoint: ${path.join(runDir, 'checkpoint.json')})\n`));
          process.exit(loopExitCode(result.stoppedBy));
        } catch (err) {
          cleanupWorkflowMcpConfig();
          console.error(chalk.red(`Loop failed for ${agent}: ${(err as Error).message}`));
          process.exit(1);
        }
      }

      try {
        let exitCode: number;
        if (fallback.length > 0) {
          // fallback requires a prompt — enforced above, narrow the type here.
          exitCode = await runWithFallback({ ...execOptions, prompt: prompt!, fallback });
        } else {
          exitCode = await execAgent(execOptions);
        }
        cleanupWorkflowMcpConfig();
        process.exit(exitCode);
      } catch (err) {
        cleanupWorkflowMcpConfig();
        console.error(chalk.red(`Failed to execute ${agent}: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
