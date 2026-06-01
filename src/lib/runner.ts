/**
 * Job execution engine for routines.
 *
 * Builds agent-specific CLI commands from job configs, spawns them with
 * sandboxed or unsandboxed environments, captures stdout to log files,
 * enforces timeouts, and extracts the final assistant report from the
 * agent's stream-JSON output.
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

  if (config.agent === 'claude') {
    if (config.mode === 'edit') {
      const planIndex = cmd.indexOf('plan');
      if (planIndex !== -1) cmd[planIndex] = 'acceptEdits';
    } else if (config.mode === 'full') {
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
    if (config.mode === 'edit') {
      cmd.push('--full-auto');
    } else if (config.mode === 'full') {
      // Remove sandbox restriction, just --full-auto
      const sbIndex = cmd.indexOf('--sandbox');
      if (sbIndex !== -1) cmd.splice(sbIndex, 2);
      cmd.push('--full-auto');
    }

    appendModelAndReasoning(cmd, config);
  }

  if (config.agent === 'gemini') {
    if (config.mode === 'edit' || config.mode === 'full') {
      cmd.push('--yolo');
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

/** Execute a job synchronously (waits for completion or timeout before resolving). */
export async function executeJob(config: JobConfig): Promise<RunResult> {
  maybeRotate();
  const timer = createTimer('agent.run', {
    agent: config.agent,
    version: config.version,
    jobName: config.name,
    mode: config.mode,
    ...redactPrompt(config.prompt),
    schedule: config.schedule,
  });

  const resolvedPrompt = resolveJobPrompt(config);
  const cmd = buildJobCommand(config, resolvedPrompt);

  const useSandbox = config.sandbox !== false;
  const overlayHome = useSandbox ? prepareJobHome(config) : undefined;

  const runId = generateRunId();
  const runDir = getRunDir(config.name, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const stdoutPath = path.join(runDir, 'stdout.log');
  const stdoutFd = fs.openSync(stdoutPath, 'w', 0o600);

  let spawnEnv = useSandbox ? buildSpawnEnv(overlayHome!) : { ...process.env } as Record<string, string>;
  if (config.timezone) {
    spawnEnv.TZ = config.timezone;
  }

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

  return new Promise<RunResult>((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      stdio: ['ignore', stdoutFd, stdoutFd],
      detached: true,
      env: spawnEnv,
    });

    // Mark startup time (time from function call to process spawn)
    timer.mark('startup');

    meta.pid = child.pid || null;
    writeRunMeta(meta);

    let settled = false;

    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;

      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch { /* process already exited */ }

      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch { /* process already exited */ }
      }, 5000);

      meta.status = 'timeout';
      meta.completedAt = new Date().toISOString();
      writeRunMeta(meta);
      timer.end({ status: 'timeout', runId });

      const reportPath = extractAndSaveReport(stdoutPath, effectiveAgent, runDir);
      resolve({ meta, reportPath });
    }, timeoutMs);

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);

      try { fs.closeSync(stdoutFd); } catch { /* fd already closed */ }

      meta.exitCode = code;
      meta.status = code === 0 ? 'completed' : 'failed';
      meta.completedAt = new Date().toISOString();
      writeRunMeta(meta);
      timer.end({ status: meta.status, exitCode: code ?? undefined, runId });

      const reportPath = extractAndSaveReport(stdoutPath, effectiveAgent, runDir);
      resolve({ meta, reportPath });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);

      try { fs.closeSync(stdoutFd); } catch { /* fd already closed */ }

      meta.status = 'failed';
      meta.completedAt = new Date().toISOString();
      writeRunMeta(meta);
      timer.end({ status: 'failed', error: err.message, runId });
      resolve({ meta, reportPath: null });
    });

    child.unref();
  });
}

/** Spawn a job as a detached process and return immediately with run metadata. */
export async function executeJobDetached(config: JobConfig): Promise<RunMeta> {
  const resolvedPrompt = resolveJobPrompt(config);
  const cmd = buildJobCommand(config, resolvedPrompt);

  const useSandbox = config.sandbox !== false;
  const overlayHome = useSandbox ? prepareJobHome(config) : undefined;

  const runId = generateRunId();
  const runDir = getRunDir(config.name, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const stdoutPath = path.join(runDir, 'stdout.log');
  const stdoutFd = fs.openSync(stdoutPath, 'w', 0o600);

  let spawnEnv = useSandbox ? buildSpawnEnv(overlayHome!) : { ...process.env } as Record<string, string>;
  if (config.timezone) {
    spawnEnv.TZ = config.timezone;
  }

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
    detached: true,
    env: spawnEnv,
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
