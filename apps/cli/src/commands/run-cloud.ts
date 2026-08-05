/**
 * `agents run <agent> [prompt] --cloud` — the vendor-cloud placement for a run.
 *
 * One of three run placements: local (default), machine (--host/--device,
 * --lease), cloud (--cloud). Routing goes through the cloud provider registry
 * exactly like `agents cloud run --agent <agent>`: the agent's native
 * `cloudProvider` wins, `--provider` overrides. The dispatch itself is the
 * shared core in lib/cloud/dispatch.ts — this module only validates the run
 * surface and translates run flags into a DispatchOptions.
 */
import chalk from 'chalk';
import type { Command } from 'commander';
import { AGENTS, resolveAgentName, isAgentHardDeprecated, hardDeprecationError } from '../lib/agents.js';
import { RUN_AUTO_KEYWORD } from '../lib/types.js';
import { resolveProvider, nativeProviderForAgent } from '../lib/cloud/registry.js';
import type { CloudProvider } from '../lib/cloud/types.js';
import type { DispatchOptions } from '../lib/cloud/types.js';
import { resolveCloudPrompt, executeCloudDispatch } from '../lib/cloud/dispatch.js';

/** Error type for run --cloud validation failures (exit 1, red message). */
export class RunCloudError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunCloudError';
  }
}

/**
 * Run flags that are meaningless on a cloud placement. Each entry maps the
 * option field to the flag the user typed. Cloud tasks run in the provider's
 * workspace on the provider's accounts, so local-run knobs (account strategy,
 * secrets injection, loop guards, resume, terminal handoff, cwd) have nothing
 * to act on — passing one is an error, never a silent ignore.
 */
const RUN_CLOUD_CONFLICTS: Array<{ field: string; flag: string; set: (v: unknown) => boolean }> = [
  { field: 'terminal', flag: '--terminal', set: (v) => v !== undefined && v !== false },
  { field: 'interactive', flag: '--interactive', set: (v) => v === true },
  { field: 'acp', flag: '--acp', set: (v) => v === true },
  { field: 'loop', flag: '--loop', set: (v) => v === true },
  { field: 'resumeCheckpoint', flag: '--resume-checkpoint', set: (v) => v !== undefined },
  { field: 'maxIterations', flag: '--max-iterations', set: (v) => v !== undefined },
  { field: 'budget', flag: '--budget', set: (v) => v !== undefined },
  { field: 'until', flag: '--until', set: (v) => v !== undefined },
  { field: 'interval', flag: '--interval', set: (v) => v !== undefined },
  { field: 'resume', flag: '--resume', set: (v) => v !== undefined && v !== false },
  { field: 'sessionId', flag: '--session-id', set: (v) => v !== undefined },
  { field: 'secrets', flag: '--secrets', set: (v) => Array.isArray(v) && (v as string[]).length > 0 },
  { field: 'secretsKeys', flag: '--secrets-keys', set: (v) => v !== undefined },
  { field: 'allowExpired', flag: '--allow-expired', set: (v) => v === true },
  { field: 'autoSecrets', flag: '--no-auto-secrets', set: (v) => v === false },
  { field: 'copyCreds', flag: '--copy-creds', set: (v) => v === true },
  { field: 'fallback', flag: '--fallback', set: (v) => v !== undefined },
  { field: 'strategy', flag: '--strategy', set: (v) => v !== undefined },
  { field: 'balanced', flag: '--balanced', set: (v) => v === true },
  { field: 'cwd', flag: '--cwd', set: (v) => v !== undefined },
  { field: 'project', flag: '--project', set: (v) => v !== undefined },
  { field: 'addDir', flag: '--add-dir', set: (v) => Array.isArray(v) && (v as string[]).length > 0 },
  { field: 'remoteCwd', flag: '--remote-cwd', set: (v) => v !== undefined },
  { field: 'env', flag: '--env', set: (v) => Array.isArray(v) && (v as string[]).length > 0 },
  { field: 'notify', flag: '--notify', set: (v) => v === true },
];

/** Flags that refine a cloud dispatch; meaningless without the placement. */
const CLOUD_ONLY_FLAGS: Array<{ field: string; flag: string; set: (v: unknown) => boolean }> = [
  { field: 'provider', flag: '--provider', set: (v) => v !== undefined },
  { field: 'repo', flag: '--repo', set: (v) => Array.isArray(v) && (v as string[]).length > 0 },
  { field: 'branch', flag: '--branch', set: (v) => v !== undefined },
  { field: 'cloudEnv', flag: '--cloud-env', set: (v) => v !== undefined },
];

/** Flags the user passed that cannot ride a cloud placement. */
export function runCloudConflicts(options: Record<string, unknown>): string[] {
  return RUN_CLOUD_CONFLICTS.filter((c) => c.set(options[c.field])).map((c) => c.flag);
}

/** Cloud-only flags passed without the --cloud placement. */
export function cloudFlagsWithoutCloud(options: Record<string, unknown>): string[] {
  return CLOUD_ONLY_FLAGS.filter((c) => c.set(options[c.field])).map((c) => c.flag);
}

/** Agents that route to a native cloud provider (the registry's truth). */
export function cloudCapableAgentIds(): string[] {
  return Object.values(AGENTS)
    .filter((a) => a.cloudProvider)
    .map((a) => a.id)
    .sort();
}

/**
 * Resolve the cloud provider for a run: explicit --provider wins, else the
 * agent's native cloud. An agent with no native cloud fails loud with the
 * capable list — never a silent ride onto the configured default.
 */
export function resolveRunCloudProvider(agentId: string, explicitProvider?: string): CloudProvider {
  if (explicitProvider) return resolveProvider(explicitProvider);
  if (!nativeProviderForAgent(agentId)) {
    throw new RunCloudError(
      `${agentId} has no native cloud. Cloud-capable agents: ${cloudCapableAgentIds().join(', ')}. ` +
        `Override with --provider <id> (rush | codex | factory | antigravity | host).`,
    );
  }
  return resolveProvider(undefined, agentId);
}

/** Validate the agent half of `agents run <agent> --cloud` and return the registry id. */
export function resolveRunCloudAgent(agentSpec: string): string {
  if (agentSpec === RUN_AUTO_KEYWORD || agentSpec.startsWith(`${RUN_AUTO_KEYWORD}@`)) {
    throw new RunCloudError(
      `agents run auto --cloud: auto harness-pick is a local-run feature. ` +
        `Name a cloud-capable agent: ${cloudCapableAgentIds().join(', ')}.`,
    );
  }
  if (agentSpec.includes('@')) {
    throw new RunCloudError(
      `Version pins (<agent>@<version>) do not apply to --cloud — the provider runs its own agent version. ` +
        `Drop the pin: agents run ${agentSpec.split('@')[0]} "<task>" --cloud.`,
    );
  }
  const agentId = resolveAgentName(agentSpec);
  if (!agentId) {
    throw new RunCloudError(`Unknown agent: ${agentSpec}. Cloud-capable agents: ${cloudCapableAgentIds().join(', ')}.`);
  }
  if (isAgentHardDeprecated(agentId)) {
    throw new RunCloudError(hardDeprecationError(agentId));
  }
  return agentId;
}

/**
 * Handle `agents run <agent> [prompt] --cloud`. Validation lives in the
 * exported helpers above (unit-tested); this wires them to the shared
 * dispatch core and dies on any validation failure.
 */
export async function handleRunCloud(
  agentSpec: string,
  prompt: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const json = options.json === true;
  try {
    const agentId = resolveRunCloudAgent(agentSpec);
    const provider = resolveRunCloudProvider(agentId, options.provider as string | undefined);
    const resolvedPrompt = resolveCloudPrompt(prompt, {
      json,
      hint: `agents run ${agentId} "<task>" --cloud${agentId === 'claude' ? ' --repo <owner/repo>' : ''}`,
    });

    const repoValues = Array.isArray(options.repo) ? (options.repo as string[]) : [];
    const dispatchOptions: DispatchOptions = {
      prompt: resolvedPrompt,
      agent: agentId,
      repo: repoValues[0],
      repos: repoValues.length > 0 ? repoValues : undefined,
      branch: options.branch as string | undefined,
      timeout: options.timeout as string | undefined,
      model: options.model as string | undefined,
      providerOptions: {},
    };
    if (options.cloudEnv) dispatchOptions.providerOptions!.env = options.cloudEnv as string;
    // --mode defaults to 'plan' on run; forward it only when the user set it.
    if (command.getOptionValueSource('mode') === 'cli') {
      dispatchOptions.providerOptions!.mode = options.mode as string;
    }

    await executeCloudDispatch({
      provider,
      dispatchOptions,
      follow: options.follow !== false,
      json,
    });
  } catch (err) {
    if (err instanceof RunCloudError) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
    throw err;
  }
}
