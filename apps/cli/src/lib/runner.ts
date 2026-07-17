/**
 * Job execution engine for routines.
 *
 * Builds agent-specific CLI commands from job configs, spawns them with
 * sandboxed or unsandboxed environments, captures stdout to log files,
 * enforces timeouts, and extracts the final assistant report from the
 * agent's stream-JSON output.
 *
 * Version/account selection mirrors `agents run`: when a routine does not pin
 * `version:`, the runner uses the configured run strategy (default `balanced`)
 * to pick a healthy install, pins the absolute binary via `getBinaryPath`, and
 * arms same-agent failover across other healthy accounts when a rate/usage
 * limit is detected mid-run (foreground `executeJob` only — detached daemon
 * fires once with the pre-flight pick).
 */

import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { JobConfig, RunMeta } from './routines.js';
import {
  resolveJobPrompt,
  parseTimeout,
  writeRunMeta,
  getRunDir,
  jobRunsOnThisDevice,
  checkJobDeviceEligibility,
} from './routines.js';
import { getRunsDir } from './state.js';
import type { AgentId } from './types.js';
import { prepareJobHome, buildSpawnEnv } from './sandbox.js';
import { resolveModel, buildReasoningFlags } from './models.js';
import { createTimer, maybeRotate, redactPrompt } from './events.js';
import {
  normalizeMode,
  resolveHeadlessMode,
  buildExecEnv,
  detectRateLimit,
  type ExecOptions,
  type ExecEffort,
  type FallbackEntry,
} from './exec.js';
import type { LoopDeps } from './loop.js';
import { loadTask as loadHostTask } from './hosts/tasks.js';
import { reconcileTask as reconcileHostTask } from './hosts/reconcile.js';
import { backgroundSpawnOptions } from './platform/process.js';
import { getBinaryPath, isVersionInstalled, resolveVersion } from './versions.js';
import {
  getConfiguredRunStrategy,
  resolveRunVersion,
  rotationFailoverChain,
  readinessFromCandidate,
  type RotateResult,
} from './rotate.js';

/** Result of a completed job execution, including metadata and optional report. */
export interface RunResult {
  meta: RunMeta;
  reportPath: string | null;
}

/** CLI command templates per agent, with {prompt} as a placeholder. */
const AGENT_COMMANDS: Record<string, string[]> = {
  claude: ['claude', '-p', '--verbose', '{prompt}', '--output-format', 'stream-json', '--permission-mode', 'plan'],
  codex: ['codex', 'exec', '--sandbox', 'workspace-write', '{prompt}', '--json'],
  gemini: ['gemini', '{prompt}', '--output-format', 'stream-json'],
  kimi: ['kimi', '--prompt', '{prompt}', '--output-format', 'stream-json'],
  droid: ['droid', 'exec', '{prompt}', '-o', 'stream-json'],
};

/** Build the full CLI argv for executing a job, applying mode, model, and permission flags. */
export function buildJobCommand(config: JobConfig, resolvedPrompt: string): string[] {
  // Workflow branch: delegate to `agents run <workflow>` which handles subagent
  // injection, WORKFLOW.md orchestration, and model selection via frontmatter.
  // appendModelAndReasoning is intentionally skipped — the workflow frontmatter
  // owns model selection. No --timeout flag: the runner enforces its own SIGTERM/SIGKILL.
  if (config.workflow) {
    const cmd = ['agents', 'run', config.workflow, resolvedPrompt, '--mode', config.mode];
    return cmd;
  }

  // Past the workflow branch this is an agent (or resume) job — command jobs never
  // reach buildJobCommand (execute*Job branches out first), and validateJob guarantees agent.
  const agent = config.agent!;

  // Resume branch: reopen an EXISTING session via `agents run <agent> --resume <id>`
  // instead of starting fresh. The real session resumes with its full prior context
  // (index-based lookup, cwd-independent) and `resolvedPrompt` becomes its next turn —
  // so a self-scheduled wake (e.g. /hibernate) is handled by the session that scheduled
  // it, not a fresh, context-less agent that would refuse an "opaque" instruction.
  if (config.resume) {
    return ['agents', 'run', agent, '--resume', config.resume, resolvedPrompt, '--mode', config.mode];
  }

  const template = AGENT_COMMANDS[agent];
  if (!template) {
    throw new Error(`Unsupported agent for daemon jobs: ${agent}`);
  }

  let cmd = template.map((part) => part.replace('{prompt}', resolvedPrompt));

  // Canonicalize mode (accepts legacy `full` as alias for `skip`).
  const mode = normalizeMode(config.mode);

  if (config.agent === 'claude') {
    if (mode === 'edit') {
      const planIndex = cmd.indexOf('plan');
      if (planIndex !== -1) cmd[planIndex] = 'acceptEdits';
    } else if (mode === 'auto') {
      const planIndex = cmd.indexOf('plan');
      if (planIndex !== -1) cmd[planIndex] = 'auto';
    } else if (mode === 'skip') {
      // Replace --permission-mode plan with --dangerously-skip-permissions
      const pmIndex = cmd.indexOf('--permission-mode');
      if (pmIndex !== -1) cmd.splice(pmIndex, 2, '--dangerously-skip-permissions');
    }

    if (config.allow?.dirs) {
      for (const dir of config.allow.dirs) {
        // Reject leading '-' so a routine YAML can't smuggle an argv flag like
        // `--dangerously-skip-permissions` past the sandbox by hiding it as an
        // allow.dirs entry.
        if (dir.startsWith('-')) {
          throw new Error(`allow.dirs entries must not start with '-': ${JSON.stringify(dir)}`);
        }
        const resolved = dir.replace(/^~/, os.homedir());
        cmd.push('--add-dir', resolved);
      }
    }

    appendModelAndReasoning(cmd, config);
  }

  if (config.agent === 'codex') {
    if (mode === 'plan') {
      // The template defaults to workspace-write; plan means read-only.
      const sbIndex = cmd.indexOf('--sandbox');
      if (sbIndex !== -1) cmd[sbIndex + 1] = 'read-only';
    } else if (mode === 'edit' || mode === 'auto') {
      // Keep the workspace-write sandbox — no approval bypass; only skip drops
      // the guardrails. Re-enable network, which workspace-write turns off.
      cmd.push('-c', 'sandbox_workspace_write.network_access=true');
    } else if (mode === 'skip') {
      // Remove sandbox restriction, just --dangerously-bypass-approvals-and-sandbox
      const sbIndex = cmd.indexOf('--sandbox');
      if (sbIndex !== -1) cmd.splice(sbIndex, 2);
      cmd.push('--dangerously-bypass-approvals-and-sandbox');
    }

    appendModelAndReasoning(cmd, config);
  }

  if (config.agent === 'gemini') {
    if (mode === 'edit') {
      cmd.push('--approval-mode', 'auto_edit');
    } else if (mode === 'skip') {
      cmd.push('--yolo');
    }

    appendModelAndReasoning(cmd, config);
  }

  if (config.agent === 'kimi') {
    // kimi daemon jobs always run headless via `--prompt`, which cannot be
    // combined with any startup-mode flag (--plan/--auto/--yolo all abort with
    // "Cannot combine --prompt with --X"). edit/auto/skip reduce to kimi's default
    // headless auto-run, so emit no flag. plan has no headless read-only
    // equivalent, so resolveHeadlessMode downgrades a plan request to auto with a
    // stderr warning (kimi's headlessPlan is false) — routines run headless, so
    // interactive is always false here. The returned mode carries no flag either.
    resolveHeadlessMode('kimi', mode, false);

    appendModelAndReasoning(cmd, config);
  }

  if (config.agent === 'droid') {
    // droid exec defaults to read-only (plan). Escalate autonomy per mode.
    if (mode === 'edit') {
      cmd.push('--auto', 'low');
    } else if (mode === 'auto') {
      cmd.push('--auto', 'high');
    } else if (mode === 'skip') {
      cmd.push('--skip-permissions-unsafe');
    }

    appendModelAndReasoning(cmd, config);
  }

  return cmd;
}

/**
 * Append --model and reasoning flags to a command being assembled.
 *
 * Pass-through model resolution: validates against the installed (agent, version)
 * catalog when possible and writes a warning to stderr on miss, but never blocks.
 * Reasoning level (config.config.reasoning) maps to per-agent flags via models.ts.
 */
function appendModelAndReasoning(cmd: string[], config: JobConfig): void {
  // Only called from buildJobCommand's agent path — config.agent is set.
  const agent = config.agent!;
  const model = config.config?.model as string | undefined;
  if (model) {
    if (config.version) {
      const resolved = resolveModel(agent, config.version, model);
      if (resolved.warning) {
        process.stderr.write(`[agents] ${resolved.warning}\n`);
      }
      cmd.push('--model', resolved.forwarded);
    } else {
      cmd.push('--model', model);
    }
  }

  const reasoning = config.config?.reasoning as string | undefined;
  if (reasoning) {
    const flags = buildReasoningFlags(agent, reasoning);
    if (flags.length > 0) cmd.push(...flags);
  }
}

function generateRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Build the argv for a command-mode routine: run the shell string directly
 * through the platform shell. No agent binary, no rotation, no sandbox.
 */
function buildShellCommand(command: string): string[] {
  return process.platform === 'win32'
    ? ['cmd', '/c', command]
    : ['/bin/sh', '-c', command];
}

/**
 * Real (un-sandboxed) environment for a command routine. Command routines do
 * `npm i -g` / `git pull` and need the actual $HOME / $PATH, not the sandbox
 * overlay. Only TZ is injected when the routine pins a timezone.
 */
function commandSpawnEnv(config: JobConfig): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  if (config.timezone) env.TZ = config.timezone;
  return env;
}

/** POSIX single-quote a string so it is safe to embed in a `/bin/sh -c` script. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Detached command routines write their own exit code to `<runDir>/exit-code`
 * (see the wrapper in executeCommandJobDetached). `monitorRunningJobs` reads it
 * to recover the true terminal status when the daemon restarted between spawn and
 * exit and so missed the in-process `child.on('exit')`. Returns null when the
 * file is absent/unparseable (child killed or crashed before writing it).
 */
function readCommandExitCode(runDir: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(runDir, 'exit-code'), 'utf-8').trim();
    if (!/^-?\d+$/.test(raw)) return null;
    return parseInt(raw, 10);
  } catch {
    return null;
  }
}

/** Pre-flight version/account selection for a routine job. */
export interface RoutineLaunchPlan {
  /** Ordered attempts: primary first, then same-agent failover accounts. */
  chain: FallbackEntry[];
  /** Full rotation result when strategy selected among healthy accounts; null when pinned. */
  rotation: RotateResult | null;
  /** True when `config.version` pinned the target (no rotation). */
  pinned: boolean;
}

/**
 * Resolve the version/account chain for a routine the same way `agents run`
 * does: honor an explicit `version:` pin; otherwise use the configured run
 * strategy (default `balanced`) so credit-exhausted / rate-limited accounts
 * are skipped pre-flight, and synthesize a same-agent failover chain from the
 * other healthy accounts for mid-run rate limits.
 *
 * Workflows are left alone — `agents run <workflow>` owns selection.
 */
export async function resolveRoutineLaunch(
  config: JobConfig,
  cwd: string = process.cwd(),
): Promise<RoutineLaunchPlan> {
  if (config.workflow) {
    return { chain: [], rotation: null, pinned: false };
  }

  // resolveRoutineLaunch is only called for agent jobs (workflow returns above;
  // command jobs branch out of execute*Job before reaching this).
  const agent = config.agent!;
  if (config.version) {
    const version = config.version;
    if (!isVersionInstalled(agent, version)) {
      process.stderr.write(
        `[agents] routine ${config.name}: pinned ${agent}@${version} is not installed\n`,
      );
    }
    return {
      chain: [{ agent, version }],
      rotation: null,
      pinned: true,
    };
  }

  const strategy = getConfiguredRunStrategy(agent, cwd);
  let version: string | undefined;
  let rotation: RotateResult | null = null;
  try {
    const resolved = await resolveRunVersion(agent, strategy, cwd);
    version = resolved.version ?? undefined;
    rotation = resolved.rotation;
    if (rotation) {
      const label = rotation.picked.email
        ? `${rotation.picked.email} · ${agent}@${rotation.picked.version}`
        : `${agent}@${rotation.picked.version}`;
      const ratio = `${rotation.healthy.length} of ${rotation.healthy.length + rotation.excluded.length} healthy`;
      process.stderr.write(
        `[agents] routine ${config.name}: ${strategy} picked ${label} (${ratio})\n`,
      );
      if (rotation.excluded.length > 0) {
        const reasons = rotation.excluded
          .map((c) => {
            const r = readinessFromCandidate(c);
            const why = r.ready ? 'deduped' : r.reason;
            return `${c.agent}@${c.version}=${why}`;
          })
          .join(', ');
        process.stderr.write(
          `[agents] routine ${config.name}: skipped ${reasons}\n`,
        );
      }
    } else if (!version) {
      process.stderr.write(
        `[agents] routine ${config.name}: strategy ${strategy} found no usable ${agent} version; ` +
          `falling back to default pin\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `[agents] routine ${config.name}: strategy ${strategy} skipped: ${(err as Error).message}\n`,
    );
  }

  if (!version) {
    version = resolveVersion(agent, cwd) ?? undefined;
  }

  if (!version) {
    process.stderr.write(
      `[agents] routine ${config.name}: no version of ${agent} configured — ` +
        `run: agents add ${agent}@<version> && agents use ${agent} <version>\n`,
    );
    return { chain: [{ agent }], rotation: null, pinned: false };
  }

  const failover = rotationFailoverChain(rotation, version);
  if (failover.length > 0) {
    const labels = failover.map((f) => `${f.agent}@${f.version}`).join(', ');
    process.stderr.write(
      `[agents] routine ${config.name}: credit/rate-limit failover armed → ${labels}\n`,
    );
  }

  return {
    chain: [{ agent, version }, ...failover],
    rotation,
    pinned: false,
  };
}

/**
 * Rewrite `cmd[0]` to the absolute binary for `agent@version` when installed.
 * Bypasses the bare-name shim so a sandboxed HOME / missing default pin cannot
 * surface as "agents: no version of X configured".
 */
export function pinJobBinary(cmd: string[], agent: AgentId, version: string | undefined): string[] {
  if (!version || cmd.length === 0) return cmd;
  if (!isVersionInstalled(agent, version)) return cmd;
  const binary = getBinaryPath(agent, version);
  if (!binary || !fs.existsSync(binary)) return cmd;
  const next = [...cmd];
  next[0] = binary;
  return next;
}

/**
 * Whether a job's command is dispatched through `agents run` (so `cmd[0] === 'agents'`)
 * rather than the agent binary directly. True for workflow jobs and for resume jobs.
 * Such commands must NOT be binary-pinned (pinning rewrites cmd[0] to the agent binary,
 * producing a broken `<binary> run …`) and must not receive a version-pinned spawn env.
 */
export function dispatchesViaAgentsRun(config: Pick<JobConfig, 'workflow' | 'resume'>): boolean {
  return Boolean(config.workflow || config.resume);
}

/**
 * Merge sandbox/base env with the canonical per-version exec env
 * (CLAUDE_CONFIG_DIR / CODEX_HOME / …) so routines share account isolation
 * with `agents run`.
 */
export function buildRoutineSpawnEnv(
  baseEnv: Record<string, string>,
  agent: AgentId,
  version: string | undefined,
  timezone?: string,
): Record<string, string> {
  const execEnv = buildExecEnv({
    agent,
    version,
    mode: 'plan',
    effort: 'auto',
    headless: true,
    env: baseEnv,
  });
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(execEnv)) {
    if (v !== undefined) out[k] = v;
  }
  if (timezone) out.TZ = timezone;
  return out;
}

/** One spawn attempt result for the single-shot executeJob path. */
interface SpawnAttemptResult {
  exitCode: number | null;
  status: 'completed' | 'failed' | 'timeout';
  error?: string;
  /** Combined log content (stdout+stderr) for rate-limit scanning. */
  logText: string;
  pid: number | null;
}

/**
 * Spawn one attempt, capture logs to `attemptLogPath`, enforce timeout.
 * Rate-limit scanning uses only this attempt's log (not prior failover output).
 * The attempt log is also appended into `combinedLogPath` for a continuous trail.
 */
function spawnJobAttempt(
  cmd: string[],
  env: Record<string, string>,
  attemptLogPath: string,
  timeoutMs: number,
  combinedLogPath?: string,
): Promise<SpawnAttemptResult> {
  // Isolate this attempt's output so detectRateLimit never sees prior attempts.
  fs.writeFileSync(attemptLogPath, '', { mode: 0o600 });
  const stdoutFd = fs.openSync(attemptLogPath, 'a', 0o600);
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      stdio: ['ignore', stdoutFd, stdoutFd],
      ...backgroundSpawnOptions({ fdStdio: true }),
      env,
    });

    let settled = false;
    const finish = (result: SpawnAttemptResult) => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(stdoutFd); } catch { /* fd already closed */ }
      let logText = '';
      try {
        logText = fs.readFileSync(attemptLogPath, 'utf-8');
      } catch { /* missing log */ }
      if (combinedLogPath) {
        try {
          fs.appendFileSync(combinedLogPath, logText);
        } catch { /* best-effort trail */ }
      }
      resolve({ ...result, logText });
    };

    const timeoutTimer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch { /* process already exited */ }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch { /* process already exited */ }
      }, 5000);
      finish({
        exitCode: null,
        status: 'timeout',
        pid: child.pid || null,
        logText: '',
      });
    }, timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timeoutTimer);
      finish({
        exitCode: code,
        status: code === 0 ? 'completed' : 'failed',
        pid: child.pid || null,
        logText: '',
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeoutTimer);
      finish({
        exitCode: 1,
        status: 'failed',
        error: err.message,
        pid: child.pid || null,
        logText: '',
      });
    });

    child.unref();
  });
}

/**
 * Execute a job synchronously (waits for completion or timeout before resolving).
 *
 * When `config.loop` is set the job is routed through the loop driver (`runLoop`
 * from loop.ts) instead of a single spawn — same driver as `agents run --loop` and
 * workflow `loop:` blocks (issue #400). The optional `deps` parameter provides
 * injectable seams (runIteration, sleep, writeCheckpoint) used by tests; production
 * callers omit it and get the defaults.
 *
 * Single-shot path: pre-flight version/account selection + mid-run rate-limit
 * failover across healthy same-agent accounts (RUSH-1016).
 */
export async function executeJob(config: JobConfig, deps?: LoopDeps): Promise<RunResult> {
  const eligibility = checkJobDeviceEligibility(config);
  if (eligibility) {
    throw new Error(eligibility.message);
  }
  // `host:` placement — the job body runs on another machine over SSH; local
  // version selection / sandbox / spawn do not apply. Sync callers (manual
  // `routines run`, catchup) follow the remote run to completion.
  if (config.host) {
    return executeJobOnHost(config, { detached: false });
  }

  // Command-mode: run a plain shell command directly (no agent, no rotation,
  // no pinning, no sandbox overlay). Reuses the run-record machinery so
  // list/runs/overdue keep working.
  if (config.command) {
    return executeCommandJobForeground(config);
  }

  maybeRotate();

  const launch = await resolveRoutineLaunch(config);
  const primaryVersion = launch.chain[0]?.version ?? config.version;

  const timer = createTimer('agent.run', {
    agent: config.agent,
    version: primaryVersion,
    jobName: config.name,
    mode: config.mode,
    ...redactPrompt(config.prompt),
    schedule: config.schedule,
  });

  const resolvedPrompt = resolveJobPrompt(config);

  // Resume must run against the REAL home: `--resume <id>` resolves the session from
  // the agent's config dir, and the sandbox overlay home has only a freshly-generated
  // config with no session store. So a resume job is never sandboxed, regardless of
  // `config.sandbox` (see the resume branch in buildJobCommand).
  const useSandbox = config.sandbox !== false && !config.resume;
  const overlayHome = useSandbox ? prepareJobHome(config) : undefined;

  const runId = generateRunId();
  const runDir = getRunDir(config.name, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const baseEnv = useSandbox
    ? buildSpawnEnv(overlayHome!)
    : { ...process.env } as Record<string, string>;

  // Workflows run via `agents run <workflow>` which delegates to claude under the hood.
  // Use 'claude' as the effective agent for report extraction and metadata when workflow is set.
  // (command jobs branched out earlier, so config.agent is set on the non-workflow path.)
  const effectiveAgent: AgentId = config.workflow ? 'claude' : config.agent!;

  const meta: RunMeta = {
    jobName: config.name,
    runId,
    agent: effectiveAgent,
    ...(config.workflow ? { workflow: config.workflow } : {}),
    pid: null,
    spawnedAt: Date.now(),
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    exitCode: null,
  };
  writeRunMeta(meta);

  const timeoutMs = parseTimeout(config.timeout) || 10 * 60 * 1000;

  // Loop path: delegate to runLoop (same driver as `agents run --loop` / workflow loop:).
  if (config.loop) {
    const spawnEnv = buildRoutineSpawnEnv(baseEnv, effectiveAgent, primaryVersion, config.timezone);
    const execOptions: ExecOptions = {
      agent: effectiveAgent,
      version: primaryVersion,
      prompt: resolvedPrompt,
      mode: normalizeMode(config.mode),
      effort: config.effort as ExecEffort,
      env: spawnEnv,
      json: true,
      headless: true,
      ...(config.config?.model ? { model: config.config.model as string } : {}),
      ...(config.allow?.dirs ? {
        addDirs: config.allow.dirs
          .filter((d) => !d.startsWith('-'))
          .map((d) => d.replace(/^~/, os.homedir())),
      } : {}),
    };
    const { runLoop } = await import('./loop.js');
    const loopResult = await runLoop(execOptions, config.loop, {
      runId,
      runDir,
      agent: effectiveAgent,
      version: primaryVersion,
    }, deps);
    meta.status = loopResult.stoppedBy === 'error' ? 'failed' : 'completed';
    meta.completedAt = new Date().toISOString();
    meta.exitCode = loopResult.stoppedBy === 'error' ? 1 : 0;
    writeRunMeta(meta);
    timer.end({ status: meta.status, exitCode: meta.exitCode ?? undefined, runId });
    return { meta, reportPath: null };
  }

  // Single-shot path: build the command once, then walk the launch chain on
  // rate/usage-limit failures (same detectRateLimit patterns as agents run).
  const baseCmd = buildJobCommand(config, resolvedPrompt);
  const stdoutPath = path.join(runDir, 'stdout.log');
  // Truncate the log for a clean run; failover attempts append.
  fs.writeFileSync(stdoutPath, '', { mode: 0o600 });

  const chain: FallbackEntry[] = launch.chain.length > 0
    ? launch.chain
    : [{ agent: effectiveAgent, version: primaryVersion }];

  timer.mark('startup');

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    const attemptAgent = entry.agent;
    const attemptVersion = entry.version;
    const label = attemptVersion ? `${attemptAgent}@${attemptVersion}` : attemptAgent;

    if (i === 0) {
      process.stderr.write(`[agents] routine ${config.name}: running ${label}\n`);
    }

    const viaAgentsRun = dispatchesViaAgentsRun(config);
    const cmd = viaAgentsRun
      ? baseCmd
      : pinJobBinary(baseCmd, attemptAgent, attemptVersion);
    const spawnEnv = viaAgentsRun
      ? (() => {
          const e = { ...baseEnv };
          if (config.timezone) e.TZ = config.timezone;
          return e;
        })()
      : buildRoutineSpawnEnv(baseEnv, attemptAgent, attemptVersion, config.timezone);

    // Remaining timeout budget shared across failover attempts.
    const elapsed = Date.now() - Date.parse(meta.startedAt);
    const remaining = Math.max(1_000, timeoutMs - (Number.isFinite(elapsed) ? elapsed : 0));

    const attemptLogPath = path.join(runDir, `stdout.attempt-${i}.log`);
    const attempt = await spawnJobAttempt(cmd, spawnEnv, attemptLogPath, remaining, stdoutPath);
    meta.pid = attempt.pid;
    writeRunMeta(meta);

    if (attempt.status === 'timeout') {
      meta.status = 'timeout';
      meta.completedAt = new Date().toISOString();
      writeRunMeta(meta);
      timer.end({ status: 'timeout', runId });
      const reportPath = extractAndSaveReport(stdoutPath, effectiveAgent, runDir);
      return { meta, reportPath };
    }

    if (attempt.status === 'completed') {
      meta.exitCode = 0;
      meta.status = 'completed';
      meta.completedAt = new Date().toISOString();
      writeRunMeta(meta);
      timer.end({ status: 'completed', exitCode: 0, runId });
      const reportPath = extractAndSaveReport(stdoutPath, effectiveAgent, runDir);
      return { meta, reportPath };
    }

    // Failed — cascade only on rate/usage limit when more chain entries remain.
    const isLast = i === chain.length - 1;
    const rateLimited = detectRateLimit(attempt.logText) || (attempt.error ? detectRateLimit(attempt.error) : false);
    if (!isLast && rateLimited) {
      const next = chain[i + 1];
      const nextLabel = next.version ? `${next.agent}@${next.version}` : next.agent;
      process.stderr.write(
        `[agents] routine ${config.name}: ${label} failed with credit/rate limit, trying ${nextLabel}\n`,
      );
      fs.appendFileSync(
        stdoutPath,
        `\n[agents] ${label} hit rate/usage limit — failover → ${nextLabel}\n`,
      );
      continue;
    }

    if (attempt.error) {
      process.stderr.write(
        `[agents] routine ${config.name}: spawn failed for ${label}: ${attempt.error}\n`,
      );
    }

    meta.exitCode = attempt.exitCode ?? 1;
    meta.status = 'failed';
    meta.completedAt = new Date().toISOString();
    writeRunMeta(meta);
    timer.end({
      status: 'failed',
      exitCode: meta.exitCode ?? undefined,
      runId,
      ...(attempt.error ? { error: attempt.error } : {}),
    });
    const reportPath = extractAndSaveReport(stdoutPath, effectiveAgent, runDir);
    return { meta, reportPath };
  }

  // Unreachable: chain is always non-empty, but keep a safe fallback.
  meta.status = 'failed';
  meta.exitCode = 1;
  meta.completedAt = new Date().toISOString();
  writeRunMeta(meta);
  timer.end({ status: 'failed', exitCode: 1, runId });
  return { meta, reportPath: null };
}

async function executeJobOnHost(config: JobConfig, opts: { detached: boolean }): Promise<RunResult> {
  if (config.workflow) {
    throw new Error(`Routine '${config.name}' runs a workflow bundle, which can't execute on a host yet — remove 'host:' or 'workflow:'.`);
  }
  if (config.loop) {
    throw new Error(`Routine '${config.name}' uses 'loop:', which can't execute on a host yet — remove 'host:' or 'loop:'.`);
  }
  if (config.command) {
    throw new Error(`Routine '${config.name}' uses 'command:', which can't execute on a host yet — remove 'host:' or 'command:'.`);
  }
  const { resolveHostRunTarget, dispatchPromptToHost } = await import('./hosts/run-target.js');
  const host = await resolveHostRunTarget(config.host!);

  const timer = createTimer('agent.run', {
    agent: config.agent,
    jobName: config.name,
    mode: config.mode,
    host: host.name,
    ...redactPrompt(config.prompt),
    schedule: config.schedule,
  });

  const runId = generateRunId();
  const runDir = getRunDir(config.name, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const meta: RunMeta = {
    jobName: config.name,
    runId,
    agent: config.agent,
    pid: null, // no local process — the run lives on the host
    spawnedAt: Date.now(),
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    exitCode: null,
    host: host.name,
  };
  writeRunMeta(meta);

  const { task, exitCode } = await dispatchPromptToHost(host, {
    agent: config.agent!,
    prompt: resolveJobPrompt(config),
    mode: normalizeMode(config.mode),
    effort: config.effort,
    model: config.config?.model as string | undefined,
    timeout: config.timeout, // enforced by the REMOTE agents run
    remoteCwd: config.remoteCwd,
    name: config.name,
    cwd: runDir,
    follow: !opts.detached,
  });
  meta.hostTaskId = task.id;

  // Sync path: a real exit code finalizes now. -1 (follow window closed) and
  // the detached path leave the meta `running` for the monitor to reconcile.
  if (!opts.detached && exitCode !== null && exitCode !== undefined && exitCode !== -1) {
    meta.status = exitCode === 0 ? 'completed' : 'failed';
    meta.exitCode = exitCode;
    meta.completedAt = new Date().toISOString();
  }
  writeRunMeta(meta);
  timer.end({ status: meta.status, exitCode: meta.exitCode ?? undefined, runId });
  return { meta, reportPath: null };
}

/** Spawn a job as a detached process and return immediately with run metadata. */

async function executeCommandJobForeground(config: JobConfig): Promise<RunResult> {
  const timer = createTimer('agent.run', {
    jobName: config.name,
    mode: config.mode,
    schedule: config.schedule,
  });

  const runId = generateRunId();
  const runDir = getRunDir(config.name, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const stdoutPath = path.join(runDir, 'stdout.log');
  const stdoutFd = fs.openSync(stdoutPath, 'w', 0o600);

  const meta: RunMeta = {
    jobName: config.name,
    runId,
    command: config.command,
    pid: null,
    spawnedAt: Date.now(),
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    exitCode: null,
  };
  writeRunMeta(meta);

  const timeoutMs = parseTimeout(config.timeout) || 10 * 60 * 1000;
  const cmd = buildShellCommand(config.command!);
  const env = commandSpawnEnv(config);

  process.stderr.write(`[agents] routine ${config.name}: running command\n`);

  const result = await new Promise<{ exitCode: number | null; status: 'completed' | 'failed' | 'timeout'; error?: string }>((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      stdio: ['ignore', stdoutFd, stdoutFd],
      ...backgroundSpawnOptions({ fdStdio: true }),
      env,
    });

    meta.pid = child.pid || null;
    writeRunMeta(meta);

    let settled = false;
    const finish = (r: { exitCode: number | null; status: 'completed' | 'failed' | 'timeout'; error?: string }) => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(stdoutFd); } catch { /* fd already closed */ }
      resolve(r);
    };

    const timeoutTimer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch { /* process already exited */ }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch { /* process already exited */ }
      }, 5000);
      finish({ exitCode: null, status: 'timeout' });
    }, timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timeoutTimer);
      finish({ exitCode: code, status: code === 0 ? 'completed' : 'failed' });
    });

    child.on('error', (err) => {
      clearTimeout(timeoutTimer);
      finish({ exitCode: 1, status: 'failed', error: err.message });
    });
  });

  meta.status = result.status;
  meta.exitCode = result.exitCode ?? (result.status === 'completed' ? 0 : 1);
  meta.completedAt = new Date().toISOString();
  writeRunMeta(meta);

  if (result.error) {
    process.stderr.write(`[agents] routine ${config.name}: command spawn failed: ${result.error}\n`);
  }
  timer.end({
    status: meta.status,
    exitCode: meta.exitCode ?? undefined,
    runId,
    ...(result.error ? { error: result.error } : {}),
  });

  return { meta, reportPath: null };
}

/** Spawn a job as a detached process and return immediately with run metadata. */

/** Spawn a job as a detached process and return immediately with run metadata. */
export async function executeJobDetached(config: JobConfig): Promise<RunMeta> {
  const eligibility = checkJobDeviceEligibility(config);
  if (eligibility) {
    process.stderr.write(`[agents] daemon: skipping '${config.name}' — ${eligibility.message}\n`);
    throw new Error(eligibility.message);
  }
  // `host:` placement — dispatch over SSH and return; the monitor finalizes.
  if (config.host) {
    const { meta } = await executeJobOnHost(config, { detached: true });
    return meta;
  }

  // Command-mode: fire a plain shell command detached (no agent, no rotation,
  // no pinning, no sandbox overlay). Still writes a run record so the daemon,
  // list/runs, and overdue tracking keep working.
  if (config.command) {
    return executeCommandJobDetached(config);
  }

  // Pre-flight: pick a healthy version/account so the daemon does not launch
  // into a credit-exhausted install. Detached cannot mid-run failover (no exit
  // wait); the next schedule tick re-selects if this attempt still fails.
  const launch = await resolveRoutineLaunch(config);
  const version = launch.chain[0]?.version ?? config.version;

  const resolvedPrompt = resolveJobPrompt(config);
  let cmd = buildJobCommand(config, resolvedPrompt);
  // workflow AND resume dispatch through `agents run` — never binary-pin them (pinning
  // rewrites cmd[0] to the agent binary → broken `<binary> run …`).
  if (!dispatchesViaAgentsRun(config) && version && config.agent) {
    cmd = pinJobBinary(cmd, config.agent, version);
  }

  // Resume must run against the REAL home: `--resume <id>` resolves the session from
  // the agent's config dir, and the sandbox overlay home has only a freshly-generated
  // config with no session store. So a resume job is never sandboxed, regardless of
  // `config.sandbox` (see the resume branch in buildJobCommand).
  const useSandbox = config.sandbox !== false && !config.resume;
  const overlayHome = useSandbox ? prepareJobHome(config) : undefined;

  const runId = generateRunId();
  const runDir = getRunDir(config.name, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const stdoutPath = path.join(runDir, 'stdout.log');
  const stdoutFd = fs.openSync(stdoutPath, 'w', 0o600);

  const baseEnv = useSandbox
    ? buildSpawnEnv(overlayHome!)
    : { ...process.env } as Record<string, string>;
  const spawnEnv = dispatchesViaAgentsRun(config)
    ? (() => {
        const e = { ...baseEnv };
        if (config.timezone) e.TZ = config.timezone;
        return e;
      })()
    // Non-command path only: config.agent is always set here (command/workflow branch earlier).
    : buildRoutineSpawnEnv(baseEnv, config.agent!, version, config.timezone);

  const effectiveAgent: AgentId = config.workflow ? 'claude' : config.agent!;

  const meta: RunMeta = {
    jobName: config.name,
    runId,
    agent: effectiveAgent,
    ...(config.workflow ? { workflow: config.workflow } : {}),
    pid: null,
    spawnedAt: Date.now(),
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    exitCode: null,
  };

  const child = spawn(cmd[0], cmd.slice(1), {
    stdio: ['ignore', stdoutFd, stdoutFd],
    ...backgroundSpawnOptions({ fdStdio: true }),
    env: spawnEnv,
  });

  child.on('error', (err) => {
    try { fs.closeSync(stdoutFd); } catch { /* fd already closed */ }
    meta.status = 'failed';
    meta.exitCode = 1;
    meta.completedAt = new Date().toISOString();
    writeRunMeta(meta);
    process.stderr.write(`[agents] daemon: spawn failed for job "${config.name}": ${err.message}\n`);
  });

  child.unref();
  try { fs.closeSync(stdoutFd); } catch { /* fd already closed */ }

  meta.pid = child.pid || null;
  writeRunMeta(meta);

  return meta;
}

/**
 * Detached (fire-and-forget) execution for a command-mode routine. Mirrors the
 * agent detached flow: write an initial running record, spawn the shell command
 * un-sandboxed, unref, then record the pid. The daemon does not wait for exit;
 * `monitorRunningJobs` reaps the record on the next tick.
 */
function executeCommandJobDetached(config: JobConfig): RunMeta {
  const runId = generateRunId();
  const runDir = getRunDir(config.name, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const stdoutPath = path.join(runDir, 'stdout.log');
  const stdoutFd = fs.openSync(stdoutPath, 'w', 0o600);

  // Wrap the shell so the child records its own exit code to <runDir>/exit-code.
  // The in-process `child.on('exit')` below writes the terminal record while the
  // daemon is alive (the common case); the file lets monitorRunningJobs recover
  // the real status if the daemon restarted between spawn and exit. (win32 relies
  // on the exit event only.)
  const exitCodePath = path.join(runDir, 'exit-code');
  // Run the command in a SUBSHELL `( … )` so that if it calls `exit`, only the
  // subshell exits — the outer shell still captures `$?` and writes the file.
  const cmd = process.platform === 'win32'
    ? buildShellCommand(config.command!)
    : ['/bin/sh', '-c',
        `(\n${config.command!}\n)\n__ac_rc=$?; printf '%s' "$__ac_rc" > ${shSingleQuote(exitCodePath)} 2>/dev/null; exit $__ac_rc`];
  const env = commandSpawnEnv(config);

  const meta: RunMeta = {
    jobName: config.name,
    runId,
    command: config.command,
    pid: null,
    spawnedAt: Date.now(),
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    exitCode: null,
  };

  const child = spawn(cmd[0], cmd.slice(1), {
    stdio: ['ignore', stdoutFd, stdoutFd],
    ...backgroundSpawnOptions({ fdStdio: true }),
    env,
  });

  // Record the real terminal status ourselves — the daemon stays alive after this
  // fire-and-forget call, so the exit event fires here. (monitorRunningJobs no
  // longer force-fails command jobs; it reads exit-code only on the restart edge.)
  let settled = false;
  const settle = (status: RunMeta['status'], exitCode: number) => {
    if (settled) return;
    settled = true;
    meta.status = status;
    meta.exitCode = exitCode;
    meta.completedAt = new Date().toISOString();
    writeRunMeta(meta);
  };
  child.on('exit', (code) => settle(code === 0 ? 'completed' : 'failed', code ?? 1));
  child.on('error', (err) => {
    settle('failed', 1);
    process.stderr.write(`[agents] daemon: command spawn failed for job "${config.name}": ${err.message}\n`);
  });

  child.unref();
  try { fs.closeSync(stdoutFd); } catch { /* fd already closed */ }

  meta.pid = child.pid || null;
  writeRunMeta(meta);

  return meta;
}

function extractAndSaveReport(
  stdoutPath: string,
  agentType: AgentId,
  runDir: string
): string | null {
  try {
    const report = extractReport(stdoutPath, agentType);
    if (report) {
      const reportPath = path.join(runDir, 'report.md');
      fs.writeFileSync(reportPath, report, 'utf-8');
      return reportPath;
    }
  } catch (err: any) {
    if (process.env.AGENTS_DEBUG) {
      console.error(`[debug] Could not extract report: ${err.message}`);
    }
  }
  return null;
}

/** Extract the final assistant message from a stream-JSON log file as a markdown report. */
export function extractReport(stdoutPath: string, agentType: AgentId): string | null {
  if (!fs.existsSync(stdoutPath)) return null;

  try {
    const content = fs.readFileSync(stdoutPath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());

    let lastMessage = '';

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);

        if (agentType === 'claude') {
          if (parsed.type === 'assistant' && parsed.message?.content) {
            for (const block of parsed.message.content) {
              if (block.type === 'text' && block.text) {
                lastMessage = block.text;
              }
            }
          }
        }

        if (agentType === 'codex') {
          if (parsed.type === 'message' && parsed.content) {
            lastMessage = typeof parsed.content === 'string'
              ? parsed.content
              : JSON.stringify(parsed.content);
          }
        }

        if (agentType === 'gemini') {
          if (parsed.type === 'text' && parsed.text) {
            lastMessage = parsed.text;
          }
        }
      } catch { /* malformed JSONL line */ }
    }

    return lastMessage || null;
  } catch {
    return null;
  }
}

/** Derive the final status of a detached run by reading the agent's stream-json
 *  tail. Detached children fire-and-forget, so we never see their exit code
 *  directly — but Claude's stream-json terminates with a `type: result` line
 *  that carries `is_error`. If we find it, the run completed cleanly (modulo
 *  agent-reported error). If not, the process likely died mid-stream and the
 *  caller should treat the run as failed. */
function inferFinalStatusFromLog(
  stdoutPath: string,
  agent: AgentId,
): { status: 'completed' | 'failed'; exitCode: number } | null {
  if (!fs.existsSync(stdoutPath)) return null;
  try {
    const content = fs.readFileSync(stdoutPath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    // Walk backwards over the last few lines — the result marker is always
    // at the tail. Cap the scan so a huge stdout doesn't iterate forever.
    for (let i = lines.length - 1, scanned = 0; i >= 0 && scanned < 20; i--, scanned++) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (agent === 'claude' && parsed.type === 'result') {
          return parsed.is_error
            ? { status: 'failed', exitCode: 1 }
            : { status: 'completed', exitCode: 0 };
        }
      } catch {
        // malformed JSONL line — keep scanning
      }
    }
    return null;
  } catch {
    return null;
  }
}

const MAX_WALL_CLOCK_MS = 24 * 60 * 60 * 1000;

/**
 * Verify that a PID still belongs to the process we spawned, not a recycled
 * OS PID. Uses the recorded `spawnedAt` (epoch ms) from meta.json and
 * compares against the process's actual start time via `ps`. Returns true
 * when the PID is alive AND plausibly ours.
 */
function isPidOurs(pid: number, spawnedAt: number | undefined): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (spawnedAt === undefined) return true;
  if (process.platform === 'win32') return true;
  try {
    const etime = execFileSync('ps', ['-p', String(pid), '-o', 'etime='],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!etime) return true;
    const parts = etime.replace(/-/g, ':').split(':').reverse();
    let uptimeSec = 0;
    if (parts[0]) uptimeSec += parseInt(parts[0], 10);
    if (parts[1]) uptimeSec += parseInt(parts[1], 10) * 60;
    if (parts[2]) uptimeSec += parseInt(parts[2], 10) * 3600;
    if (parts[3]) uptimeSec += parseInt(parts[3], 10) * 86400;
    const processStartMs = Date.now() - uptimeSec * 1000;
    return Math.abs(processStartMs - spawnedAt) < 30_000;
  } catch {
    return true;
  }
}

/**
 * Finalize one `host:`-placed run by healing its host-task sidecar against the
 * remote `.exit` (lib/hosts/reconcile.ts). Mutates + persists the meta only
 * when the sidecar reached a terminal state.
 */
function finalizeHostRun(meta: RunMeta): void {
  try {
    const task = loadHostTask(meta.hostTaskId!);
    if (!task) return;
    const healed = reconcileHostTask(task);
    if (healed.status !== 'completed' && healed.status !== 'failed') return;
    meta.status = healed.status;
    meta.exitCode = healed.exitCode ?? (healed.status === 'completed' ? 0 : 1);
    meta.completedAt = healed.finishedAt ?? new Date().toISOString();
    writeRunMeta(meta);
  } catch { /* unreachable host or unreadable sidecar — retry next sweep */ }
}

/** Scan all runs marked "running" and finalize any whose process has exited. */
export function monitorRunningJobs(): void {
  const runsDir = getRunsDir();
  if (!fs.existsSync(runsDir)) return;

  const jobDirs = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory());

  for (const jobDir of jobDirs) {
    const jobRunsPath = path.join(runsDir, jobDir.name);
    const runDirs = fs.readdirSync(jobRunsPath, { withFileTypes: true })
      .filter((e) => e.isDirectory());

    for (const runDirEntry of runDirs) {
      const metaPath = path.join(jobRunsPath, runDirEntry.name, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;

      try {
        const meta: RunMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (meta.status !== 'running') continue;

        // `host:`-placed run — no local pid to watch. Reconcile against the
        // remote `.exit` (completion is confirmed, never guessed: an
        // unreachable host leaves the run `running` for the next sweep).
        if (meta.hostTaskId) {
          finalizeHostRun(meta);
          continue;
        }

        if (!meta.pid) continue;

        const runDirPath = path.join(jobRunsPath, runDirEntry.name);
        const stdoutPath = path.join(runDirPath, 'stdout.log');

        // Command-mode records carry no agent; there is no stream-json report to
        // parse or extract. Reap them on pid liveness alone.
        const isCommandRun = Boolean(meta.command) || !meta.agent;

        const wallClockMs = Date.now() - Date.parse(meta.startedAt);
        if (Number.isFinite(wallClockMs) && wallClockMs > MAX_WALL_CLOCK_MS) {
          meta.status = 'timeout';
          meta.completedAt = new Date().toISOString();
          writeRunMeta(meta);
          if (!isCommandRun) extractAndSaveReport(stdoutPath, meta.agent!, runDirPath);
          continue;
        }

        if (!isPidOurs(meta.pid, meta.spawnedAt)) {
          if (isCommandRun) {
            // Command routines normally record their own terminal status via
            // child.on('exit') (so this record would already be non-'running' and
            // skipped above). Reaching here means the daemon restarted mid-run and
            // missed the exit event — recover the true code from the exit-code file
            // the child wrote; its absence means the child was killed/crashed.
            const ec = readCommandExitCode(runDirPath);
            meta.status = ec === 0 ? 'completed' : 'failed';
            meta.exitCode = ec;
          } else {
            const inferred = inferFinalStatusFromLog(stdoutPath, meta.agent!);
            if (inferred) {
              meta.status = inferred.status;
              meta.exitCode = inferred.exitCode;
            } else {
              meta.status = 'failed';
            }
          }
          meta.completedAt = new Date().toISOString();
          writeRunMeta(meta);

          if (!isCommandRun) extractAndSaveReport(stdoutPath, meta.agent!, runDirPath);
        }
      } catch { /* corrupt or unreadable meta.json */ }
    }
  }
}
