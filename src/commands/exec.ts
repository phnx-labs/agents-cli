/**
 * Agent execution command.
 *
 * Registers the `agents run` command which spawns agent CLIs interactively
 * or headlessly. Supports profile resolution, version rotation, secrets
 * injection, and multi-agent fallback chains for rate-limit resilience.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  buildExecCommand,
  parseExecEnv,
  execAgent,
  runWithFallback,
  AGENT_COMMANDS,
  type ExecOptions,
  type ExecMode,
  type ExecEffort,
  type FallbackEntry,
} from '../lib/exec.js';
import type { AgentId } from '../lib/types.js';
import { profileExists, resolveProfileForRun } from '../lib/profiles.js';
import { getInstalledSubagent, installSubagentToAgent } from '../lib/subagents.js';
import { readBundle, resolveBundleEnv, describeBundle } from '../lib/secrets/bundles.js';
import {
  getConfiguredRunStrategy,
  normalizeRunStrategy,
  resolveRunVersion,
  RUN_STRATEGIES,
  type RotateResult,
} from '../lib/rotate.js';
import { getGlobalDefault, getVersionHomePath, resolveVersion, resolveVersionAlias } from '../lib/versions.js';
import * as fs from 'fs';
import * as path from 'path';

const VALID_AGENTS = Object.keys(AGENT_COMMANDS);

interface ExecCommandActionOptions {
  mode: ExecMode;
  effort: ExecEffort;
  model?: string;
  cwd?: string;
  addDir: string[];
  env: string[];
  secrets: string[];
  json?: boolean;
  headless?: boolean;
  interactive?: boolean;
  sessionId?: string;
  verbose?: boolean;
  timeout?: string;
  fallback?: string;
  balanced?: boolean;
  strategy?: string;
  acp?: boolean;
}

/** Type guard that narrows a string to a known AgentId. */
function isValidAgent(agent: string): agent is AgentId {
  return VALID_AGENTS.includes(agent);
}

/** Build a one-line banner describing which version the strategy picked. */
function formatRotationBanner(result: RotateResult, verb: string = 'balanced'): string {
  const { picked, healthy, excluded } = result;
  const label = picked.email ? `${picked.email} · ${picked.agent}@${picked.version}` : `${picked.agent}@${picked.version}`;
  const ratio = `${healthy.length} of ${healthy.length + excluded.length} healthy`;
  return `[agents] ${verb} picked ${label} (${ratio})`;
}

/** Register the `agents run <agent> [prompt]` command. */
export function registerRunCommand(program: Command): void {
  program
    .command('run <agent> [prompt]')
    .description('Execute an agent. Pass a prompt for headless runs; omit it to launch the agent interactively.')
    .option('-m, --mode <mode>', 'How much the agent can do: plan (read-only), edit (can write files), full (writes + all permissions)', 'plan')
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
    .option('--cwd <dir>', 'Working directory for the agent (defaults to current directory)')
    .option(
      '--add-dir <dir>',
      'Grant access to an additional directory outside the project (Claude only, repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      []
    )
    .option('--json', 'Stream events as JSON lines (for parsing by other tools)')
    .option('--headless', 'Non-interactive mode (auto-enabled when prompt provided)', false)
    .option('-i, --interactive', 'Force interactive mode even when a prompt is provided')
    .option('--session-id <id>', 'Resume a previous conversation (Claude only)')
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
    .addHelpText('after', `
Modes:
  With a prompt -> headless (pipes output, no TTY, exits when the agent finishes).
  Without a prompt -> interactive (launches the agent's TUI; stdio is fully inherited).

Run strategy:
  pinned     Use the workspace/global pinned version from agents.yaml.
  available  Use the pinned version if it has usage available; otherwise switch
             to another signed-in version with usage available.
  balanced   Distribute traffic across healthy accounts using weighted random
             by remaining capacity — fresher accounts get more, near-exhausted
             ones get less. Avoids bursting any single account.
  Configure with run.<agent>.strategy in agents.yaml, or override with
  --strategy. --balanced is kept as a shortcut for --strategy balanced.
  Legacy "rotate" is accepted as an alias for "balanced".
  Ignored when @version is pinned, when a profile is used, or with --fallback.

Examples:
  # Interactive with the pinned default version
  agents run claude

  # Interactive, distribute load across healthy accounts
  agents run claude --strategy balanced

  # Headless, switch away from the pinned version when usage is unavailable
  agents run claude "summarize recent git commits" --mode plan --strategy available

  # Pin a specific version (rotation ignored)
  agents run codex@0.116.0 "fix linting errors in src/" --mode edit

  # Full autonomy with maximum reasoning for a complex task
  agents run claude "refactor auth to use JWT" --mode full --effort max

  # Resume a previous conversation to continue work
  agents run claude "now add rate limiting" --session-id a1b2c3d4 --mode edit

  # Automated cron job: generate daily report with 10-minute timeout
  agents run claude "generate sales report for yesterday" --mode plan --timeout 10m --json > report.jsonl

  # Auto-fallback to codex then gemini if claude hits a rate limit
  agents run claude "refactor auth module" --mode edit --fallback codex,gemini

  # Inject a named secrets bundle (keychain-backed)
  agents run claude "charge a test card" --secrets prod-stripe

  # Pin fallback versions: primary claude@2.0.65, fallback codex@0.116.0 then gemini
  agents run claude@2.0.65 "deep refactor" --fallback codex@0.116.0,gemini
`)
    .action(async (agentSpec: string, prompt: string | undefined, options: ExecCommandActionOptions) => {
      // Parse agent@version
      const [rawAgent, rawVersion] = agentSpec.split('@');
      let agent: AgentId;
      let version: string | undefined = rawVersion || undefined;
      let profileEnv: Record<string, string> | undefined;
      let fromProfile = false;

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
      } else if (getInstalledSubagent(rawAgent)) {
        // Workflow: a named subagent directory with AGENT.md acts as an
        // orchestrator. Co-located subagents/ subdirectories are wired into
        // ~/.claude/agents/ so Claude's Agent tool can discover them.
        const workflow = getInstalledSubagent(rawAgent)!;
        agent = 'claude';

        // Resolve the version we'll actually run so we wire subagents into
        // the right version home.
        const resolvedVersion = resolveVersionAlias('claude', version);
        const versionHome = getVersionHomePath('claude', resolvedVersion ?? getGlobalDefault('claude') ?? '');

        // Install nested subagents into the claude version home.
        const subSubagentsDir = path.join(workflow.path, 'subagents');
        if (fs.existsSync(subSubagentsDir)) {
          for (const entry of fs.readdirSync(subSubagentsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const subPath = path.join(subSubagentsDir, entry.name);
            if (!fs.existsSync(path.join(subPath, 'AGENT.md'))) continue;
            installSubagentToAgent(subPath, entry.name, 'claude', versionHome);
          }
        }

        // Prepend the orchestrator's instructions to the user prompt so Claude
        // runs in its workflow role from the first turn.
        const orchestratorBody = workflow.files
          .filter(f => f === 'AGENT.md')
          .map(f => fs.readFileSync(path.join(workflow.path, f), 'utf-8').replace(/^---[\s\S]*?---\n/, '').trim())
          [0] ?? '';
        if (orchestratorBody && prompt !== undefined) {
          prompt = `${orchestratorBody}\n\n---\n\n${prompt}`;
        }

        process.stderr.write(chalk.gray(`Workflow '${rawAgent}' → claude (${workflow.files.length} files)\n`));
      } else {
        console.error(chalk.red(`Unknown agent: ${rawAgent}`));
        console.error(chalk.gray(`Available agents: ${VALID_AGENTS.join(', ')}`));
        console.error(chalk.gray(`Or add a profile: agents profiles add <name>`));
        process.exit(1);
      }

      version = resolveVersionAlias(agent, version);

      const cwd = options.cwd ?? process.cwd();
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
              if (resolved.rotation) {
                const banner = formatRotationBanner(resolved.rotation, strategy);
                process.stderr.write(chalk.gray(banner + '\n'));
              }
            } else {
              process.stderr.write(chalk.yellow(`[agents] strategy ${strategy} found no usable ${agent} version; falling back to defaults\n`));
            }
          } catch (err) {
            process.stderr.write(chalk.yellow(`[agents] strategy ${strategy} skipped: ${(err as Error).message}\n`));
          }
        }
      }

      const mode = options.mode as ExecMode;
      if (!['plan', 'edit', 'full'].includes(mode)) {
        console.error(chalk.red(`Invalid mode: ${mode}. Use 'plan', 'edit', or 'full'`));
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
      for (const bundleName of options.secrets) {
        try {
          const bundle = readBundle(bundleName);
          const entries = describeBundle(bundle);
          const counts: Record<string, number> = {};
          for (const e of entries) {
            counts[e.kind] = (counts[e.kind] || 0) + 1;
          }
          const breakdown = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
          console.log(chalk.gray(`[secrets] Resolved ${bundleName}: ${entries.length} keys (${breakdown})`));
          secretsEnv = { ...secretsEnv, ...resolveBundleEnv(bundle) };
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

      const execOptions: ExecOptions = {
        agent,
        version,
        prompt,
        interactive: options.interactive,
        mode,
        effort,
        cwd: options.cwd,
        model: options.model,
        addDirs: options.addDir,
        json: options.json,
        headless: options.headless ?? true,
        sessionId: options.sessionId,
        verbose: options.verbose,
        timeout: options.timeout,
        env,
      };

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
        for (const entry of entries) {
          const [fbAgent, fbVersion] = entry.split('@');
          if (!isValidAgent(fbAgent)) {
            console.error(chalk.red(`Unknown fallback agent: ${fbAgent}`));
            console.error(chalk.gray(`Available: ${VALID_AGENTS.join(', ')}`));
            process.exit(1);
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

      const cmd = buildExecCommand(execOptions);
      process.stderr.write(chalk.gray(`Running: ${cmd.join(' ')}\n\n`));

      try {
        let exitCode: number;
        if (fallback.length > 0) {
          // fallback requires a prompt — enforced above, narrow the type here.
          exitCode = await runWithFallback({ ...execOptions, prompt: prompt!, fallback });
        } else {
          exitCode = await execAgent(execOptions);
        }
        process.exit(exitCode);
      } catch (err) {
        console.error(chalk.red(`Failed to execute ${agent}: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
