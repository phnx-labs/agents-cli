/**
 * Scheduled routines management.
 *
 * Registers the `agents routines` command tree for creating, editing,
 * running, pausing, and removing cron-scheduled agent invocations.
 * Also exposes scheduler lifecycle controls (start/stop/status/logs).
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

import {
  isDaemonRunning,
  isDaemonWedged,
  signalDaemonReload,
  startDaemon,
  stopDaemon,
  readDaemonPid,
  readDaemonLog,
  getDaemonStatus,
} from '../lib/daemon.js';
import { humanizeCron, humanizeNextRun, formatRepoLink, REPO_DISPLAY_MAX } from '../lib/routines-format.js';
import {
  listJobs as listAllJobs,
  deleteJob,
  readJob,
  validateJob,
  writeJob,
  setJobEnabled,
  listRuns,
  getLatestRun,
  getRunDir,
  getJobPath,
  parseAtTime,
  jobRunsOnThisDevice,
  checkJobDeviceEligibility,
} from '../lib/routines.js';
import type { JobConfig } from '../lib/routines.js';
import { fireWebhookJobs, matchJobsToWebhook, type GithubWebhook } from '../lib/triggers/webhook.js';
import { getRoutinesDir } from '../lib/state.js';
import { IS_WINDOWS } from '../lib/platform/index.js';
import { safeJoin } from '../lib/paths.js';
import { executeJob, executeJobDetached, monitorRunningJobs } from '../lib/runner.js';
import { JobScheduler } from '../lib/scheduler.js';
import { detectOverdueJobs } from '../lib/overdue.js';
import { isInteractiveTerminal, requireInteractiveSelection } from './utils.js';
import { setHelpSections } from '../lib/help.js';
import { loadDevices } from '../lib/devices/registry.js';
import { normalizeHost } from '../lib/machine-id.js';
import { addHostOption } from '../lib/hosts/option.js';

/**
 * Human-friendly wall-clock a run took (e.g. "  · 3 min", "  · 45 sec"), or ""
 * when it hasn't completed or timestamps are unparseable. Leading separator lets
 * callers drop it straight into a status line.
 */
export function formatRunDuration(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return '';
  const ms = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `  · ${sec} sec`;
  const min = Math.round(sec / 60);
  if (min < 60) return `  · ${min} min`;
  const hr = Math.floor(min / 60);
  const rem = min % 60;
  return rem ? `  · ${hr} hr ${rem} min` : `  · ${hr} hr`;
}

/**
 * Human label for what fires a job: its cron schedule, or its event trigger
 * for schedule-less (trigger-only) routines.
 */
function fireConditionLabel(job: JobConfig): string {
  if (job.schedule) return humanizeCron(job.schedule, job.timezone);
  if (job.trigger) {
    const scope = job.trigger.repo
      ? ` (${job.trigger.repo}${job.trigger.branch ? `@${job.trigger.branch}` : ''})`
      : '';
    return `on ${job.trigger.event}${scope}`;
  }
  return '-';
}

/** Start or reload the background scheduler so newly-added jobs fire on time. */
function ensureSchedulerRunning(): void {
  if (isDaemonRunning()) {
    signalDaemonReload();
    console.log(chalk.gray('Scheduler reloaded'));
    return;
  }
  const result = startDaemon();
  if (result.pid) {
    console.log(chalk.green(`Scheduler started (PID: ${result.pid}). It will run in the background and fire routines on schedule.`));
    console.log(chalk.gray(`Stop anytime with: agents routines stop`));
  } else {
    console.log(chalk.yellow('Could not start the scheduler. Start it manually with: agents routines start'));
  }
}

/** Detect Ctrl+C or premature stream close during an interactive prompt. */
function isPromptCancelled(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes('User force closed') ||
      err.name === 'ExitPromptError' ||
      (err as any).code === 'ERR_USE_AFTER_CLOSE')
  );
}

/**
 * Interactive job picker. Returns the selected job name or null on cancel/empty.
 *
 * `cwd` is opt-in: pass `process.cwd()` only for inspect-class commands
 * (`view`) whose backing operation tolerates project-layer entries. Mutation
 * (`remove`/`edit`/`pause`/`resume`) and execution (`run`) callers omit it,
 * which limits the picker — and therefore the user — to user-layer routines
 * only. Without that guard, a cloned public repo's `.agents/routines/<name>.yml`
 * would surface in `agents routines run`'s picker and execute with an
 * attacker-supplied prompt under the user's Claude session.
 */
async function pickJob(
  message: string,
  filter?: (job: JobConfig) => boolean,
  alternatives: string[] = [],
  cwd?: string,
): Promise<string | null> {
  let jobs = listAllJobs(cwd);
  if (filter) {
    jobs = jobs.filter(filter);
  }

  if (jobs.length === 0) {
    console.log(chalk.yellow('No jobs available'));
    return null;
  }

  if (!isInteractiveTerminal()) {
    requireInteractiveSelection(message.replace(/:$/, ''), alternatives);
  }

  try {
    const { select } = await import('@inquirer/prompts');
    return await select({
      message,
      choices: jobs.map((job) => ({
        value: job.name,
        name: `${job.name} ${chalk.gray(`(${job.workflow ? `wf:${job.workflow}` : job.agent}, ${job.schedule ?? fireConditionLabel(job)})`)}`,
      })),
    });
  } catch (err) {
    if (isPromptCancelled(err)) {
      console.log(chalk.gray('Cancelled'));
      return null;
    }
    throw err;
  }
}

/**
 * Parse a comma-separated devices string, normalize, deduplicate, and validate
 * each entry against the registered fleet. Exits nonzero on empty/whitespace
 * input or unknown devices.
 */
async function parseAndValidateDevices(raw: string): Promise<string[]> {
  const names = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => normalizeHost(s)))];
  if (names.length === 0) {
    console.log(chalk.red('--devices requires at least one non-empty device name'));
    process.exit(1);
  }
  const registry = await loadDevices();
  const registered = new Set(Object.keys(registry).map((k) => normalizeHost(k)));
  const unknown = names.filter((n) => !registered.has(n));
  if (unknown.length > 0) {
    console.log(chalk.red(`Unknown device(s): ${unknown.join(', ')}`));
    console.log(chalk.gray(`Registered: ${[...registered].sort().join(', ') || '(none)'}`));
    console.log(chalk.gray('Enroll devices with: agents devices sync'));
    process.exit(1);
  }
  return names;
}

/** Register the `agents routines` command tree. */
export function registerRoutinesCommands(program: Command): void {
  const routinesCmd = program
    .command('routines')
    .description('Schedule agents to run on a cron schedule or at a specific time. The scheduler auto-starts on first add.');

  addHostOption(routinesCmd);

  setHelpSections(routinesCmd, {
    examples: `
      # Cron routine: Claude every weekday at 9 AM (scheduler auto-starts)
      agents routines add daily-standup --schedule "0 9 * * 1-5" --agent claude --prompt "Draft standup from git log"

      # One-shot: Codex tomorrow at 2:30 PM, then never again
      agents routines add hotfix-review --at "14:30" --agent codex --prompt "Review hotfix PR #42"

      # Create from YAML (for complex routines with multiple settings)
      agents routines add weekly-report.yml

      # List all routines and their next run times
      agents routines list

      # List routines on a specific device
      agents routines list --host yosemite-s0

      # Create a routine restricted to specific devices
      agents routines add nightly --schedule "0 2 * * *" --agent claude --prompt "Summarize today's commits" --devices yosemite-s0,mac-mini

      # Interactively manage which devices may run a routine
      agents routines devices nightly

      # Run a routine right now in the foreground (ignores schedule)
      agents routines run daily-standup

      # Check whether the scheduler is running
      agents routines status
    `,
    notes: `
      A routine is a YAML file that schedules an agent invocation. It specifies:
        - which agent to run (claude, codex, gemini, ...)
        - when to run (cron schedule or one-shot time)
        - what task to give the agent (the prompt)
        - execution constraints (mode, effort, timeout)

      The background scheduler auto-starts the first time you add a routine.
      Manage it with 'agents routines start|stop|status'.

      Version / credit failover (same semantics as 'agents run'):
        - Omit 'version:' to let the configured run strategy (default: balanced)
          pick a healthy install and skip accounts that are out of credits or
          rate-limited. Pin with 'version: 2.1.x' when you want one install only.
        - Foreground 'agents routines run' re-dispatches to the next healthy
          same-agent account when a mid-run rate/usage limit is detected.
        - Detached/daemon fires use the pre-flight pick only (next tick re-selects).
        - Diagnostic lines log which account was picked, which were skipped, and
          each failover hop: look for "[agents] routine <name>:" in the run log.
        - Headless Claude auth: store CLAUDE_CODE_OAUTH_TOKEN in the 'claude'
          secrets bundle so the daemon can inject it into routine spawns.
    `,
  });

  routinesCmd
    .command('list')
    .description('See all scheduled jobs, when they run next, and their last execution status')
    .option('--json', 'Emit machine-readable JSON instead of the table (used by the menu bar helper)')
    .action((options: { json?: boolean }) => {
      try { monitorRunningJobs(); } catch { /* best-effort orphan reap */ }
      const jobs = listAllJobs(process.cwd());
      if (jobs.length === 0) {
        if (options.json) {
          process.stdout.write('[]\n');
          return;
        }
        console.log(chalk.gray('No jobs configured'));
        console.log(chalk.gray('  Add a job: agents routines add <path-to-job.yml>'));
        return;
      }

      const scheduler = new JobScheduler(async () => {});
      scheduler.loadAll();

      // Build a quick lookup: which jobs are currently overdue?
      const overdueSet = new Set<string>();
      try {
        for (const j of detectOverdueJobs()) overdueSet.add(j.name);
      } catch {
        // Best-effort indicator; never block the list on detection errors.
      }

      // Machine-readable path: same data the table renders, but structured.
      // The menu bar helper relies on this so it never reimplements cron math.
      if (options.json) {
        const nowJson = new Date();
        const payload = jobs.map((job) => {
          const nextRun = scheduler.getNextRun(job.name);
          const latestRun = getLatestRun(job.name);
          return {
            name: job.name,
            agent: job.agent ?? null,
            workflow: job.workflow ?? null,
            repo: job.repo ?? null,
            schedule: job.schedule ?? null,
            scheduleHuman: fireConditionLabel(job),
            trigger: job.trigger ?? null,
            timezone: job.timezone ?? null,
            devices: job.devices ?? [],
            runsHere: jobRunsOnThisDevice(job),
            enabled: job.enabled,
            overdue: overdueSet.has(job.name),
            nextRun: nextRun ? nextRun.toISOString() : null,
            nextRunHuman: humanizeNextRun(nextRun ?? null, nowJson, job.timezone),
            lastStatus: latestRun?.status ?? null,
            lastRunStartedAt: latestRun?.startedAt ?? null,
            lastRunCompletedAt: latestRun?.completedAt ?? null,
          };
        });
        scheduler.stopAll();
        process.stdout.write(JSON.stringify(payload) + '\n');
        return;
      }

      console.log(chalk.bold('Scheduled Jobs\n'));

      // OSC 8 hyperlink helper — renders as a clickable link in supporting terminals.
      // Guarded on process.stdout.isTTY so that piped/redirected output never
      // contains raw ESC ] 8 ;; ... BEL escape sequences.
      const link = (label: string, url: string | null): string =>
        url && process.stdout.isTTY ? `\x1b]8;;${url}\x07${label}\x1b]8;;\x07` : label;

      const now = new Date();

      const NAME_W = 24;
      const AGENT_W = 10;
      const REPO_W = REPO_DISPLAY_MAX;
      const DEVICE_W = 22;
      const SCHED_W = 22;
      const ENABLED_W = 10;
      const NEXT_W = 22;

      const header =
        `  ${'Name'.padEnd(NAME_W)} ${'Agent'.padEnd(AGENT_W)} ${'Repo'.padEnd(REPO_W)} ${'Devices'.padEnd(DEVICE_W)} ${'Schedule'.padEnd(SCHED_W)} ${'Enabled'.padEnd(ENABLED_W)} ${'Next Run'.padEnd(NEXT_W)} Last Status`;
      console.log(chalk.gray(header));
      console.log(chalk.gray('  ' + '-'.repeat(NAME_W + AGENT_W + REPO_W + DEVICE_W + SCHED_W + ENABLED_W + NEXT_W + 20)));

      for (const job of jobs) {
        const nextRun = scheduler.getNextRun(job.name);
        const nextStr = humanizeNextRun(nextRun ?? null, now, job.timezone);
        let schedStr = fireConditionLabel(job);
        if (job.endAt) {
          const end = new Date(job.endAt);
          const endLabel = Number.isFinite(end.getTime())
            ? end.toLocaleDateString()
            : job.endAt;
          schedStr = `${schedStr} (until ${endLabel})`;
        }
        const latestRun = getLatestRun(job.name);
        const lastStatus = latestRun?.status || '-';

        const repoInfo = formatRepoLink(job.repo);
        const repoCell = link(repoInfo.display, repoInfo.href);
        // Pad based on the display string, not the raw cell (which may include escape codes).
        const repoPadding = Math.max(0, REPO_W - repoInfo.display.length);

        const enabledStr = job.enabled ? chalk.green('yes') : chalk.gray('no');
        // chalk adds escape codes; pad the raw word and let chalk wrap it.
        const enabledWord = job.enabled ? 'yes' : 'no';
        const enabledPad = Math.max(0, ENABLED_W - enabledWord.length);

        const deviceFull = job.devices?.join(',') ?? '';
        const deviceWord = deviceFull.length === 0
          ? 'all'
          : deviceFull.length > DEVICE_W
            ? deviceFull.slice(0, DEVICE_W - 1) + '…'
            : deviceFull;
        const deviceCell = deviceFull.length === 0
          ? chalk.gray('all')
          : jobRunsOnThisDevice(job)
            ? deviceWord
            : chalk.gray(deviceWord);
        const devicePad = Math.max(0, DEVICE_W - deviceWord.length);

        const statusColor =
          lastStatus === 'completed' ? chalk.green
          : lastStatus === 'failed' ? chalk.red
          : lastStatus === 'timeout' ? chalk.yellow
          : chalk.gray;

        const overdueTag = overdueSet.has(job.name) ? chalk.yellow(' (overdue)') : '';

        const agentLabelPadded = job.workflow
          ? chalk.magenta(`wf:${job.workflow}`.padEnd(10))
          : (job.agent || '').padEnd(10);
        console.log(
          `  ${chalk.cyan(job.name.padEnd(NAME_W))} ${agentLabelPadded} ${repoCell}${' '.repeat(repoPadding)} ${deviceCell}${' '.repeat(devicePad)} ${schedStr.padEnd(SCHED_W)} ${enabledStr}${' '.repeat(enabledPad)} ${chalk.gray(nextStr.padEnd(NEXT_W))} ${statusColor(lastStatus)}${overdueTag}`
        );
      }

      if (overdueSet.size > 0) {
        console.log();
        console.log(chalk.yellow(`  ${overdueSet.size} routine(s) overdue — catch up with: agents routines catchup`));
      }

      scheduler.stopAll();
      console.log();
    });

  routinesCmd
    .command('add [nameOrPath]')
    .description('Create a new routine from a YAML file or inline flags. Starts the scheduler automatically if it is not already running.')
    .option('-s, --schedule <cron>', 'Cron schedule in standard format (5 fields: minute hour day month weekday)')
    .option('-a, --agent <agent>', 'Which agent runs this routine: claude, codex, gemini, cursor, or opencode')
    .option('--workflow <name>', 'Run an installed workflow (~/.agents/workflows/<name>) via `agents run`. Mutually exclusive with --agent.')
    .option('-p, --prompt <prompt>', 'Task instruction for the agent')
    .option('-m, --mode <mode>', "Execution mode: plan (read-only), edit (can write files), auto (smart classifier, the default), or skip (bypass all permission prompts). 'full' accepted as alias for skip.", 'auto')
    .option('-e, --effort <effort>', 'Reasoning effort: low | medium | high | xhigh | max | auto', 'auto')
    .option('-t, --timeout <timeout>', 'Kill the agent if it runs longer than this (e.g., 10m, 2h, 3d, 1w; max 1w)', '10m')
    .option('--timezone <tz>', 'Interpret schedule in this timezone (e.g., America/Los_Angeles)')
    .option('--devices <names>', 'Fleet allowlist (comma-separated): only listed devices schedule and fire this routine. Omit for unrestricted.')
    .option('--at <time>', 'One-shot mode: run once at this time (e.g., "14:30" or "2026-02-24 09:00"), then disable')
    .option('--end-at <iso>', 'Stop firing on or after this ISO 8601 timestamp (e.g., "2026-12-31T23:59:00Z"); routine auto-disables.')
    .option('--disabled', 'Create the routine but keep it paused (enable later with resume)')
    .option('--resume <sessionId>', 'At fire time, resume this existing session id (via `agents run <agent> --resume`) instead of starting fresh — the actual session reopens with full context and the prompt becomes its next turn. Powers self-scheduled wake-ups (e.g. /hibernate). Use with --agent claude|codex.')
    .action(async (nameOrPath: string | undefined, options) => {
      // Check if inline mode (has flags) or file mode
      const hasInlineFlags = options.schedule || options.agent || options.workflow || options.prompt || options.at;

      if (hasInlineFlags) {
        // Inline mode: create job from flags
        if (!nameOrPath) {
          console.log(chalk.red('Job name is required'));
          console.log(chalk.gray('Usage: agents routines add <name> --schedule "..." --agent <agent> --prompt "..."'));
          process.exit(1);
        }

        // Validate mutually exclusive --agent / --workflow
        if (options.agent && options.workflow) {
          console.log(chalk.red('--agent and --workflow are mutually exclusive; specify exactly one'));
          process.exit(1);
        }

        let schedule = options.schedule;
        let runOnce = false;

        // Handle --at for one-shot jobs
        if (options.at) {
          const parsed = parseAtTime(options.at);
          if (!parsed) {
            console.log(chalk.red(`Invalid --at format: ${options.at}`));
            console.log(chalk.gray('Supported formats: "14:30" or "2026-02-24 09:00"'));
            process.exit(1);
          }
          schedule = parsed.schedule;
          runOnce = parsed.runOnce;
        }

        if (!schedule) {
          console.log(chalk.red('Schedule is required (use --schedule or --at)'));
          process.exit(1);
        }

        if (!options.agent && !options.workflow) {
          console.log(chalk.red('An agent or workflow is required (use --agent or --workflow)'));
          process.exit(1);
        }

        if (!options.prompt) {
          console.log(chalk.red('Prompt is required (use --prompt)'));
          process.exit(1);
        }

        // Parse and validate --devices against the fleet registry.
        let devices: string[] | undefined;
        if (options.devices !== undefined) {
          devices = await parseAndValidateDevices(options.devices);
        }

        const config: JobConfig = {
          name: nameOrPath,
          schedule,
          agent: options.agent,
          ...(options.workflow ? { workflow: options.workflow } : {}),
          mode: options.mode,
          effort: options.effort,
          timeout: options.timeout,
          enabled: !options.disabled,
          prompt: options.prompt,
          timezone: options.timezone,
          ...(devices ? { devices } : {}),
          ...(runOnce ? { runOnce: true } : {}),
          ...(options.endAt ? { endAt: options.endAt } : {}),
          ...(options.resume ? { resume: options.resume } : {}),
        };

        const errors = validateJob(config);
        if (errors.length > 0) {
          console.log(chalk.red('Validation errors:'));
          for (const err of errors) {
            console.log(chalk.red(`  - ${err}`));
          }
          process.exit(1);
        }

        writeJob(config);
        console.log(chalk.green(`Job '${nameOrPath}' added`));
        if (runOnce) {
          console.log(chalk.gray(`One-shot job scheduled for: ${options.at}`));
        }

        ensureSchedulerRunning();
      } else {
        // File mode: load from YAML file
        if (!nameOrPath) {
          console.log(chalk.red('File path or job name with flags is required'));
          console.log(chalk.gray('Usage: agents routines add <path-to-job.yml>'));
          console.log(chalk.gray('   or: agents routines add <name> --schedule "..." --agent <agent> --prompt "..."'));
          process.exit(1);
        }

        const resolved = path.resolve(nameOrPath);
        if (!fs.existsSync(resolved)) {
          console.log(chalk.red(`File not found: ${resolved}`));
          process.exit(1);
        }

        const content = fs.readFileSync(resolved, 'utf-8');
        let parsed: any;
        try {
          parsed = yaml.parse(content);
        } catch (err) {
          console.log(chalk.red(`Invalid YAML: ${(err as Error).message}`));
          process.exit(1);
        }

        const name = parsed.name || path.basename(resolved).replace(/\.ya?ml$/, '');
        parsed.name = name;

        const errors = validateJob(parsed);
        if (errors.length > 0) {
          console.log(chalk.red('Validation errors:'));
          for (const err of errors) {
            console.log(chalk.red(`  - ${err}`));
          }
          process.exit(1);
        }

        const config: JobConfig = {
          mode: 'auto',
          effort: 'auto',
          timeout: '10m',
          enabled: true,
          ...parsed,
        } as JobConfig;

        writeJob(config);
        console.log(chalk.green(`Job '${name}' added`));

        ensureSchedulerRunning();
      }
    });

  routinesCmd
    .command('remove [name]')
    .description('Delete a routine. Stops scheduling future runs; past execution logs remain on disk.')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = await pickJob('Select job to remove', undefined, ['agents routines remove <name>']) ?? undefined;
        if (!name) return;
      }

      const deleted = deleteJob(name);
      if (deleted) {
        console.log(chalk.green(`Job '${name}' removed`));
        if (isDaemonRunning()) {
          signalDaemonReload();
          console.log(chalk.gray('Daemon reloaded'));
        }
      } else {
        console.log(chalk.red(`Job '${name}' not found`));
        process.exit(1);
      }
    });

  routinesCmd
    .command('view [name]')
    .description('Show the full YAML configuration for a routine')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = await pickJob('Select job to view', undefined, ['agents routines view <name>'], process.cwd()) ?? undefined;
        if (!name) return;
      }

      const job = readJob(name, process.cwd());
      if (!job) {
        console.log(chalk.red(`Job '${name}' not found`));
        process.exit(1);
      }

      console.log(chalk.bold(`Job: ${name}\n`));
      console.log(yaml.stringify(job));
    });

  routinesCmd
    .command('edit [name]')
    .description('Open a routine in $EDITOR. Creates a new YAML template if the routine does not exist.')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = await pickJob('Select job to edit', undefined, ['agents routines edit <name>']) ?? undefined;
        if (!name) return;
      }

      const jobPath = getJobPath(name);
      if (!jobPath) {
        // Job doesn't exist - create a new one
        const cronDir = getRoutinesDir();
        const newPath = safeJoin(cronDir, `${name}.yml`);

        // Create template
        const template = yaml.stringify({
          name,
          schedule: '0 9 * * *',
          agent: 'claude',
          prompt: 'Your prompt here',
        });
        fs.writeFileSync(newPath, template, 'utf-8');
        console.log(chalk.gray(`Created new job file: ${newPath}`));
      }

      const targetPath = jobPath || path.join(getRoutinesDir(), `${name}.yml`);
      const editor = process.env.EDITOR || process.env.VISUAL || (IS_WINDOWS ? 'notepad' : 'vi');
      const editorParts = editor.split(/\s+/).filter(Boolean);
      const editorBin = editorParts[0];
      const editorArgs = [...editorParts.slice(1), targetPath];

      const { spawn: spawnSync } = await import('child_process');
      const child = spawnSync(editorBin, editorArgs, {
        stdio: 'inherit',
      });

      child.on('close', (code) => {
        if (code === 0) {
          // Validate the edited file
          const job = readJob(name!);
          if (job) {
            const errors = validateJob(job);
            if (errors.length > 0) {
              console.log(chalk.yellow('\nWarning: Job has validation errors:'));
              for (const err of errors) {
                console.log(chalk.yellow(`  - ${err}`));
              }
            } else {
              console.log(chalk.green(`\nJob '${name}' saved`));
              if (isDaemonRunning()) {
                signalDaemonReload();
                console.log(chalk.gray('Daemon reloaded'));
              }
            }
          }
        }
      });
    });

  routinesCmd
    .command('runs [name]')
    .description('See execution history: run IDs, completion status, and start times (up to last 10 runs)')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = await pickJob('Select job to view runs', undefined, ['agents routines runs <name>']) ?? undefined;
        if (!name) return;
      }

      const runs = listRuns(name);
      if (runs.length === 0) {
        console.log(chalk.yellow(`No runs found for job '${name}'`));
        return;
      }

      console.log(chalk.bold(`Execution History: ${name}\n`));
      for (const run of runs.slice(-10)) {
        const status = run.status === 'completed'
          ? chalk.green(run.status)
          : run.status === 'failed'
            ? chalk.red(run.status)
            : chalk.yellow(run.status);
        console.log(`  ${run.runId}  ${status}  ${run.startedAt}`);
      }
    });

  routinesCmd
    .command('run [name]')
    .description('Execute a routine right now in the foreground. Ignores the schedule; useful for testing before enabling.')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = await pickJob('Select job to run', undefined, ['agents routines run <name>']) ?? undefined;
        if (!name) return;
      }

      // Execution is intentionally user-only: a routine spawns a full agent
      // session with a YAML-supplied prompt, so a cloned public repo's
      // `.agents/routines/<name>.yml` would be a prompt-injection vector if
      // `run` honored the project layer. `list` / `view` stay project-aware
      // for inspection; `run`, `remove`, `edit`, `pause`, `resume` stay on
      // the trusted user layer.
      const job = readJob(name);
      if (!job) {
        console.log(chalk.red(`Job '${name}' not found`));
        process.exit(1);
      }

      const eligibility = checkJobDeviceEligibility(job);
      if (eligibility) {
        console.log(chalk.red(eligibility.message));
        console.log(chalk.gray(`  ${eligibility.suggestion}`));
        process.exit(1);
      }

      const runLabel = job.workflow ? `workflow: ${job.workflow}` : `agent: ${job.agent}`;
      console.log(chalk.bold(`Running job '${name}' (${runLabel}, mode: ${job.mode})\n`));
      const spinner = ora('Executing...').start();

      try {
        const result = await executeJob(job);
        if (result.meta.status === 'completed') {
          spinner.succeed(`Job completed (exit code: ${result.meta.exitCode})`);
        } else if (result.meta.status === 'timeout') {
          spinner.warn(`Job timed out after ${job.timeout}`);
        } else {
          spinner.fail(`Job failed (exit code: ${result.meta.exitCode})`);
        }

        console.log(chalk.gray(`  Run: ${result.meta.runId}`));
        console.log(chalk.gray(`  Log: ${getRunDir(name, result.meta.runId)}/stdout.log`));

        if (result.reportPath) {
          console.log(chalk.bold('\nReport:\n'));
          console.log(fs.readFileSync(result.reportPath, 'utf-8'));
        }
      } catch (err) {
        spinner.fail('Execution failed');
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  routinesCmd
    .command('catchup')
    .description('Run any routines that missed their last scheduled fire (e.g. because your laptop was off). Detached — runs in the background under the scheduler.')
    .option('--dry-run', 'List overdue routines without running them')
    .action(async (options) => {
      const overdue = detectOverdueJobs();
      if (overdue.length === 0) {
        console.log(chalk.gray('No overdue routines.'));
        return;
      }

      console.log(chalk.bold(`${overdue.length} overdue routine(s):\n`));
      for (const job of overdue) {
        const last = job.lastRanAt ? job.lastRanAt.toLocaleString() : 'never';
        console.log(`  ${chalk.cyan(job.name)} — missed ${chalk.gray(job.expectedAt.toLocaleString())}, last ran ${chalk.gray(last)}`);
      }

      if (options.dryRun) {
        console.log(chalk.gray('\n(dry run — no jobs triggered)'));
        return;
      }

      // Need the daemon alive so spawned jobs are monitored and meta.json is
      // finalized. Start it if it isn't already running.
      if (!isDaemonRunning()) {
        const started = startDaemon();
        if (started.pid) {
          console.log(chalk.gray(`\nStarted scheduler (PID: ${started.pid}) so catchup runs are monitored.`));
        }
      }

      console.log(chalk.bold('\nTriggering catchup runs...'));
      for (const job of overdue) {
        const config = readJob(job.name);
        if (!config) {
          console.log(`  ${job.name} → ${chalk.red('config not found')}`);
          continue;
        }
        try {
          const meta = await executeJobDetached(config);
          console.log(`  ${job.name} → ${chalk.green('started')} (run: ${meta.runId}, PID: ${meta.pid ?? 'n/a'})`);
        } catch (err) {
          console.log(`  ${job.name} → ${chalk.red('failed to start')}: ${(err as Error).message}`);
        }
      }
      console.log(chalk.gray('\nTrack progress with: agents routines runs <name>'));
    });

  routinesCmd
    .command('webhook')
    .description('Fire trigger-based routines from a single GitHub webhook payload (read from --file or stdin). One-shot: matches and fires, then exits. For a long-running receiver, run this behind your own HTTP forwarder.')
    .requiredOption('--event <name>', 'GitHub event name, as sent in the X-GitHub-Event header (e.g. pull_request, push, workflow_run)')
    .option('--file <path>', 'Read the webhook JSON payload from this file instead of stdin')
    .option('--dry-run', 'Show which routines would fire without firing them')
    .action(async (options: { event: string; file?: string; dryRun?: boolean }) => {
      // Load the raw JSON payload: --file wins, else drain stdin.
      let raw: string;
      if (options.file) {
        const resolved = path.resolve(options.file);
        if (!fs.existsSync(resolved)) {
          console.log(chalk.red(`File not found: ${resolved}`));
          process.exit(1);
        }
        raw = fs.readFileSync(resolved, 'utf-8');
      } else {
        if (process.stdin.isTTY) {
          console.log(chalk.red('No payload provided. Pass --file <path> or pipe the webhook JSON on stdin.'));
          process.exit(1);
        }
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        raw = Buffer.concat(chunks).toString('utf-8');
      }

      let payload: Record<string, unknown>;
      try {
        const parsed = raw.trim() ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('payload must be a JSON object');
        }
        payload = parsed as Record<string, unknown>;
      } catch (err) {
        console.log(chalk.red(`Invalid webhook payload JSON: ${(err as Error).message}`));
        process.exit(1);
      }

      const webhook: GithubWebhook = { event: options.event, payload };

      // Matching is intentionally user-layer only (fireWebhookJobs defaults to
      // listJobs() with no cwd), mirroring `run`/`catchup`: a webhook must never
      // fire a cloned project repo's `.agents/routines/*.yml` and run an
      // attacker-supplied prompt under the user's agent session.
      if (options.dryRun) {
        const matched = matchJobsToWebhook(listAllJobs(), webhook);
        if (matched.length === 0) {
          console.log(chalk.gray(`No routines match a ${options.event} event for this payload.`));
          return;
        }
        console.log(chalk.bold(`${matched.length} routine(s) would fire on ${options.event}:\n`));
        for (const job of matched) {
          console.log(`  ${chalk.cyan(job.name)} — ${fireConditionLabel(job)}`);
        }
        console.log(chalk.gray('\n(dry run — no routines triggered)'));
        return;
      }

      // Fired jobs run detached via executeJobDetached (the same path cron
      // uses). Keep the daemon alive so each run's meta.json is finalized.
      if (!isDaemonRunning()) {
        const started = startDaemon();
        if (started.pid) {
          console.log(chalk.gray(`Started scheduler (PID: ${started.pid}) so webhook runs are monitored.`));
        }
      }

      const fired = await fireWebhookJobs(webhook);
      if (fired.length === 0) {
        console.log(chalk.gray(`No routines match a ${options.event} event for this payload.`));
        return;
      }

      console.log(chalk.bold(`Fired ${fired.length} routine(s) on ${options.event}:\n`));
      for (const f of fired) {
        console.log(`  ${chalk.cyan(f.jobName)} → ${chalk.green('started')} (run: ${f.runId})`);
      }
      console.log(chalk.gray('\nTrack progress with: agents routines runs <name>'));
    });

  routinesCmd
    .command('logs [name]')
    .description('Show a run’s concise summary — status + extracted report. --full for the raw stdout stream; --run for a specific past run.')
    .option('-r, --run <runId>', 'Show logs from this run ID instead of the latest')
    .option('-m, --full', 'Show the full raw stdout stream instead of the concise summary')
    .action(async (name: string | undefined, options) => {
      if (!name) {
        name = await pickJob('Select job to view logs', undefined, ['agents routines logs <name>', 'agents routines logs <name> --run <run-id>']) ?? undefined;
        if (!name) return;
      }

      // Resolve the run: an explicit --run row, else the latest.
      const run = options.run
        ? listRuns(name).find((r) => r.runId === options.run)
        : getLatestRun(name);
      if (!run) {
        console.log(chalk.yellow(options.run ? `No run '${options.run}' for job '${name}'` : `No runs found for job '${name}'`));
        return;
      }
      const runId = run.runId;
      const logPath = path.join(getRunDir(name, runId), 'stdout.log');

      // --full: the raw combined stdout stream (the old default).
      if (options.full) {
        if (!fs.existsSync(logPath)) {
          console.log(chalk.yellow(`Log not found: ${logPath}`));
          return;
        }
        console.log(chalk.gray(`Run: ${runId}\n`));
        console.log(fs.readFileSync(logPath, 'utf-8'));
        return;
      }

      // Concise by default: a status header + the extracted report (final
      // assistant message). Routine runs are sandboxed (transcript in an overlay
      // HOME, not the session index), so the captured report — not renderSummary —
      // is the concise view. Falls back to a bounded stdout tail when no report
      // was extracted (e.g. the run failed before finishing).
      const statusColor = run.status === 'completed' ? chalk.green
        : run.status === 'failed' || run.status === 'timeout' ? chalk.red
        : chalk.yellow;
      console.log(chalk.bold(name) + chalk.gray(`  run ${runId}`));
      console.log(
        statusColor(run.status) +
        chalk.gray(`  ${run.startedAt}`) +
        chalk.gray(formatRunDuration(run.startedAt, run.completedAt)) +
        (run.exitCode !== null && run.exitCode !== undefined ? chalk.gray(`  exit ${run.exitCode}`) : '')
      );
      console.log(chalk.gray('─'.repeat(60)));

      const reportPath = path.join(getRunDir(name, runId), 'report.md');
      if (fs.existsSync(reportPath)) {
        console.log(fs.readFileSync(reportPath, 'utf-8').trimEnd());
        console.log(chalk.gray('\n(pass --full for the raw stdout stream)'));
        return;
      }

      // No report — show a bounded tail rather than dumping the whole stream.
      if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        const tail = lines.slice(-40).join('\n').trimEnd();
        console.log(chalk.gray('(no report extracted — showing the last lines of stdout)'));
        if (tail) console.log(tail);
        console.log(chalk.gray('\n(pass --full for the raw stdout stream)'));
      } else {
        console.log(chalk.gray('(no output captured for this run)'));
      }
    });

  routinesCmd
    .command('report [name]')
    .description('Show the extracted report from the most recent execution. Reports are parsed from agent output on completion.')
    .option('-r, --run <runId>', 'Show report from this run ID instead of the latest')
    .action(async (name: string | undefined, options) => {
      if (!name) {
        name = await pickJob('Select job to view report', undefined, ['agents routines report <name>', 'agents routines report <name> --run <run-id>']) ?? undefined;
        if (!name) return;
      }

      let runId = options.run;
      if (!runId) {
        const latest = getLatestRun(name);
        if (!latest) {
          console.log(chalk.yellow(`No runs found for job '${name}'`));
          return;
        }
        runId = latest.runId;
      }

      const reportPath = path.join(getRunDir(name, runId), 'report.md');
      if (!fs.existsSync(reportPath)) {
        console.log(chalk.yellow(`No report found for run ${runId}`));
        console.log(chalk.gray(`  Reports are extracted from agent output on completion`));
        return;
      }

      console.log(chalk.gray(`Run: ${runId}\n`));
      console.log(fs.readFileSync(reportPath, 'utf-8'));
    });

  routinesCmd
    .command('resume [name]')
    .description('Re-enable a paused routine so the daemon schedules it again')
    .action(async (name: string | undefined) => {
      if (!name) {
        // Only show paused jobs
        name = await pickJob('Select job to resume', (job) => !job.enabled, ['agents routines resume <name>']) ?? undefined;
        if (!name) return;
      }

      try {
        setJobEnabled(name, true);
        console.log(chalk.green(`Job '${name}' resumed`));
        if (isDaemonRunning()) {
          signalDaemonReload();
          console.log(chalk.gray('Daemon reloaded'));
        }
      } catch (err) {
        console.log(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  routinesCmd
    .command('pause [name]')
    .description('Temporarily disable a routine. Stops scheduling future runs; enable again with resume.')
    .action(async (name: string | undefined) => {
      if (!name) {
        // Only show enabled jobs
        name = await pickJob('Select job to pause', (job) => job.enabled, ['agents routines pause <name>']) ?? undefined;
        if (!name) return;
      }

      try {
        setJobEnabled(name, false);
        console.log(chalk.green(`Job '${name}' paused`));
        if (isDaemonRunning()) {
          signalDaemonReload();
          console.log(chalk.gray('Scheduler reloaded'));
        }
      } catch (err) {
        console.log(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  // Fleet allowlist management for a single routine.
  routinesCmd
    .command('devices [name]')
    .description('View or change which devices may run a routine. Without flags, opens an interactive picker (requires a TTY).')
    .option('--set <devices>', 'Replace the allowlist with this comma-separated list (strict fleet validation)')
    .option('--clear', 'Remove the allowlist so the routine runs on every device')
    .action(async (name: string | undefined, options: { set?: string; clear?: boolean }) => {
      const hasSet = options.set !== undefined;
      if (hasSet && options.clear) {
        console.log(chalk.red('--set and --clear are mutually exclusive'));
        process.exit(1);
      }

      if (!name) {
        name = await pickJob('Select routine', undefined, ['agents routines devices <name>']) ?? undefined;
        if (!name) return;
      }
      const job = readJob(name);
      if (!job) {
        console.log(chalk.red(`Job '${name}' not found`));
        process.exit(1);
      }

      if (options.clear) {
        job.devices = undefined;
        writeJob(job);
        console.log(chalk.green(`Devices cleared for '${name}' — runs on all devices`));
        if (isDaemonRunning()) signalDaemonReload();
        return;
      }

      if (hasSet) {
        const devices = await parseAndValidateDevices(options.set!);
        job.devices = devices;
        writeJob(job);
        console.log(chalk.green(`Devices for '${name}' set to: ${devices.join(', ')}`));
        if (isDaemonRunning()) signalDaemonReload();
        return;
      }

      // Interactive picker
      if (!isInteractiveTerminal()) {
        requireInteractiveSelection('device allowlist', ['agents routines devices <name> --set a,b', 'agents routines devices <name> --clear']);
      }

      const registry = await loadDevices();
      const registeredNames = Object.keys(registry).map((k) => normalizeHost(k)).sort();
      if (registeredNames.length === 0) {
        console.log(chalk.yellow('No devices registered. Enroll with: agents devices sync'));
        return;
      }

      const currentSet = new Set((job.devices ?? []).map((d) => normalizeHost(d)));

      try {
        const { checkbox } = await import('@inquirer/prompts');
        const selected = await checkbox({
          message: `Devices allowed to run '${name}' (space to toggle, enter to confirm, empty = unrestricted):`,
          choices: registeredNames.map((d) => ({
            value: d,
            name: d,
            checked: currentSet.has(d),
          })),
        });

        if (selected.length === 0) {
          job.devices = undefined;
          writeJob(job);
          console.log(chalk.green(`Devices cleared for '${name}' — runs on all devices`));
        } else {
          job.devices = selected;
          writeJob(job);
          console.log(chalk.green(`Devices for '${name}' set to: ${selected.join(', ')}`));
        }
        if (isDaemonRunning()) signalDaemonReload();
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('Cancelled'));
          return;
        }
        throw err;
      }
    });

  // Scheduler lifecycle — usually auto-managed by `routines add`, exposed here for manual control.

  routinesCmd
    .command('start')
    .description('Start the background scheduler. Usually unnecessary — it auto-starts when you add your first routine.')
    .action(() => {
      const result = startDaemon();
      if (result.method === 'already-running') {
        console.log(chalk.yellow(`Scheduler already running (PID: ${result.pid})`));
      } else if (result.pid) {
        console.log(chalk.green(`Scheduler started (PID: ${result.pid})`));
      } else {
        console.log(chalk.yellow('Scheduler start dispatched but no PID surfaced. Check `agents routines status`.'));
      }
    });

  routinesCmd
    .command('stop')
    .description('Stop the background scheduler. Routines will not fire until you start it again.')
    .action(() => {
      if (!isDaemonRunning()) {
        console.log(chalk.yellow('Scheduler is not running'));
        return;
      }
      stopDaemon();
      console.log(chalk.green('Scheduler stopped'));
    });

  routinesCmd
    .command('status')
    .description('Show scheduler status, enabled routines, and when each one fires next.')
    .action(() => {
      try { monitorRunningJobs(); } catch { /* best-effort orphan reap */ }
      const status = getDaemonStatus();

      console.log(chalk.bold('Scheduler\n'));
      const stateLabel = status.state === 'running'
        ? chalk.green('running')
        : status.state === 'wedged'
          ? chalk.red('wedged')
          : chalk.gray('stopped');
      console.log(`  Status:    ${stateLabel}`);
      if (status.pid) console.log(`  PID:       ${status.pid}`);
      if (status.binaryPath) console.log(`  Binary:    ${chalk.gray(status.binaryPath)}`);
      if (status.heartbeat) {
        const ago = Math.round((Date.now() - Date.parse(status.heartbeat.lastTick)) / 1000);
        console.log(`  Heartbeat: ${chalk.gray(`${ago} sec ago`)}`);
      }

      const jobs = listAllJobs();
      const enabled = jobs.filter((j) => j.enabled);
      console.log(`  Routines:  ${enabled.length} enabled / ${jobs.length} total`);

      if (status.state === 'wedged') {
        console.log(chalk.red('\n  The daemon is wedged (heartbeat stale). Restart with: agents routines stop && agents routines start'));
      }

      if (status.running && enabled.length > 0) {
        const scheduler = new JobScheduler(async () => {});
        scheduler.loadAll();
        const scheduled = scheduler.listScheduled();
        console.log(chalk.bold('\n  Upcoming Runs\n'));
        for (const job of scheduled) {
          const next = job.nextRun ? job.nextRun.toLocaleString() : 'unknown';
          console.log(`    ${chalk.cyan(job.name.padEnd(24))} next: ${chalk.gray(next)}`);
        }
        scheduler.stopAll();
      } else if (!status.running && jobs.length > 0) {
        console.log(chalk.gray('\n  Start the scheduler to begin firing routines: agents routines start'));
      }
    });

  routinesCmd
    .command('scheduler-logs')
    .description('Read scheduler log output (for debugging why a routine did not fire). Use --follow to stream.')
    .option('-n, --lines <number>', 'Show this many recent lines (default: 50)', '50')
    .option('-f, --follow', 'Stream log output in real time (like tail -f)')
    .action(async (options) => {
      if (options.follow) {
        const { getDaemonDir } = await import('../lib/state.js');
        const { followFile } = await import('../lib/log-follow.js');
        const logPath = path.join(getDaemonDir(), 'logs.jsonl');
        const recent = readDaemonLog(parseInt(options.lines, 10));
        if (recent) console.log(recent);
        const stop = followFile(logPath, (text) => process.stdout.write(text), { fromEnd: true });
        process.on('SIGINT', () => { stop(); process.exit(0); });
        return;
      }

      const lines = parseInt(options.lines, 10);
      const output = readDaemonLog(lines);
      if (output) {
        console.log(output);
      } else {
        console.log(chalk.gray('No scheduler logs'));
      }
    });

  // Every direct routines subcommand accepts the shared --host family so remote
  // fall-through works and each subcommand's --help documents the flags.
  for (const sub of routinesCmd.commands) {
    addHostOption(sub);
  }
}
