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
  signalDaemonReload,
  startDaemon,
  stopDaemon,
  readDaemonPid,
  readDaemonLog,
} from '../lib/daemon.js';
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
} from '../lib/routines.js';
import type { JobConfig } from '../lib/routines.js';
import { getRoutinesDir } from '../lib/state.js';
import { safeJoin } from '../lib/paths.js';
import { executeJob } from '../lib/runner.js';
import { JobScheduler } from '../lib/scheduler.js';
import { isInteractiveTerminal, requireInteractiveSelection } from './utils.js';

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

/** Interactive job picker. Returns the selected job name or null on cancel/empty. */
async function pickJob(
  message: string,
  filter?: (job: JobConfig) => boolean,
  alternatives: string[] = [],
): Promise<string | null> {
  let jobs = listAllJobs();
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
        name: `${job.name} ${chalk.gray(`(${job.agent}, ${job.schedule})`)}`,
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

/** Register the `agents routines` command tree. */
export function registerRoutinesCommands(program: Command): void {
  const routinesCmd = program
    .command('routines')
    .description('Schedule agents to run on a cron schedule or at a specific time. The scheduler auto-starts on first add.')
    .addHelpText(
      'after',
      `
A routine is a YAML file that schedules an agent invocation. It specifies:
  - which agent to run (claude, codex, gemini, etc.)
  - when to run (cron schedule or one-shot time)
  - what task to give the agent (the prompt)
  - execution constraints (mode, effort, timeout)

A background scheduler fires routines on their schedule. It auto-starts the first
time you add a routine; control it manually with 'agents routines start|stop|status'.

Examples:
  # Create a routine that runs Claude every weekday at 9 AM (scheduler auto-starts)
  agents routines add daily-standup --schedule "0 9 * * 1-5" --agent claude --prompt "Draft standup update from git log"

  # One-shot routine: run Codex tomorrow at 2:30 PM, then never again
  agents routines add hotfix-review --at "14:30" --agent codex --prompt "Review hotfix PR #42"

  # Create from a YAML file (for complex routines with multiple settings)
  agents routines add weekly-report.yml

  # See all routines and their next run times
  agents routines list

  # Check whether the scheduler is running
  agents routines status

  # Test a routine immediately in the foreground (ignores schedule)
  agents routines run daily-standup
`
    );

  routinesCmd
    .command('list')
    .description('See all scheduled jobs, when they run next, and their last execution status')
    .action(() => {
      const jobs = listAllJobs();
      if (jobs.length === 0) {
        console.log(chalk.gray('No jobs configured'));
        console.log(chalk.gray('  Add a job: agents routines add <path-to-job.yml>'));
        return;
      }

      const scheduler = new JobScheduler(async () => {});
      scheduler.loadAll();

      console.log(chalk.bold('Scheduled Jobs\n'));

      const header = `  ${'Name'.padEnd(24)} ${'Agent'.padEnd(10)} ${'Schedule'.padEnd(20)} ${'Enabled'.padEnd(10)} ${'Next Run'.padEnd(24)} ${'Last Status'}`;
      console.log(chalk.gray(header));
      console.log(chalk.gray('  ' + '-'.repeat(110)));

      for (const job of jobs) {
        const nextRun = scheduler.getNextRun(job.name);
        const nextStr = nextRun ? nextRun.toLocaleString() : '-';
        const latestRun = getLatestRun(job.name);
        const lastStatus = latestRun?.status || '-';

        const enabledStr = job.enabled ? chalk.green('yes') : chalk.gray('no');
        const statusColor = lastStatus === 'completed' ? chalk.green : lastStatus === 'failed' ? chalk.red : lastStatus === 'timeout' ? chalk.yellow : chalk.gray;

        console.log(
          `  ${chalk.cyan(job.name.padEnd(24))} ${job.agent.padEnd(10)} ${job.schedule.padEnd(20)} ${enabledStr.padEnd(10 + 10)} ${chalk.gray(nextStr.padEnd(24))} ${statusColor(lastStatus)}`
        );
      }

      scheduler.stopAll();
      console.log();
    });

  routinesCmd
    .command('add [nameOrPath]')
    .description('Create a new routine from a YAML file or inline flags. Starts the scheduler automatically if it is not already running.')
    .option('-s, --schedule <cron>', 'Cron schedule in standard format (5 fields: minute hour day month weekday)')
    .option('-a, --agent <agent>', 'Which agent runs this routine: claude, codex, gemini, cursor, or opencode')
    .option('-p, --prompt <prompt>', 'Task instruction for the agent')
    .option('-m, --mode <mode>', 'Execution mode: plan (read-only) or edit (can write files)', 'plan')
    .option('-e, --effort <effort>', 'Reasoning effort: low | medium | high | xhigh | max | auto', 'auto')
    .option('-t, --timeout <timeout>', 'Kill the agent if it runs longer than this (e.g., 30m, 2h)', '30m')
    .option('--timezone <tz>', 'Interpret schedule in this timezone (e.g., America/Los_Angeles)')
    .option('--at <time>', 'One-shot mode: run once at this time (e.g., "14:30" or "2026-02-24 09:00"), then disable')
    .option('--disabled', 'Create the routine but keep it paused (enable later with resume)')
    .action(async (nameOrPath: string | undefined, options) => {
      // Check if inline mode (has flags) or file mode
      const hasInlineFlags = options.schedule || options.agent || options.prompt || options.at;

      if (hasInlineFlags) {
        // Inline mode: create job from flags
        if (!nameOrPath) {
          console.log(chalk.red('Job name is required'));
          console.log(chalk.gray('Usage: agents routines add <name> --schedule "..." --agent <agent> --prompt "..."'));
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

        if (!options.agent) {
          console.log(chalk.red('Agent is required (use --agent)'));
          process.exit(1);
        }

        if (!options.prompt) {
          console.log(chalk.red('Prompt is required (use --prompt)'));
          process.exit(1);
        }

        const config: JobConfig = {
          name: nameOrPath,
          schedule,
          agent: options.agent,
          mode: options.mode,
          effort: options.effort,
          timeout: options.timeout,
          enabled: !options.disabled,
          prompt: options.prompt,
          timezone: options.timezone,
          ...(runOnce ? { runOnce: true } : {}),
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
          mode: 'plan',
          effort: 'auto',
          timeout: '30m',
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
        name = await pickJob('Select job to view', undefined, ['agents routines view <name>']) ?? undefined;
        if (!name) return;
      }

      const job = readJob(name);
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
      const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
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

      const job = readJob(name);
      if (!job) {
        console.log(chalk.red(`Job '${name}' not found`));
        process.exit(1);
      }

      console.log(chalk.bold(`Running job '${name}' (agent: ${job.agent}, mode: ${job.mode})\n`));
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
    .command('logs [name]')
    .description('Read stdout from the most recent execution. Use --run to see a specific past run.')
    .option('-r, --run <runId>', 'Show logs from this run ID instead of the latest')
    .action(async (name: string | undefined, options) => {
      if (!name) {
        name = await pickJob('Select job to view logs', undefined, ['agents routines logs <name>', 'agents routines logs <name> --run <run-id>']) ?? undefined;
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

      const logPath = path.join(getRunDir(name, runId), 'stdout.log');
      if (!fs.existsSync(logPath)) {
        console.log(chalk.yellow(`Log not found: ${logPath}`));
        return;
      }

      console.log(chalk.gray(`Run: ${runId}\n`));
      console.log(fs.readFileSync(logPath, 'utf-8'));
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

  // Scheduler lifecycle — usually auto-managed by `routines add`, exposed here for manual control.

  routinesCmd
    .command('start')
    .description('Start the background scheduler. Usually unnecessary — it auto-starts when you add your first routine.')
    .action(() => {
      const result = startDaemon();
      if (result.method === 'already-running') {
        console.log(chalk.yellow(`Scheduler already running (PID: ${result.pid})`));
      } else {
        console.log(chalk.green(`Scheduler started (PID: ${result.pid})`));
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
      const running = isDaemonRunning();
      const pid = readDaemonPid();

      console.log(chalk.bold('Scheduler\n'));
      console.log(`  Status:    ${running ? chalk.green('running') : chalk.gray('stopped')}`);
      if (pid) console.log(`  PID:       ${pid}`);

      const jobs = listAllJobs();
      const enabled = jobs.filter((j) => j.enabled);
      console.log(`  Routines:  ${enabled.length} enabled / ${jobs.length} total`);

      if (running && enabled.length > 0) {
        const scheduler = new JobScheduler(async () => {});
        scheduler.loadAll();
        const scheduled = scheduler.listScheduled();
        console.log(chalk.bold('\n  Upcoming Runs\n'));
        for (const job of scheduled) {
          const next = job.nextRun ? job.nextRun.toLocaleString() : 'unknown';
          console.log(`    ${chalk.cyan(job.name.padEnd(24))} next: ${chalk.gray(next)}`);
        }
        scheduler.stopAll();
      } else if (!running && jobs.length > 0) {
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
        const { spawn } = await import('child_process');
        const { getDaemonDir } = await import('../lib/state.js');
        const logPath = path.join(getDaemonDir(), 'logs.jsonl');
        const child = spawn('tail', ['-f', logPath]);
        child.stdout?.pipe(process.stdout);
        child.stderr?.pipe(process.stderr);
        child.on('exit', () => process.exit(0));
        process.on('SIGINT', () => { child.kill(); process.exit(0); });
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
}
