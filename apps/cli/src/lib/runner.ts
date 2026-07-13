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

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { JobConfig, RunMeta } from './routines.js';
import {
  resolveJobPrompt,
  parseTimeout,
  writeRunMeta,
  getRunDir,
} from './routines.js';
import { getRunsDir } from './state.js';
import type { AgentId } from './types.js';
import { prepareJobHome, buildSpawnEnv } from './sandbox.js';
import { resolveModel, buildReasoningFlags } from './models.js';
import { createTimer, maybeRotate, redactPrompt } from './events.js';
import {
  normalizeMode,
  buildExecEnv,
  detectRateLimit,
  type ExecOptions,
  type ExecEffort,
  type FallbackEntry,
} from './exec.js';
import type { LoopDeps } from './loop.js';
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

  const template = AGENT_COMMANDS[config.agent];
  if (!template) {
    throw new Error(`Unsupported agent for daemon jobs: ${config.agent}`);
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
    // headless auto-run, so emit no flag; plan has no headless read-only
    // equivalent, so fail closed rather than silently allowing writes.
    if (mode === 'plan') {
      throw new Error(
        'kimi has no headless read-only mode: routine jobs cannot run kimi with --mode plan ' +
          '(kimi rejects --prompt + --plan). Use --mode edit, auto, or skip.',
      );
    }

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
  const model = config.config?.model as string | undefined;
  if (model) {
    if (config.version) {
      const resolved = resolveModel(config.agent, config.version, model);
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
    const flags = buildReasoningFlags(config.agent, reasoning);
    if (flags.length > 0) cmd.push(...flags);
  }
}

function generateRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
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

  const agent = config.agent;
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
 * Spawn one attempt, capture logs to `stdoutPath`, enforce timeout.
 * Appends to the log file so failover attempts leave a continuous trail.
 */
function spawnJobAttempt(
  cmd: string[],
  env: Record<string, string>,
  stdoutPath: string,
  timeoutMs: number,
): Promise<SpawnAttemptResult> {
  const stdoutFd = fs.openSync(stdoutPath, 'a', 0o600);
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
        logText = fs.readFileSync(stdoutPath, 'utf-8');
      } catch { /* missing log */ }
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

  const useSandbox = config.sandbox !== false;
  const overlayHome = useSandbox ? prepareJobHome(config) : undefined;

  const runId = generateRunId();
  const runDir = getRunDir(config.name, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const baseEnv = useSandbox
    ? buildSpawnEnv(overlayHome!)
    : { ...process.env } as Record<string, string>;

  // Workflows run via `agents run <workflow>` which delegates to claude under the hood.
  // Use 'claude' as the effective agent for report extraction and metadata when workflow is set.
  const effectiveAgent: AgentId = config.workflow ? 'claude' : config.agent;

  const meta: RunMeta = {
    jobName: config.name,
    runId,
    agent: effectiveAgent,
    ...(config.workflow ? { workflow: config.workflow } : {}),
    pid: null,
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

    const cmd = config.workflow
      ? baseCmd
      : pinJobBinary(baseCmd, attemptAgent, attemptVersion);
    const spawnEnv = config.workflow
      ? (() => {
          const e = { ...baseEnv };
          if (config.timezone) e.TZ = config.timezone;
          return e;
        })()
      : buildRoutineSpawnEnv(baseEnv, attemptAgent, attemptVersion, config.timezone);

    // Remaining timeout budget shared across failover attempts.
    const elapsed = Date.now() - Date.parse(meta.startedAt);
    const remaining = Math.max(1_000, timeoutMs - (Number.isFinite(elapsed) ? elapsed : 0));

    const attempt = await spawnJobAttempt(cmd, spawnEnv, stdoutPath, remaining);
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

/** Spawn a job as a detached process and return immediately with run metadata. */
export async function executeJobDetached(config: JobConfig): Promise<RunMeta> {
  // Pre-flight: pick a healthy version/account so the daemon does not launch
  // into a credit-exhausted install. Detached cannot mid-run failover (no exit
  // wait); the next schedule tick re-selects if this attempt still fails.
  const launch = await resolveRoutineLaunch(config);
  const version = launch.chain[0]?.version ?? config.version;

  const resolvedPrompt = resolveJobPrompt(config);
  let cmd = buildJobCommand(config, resolvedPrompt);
  if (!config.workflow && version) {
    cmd = pinJobBinary(cmd, config.agent, version);
  }

  const useSandbox = config.sandbox !== false;
  const overlayHome = useSandbox ? prepareJobHome(config) : undefined;

  const runId = generateRunId();
  const runDir = getRunDir(config.name, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const stdoutPath = path.join(runDir, 'stdout.log');
  const stdoutFd = fs.openSync(stdoutPath, 'w', 0o600);

  const baseEnv = useSandbox
    ? buildSpawnEnv(overlayHome!)
    : { ...process.env } as Record<string, string>;
  const spawnEnv = config.workflow
    ? (() => {
        const e = { ...baseEnv };
        if (config.timezone) e.TZ = config.timezone;
        return e;
      })()
    : buildRoutineSpawnEnv(baseEnv, config.agent, version, config.timezone);

  const effectiveAgent: AgentId = config.workflow ? 'claude' : config.agent;

  const meta: RunMeta = {
    jobName: config.name,
    runId,
    agent: effectiveAgent,
    ...(config.workflow ? { workflow: config.workflow } : {}),
    pid: null,
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
        if (!meta.pid) continue;

        try {
          process.kill(meta.pid, 0);
        } catch { /* process no longer running */
          const runDirPath = path.join(jobRunsPath, runDirEntry.name);
          const stdoutPath = path.join(runDirPath, 'stdout.log');

          // Prefer the agent's own success/error marker; fall back to "failed"
          // only when the stream ended without one (process killed mid-run).
          const inferred = inferFinalStatusFromLog(stdoutPath, meta.agent);
          if (inferred) {
            meta.status = inferred.status;
            meta.exitCode = inferred.exitCode;
          } else {
            meta.status = 'failed';
          }
          meta.completedAt = new Date().toISOString();
          writeRunMeta(meta);

          extractAndSaveReport(stdoutPath, meta.agent, runDirPath);
        }
      } catch { /* corrupt or unreadable meta.json */ }
    }
  }
}
