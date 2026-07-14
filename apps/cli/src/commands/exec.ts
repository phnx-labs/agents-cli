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
import { recordDispatchedRun } from '../lib/audit/log.js';
import { warnUnpushedWork, shouldWarnUnpushed } from '../lib/warn-unpushed.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

interface ExecCommandActionOptions {
  mode: ExecMode;
  effort: ExecEffort;
  model?: string;
  cwd?: string;
  /** --project <slug>[@worktree]: resolve cwd from the projects root shorthand. */
  project?: string;
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
  /** --name <slug>: durable launch handle, resolvable via `agents sessions <name>`. */
  name?: string;
  verbose?: boolean;
  raw?: boolean;
  /** `--no-tmux` → commander sets this false (default true) to bypass the tmux wrapper. */
  tmux?: boolean;
  /** `--disable-tmux` → explicit alias of --no-tmux. */
  disableTmux?: boolean;
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
  secretsKeys?: string; // --secrets-keys: comma-separated key subset for --secrets bundles
  allowExpired?: boolean; // --allow-expired: skip expiry pre-run abort for secrets
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

/**
 * Drive a workflow's declarative `for_each:` fan-out end-to-end (issue #343).
 *
 * Runs the producer, expands one stage teammate per produced item (respecting
 * `max_items` / `DEFAULT_FOR_EACH_CAP`, surfacing any truncation — never a
 * silent cap), stages them into a fresh team via the existing `runForEach`
 * bridge, then drives the teams supervisor until the DAG drains. When a verify
 * panel is declared, tallies each item's `keep_if` gate from the skeptics'
 * terminal status and logs which items survived.
 *
 * Reuses the teams substrate wholesale — no new orchestration engine. Returns
 * the process exit code (0 on drain, 1 on producer failure / non-drain).
 */
export async function runWorkflowForEach(
  spec: import('../lib/workflows.js').ForEachSpec,
  opts: { workflowName: string; cwd: string; effort?: ExecEffort },
): Promise<number> {
  const [{ produceItems, runForEach, tallyForEach }, { expandForEach, DEFAULT_FOR_EACH_CAP }, { AgentManager }, { createTeam }, { runSupervisor }, { ALL_AGENT_IDS }] = await Promise.all([
    import('../lib/teams/forEach.js'),
    import('../lib/workflows.js'),
    import('../lib/teams/agents.js'),
    import('../lib/teams/registry.js'),
    import('../lib/teams/supervisor.js'),
    import('../lib/agents.js'),
  ]);

  // The teams substrate spawns teammates as a real harness. When `agent:` names
  // a known harness id, honor it; otherwise fall back to claude (the workflow
  // harness) so a subagent-style name in `agent:` still runs.
  const isHarness = (a: string): boolean => (ALL_AGENT_IDS as readonly string[]).includes(a);
  const runSpec: import('../lib/workflows.js').ForEachSpec = {
    ...spec,
    agent: isHarness(spec.agent) ? spec.agent : 'claude',
    ...(spec.verify
      ? { verify: { ...spec.verify, agent: isHarness(spec.verify.agent) ? spec.verify.agent : 'claude' } }
      : {}),
  };
  if (runSpec.agent !== spec.agent) {
    process.stderr.write(chalk.gray(`[for_each] '${spec.agent}' is not a harness id — staging stage teammates as claude\n`));
  }

  // 1. Producer: run the shell command (or resolve itemsRef) into the item list.
  let items: string[];
  try {
    items = await produceItems(runSpec, { cwd: opts.cwd });
  } catch (err) {
    console.error(chalk.red(`[for_each] producer failed: ${(err as Error).message}`));
    return 1;
  }
  if (items.length === 0) {
    process.stderr.write(chalk.yellow('[for_each] producer emitted no items — nothing to fan out.\n'));
    return 0;
  }

  // 2. Cap accounting (surfaced, never silent — acceptance criterion in #343).
  const cap = runSpec.max_items ?? DEFAULT_FOR_EACH_CAP;
  const { truncated } = expandForEach(runSpec, items);
  if (truncated > 0) {
    process.stderr.write(chalk.yellow(
      `[for_each] producer emitted ${items.length} items; capping at ${cap} (${truncated} dropped). Raise \`max_items\` to fan out more.\n`,
    ));
  }
  process.stderr.write(chalk.gray(`[for_each] ${Math.min(items.length, cap)} stage teammate(s) from ${items.length} produced item(s)\n`));

  // 3. Stage the expanded teammates into a fresh team via the existing bridge.
  const team = `foreach-${opts.workflowName.replace(/[^a-zA-Z0-9_-]/g, '-')}-${Date.now().toString(36)}`;
  await createTeam(team, { description: `for_each fan-out from workflow '${opts.workflowName}'` });
  const mgr = new AgentManager();
  const { teammates } = await runForEach(mgr, team, runSpec, items, {
    cwd: opts.cwd,
    effort: opts.effort,
    concurrency: runSpec.concurrency,
  });

  // 4. Drive the supervisor until the DAG drains (the same loop `teams start
  // --watch` uses; it absorbs the staged teammates via rescanFromDisk).
  const result = await runSupervisor(mgr, {
    team,
    onWave: (s) => {
      const ts = s.timestamp.slice(11, 19);
      process.stderr.write(
        `[${ts}] [for_each] wave ${s.wave}  launched=${s.launched.length}  running=${s.running}  pending=${s.pending}  done=${s.completed}  failed=${s.failed}\n`,
      );
    },
  });

  // 5. keep_if tally: a skeptic that COMPLETED is a keep vote; a failed skeptic
  // votes to drop. Gate each item and report which survived.
  if (runSpec.verify) {
    const loaded = await mgr.listByTask(team);
    const statusByName = new Map(loaded.map((a) => [a.name, a.status]));
    const verdicts = tallyForEach(teammates, (v) => statusByName.get(v.name) === 'completed');
    const kept = verdicts.filter((v) => v.kept);
    process.stderr.write(chalk.gray(
      `[for_each] keep_if=${runSpec.verify.keep_if}: kept ${kept.length}/${verdicts.length} item(s)\n`,
    ));
    for (const v of verdicts) {
      const tag = v.kept ? chalk.green('keep') : chalk.red('drop');
      process.stderr.write(chalk.gray(`  [${tag}] ${v.item} (${v.votes.filter(Boolean).length}/${v.votes.length} votes)\n`));
    }
  }

  if (result.stoppedBy === 'drained') {
    process.stderr.write(chalk.green(`[for_each] drained in ${Math.floor(result.elapsed_ms / 1000)}s (${result.waves} waves). Team: ${team}\n`));
    return 0;
  }
  process.stderr.write(chalk.yellow(`[for_each] stopped by ${result.stoppedBy} after ${result.waves} waves. Team: ${team}\n`));
  return 1;
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
    .option(
      '--secrets-keys <keys>',
      'Inject only this comma-separated subset of keys from --secrets bundles (e.g. KEY1,KEY2). Missing keys are an error. Applies to all --secrets bundles on this run.',
    )
    .option('--allow-expired', 'Inject secrets even if their expiry date has passed (overrides the pre-run expiry abort).')
    .option('--cwd <dir>', 'Working directory for the agent (defaults to current directory). With --host, the directory ON the host.')
    .option(
      '-P, --project <ref>',
      'Project shorthand <slug>[@worktree], resolved against your projects root (auto-inferred, cached). Sets the cwd locally or on --host.',
    )
    .option(
      '--add-dir <dir>',
      'Grant access to an additional directory outside the project (Claude and Codex, repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      []
    )
    .option('--json', 'Stream events as JSON lines (for parsing by other tools)')
    .option('--quiet', 'Suppress preamble (rotation banner, "Running:" line). Useful when piping JSON events to a parser.', false)
    .option('--headless', 'Force headless mode. Auto-enabled when a prompt is provided; pass explicitly to stay headless with no prompt (reads the prompt from stdin).', false)
    .option('-i, --interactive', 'Force interactive mode even when a prompt is provided. Mutually exclusive with --headless.')
    .option('--resume [id]', 'Resume a previous conversation. Accepts a full or partial session id (prefix-matched against the index); omit the id to pick from recent sessions interactively. Resumes under the version that started the session. claude/codex resume natively; other agents replay via a /continue first message. Pair with a prompt to continue headlessly.')
    .option('--session-id <id>', 'Force a NEW conversation to use this exact session UUID (Claude only). This CREATES a session — to resume an existing one, use --resume.')
    .option('--name <slug>', 'Name the run — seeds the session label so it shows up as `<name>` in `agents sessions` and resolves by it (and `agents hosts logs <name>` for --host runs) instead of an opaque id. An agent-generated title later refines the label; your name shows until then. Optional.')
    .option('--verbose', 'Show detailed execution logs')
    .option('--raw', 'Interactive runs on macOS/Linux launch inside a shared tmux session (for %pane addressing + re-attach). Pass --raw to spawn the agent directly instead. Also disabled by AGENTS_NO_TMUX=1.')
    .option('--no-tmux', 'Spawn the agent directly instead of wrapping it in the shared tmux session. Same effect as --raw / AGENTS_NO_TMUX=1. Use this to see the agent\'s full startup output when a launch is failing.')
    .option('--disable-tmux', 'Alias for --no-tmux.')
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
      'Version/account selection strategy: pinned | available | balanced. Defaults to run.<agent>.strategy, then balanced (spreads load across healthy accounts and skips any that are rate-limited). (Legacy `rotate` accepted as alias for `balanced`.)',
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
    .option('--remote-cwd <dir>', 'Explicit host working directory for --host runs (overrides --cwd; usually --cwd suffices).')
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

  // Required for the documented `agents run <agent> [prompt] -- <native flags>`
  // passthrough: commander >=13 rejects excess operands by default, so any
  // post-`--` token died with "too many arguments" before the action ran. The
  // action re-derives the `--` boundary from rawArgs and still errors on excess
  // operands that are NOT behind `--`.
  runCmd.allowExcessArguments(true);

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
        pinned     use the workspace/global pinned version
        available  use pinned if it can run right now; otherwise switch to another signed-in version
        balanced   distribute load across healthy accounts by remaining capacity (default)
        A version/account is skipped when it is rate-limited right now — any usage window (incl. the 5-hour session window) at 100%, matching the 'agents view' badge.
        --balanced is shorthand for --strategy balanced. Ignored when @version is pinned, when a profile is used, or with --fallback.

      Fallback: --fallback codex,gemini retries on rate-limit failure via /continue handoff. Each entry accepts @version.

      Resume: --resume <id> continues a prior conversation (full or partial id; omit to pick interactively). claude/codex resume natively; others replay via a /continue first message. Add a prompt to continue headlessly.

      Passthrough: everything after -- is forwarded verbatim to the underlying agent CLI.
        agents run kimi -- --plan --some-native-flag value
    `,
  });

  runCmd.action(async (agentSpec: string, prompt: string | undefined, options: ExecCommandActionOptions, command: Command) => {
      // Capture everything after -- as passthrough args forwarded verbatim to the
      // underlying CLI. Commander strips the literal `--` and folds what follows
      // into the positional operands (so `agents run codex -- --yolo` would parse
      // `--yolo` as the PROMPT) — recover the boundary from rawArgs instead of
      // operand counts. Excess operands not behind `--` are still an error (an
      // unquoted prompt must not silently become agent flags).
      const rawArgs: string[] = process.argv;
      const separatorIdx = rawArgs.indexOf('--');
      const passthroughArgs = separatorIdx === -1 ? [] : rawArgs.slice(separatorIdx + 1);
      const operandsBeforeSeparator = command.args.length - passthroughArgs.length;
      if (operandsBeforeSeparator > 2) {
        console.error(chalk.red(
          `Too many arguments for 'run'. Quote the prompt ("fix the bug"), and put agent-native flags after -- (agents run codex -- --yolo).`,
        ));
        process.exit(1);
      }
      if (prompt !== undefined && operandsBeforeSeparator < 2) {
        // The token commander assigned to [prompt] came from behind `--` — it is
        // a native flag, not a prompt. Run interactively.
        prompt = undefined;
      }

      // --lease: invent a disposable cloud box for this run (via crabbox), run
      // the agent there, then tear it down. Unlike --host, nothing is registered.
      if (options.lease) {
        if (prompt === undefined) {
          console.error(chalk.red('A prompt is required for leased runs: agents run <agent> "<task>" --lease'));
          process.exit(1);
        }
        const backend = typeof options.lease === 'string' ? options.lease : undefined;
        const { detectSignedInRuntimes, pickRuntimes, resolveClaudeCredentialsBlob } = await import('../lib/crabbox/runtimes.js');
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
        // Claude ships its OAuth token (not just the .claude.json config) — name it
        // explicitly so the consent covers the actual credential transferred.
        const whatShips = runtimes.includes('claude') ? 'credentials + Claude OAuth token' : 'credentials';
        const ok = await confirm({
          message: `Copy ${whatShips} for ${names} to a disposable cloud box, run there, then destroy it?`,
          default: false,
        });
        if (!ok) {
          console.error(chalk.yellow('Aborted — no credentials pushed, no box leased.'));
          process.exit(1);
        }

        // Read the Claude OAuth token from the local Keychain (silent) so it can be
        // written to ~/.claude/.credentials.json on the box — otherwise Claude boots
        // "Not logged in". Consent above already covered this transfer.
        let claudeCredentialsJson: string | null = null;
        if (runtimes.includes('claude')) {
          const claudeEmail = detected.find((d) => d.id === 'claude')?.email ?? null;
          claudeCredentialsJson = await resolveClaudeCredentialsBlob({ preferEmail: claudeEmail });
          if (!claudeCredentialsJson) {
            console.error(chalk.yellow('Warning: could not read the local Claude OAuth token — the box may come up "Not logged in".'));
          }
        }

        // Progress UI. A self-throttled spinner (NOT ora — see progress.ts) covers
        // the otherwise-silent provisioning + box-setup phases; the agent's own
        // output then prints verbatim. The router splits the crabbox stream at the
        // box-side marker. Rule: only ONE spinner phase is active at a time, and no
        // other output is written to stderr while it spins — so it can never storm.
        const { createLeaseOutputRouter, createSpinner } = await import('../lib/crabbox/progress.js');
        const agentName = agentSpec.split('@')[0];
        const spinner = createSpinner({ stream: process.stderr });
        let warmupTimer: ReturnType<typeof setInterval> | undefined;
        const stopTimer = () => { if (warmupTimer) { clearInterval(warmupTimer); warmupTimer = undefined; } };
        const fit = (s: string) => {
          const w = Math.max(20, (process.stderr.columns || 80) - 24);
          return s.length > w ? s.slice(0, w - 1) + '…' : s;
        };
        const router = createLeaseOutputRouter({
          // Setup lines only ever update spinner text (no direct stderr writes),
          // so the spinner stays the single writer during the setup phase.
          onSetupLine: (line) => spinner.update(`Setting up box — ${fit(line)}`),
          onAgentChunk: (chunk) => {
            // First agent byte: stop the setup spinner, THEN stream to stdout.
            if (spinner.active) spinner.stopAndPersist('✔', chalk.gray(`Box provisioned — ${agentName} output:`));
            process.stdout.write(chunk);
          },
        });

        try {
          const { exitCode, box, toreDown } = await leaseAndRun({
            agent: agentName,
            prompt,
            mode: options.mode,
            model: options.model,
            backend,
            runtimes,
            detected,
            claudeCredentialsJson,
            secretsBundle: process.env.AGENTS_LEASE_SECRETS_BUNDLE,
            keep: options.keepBox,
            onData: (chunk) => router.push(chunk),
            onPhase: (phase) => {
              if (phase.kind === 'warmup') {
                const label = `Leasing a ${phase.backend ?? 'hetzner'} box`;
                spinner.start(`${label}…`);
                const t0 = Date.now();
                warmupTimer = setInterval(() => spinner.update(`${label}… (${Math.round((Date.now() - t0) / 1000)}s)`), 1000);
              } else if (phase.kind === 'ready') {
                stopTimer();
                spinner.stopAndPersist('✔', `Box ${phase.box.slug} ready${phase.box.ip ? ` (${phase.box.ip})` : ''} · ${Math.round(phase.elapsedMs / 1000)}s`);
                spinner.start('Setting up box…');
              } else if (phase.kind === 'teardown') {
                if (spinner.active) spinner.stop();
              }
            },
          });
          router.end();
          stopTimer();
          if (spinner.active) spinner.stop();
          // Safety net: if setup failed before the agent ever ran, the setup log
          // was only shown as transient spinner text — surface it so the error is
          // diagnosable.
          if (exitCode !== 0 && !router.sawAgent()) {
            const log = router.setupLines();
            if (log.length) process.stderr.write(chalk.dim(log.join('\n')) + '\n');
          }
          console.error(chalk.gray(toreDown ? `Box ${box.slug} destroyed.` : `Box ${box.slug} kept${box.ip ? ` (${box.ip})` : ''}. Stop it: crabbox stop ${box.slug}`));
          process.exit(exitCode === null ? 1 : exitCode);
        } catch (err) {
          stopTimer();
          if (spinner.active) spinner.stopAndPersist('✖', chalk.red('Lease failed'));
          const log = router.setupLines();
          if (log.length && !router.sawAgent()) process.stderr.write(chalk.dim(log.join('\n')) + '\n');
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
      }

      // --host/--on/--computer: offload this run onto a registered agent host
      // over SSH instead of running locally. The three flags are aliases.
      const hostGiven = [options.host, options.device, options.on, options.computer].filter((v): v is string => !!v);

      // --project <slug>[@worktree]: resolve the projects-root shorthand into a
      // cwd. On a host run it resolves home-relative (`~/…`, so the host expands
      // it); locally it becomes an absolute path. It owns the working directory,
      // so it is mutually exclusive with both --cwd and --remote-cwd.
      if (options.project) {
        if (options.cwd || options.remoteCwd) {
          console.error(chalk.red('Pass --project alone — not with --cwd or --remote-cwd.'));
          process.exit(1);
        }
        const { resolveProjectRef } = await import('../lib/project-root.js');
        try {
          options.cwd = await resolveProjectRef(options.project, { forRemote: hostGiven.length > 0 });
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
      }

      if (hostGiven.length > 0) {
        if (new Set(hostGiven).size > 1) {
          console.error(chalk.red('Conflicting --host/--device values — pass just one.'));
          process.exit(1);
        }
        const hostName = hostGiven[0];
        const { resolveHost, resolveHostByCap } = await import('../lib/hosts/registry.js');
        const { dispatchToHost, runInteractiveOnHost } = await import('../lib/hosts/dispatch.js');
        const { registerHostSession, registerInteractiveHostSession } = await import('../lib/hosts/session-index.js');
        // A password-auth device throws DeviceOffloadUnsupportedError here; it's
        // printed cleanly by the top-level catch in index.ts (covers every
        // resolveHost caller), so it never falls through to capability routing.
        let host = await resolveHost(hostName);
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
          const runAgent = agentSpec.split('@')[0];
          // Working directory on the host: an explicit --remote-cwd is used
          // verbatim; --cwd/--project are made portable (a local-home absolute
          // becomes `~/…` so the remote shell re-roots it at ITS home).
          const { toRemotePortable } = await import('../lib/project-root.js');
          const hostCwd = options.remoteCwd ?? (options.cwd ? toRemotePortable(options.cwd) : undefined);
          // `--resume [id]`: commander yields the string id, or `true` when the
          // flag is passed bare. A bare resume needs the interactive picker,
          // which can't run over a detached remote dispatch — only forward a
          // concrete id.
          const resumeId = typeof options.resume === 'string' ? options.resume : undefined;

          // Decide whether this host run is interactive. No prompt always means
          // interactive (matching local resolveInteractive); --interactive forces
          // interactive even when a prompt is provided; --headless forces headless
          // and therefore requires a prompt.
          if (options.interactive && options.headless) {
            console.error(chalk.red('--interactive and --headless are mutually exclusive. Pass one, or neither (mode is inferred from prompt presence).'));
            process.exit(1);
          }
          const interactiveHost = options.interactive === true || (prompt === undefined && options.headless !== true);

          if (interactiveHost) {
            // Interactive host run: forward the local TTY over SSH and let the
            // remote agent start its normal interactive UI (tmux on the host).
            if (options.follow === false) {
              console.error(chalk.red('--no-follow is not compatible with interactive host runs. Interactive runs are attached by definition.'));
              process.exit(1);
            }
            // Mirror the local path (lib/exec.ts): only Claude accepts a forced
            // `--session-id`. Generating it here lets us register the run in the
            // local index and makes it resumable by id. On resume the remote
            // session keeps its existing id — don't mint a new one.
            const hostSessionId = runAgent === 'claude' && !resumeId ? randomUUID() : undefined;
            if (hostSessionId) {
              registerInteractiveHostSession({
                cwd: process.cwd(),
                host: host.name,
                agent: runAgent,
                sessionId: hostSessionId,
                name: options.name,
              });
            }
            const exitCode = await runInteractiveOnHost(host, {
              agent: runAgent,
              prompt,
              mode: options.mode,
              model: options.model,
              remoteCwd: hostCwd,
              sessionId: hostSessionId,
              name: options.name,
              resume: resumeId,
              passthroughArgs,
              raw: options.raw || options.tmux === false || options.disableTmux === true,
              forceInteractive: options.interactive,
            });
            process.exit(exitCode);
          }

          // Headless host run: launch detached, tail the remote log, and follow
          // until the remote process exits.
          if (prompt === undefined) {
            console.error(chalk.red('A prompt is required for headless host runs: agents run <agent> "<task>" --host <name>'));
            process.exit(1);
          }
          const hostSessionId = runAgent === 'claude' && !resumeId ? randomUUID() : undefined;
          const { task, exitCode } = await dispatchToHost(host, {
            agent: runAgent,
            prompt,
            mode: options.mode,
            model: options.model,
            remoteCwd: hostCwd,
            sessionId: hostSessionId,
            name: options.name,
            resume: resumeId,
            follow: options.follow !== false,
          });
          // Register the dispatched run in the LOCAL session index so it shows
          // up in `agents sessions` and resolves by id/name, even though its
          // transcript lives on the host. No-op when no session id was captured.
          registerHostSession(task, { cwd: process.cwd(), prompt });
          if (options.follow === false) {
            // The handle the caller uses to check on the run: the name if given,
            // else the real host-task id (never the old literal `<id>`). Steer
            // to the compact `agents sessions` digest over the raw log first.
            const handle = task.name ?? task.id;
            console.log(
              chalk.green(`Dispatched to ${host.name}${task.name ? ` as "${task.name}"` : ''}.`) + '\n' +
              chalk.gray(`  Status:  agents sessions ${handle}`) + chalk.gray('   (compact digest — use this)') + '\n' +
              chalk.gray(`  Raw log: agents hosts logs ${handle} -f`) + chalk.gray('   (heavy, only if needed)'),
            );
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
        // Governance chokepoint (#347): --resume-checkpoint short-circuits normal
        // dispatch and exits here — record its one audit entry with the agent,
        // version, and cwd reconstructed from the checkpoint.
        const resumeExit = loopExitCode(result.stoppedBy);
        recordDispatchedRun({
          agent: cp.agent,
          version: cp.version ?? 'unknown',
          mode: resumeExec.mode ?? 'auto',
          cwd: resumeExec.cwd ?? process.cwd(),
          exitCode: resumeExit,
        });
        // A resumed loop is always headless; surface any commits it left unpushed.
        if (shouldWarnUnpushed(resumeExec.mode ?? 'auto', false)) await warnUnpushedWork(resumeExec.cwd ?? process.cwd());
        process.exit(resumeExit);
      }

      const [
        { buildExecCommand, parseExecEnv, execAgent, runWithFallback, normalizeMode, resolveMode, headlessPlanStallCommand, nativeResume, resolveInteractive },
        { ALL_AGENT_IDS },
        { profileExists, resolveProfileForRun },
        { readAndResolveBundleEnv, describeBundle, assertRemoteBundleFlagsUnsupported },
        { splitBundleRef, resolveSshTarget, remoteResolveEnv },
        { getConfiguredRunStrategy, normalizeRunStrategy, resolveRunVersion, rotationFailoverChain, shouldArmRotationFailover, RUN_STRATEGIES },
        { getGlobalDefault, getVersionHomePath, resolveVersion, resolveVersionAlias, ensureAgentRunnable },
        { buildDiscoveredPlugin, loadPluginManifest, syncPluginToVersion },
        { parseWorkflowFrontmatter, resolveWorkflowRef, resolveAllowedSubagents, pruneStaleWorkflowSubagents },
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
      let profileFallbackModel: { envKey: string; model: string } | undefined;
      let workflowModel: string | undefined;
      // WORKFLOW.md capability scoping, translated to Claude headless flags below.
      let workflowToolsRestrict: string[] | undefined;
      let workflowMcpConfigPath: string | undefined;
      // Full paths of workflow subagent files THIS run copied into the shared
      // per-agent agents dir. Torn down after the run to restore the shared dir
      // (issue #401), mirroring cleanupWorkflowMcpConfig for the mcp-config.
      const workflowSubagentTargets: string[] = [];
      // WORKFLOW.md `loop:` block (issue #332). When a workflow declares it,
      // `agents run <workflow>` honors the loop without a --loop flag.
      let workflowLoop: import('../lib/workflows.js').LoopConfigRaw | undefined;
      // WORKFLOW.md `for_each:` block (issue #343). When a workflow declares it,
      // `agents run <workflow>` runs the producer, expands one stage teammate per
      // produced item, and drives the teams supervisor to drain — no `teams`
      // subcommands needed.
      let workflowForEach: import('../lib/workflows.js').ForEachSpec | undefined;
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
          profileFallbackModel = resolved.fallbackModel;
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
        workflowForEach = workflowFrontmatter?.forEach;

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
          // Fail-closed prune (issue #401, follow-up to #324). A prior
          // unrestricted run may have left workflow subagent files that THIS
          // scoped run does not permit; they linger in the shared dir and stay
          // dispatchable. Remove those no-longer-permitted workflow-managed
          // files BEFORE writing the allowed set — never a user's own subagent.
          const pruned = pruneStaleWorkflowSubagents(claudeAgentsDir, allFiles, allowedStems);
          if (pruned.length > 0) {
            process.stderr.write(chalk.gray(`[workflow] pruned ${pruned.length} stale workflow subagent(s) from shared dir: ${pruned.join(', ')}\n`));
          }
          let copied = 0;
          let skipped = 0;
          for (const file of allFiles) {
            const stem = file.replace(/\.md$/, '');
            if (!allowStemSet.has(stem)) {
              skipped++;
              continue;
            }
            const dest = path.join(claudeAgentsDir, file);
            fs.copyFileSync(path.join(subagentsDir, file), dest);
            workflowSubagentTargets.push(dest);
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
      // Captured from resolveRunVersion below so mid-run rate-limit failover can
      // synthesize a same-agent fallback chain from the other healthy accounts
      // (issue #348). Stays null unless a non-pinned strategy actually rotated.
      let rotationResult: import('../lib/rotate.js').RotateResult | null = null;
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
              rotationResult = resolved.rotation;
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

      // Self-heal the launch target. A gutted install (JS wrapper present,
      // native binary missing — a partial/raced npm extraction of the optional
      // per-arch dependency) would otherwise spawn and die with a raw ENOENT
      // inside the agent's own wrapper. Repair it in place (or fall back to a
      // runnable version, re-pinning it) BEFORE we build the launch command.
      // Skipped for headless resume-native/acp/loop paths only if it errored;
      // here it runs for every normal dispatch. Best-effort log to stderr.
      {
        const launchTarget = version ?? resolveVersion(agent, cwd) ?? undefined;
        if (launchTarget) {
          const healed = await ensureAgentRunnable(
            agent,
            launchTarget,
            options.quiet ? undefined : (m) => process.stderr.write(chalk.yellow(`[agents] ${m}\n`)),
          );
          if (healed === null) {
            console.error(chalk.red(`agents: ${agent}@${launchTarget} is not runnable and could not be repaired. Try: agents add ${agent}@latest`));
            process.exit(1);
          }
          // Always adopt the healed version explicitly. In the version-undefined
          // path a fallback re-pins the GLOBAL default, but `resolveVersion`
          // prefers a PROJECT pin — so leaving `version` undefined would let the
          // shim re-resolve the still-broken project pin and crash anyway. Pinning
          // the runnable version here is a no-op when nothing changed.
          version = healed;
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

      // Default CLI mode is the generic 'plan'. Agents without a read-only
      // mode (antigravity, cursor, kiro, …) degrade via resolveMode to their
      // safest native mode (modes[0], typically edit). That covers both the
      // implicit default and an explicit `--mode plan`, so multi-agent
      // scripts can pass a uniform plan flag without per-agent branching.
      // Elevation is never silent: we warn on stderr (yellow when the user
      // explicitly asked for plan; gray for the implicit default / auto).
      // `skip` still hard-fails when unsupported — pretending we bypassed
      // permissions would be unsafe.
      const modeIsDefault = modeSource === 'default';
      const requestedMode = normalizeMode(mode);
      let resolvedMode: ReturnType<typeof resolveMode>;
      try {
        resolvedMode = resolveMode(agent, requestedMode);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
      if (resolvedMode !== requestedMode) {
        mode = resolvedMode as ExecMode;
        if (!options.quiet) {
          if (requestedMode === 'plan' && !modeIsDefault) {
            process.stderr.write(
              chalk.yellow(
                `[agents] ${agent} has no read-only 'plan' mode; using '${mode}' (writable) instead. Pass --mode ${mode} to silence this.\n`,
              ),
            );
          } else {
            process.stderr.write(
              chalk.gray(`[agents] ${agent} has no '${requestedMode}' mode; using '${mode}'\n`),
            );
          }
        }
      } else {
        mode = resolvedMode as ExecMode;
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
      const secretsKeysSubset = options.secretsKeys
        ? options.secretsKeys.split(',').map((k: string) => k.trim()).filter(Boolean)
        : undefined;
      let secretsEnv: Record<string, string> = {};
      for (const bundleRef of options.secrets) {
        try {
          const { bundle: bundleName, host } = splitBundleRef(bundleRef);
          if (host) {
            // Least-privilege flags (--secrets-keys / --allow-expired) do not
            // yet cross the SSH resolver — silently applying them would inject
            // the full remote env or an expired key. Fail loud so the user
            // can drop the flag or resolve locally instead.
            assertRemoteBundleFlagsUnsupported(
              bundleName,
              host,
              { keys: secretsKeysSubset, allowExpired: options.allowExpired },
              { keysFlag: '--secrets-keys', allowExpiredFlag: '--allow-expired' },
            );
            // Remote bundle (`bundle@host`): resolve over SSH and inject
            // ephemerally — values never touch this machine's keychain or disk.
            const target = await resolveSshTarget(host);
            const bundleEnv = await remoteResolveEnv(target, bundleName);
            console.log(chalk.gray(`[secrets] Resolved ${bundleName}@${host}: ${Object.keys(bundleEnv).length} keys (remote, ephemeral)`));
            secretsEnv = { ...secretsEnv, ...bundleEnv };
          } else {
            const { bundle, env: bundleEnv } = readAndResolveBundleEnv(bundleName, {
              caller: `agent ${agent}`,
              keys: secretsKeysSubset,
              allowExpired: options.allowExpired,
            });
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
        name: options.name,
        resume: resumeNative,
        verbose: options.verbose,
        // --raw, --no-tmux (commander negation → options.tmux === false), and
        // --disable-tmux all bypass the interactive tmux wrapper. AGENTS_NO_TMUX=1
        // does the same via the env check in exec.ts.
        raw: options.raw || options.tmux === false || options.disableTmux === true,
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

      // Profile-declared same-host model swap (issue #325). Inserted BEFORE any
      // user --fallback entries so a rate limit first tries the cheaper/backup
      // model on the same provider (auth + base URL preserved via envOverride);
      // only if THAT still rate-limits do we cascade to a different agent CLI.
      // Requires a prompt for the same reason --fallback does — headless-only.
      if (fromProfile && profileFallbackModel && prompt !== undefined && !options.interactive) {
        fallback.unshift({
          agent,
          version,
          envOverride: { [profileFallbackModel.envKey]: profileFallbackModel.model },
        });
      }

      // Mid-run rate-limit failover (issue #348). When a pre-flight rotation
      // picked an account and there are OTHER healthy accounts for the same
      // agent, synthesize a same-agent fallback chain from them so a 429 mid-run
      // re-dispatches on the next healthy account via the SAME runWithFallback
      // path (continuing the session via /continue). Because this injects into
      // the same `fallback` array `--fallback` uses, it must only arm for run
      // shapes that accept a fallback chain — shouldArmRotationFailover excludes
      // acp/loop/resume-checkpoint (which reject a non-empty fallback below),
      // interactive/no-prompt runs, and runs that already have an explicit or
      // profile fallback. Pinned/single-account runs stay unchanged because
      // rotationResult is null or rotationFailoverChain returns []. version is
      // set here because rotationResult is only populated when resolveRunVersion
      // picked one.
      if (
        shouldArmRotationFailover({
          hasRotation: !!rotationResult,
          hasVersion: !!version,
          hasPrompt: prompt !== undefined,
          explicitFallback: fallback.length > 0,
          interactive: !!options.interactive,
          acp: !!options.acp,
          loop: !!options.loop,
          resumeCheckpoint: !!options.resumeCheckpoint,
        })
      ) {
        const failover = rotationFailoverChain(rotationResult!, version!);
        if (failover.length > 0) {
          fallback.push(...failover);
          if (!options.quiet) {
            const accounts = failover.map(f => `${f.agent}@${f.version}`).join(', ');
            process.stderr.write(chalk.gray(`[agents] rate-limit failover armed: ${accounts}\n`));
          }
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
          // Governance chokepoint (#347): the --acp path exits here, bypassing
          // the normal finalize below — record its one audit entry.
          recordDispatchedRun({ agent, version: defaultVersion ?? 'unknown', mode, cwd, exitCode });
          // ACP headless run always has a prompt; surface any unpushed commits.
          if (shouldWarnUnpushed(mode, false)) await warnUnpushedWork(cwd);
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

      // Restore the shared per-agent agents dir after the run (issue #401):
      // remove the workflow subagent files THIS run copied in, so a scoped
      // workflow never leaves definitions behind for the next, unrelated run to
      // inherit. Mirrors cleanupWorkflowMcpConfig — tear down only what we made.
      const cleanupWorkflowSubagents = () => {
        for (const target of workflowSubagentTargets) {
          try {
            fs.rmSync(target, { force: true });
          } catch {
            // best-effort: nothing actionable if the file is already gone.
          }
        }
      };

      // for_each dispatch (issue #343). A workflow that declares `for_each:` is a
      // declarative dynamic fan-out, not a single-agent run: execute the producer,
      // expand one stage teammate per produced item (+ optional verify panel),
      // stage them into a team, then drive the supervisor until the DAG drains.
      // This is mutually exclusive with the single-agent loop/fallback paths — the
      // fan-out IS the run.
      if (workflowForEach) {
        cleanupWorkflowMcpConfig();
        cleanupWorkflowSubagents();
        const exitCode = await runWorkflowForEach(workflowForEach, {
          workflowName: rawAgent,
          cwd,
          effort: options.effort,
        });
        process.exit(exitCode);
      }

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
          cleanupWorkflowSubagents();
          process.stderr.write(chalk.gray(`[loop] stopped: ${result.stoppedBy} after ${result.iterations} iteration(s), ${result.tokens} tokens (checkpoint: ${path.join(runDir, 'checkpoint.json')})\n`));
          // Governance chokepoint (#347): the --loop path exits here, bypassing
          // the normal finalize below — record its one audit entry.
          const loopExit = loopExitCode(result.stoppedBy);
          recordDispatchedRun({ agent, version: defaultVersion ?? 'unknown', mode, cwd, exitCode: loopExit });
          // A loop is always headless; surface any commits it left unpushed.
          if (shouldWarnUnpushed(mode, false)) await warnUnpushedWork(cwd);
          process.exit(loopExit);
        } catch (err) {
          cleanupWorkflowMcpConfig();
          cleanupWorkflowSubagents();
          console.error(chalk.red(`Loop failed for ${agent}: ${(err as Error).message}`));
          process.exit(1);
        }
      }

      try {
        let exitCode: number;
        let ranAgent = agent;
        let ranVersion = defaultVersion;
        if (fallback.length > 0) {
          // fallback requires a prompt — enforced above, narrow the type here.
          // The sink reports which chain entry actually executed (may differ from
          // the primary after a rate-limit handoff) so the audit record is honest.
          const sink: { agent?: AgentId; version?: string } = {};
          exitCode = await runWithFallback({ ...execOptions, prompt: prompt!, fallback, dispatchSink: sink });
          ranAgent = sink.agent ?? agent;
          ranVersion = sink.version ?? defaultVersion;
        } else {
          exitCode = await execAgent(execOptions);
        }
        cleanupWorkflowMcpConfig();
        cleanupWorkflowSubagents();
        // Surface committed-but-unpushed work a headless writable run left
        // behind, so it isn't silently stranded in a worktree. Advisory only,
        // never throws; skipped for interactive runs (the human sees the shell)
        // and read-only plan mode (can't commit).
        if (shouldWarnUnpushed(mode, resolveInteractive(execOptions))) {
          await warnUnpushedWork(cwd);
        }
        // Governance chokepoint (#347): every dispatched run finalizes here.
        // ONE tamper-evident audit record per run — non-fatal by contract.
        recordDispatchedRun({ agent: ranAgent, version: ranVersion ?? 'unknown', mode, cwd, exitCode });
        process.exit(exitCode);
      } catch (err) {
        cleanupWorkflowMcpConfig();
        cleanupWorkflowSubagents();
        // An agent that committed then crashed is the case where stranded work
        // matters most — warn before exiting the error path too.
        if (shouldWarnUnpushed(mode, resolveInteractive(execOptions))) {
          await warnUnpushedWork(cwd);
        }
        console.error(chalk.red(`Failed to execute ${agent}: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
