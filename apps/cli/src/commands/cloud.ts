/**
 * Cloud dispatch commands for running agent tasks on remote infrastructure.
 *
 * Provides a unified CLI for dispatching, monitoring, and managing tasks
 * across multiple cloud providers (Rush Cloud, Codex Cloud, Factory/Droid).
 * All tasks are tracked locally in a SQLite database for cross-provider listing.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { die, relTime, truncate, isJsonMode } from '../lib/format.js';
import * as fs from 'fs';
import * as path from 'path';
import ora from 'ora';
import { resolveProvider, getAllProviders, getDefaultProviderId } from '../lib/cloud/registry.js';
import { insertTask, updateTaskStatus, getTaskById, listTasks as listStoredTasks, listActiveTasks } from '../lib/cloud/store.js';
import { renderStream } from '../lib/cloud/stream.js';
import type { CloudProvider, CloudProviderId, CloudTarget, CloudTaskStatus, DispatchOptions, ImageAttachment, SkillRef } from '../lib/cloud/types.js';
import { MissingTargetError, MAX_IMAGES_PER_DISPATCH } from '../lib/cloud/types.js';
import type { JobConfig, JobTrigger } from '../lib/routines.js';
import { normalizeTriggerEvent, validateTrigger, writeJob, jobExists, GITHUB_TRIGGER_EVENTS } from '../lib/routines.js';
import { machineId } from '../lib/machine-id.js';
import { emit } from '../lib/events.js';

/** Map a supported image file extension to its wire mimeType. Rejects anything else. */
function imageMimeFromPath(file: string): ImageAttachment['mimeType'] {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  die(`Unsupported image type ${JSON.stringify(ext || file)}. Use .png, .jpg/.jpeg, or .webp.`);
}

/** Read one image file into a base64 ImageAttachment, dying with a clear error if it's missing. */
function readImageAttachment(file: string): ImageAttachment {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    die(`Image not found: ${file}`);
  }
  const mimeType = imageMimeFromPath(file);
  return { data: fs.readFileSync(file).toString('base64'), mimeType };
}

/** Parse a `--skill <id>` value (`id` or `id@version`) into a SkillRef. */
function parseSkillRef(raw: string): SkillRef {
  const at = raw.lastIndexOf('@');
  if (at > 0) {
    return { id: raw.slice(0, at), version: raw.slice(at + 1) };
  }
  return { id: raw };
}

/** Print an error message to stderr and exit. */
/** Return a chalk color function appropriate for the given task status. */
export function statusColor(status: string): (s: string) => string {
  switch (status) {
    case 'queued':
    case 'allocating': return chalk.blue;
    case 'running': return chalk.yellow;
    case 'idle': return chalk.gray;
    case 'completed': return chalk.green;
    case 'input_required': return chalk.magenta;
    case 'failed': return chalk.red;
    case 'cancelled': return chalk.gray;
    default: return chalk.white;
  }
}


/**
 * After a `MissingTargetError`, try to resolve the target interactively.
 * Returns the chosen id, or undefined when no interactive resolution is
 * possible (non-TTY/JSON, provider can't enumerate, or user cancels) — the
 * caller then prints the error's guidance.
 *
 * Codex has no `listTargets` (no list-environments CLI), so it always returns
 * undefined here and the user sees the `codex cloud` guidance. Factory lists
 * Droid Computers; if listing fails (not signed in) or parses to nothing, we
 * fall back to a free-text prompt so a dispatch is never hard-blocked.
 */
async function pickMissingTarget(
  provider: CloudProvider,
  err: MissingTargetError,
  json: boolean,
): Promise<string | undefined> {
  if (json || !process.stdout.isTTY) return undefined;
  if (!provider.listTargets) return undefined;

  const { select, input } = await import('@inquirer/prompts');
  const promptName = err.kind === 'env' ? 'environment' : 'computer';

  let targets: CloudTarget[];
  try {
    targets = await provider.listTargets();
  } catch (listErr) {
    process.stderr.write(chalk.dim(`Could not list ${promptName}s: ${(listErr as Error).message}\n`));
    targets = [];
  }

  try {
    if (targets.length > 0) {
      return await select({
        message: `Select a ${promptName}`,
        choices: targets.map((t) => ({ value: t.id, name: t.label ? `${t.id}  ${chalk.dim(t.label)}` : t.id })),
      });
    }
    const typed = (await input({ message: `No ${promptName}s found. Enter a ${promptName} name (blank to cancel):` })).trim();
    return typed || undefined;
  } catch {
    // User hit Ctrl-C / Esc on the prompt.
    return undefined;
  }
}

/** Register the `agents cloud` command tree (run, list, status, logs, cancel, message, providers). */
export function registerCloudCommands(program: Command): void {
  const cloud = program
    .command('cloud', { hidden: true })
    .description('Dispatch and manage cloud agent tasks across providers (Rush, Codex, Factory, Antigravity).')
    .addHelpText('after', `
Each agent runs in its own cloud. Pass --agent and the provider is auto-selected
(claude→rush, codex→codex, droid→factory, antigravity→antigravity); --provider overrides.

Providers:
  rush         Rush Cloud — Claude against a GitHub repo + branch → PR
  codex        Codex Cloud — runs in a pre-built Codex environment (--env)
  factory      Factory Droid Computer — droid exec on a cloud VM (--computer)
  antigravity  Gemini Managed Agents — Antigravity harness in a remote sandbox

Examples:
  # Dispatch a quick fix to Rush Cloud and stream the output
  agents cloud run "fix the flaky e2e in apps/web/tests/checkout.spec.ts" --provider rush --repo acme/example --branch main

  # Fire-and-forget (returns the task id, no streaming)
  agents cloud run "bump tailwind to v4 and fix the breaks" --provider rush --repo acme/example --no-follow

  # Multi-repo dispatch: touch both rush and rush-extension in one task
  agents cloud run "rename POST /v1/charge -> /v2/charge across server + extension" --provider rush --repo acme/example --repo acme/example-extension

  # Codex Cloud against a saved environment
  agents cloud run "add pytest fixtures for the new billing module" --provider codex --env env_a1b2c3 --agent codex --timeout 30m

  # Factory pod targeting a specific computer (Droid)
  agents cloud run "QA the new onboarding flow end-to-end" --provider factory --computer linux-vm-1 --agent droid

  # See every cloud task you've dispatched (most recent first)
  agents cloud list

  # Inspect a specific task
  agents cloud status tsk_4f2a91

  # Live-tail logs for a running task
  agents cloud logs tsk_4f2a91

  # Send a follow-up while the task is in needs-review
  agents cloud message tsk_4f2a91 "Looks good — also update the OpenAPI spec"

  # Cancel a runaway task
  agents cloud cancel tsk_4f2a91

  # See which providers are signed in and ready
  agents cloud providers
`);

  // ── agents cloud run ──────────────────────────────────────────────────
  cloud
    .command('run [prompt]')
    .description('Dispatch a task to a cloud agent.')
    .option('--provider <id>', 'Cloud backend: rush, codex, factory, antigravity, host (overrides agent auto-routing)')
    .option('--agent <name>', 'Agent to run: claude, codex, droid, antigravity (auto-routes to its native cloud)')
    .option(
      '--repo <owner/repo>',
      'GitHub repository. Repeatable for multi-repo dispatch (Rush Cloud only).',
      (value: string, previous: string[] | undefined) => {
        const acc = Array.isArray(previous) ? previous : [];
        acc.push(value);
        return acc;
      },
    )
    .option('--branch <name>', 'Target git branch')
    .option(
      '--on <event>',
      'Register this run as an event trigger instead of dispatching now: pull_request (pr), push, issue_comment, workflow_run. Persists a trigger-bound routine.',
    )
    .option('--name <name>', 'Routine name to register under (with --on). Defaults to a generated name.')
    .option('-p, --prompt <text>', 'Inline prompt (alternative to positional argument)')
    .option('--timeout <duration>', 'Kill after duration (e.g., 30m, 2h)')
    .option('--model <model>', 'Model override')
    .option('--env <id>', 'Codex Cloud environment ID')
    .option('--computer <name>', 'Factory/Droid computer target')
    .option('--host <name>', 'One of your machines as the target (a registered host, device, capability tag, or user@host). Implies --provider host.')
    .option('--remote-cwd <dir>', 'Working directory on the host (--provider host only)')
    .option('--any', 'With --host <cap> (a capability tag), pick any matching host instead of erroring when several match')
    .option('--autonomy <level>', 'Factory/Droid autonomy: low, medium, high (default high)')
    .option('--mode <mode>', 'Execution mode (e.g., plan, edit, full)')
    .option(
      '--image <path>',
      `Attach an image (.png/.jpg/.webp) for vision dispatch. Repeatable, up to ${MAX_IMAGES_PER_DISPATCH} (Rush Cloud only).`,
      (value: string, previous: string[] | undefined) => {
        const acc = Array.isArray(previous) ? previous : [];
        acc.push(value);
        return acc;
      },
    )
    .option(
      '--skill <id>',
      'Ride-along skill by id (or id@version). Repeatable (Rush Cloud only).',
      (value: string, previous: string[] | undefined) => {
        const acc = Array.isArray(previous) ? previous : [];
        acc.push(value);
        return acc;
      },
    )
    .option(
      '-b, --balanced',
      'Shortcut for --strategy balanced. Route the factory run across all healthy accounts.',
    )
    .option(
      '--strategy <strategy>',
      'Account selection strategy for the factory: balanced. Sends all healthy accounts so the factory pod rotates between them on rate-limit.',
    )
    .option(
      '--upload-account-tokens',
      'Upload Claude OAuth credentials to Rush Cloud on first dispatch (consent recorded for future runs).',
    )
    .option('--json', 'Structured JSON output')
    .option('--no-follow', 'Dispatch and exit without streaming output')
    .addHelpText('after', `
Examples:
  # Rush Cloud
  agents cloud run "fix the flaky test" --provider rush --repo user/repo
  agents cloud run task.md --provider rush --repo org/project --agent codex

  # Rush Cloud — multi-repo (clones each into /workspace/<owner>/<name>/)
  agents cloud run "refactor shared logger" --provider rush --repo user/rush --repo user/agents

  # Codex Cloud
  agents cloud run "add auth tests" --provider codex --env env_abc123

  # One of your own machines (agents hosts / agents devices), over SSH
  agents cloud run "run the nightly benchmark" --host gpu-box --agent claude
  agents cloud run "rebuild the index" --host gpu --any --remote-cwd ~/proj

  # Default provider (set in ~/.agents/agents.yaml)
  agents cloud run "refactor auth module" --repo user/repo
`)
    .action(async (positionalPrompt: string | undefined, options: Record<string, unknown>) => {
      const json = isJsonMode(options as { json?: boolean });

      // Resolve prompt: --prompt flag, positional arg, or file
      let prompt = (options.prompt as string) || positionalPrompt;
      if (!prompt) die('Prompt is required. Pass it as an argument or with --prompt.');

      // If prompt is a file path, read it and tell the user
      if (fs.existsSync(prompt) && fs.statSync(prompt).isFile()) {
        const filePath = prompt;
        const stat = fs.statSync(filePath);
        const sizeKB = (stat.size / 1024).toFixed(1);
        prompt = fs.readFileSync(filePath, 'utf-8').trim();
        if (process.stderr.isTTY) {
          process.stderr.write(chalk.dim(`Reading prompt from ${filePath} (${sizeKB} KB)\n`));
        }
      }

      // --host names one of YOUR machines as the target — that only means
      // something to the host provider, so it implies --provider host rather
      // than silently riding along to a cloud backend that would ignore it.
      if (options.host && options.provider && options.provider !== 'host') {
        die(`--host targets your own machines (--provider host), not ${options.provider}. Drop --host, or use --provider host.`);
      }
      const explicitProvider = (options.provider as string | undefined) ?? (options.host ? 'host' : undefined);

      // Agent-aware: with no --provider, the agent routes to its native cloud
      // (claude→rush, codex→codex, droid→factory, antigravity→antigravity).
      const provider = resolveProvider(explicitProvider, options.agent as string | undefined);

      // --repo is repeatable: commander gives us an array via our collector.
      // A single --repo value arrives as a one-element array; keep the legacy
      // singular `repo` field in sync so providers that only know that field
      // still dispatch correctly.
      const repoValues = Array.isArray(options.repo)
        ? (options.repo as string[])
        : options.repo
          ? [options.repo as string]
          : [];

      const dispatchOptions: DispatchOptions = {
        prompt,
        agent: options.agent as string | undefined,
        repo: repoValues[0],
        repos: repoValues.length > 0 ? repoValues : undefined,
        branch: options.branch as string | undefined,
        timeout: options.timeout as string | undefined,
        model: options.model as string | undefined,
        providerOptions: {},
      };

      if (options.env) dispatchOptions.providerOptions!.env = options.env as string;
      if (options.computer) dispatchOptions.providerOptions!.computer = options.computer as string;
      if (options.host) dispatchOptions.providerOptions!.host = options.host as string;
      if (options.remoteCwd) dispatchOptions.providerOptions!.remoteCwd = options.remoteCwd as string;
      if (options.any) dispatchOptions.providerOptions!.any = true;
      if (options.autonomy) dispatchOptions.providerOptions!.autonomy = options.autonomy as string;
      if (options.mode) dispatchOptions.providerOptions!.mode = options.mode as string;
      if (options.balanced || (options.strategy as string) === 'balanced') {
        dispatchOptions.providerOptions!.strategy = 'balanced';
      }
      if (options.uploadAccountTokens) dispatchOptions.providerOptions!.uploadAccountTokens = true;

      // --on <event>: register this run as an event trigger instead of
      // dispatching now. We parse + validate the event, attach it to
      // dispatchOptions.trigger, and persist a trigger-bound routine so the
      // local webhook receiver can fire it (src/lib/triggers/webhook.ts).
      // Remote firing of the trigger is a follow-up.
      if (options.on) {
        const event = normalizeTriggerEvent(options.on as string);
        if (!event) {
          die(`Unknown --on event "${options.on}". Use one of: ${GITHUB_TRIGGER_EVENTS.join(', ')} (aliases: pr, comment, workflow).`);
        }
        const trigger: JobTrigger = { type: 'github_event', event: event! };
        if (repoValues[0]) trigger.repo = repoValues[0];
        if (options.branch) trigger.branch = options.branch as string;

        const triggerErrors = validateTrigger(trigger);
        if (triggerErrors.length > 0) die(`Invalid trigger: ${triggerErrors.join(', ')}`);

        dispatchOptions.trigger = trigger;

        const routineName = (options.name as string | undefined)
          || `cloud-${event}-${(repoValues[0] || 'any').replace(/[^a-z0-9]+/gi, '-')}`.toLowerCase();
        if (jobExists(routineName)) {
          die(`A routine named "${routineName}" already exists. Pass --name to register under a different name.`);
        }

        const routine: JobConfig = {
          name: routineName,
          trigger,
          agent: (options.agent as string as JobConfig['agent']) || 'claude',
          mode: 'plan',
          effort: 'auto',
          timeout: (options.timeout as string) || '10m',
          enabled: true,
          prompt,
        };
        if (repoValues[0]) routine.repo = repoValues[0];
        // --host with --on: the webhook-fired run places on that machine (the
        // routine carries the placement, and firing pins to THIS device so a
        // fleet of receivers can't each dispatch a duplicate).
        if (options.host) {
          routine.host = options.host as string;
          if (options.remoteCwd) routine.remoteCwd = options.remoteCwd as string;
          routine.devices = [machineId()];
        }
        writeJob(routine);

        if (json) {
          console.log(JSON.stringify({ ok: true, registered: routineName, trigger }, null, 2));
        } else {
          console.log(chalk.green(`Registered trigger routine "${routineName}"`));
          console.log(`  ${chalk.dim('on:')}    ${event}${trigger.repo ? ` (${trigger.repo}${trigger.branch ? `@${trigger.branch}` : ''})` : ''}`);
          console.log(`  ${chalk.dim('agent:')} ${routine.agent}`);
          console.log(chalk.dim(`\nFires when a matching GitHub webhook is delivered to the local receiver. Remote firing is a follow-up.`));
        }
        return;
      }

      // Vision attachments + ride-along skills. Only wire them when the resolved
      // provider advertises support — otherwise fail loud rather than silently
      // drop the flags the user passed.
      const imagePaths = Array.isArray(options.image) ? (options.image as string[]) : [];
      const skillIds = Array.isArray(options.skill) ? (options.skill as string[]) : [];
      const caps = provider.capabilities();
      if (imagePaths.length > 0) {
        if (!caps.images) die(`${provider.name} does not support image attachments.`);
        if (imagePaths.length > MAX_IMAGES_PER_DISPATCH) {
          die(`Too many images: ${imagePaths.length}. Max is ${MAX_IMAGES_PER_DISPATCH} per dispatch.`);
        }
        dispatchOptions.images = imagePaths.map(readImageAttachment);
      }
      if (skillIds.length > 0) {
        if (!caps.skills) die(`${provider.name} does not support ride-along skills.`);
        dispatchOptions.skills = skillIds.map(parseSkillRef);
      }

      // Dispatch. On a missing pre-provisioned target (Codex env / Factory
      // computer), offer an interactive picker instead of a raw error.
      const dispatchOnce = async () => {
        const spinner = ora({ text: `Dispatching to ${provider.name}...`, stream: process.stderr }).start();
        try {
          const t = await provider.dispatch(dispatchOptions);
          spinner.succeed(`Task ${t.id} dispatched to ${provider.name}`);
          return t;
        } catch (err) {
          spinner.fail('Dispatch failed');
          throw err;
        }
      };

      let task;
      try {
        task = await dispatchOnce();
      } catch (err) {
        if (err instanceof MissingTargetError) {
          const picked = await pickMissingTarget(provider, err, json);
          if (!picked) {
            die(err.guidance ? `${err.message}\n\n${err.guidance}` : err.message);
          }
          dispatchOptions.providerOptions![err.kind] = picked;
          try {
            task = await dispatchOnce();
          } catch (err2) {
            die((err2 as Error).message);
          }
        } else {
          die((err as Error).message);
        }
      }

      // Persist locally
      insertTask(task);
      emit('cloud.dispatch', { module: 'cloud', taskId: task.id, agent: task.agent, provider: task.provider, status: task.status });

      if (json) {
        process.stdout.write(JSON.stringify(task) + '\n');
      }

      // Stream output unless --no-follow
      if (options.follow === false) return;

      try {
        // Live budget kill-switch (issue #399). Reuses makeLiveSpendWatcher to
        // feed the provider's `usage` events into a shared watcher; on a cap
        // breach we call provider.cancel(task.id) mid-stream. Dormant (returns
        // null) when no caps are configured, so the raw stream flows unchanged.
        const { wrapStreamWithBudgetGate } = await import('../lib/budget/live-cloud.js');
        const gated = wrapStreamWithBudgetGate({
          provider,
          taskId: task.id,
          project: task.repo ?? task.repos?.[0] ?? process.cwd(),
          agent: task.agent ?? 'cloud',
          cwd: process.cwd(),
        });
        const eventSource = gated ? gated.wrap(provider.stream(task.id)) : provider.stream(task.id);
        const result = await renderStream(eventSource, { json });
        updateTaskStatus(task.id, result.status as CloudTaskStatus, {
          summary: result.summary,
          prUrl: result.prUrl,
        });
        emit('cloud.complete', { module: 'cloud', taskId: task.id, status: result.status, prUrl: result.prUrl });
        if (gated?.gate.breached()) {
          const b = gated.gate.breach();
          process.stderr.write(
            `[budget] cap ${b?.cap} exceeded — cancelled cloud task ${task.id}\n`,
          );
          process.exitCode = 7; // Mirrors BUDGET_KILL_EXIT_CODE for CI/headless.
        }
      } catch (err) {
        // Stream disconnect is OK — task keeps running
        process.stderr.write(chalk.dim(`\nStream disconnected. Task ${task.id} continues running.\n`));
        process.stderr.write(chalk.dim(`Check status: agents cloud status ${task.id}\n`));
      }
    });

  // ── agents cloud list ─────────────────────────────────────────────────
  cloud
    .command('list')
    .description('List cloud tasks.')
    .option('--provider <id>', 'Filter by provider')
    .option('--status <status>', 'Filter by status')
    .option('--limit <n>', 'Max results', '20')
    .option('--json', 'JSON output')
    .action(async (options: Record<string, unknown>) => {
      const json = isJsonMode(options as { json?: boolean });
      const providerId = options.provider as CloudProviderId | undefined;
      const status = options.status as CloudTaskStatus | undefined;
      const limit = parseInt(options.limit as string, 10) || 20;

      // Auto-refresh tasks still in transient states (queued, allocating, running, input_required).
      // Groups by provider to minimise resolver calls, refreshes each via provider.status().
      const activeTasks = listActiveTasks();
      if (activeTasks.length > 0) {
        const byProvider = new Map<CloudProviderId, string[]>();
        for (const t of activeTasks) {
          if (providerId && t.provider !== providerId) continue;
          let ids = byProvider.get(t.provider);
          if (!ids) { ids = []; byProvider.set(t.provider, ids); }
          ids.push(t.id);
        }

        const refreshJobs: Promise<void>[] = [];
        for (const [pid, ids] of byProvider) {
          try {
            const provider = resolveProvider(pid);
            for (const id of ids) {
              refreshJobs.push(
                provider.status(id)
                  .then((fresh) => { insertTask(fresh); })
                  .catch(() => {}),  // stale cache is acceptable if API is down
              );
            }
          } catch {
            // provider not configured — skip
          }
        }

        if (refreshJobs.length > 0) {
          await Promise.allSettled(refreshJobs);
        }
      }

      const tasks = listStoredTasks({ provider: providerId, status, limit });

      if (json) {
        process.stdout.write(JSON.stringify(tasks, null, 2) + '\n');
        return;
      }

      if (tasks.length === 0) {
        console.log(chalk.dim('No cloud tasks found.'));
        return;
      }

      // Table header
      const header = [
        chalk.dim('ID'.padEnd(14)),
        chalk.dim('Provider'.padEnd(10)),
        chalk.dim('Status'.padEnd(16)),
        chalk.dim('Agent'.padEnd(8)),
        chalk.dim('Prompt'.padEnd(40)),
        chalk.dim('When'),
      ].join('  ');
      console.log(header);
      console.log(chalk.dim('-'.repeat(100)));

      for (const t of tasks) {
        const row = [
          t.id.slice(0, 12).padEnd(14),
          t.provider.padEnd(10),
          statusColor(t.status)(t.status.padEnd(16)),
          (t.agent ?? '-').padEnd(8),
          truncate(t.prompt.replace(/\n/g, ' '), 40).padEnd(40),
          chalk.dim(relTime(t.createdAt)),
        ].join('  ');
        console.log(row);
      }
    });

  // ── agents cloud status ───────────────────────────────────────────────
  cloud
    .command('status <id>')
    .description('Show task detail and latest status.')
    .option('--json', 'JSON output')
    .action(async (id: string, options: Record<string, unknown>) => {
      const json = isJsonMode(options as { json?: boolean });

      // Try local first, then remote
      let task = getTaskById(id);
      const providerId = task?.provider;

      if (providerId) {
        try {
          const provider = resolveProvider(providerId);
          task = await provider.status(id);
          insertTask(task);
        } catch {
          // Fall back to local cache
        }
      }

      if (!task) die(`Task ${id} not found.`);

      if (json) {
        process.stdout.write(JSON.stringify(task, null, 2) + '\n');
        return;
      }

      console.log(`${chalk.bold('Task')} ${task.id}`);
      console.log(`  ${chalk.dim('Provider:')}  ${task.provider}`);
      console.log(`  ${chalk.dim('Status:')}    ${statusColor(task.status)(task.status)}`);
      if (task.agent) console.log(`  ${chalk.dim('Agent:')}     ${task.agent}`);
      if (task.repo) console.log(`  ${chalk.dim('Repo:')}      ${task.repo}`);
      if (task.branch) console.log(`  ${chalk.dim('Branch:')}    ${task.branch}`);
      if (task.prUrl) console.log(`  ${chalk.dim('PR:')}        ${task.prUrl}`);
      console.log(`  ${chalk.dim('Prompt:')}    ${truncate(task.prompt.replace(/\n/g, ' '), 80)}`);
      console.log(`  ${chalk.dim('Created:')}   ${relTime(task.createdAt)}`);
      if (task.summary) {
        console.log(`  ${chalk.dim('Summary:')}   ${truncate(task.summary.replace(/\n/g, ' '), 120)}`);
      }
    });

  // ── agents cloud logs ─────────────────────────────────────────────────
  cloud
    .command('logs <id>')
    .description('Stream live output from a cloud task.')
    .option('-f, --follow', 'Follow output (default for running tasks)', true)
    .option('--json', 'JSON event stream')
    .action(async (id: string, options: Record<string, unknown>) => {
      const json = isJsonMode(options as { json?: boolean });

      const task = getTaskById(id);
      if (!task) die(`Task ${id} not found locally. Run 'agents cloud list' first.`);

      const provider = resolveProvider(task.provider);

      try {
        // Live budget kill-switch (issue #399) — wrap the stream so a cap
        // breach mid-stream cancels the task server-side. Dormant when no caps.
        const { wrapStreamWithBudgetGate } = await import('../lib/budget/live-cloud.js');
        const gated = wrapStreamWithBudgetGate({
          provider,
          taskId: id,
          project: task.repo ?? task.repos?.[0] ?? process.cwd(),
          agent: task.agent ?? 'cloud',
          cwd: process.cwd(),
        });
        const eventSource = gated ? gated.wrap(provider.stream(id)) : provider.stream(id);
        const result = await renderStream(eventSource, { json });
        updateTaskStatus(id, result.status as CloudTaskStatus, {
          summary: result.summary,
          prUrl: result.prUrl,
        });
        emit('cloud.complete', { module: 'cloud', taskId: id, status: result.status, prUrl: result.prUrl });
        if (gated?.gate.breached()) {
          process.exitCode = 7;
        }
      } catch (err) {
        process.stderr.write(chalk.dim(`\nStream ended. ${(err as Error).message}\n`));
      }
    });

  // ── agents cloud cancel ───────────────────────────────────────────────
  cloud
    .command('cancel <id>')
    .description('Cancel a running cloud task.')
    .action(async (id: string) => {
      const task = getTaskById(id);
      if (!task) die(`Task ${id} not found.`);

      const provider = resolveProvider(task.provider);

      try {
        await provider.cancel(id);
        updateTaskStatus(id, 'cancelled');
        emit('cloud.cancel', { module: 'cloud', taskId: id, provider: task.provider });
        console.log(chalk.green(`Task ${id} cancelled.`));
      } catch (err) {
        die((err as Error).message);
      }
    });

  // ── agents cloud message ──────────────────────────────────────────────
  cloud
    .command('message <id> <text>')
    .description('Send a follow-up message to a finished or needs-review task.')
    .action(async (id: string, text: string) => {
      const task = getTaskById(id);
      if (!task) die(`Task ${id} not found.`);

      const provider = resolveProvider(task.provider);

      try {
        await provider.message(id, text);
        updateTaskStatus(id, 'running');
        emit('cloud.message', { module: 'cloud', taskId: id });
        console.log(chalk.green(`Message sent to task ${id}. Agent is continuing.`));
      } catch (err) {
        die((err as Error).message);
      }
    });

  // ── agents cloud providers ────────────────────────────────────────────
  cloud
    .command('providers')
    .description('List available cloud providers and their status.')
    .option('--json', 'JSON output')
    .action((options: Record<string, unknown>) => {
      const json = isJsonMode(options as { json?: boolean });
      const providers = getAllProviders();
      const defaultId = getDefaultProviderId();

      if (json) {
        const data = providers.map((p) => ({
          id: p.id,
          name: p.name,
          available: p.capabilities().available,
          default: p.id === defaultId,
        }));
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      console.log(chalk.bold('Cloud Providers\n'));
      for (const p of providers) {
        const available = p.capabilities().available;
        const isDefault = p.id === defaultId;
        const status = available ? chalk.green('ready') : chalk.dim('not configured');
        const defaultTag = isDefault ? chalk.cyan(' (default)') : '';
        console.log(`  ${p.id.padEnd(12)} ${p.name.padEnd(20)} ${status}${defaultTag}`);
      }
    });

  // ── agents cloud envs ─────────────────────────────────────────────────
  // Discover the pre-provisioned targets a provider runs inside — Codex
  // environments, Factory Droid Computers — so users don't copy opaque IDs
  // out of a web UI.
  cloud
    .command('envs')
    .alias('targets')
    .description('List the pre-provisioned targets (Codex environments / Droid Computers) you can dispatch into.')
    .option('--provider <id>', 'Only this provider (codex, factory, ...)')
    .option('--json', 'JSON output')
    .action(async (options: Record<string, unknown>) => {
      const json = isJsonMode(options as { json?: boolean });
      const only = options.provider as CloudProviderId | undefined;

      // Providers that run inside a pre-provisioned target declare targetKind.
      const providers = getAllProviders().filter((p) => p.targetKind && (!only || p.id === only));
      if (only && providers.length === 0) {
        die(`Provider '${only}' has no pre-provisioned targets (or is unknown). Targets apply to: codex, factory.`);
      }

      const results: Array<{ provider: CloudProviderId; kind: string; targets: { id: string; label?: string }[]; note?: string }> = [];
      for (const p of providers) {
        const kind = p.targetKind!;
        if (!p.listTargets) {
          // Not enumerable (Codex). Surface guidance instead of a list.
          const guidance = kind === 'env'
            ? 'Codex environments are not listable from the CLI. Browse/create them with `codex cloud` (interactive), then use --env <id>.'
            : 'Not enumerable from the CLI.';
          results.push({ provider: p.id, kind, targets: [], note: guidance });
          continue;
        }
        try {
          const targets = await p.listTargets();
          results.push({ provider: p.id, kind, targets: targets.map((t) => ({ id: t.id, label: t.label })) });
        } catch (err) {
          results.push({ provider: p.id, kind, targets: [], note: (err as Error).message });
        }
      }

      if (json) {
        process.stdout.write(JSON.stringify(results, null, 2) + '\n');
        return;
      }

      for (const r of results) {
        console.log(chalk.bold(`\n${r.provider}`) + chalk.dim(` (${r.kind})`));
        if (r.targets.length > 0) {
          for (const t of r.targets) {
            console.log(`  ${t.id}${t.label ? '  ' + chalk.dim(t.label) : ''}`);
          }
        } else {
          console.log(chalk.dim(`  ${r.note ?? 'none'}`));
        }
      }
    });
}
