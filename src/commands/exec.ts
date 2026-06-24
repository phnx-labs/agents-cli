/**
 * Agent execution command.
 *
 * Registers the `agents run` command which spawns agent CLIs interactively
 * or headlessly. Supports profile resolution, version rotation, secrets
 * injection, and multi-agent fallback chains for rate-limit resilience.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import type { ExecOptions, ExecMode, ExecEffort, FallbackEntry } from '../lib/exec.js';
import type { AgentId } from '../lib/types.js';
import type { ResolvedRunDefaults } from '../lib/run-defaults.js';
import { setHelpSections } from '../lib/help.js';
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
  return agent in AGENTS;
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
    );

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

      Resume: --session-id <id> continues a prior Claude conversation.
    `,
  });

  runCmd.action(async (agentSpec: string, prompt: string | undefined, options: ExecCommandActionOptions) => {
      const [
        { buildExecCommand, parseExecEnv, execAgent, runWithFallback, normalizeMode, resolveMode, defaultModeFor, headlessPlanStallCommand },
        { ALL_AGENT_IDS },
        { profileExists, resolveProfileForRun },
        { readAndResolveBundleEnv, describeBundle },
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
      for (const bundleName of options.secrets) {
        try {
          const { bundle, env: bundleEnv } = readAndResolveBundleEnv(bundleName, { caller: `agent ${agent}` });
          const entries = describeBundle(bundle);
          const counts: Record<string, number> = {};
          for (const e of entries) {
            counts[e.kind] = (counts[e.kind] || 0) + 1;
          }
          const breakdown = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
          console.log(chalk.gray(`[secrets] Resolved ${bundleName}: ${entries.length} keys (${breakdown})`));
          secretsEnv = { ...secretsEnv, ...bundleEnv };
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
        interactive: options.interactive,
        mode,
        effort,
        cwd: options.cwd,
        model,
        addDirs: options.addDir,
        json: options.json,
        headless: options.headless,
        sessionId: options.sessionId,
        verbose: options.verbose,
        timeout: options.timeout,
        env,
        toolsRestrict: workflowToolsRestrict,
        mcpConfigPath: workflowMcpConfigPath,
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
