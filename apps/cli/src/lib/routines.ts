/**
 * Scheduled job (routine) configuration and run history management.
 *
 * Routines are YAML files in ~/.agents/routines/ that define recurring or
 * one-shot agent tasks. This module handles CRUD operations on job configs,
 * run metadata persistence, prompt variable expansion, and one-shot "at" time
 * scheduling.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { Cron } from 'croner';
import { getRoutinesDir, getRunsDir, ensureAgentsDir, getProjectRoutinesDir } from './state.js';
import { safeJoin } from './paths.js';
import type { AgentId } from './types.js';
import { ALL_AGENT_IDS } from './agents.js';
import type { LoopConfig } from './loop.js';
import { machineId, normalizeHost } from './machine-id.js';

/** Tool/site/directory allow-list for sandboxed job execution. */
export interface JobAllowConfig {
  tools?: string[];
  sites?: string[];
  dirs?: string[];
}

/** GitHub webhook events a routine can be triggered by. */
export type GithubTriggerEvent = 'pull_request' | 'push' | 'issue_comment' | 'workflow_run';

/** Canonical set of accepted GitHub trigger events — single source for validation. */
export const GITHUB_TRIGGER_EVENTS: readonly GithubTriggerEvent[] = [
  'pull_request',
  'push',
  'issue_comment',
  'workflow_run',
];

/**
 * Map a user-facing `--on` alias to a canonical GitHub trigger event.
 * Accepts the canonical names plus friendly shortcuts (e.g. `pr`, `pr_opened`
 * → `pull_request`, `comment` → `issue_comment`). Returns null when unknown.
 */
export function normalizeTriggerEvent(input: string): GithubTriggerEvent | null {
  const key = input.trim().toLowerCase();
  const aliases: Record<string, GithubTriggerEvent> = {
    pull_request: 'pull_request',
    pr: 'pull_request',
    pr_opened: 'pull_request',
    pull: 'pull_request',
    push: 'push',
    issue_comment: 'issue_comment',
    comment: 'issue_comment',
    workflow_run: 'workflow_run',
    workflow: 'workflow_run',
  };
  return aliases[key] ?? null;
}

/**
 * Event-based fire condition for a routine — an alternative (or complement) to
 * `schedule`. Currently only `github_event`: an incoming GitHub webhook whose
 * event (and optional repo/branch) match fires the job through the same
 * dispatch path a cron fire uses. See `src/lib/triggers/webhook.ts`.
 */
export interface JobTrigger {
  type: 'github_event';
  event: GithubTriggerEvent;
  /** `owner/name` — when set, only payloads for this repo match. */
  repo?: string;
  /** git branch (ref short name) — when set, only payloads for this branch match. */
  branch?: string;
}

/**
 * Full configuration for a routine (persisted as YAML).
 *
 * A job fires on a `schedule` (cron), on a `trigger` (event/webhook), or both.
 * `schedule` remains a first-class field; trigger-only jobs omit it and are
 * skipped by the cron scheduler (they fire only via the webhook receiver).
 */
export interface JobConfig {
  name: string;
  /** Cron expression. Optional when `trigger` is set (event-only routine). */
  schedule?: string;
  /** Event/webhook fire condition. Optional when `schedule` is set. */
  trigger?: JobTrigger;
  agent: AgentId;  // required when workflow is absent
  workflow?: string;
  // 'full' is accepted as a permanent silent alias for 'skip' (see normalizeMode).
  mode: 'plan' | 'edit' | 'auto' | 'skip' | 'full';
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
  timeout: string;
  enabled: boolean;
  prompt: string;
  timezone?: string;
  repo?: string;
  /**
   * Pin this routine to one machine. `~/.agents/routines/` is synced to every
   * device via the user repo, so without a pin an enabled routine fires on
   * EVERY machine running the scheduler. When set, only the device whose
   * `machineId()` matches (normalized hostname, e.g. `yosemite-s0`) schedules,
   * fires, catches up, or counts this job as overdue; everywhere else it is
   * inert and `run` refuses with an `agents ssh` pointer.
   */
  device?: string;
  variables?: Record<string, string>;
  sandbox?: boolean;
  allow?: JobAllowConfig;
  config?: Record<string, unknown>;
  version?: string;
  runOnce?: boolean;
  // RFC3339 timestamp; routine auto-disables at the next fire on/after this time.
  endAt?: string;
  /** When set, executeJob runs this job through the loop driver instead of once. */
  loop?: LoopConfig;
}

/** Metadata for a single job execution, persisted as JSON in the run directory. */
export interface RunMeta {
  jobName: string;
  runId: string;
  agent: AgentId;  // undefined at runtime for workflow jobs
  workflow?: string;
  pid: number | null;
  /** Process birth time (epoch ms) recorded at spawn for pid-reuse detection. */
  spawnedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'timeout';
  startedAt: string;
  completedAt: string | null;
  exitCode: number | null;
}

/**
 * True when the job may execute on this machine: no `device` pin, or the pin
 * names this device. Both sides go through `normalizeHost` so `Yosemite-S0`,
 * `yosemite-s0.tailnet.ts.net`, and `yosemite-s0` all agree. Every fire path
 * (cron scheduler, webhook, catchup/overdue, manual run) gates on this.
 */
export function jobRunsOnThisDevice(config: Pick<JobConfig, 'device'>): boolean {
  if (!config.device) return true;
  return normalizeHost(config.device) === machineId();
}

/** Default values applied to every job config when fields are omitted. */
const JOB_DEFAULTS: Partial<JobConfig> = {
  mode: 'auto',
  effort: 'auto',
  timeout: '10m',
  enabled: true,
};

/**
 * List all job configs, scanning project > user routine dirs.
 * Project routines (`<project>/.agents/routines/`) shadow user routines of the
 * same name. Project discovery is opt-in via `cwd`; the daemon (which calls
 * `listJobs()` with no argument) only sees user routines.
 */
export function listJobs(cwd?: string): JobConfig[] {
  ensureAgentsDir();
  const seen = new Set<string>();
  const jobs: JobConfig[] = [];

  const dirs: string[] = [];
  if (cwd) {
    const projectDir = getProjectRoutinesDir(cwd);
    if (projectDir) dirs.push(projectDir);
  }
  dirs.push(getRoutinesDir());

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    for (const file of files) {
      const job = readJobFile(path.join(dir, file));
      if (!job) continue;
      if (seen.has(job.name)) continue;
      seen.add(job.name);
      jobs.push(job);
    }
  }
  return jobs;
}

/**
 * Read a single job config by name, checking project > user.
 * Project discovery is opt-in via `cwd`; daemon callers pass no argument and
 * only resolve user routines.
 */
export function readJob(name: string, cwd?: string): JobConfig | null {
  ensureAgentsDir();
  const dirs: string[] = [];
  if (cwd) {
    const projectDir = getProjectRoutinesDir(cwd);
    if (projectDir) dirs.push(projectDir);
  }
  dirs.push(getRoutinesDir());

  for (const dir of dirs) {
    for (const ext of ['.yml', '.yaml']) {
      const filePath = safeJoin(dir, name + ext);
      if (fs.existsSync(filePath)) {
        return readJobFile(filePath);
      }
    }
  }
  return null;
}

function readJobFile(filePath: string): JobConfig | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;

    return {
      ...JOB_DEFAULTS,
      ...parsed,
      name: parsed.name || path.basename(filePath).replace(/\.ya?ml$/, ''),
    } as JobConfig;
  } catch {
    return null;
  }
}

/** Write a job config to disk, omitting fields that match defaults. */
export function writeJob(config: JobConfig): void {
  ensureAgentsDir();
  const jobsDir = getRoutinesDir();
  const filePath = safeJoin(jobsDir, config.name + '.yml');

  const output: Record<string, unknown> = { ...config };
  if (output.mode === 'auto') delete output.mode;
  if (output.effort === 'auto') delete output.effort;
  if (output.timeout === '10m') delete output.timeout;
  if (output.enabled === true) delete output.enabled;
  if (output.runOnce === false || output.runOnce === undefined) delete output.runOnce;

  fs.writeFileSync(filePath, yaml.stringify(output), 'utf-8');
}

/** Delete a job config file by name. Returns true if the file existed. */
export function deleteJob(name: string): boolean {
  const jobsDir = getRoutinesDir();
  for (const ext of ['.yml', '.yaml']) {
    const filePath = safeJoin(jobsDir, name + ext);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  }
  return false;
}

/** Enable or disable a job by name. */
export function setJobEnabled(name: string, enabled: boolean): void {
  const job = readJob(name);
  if (!job) throw new Error(`Job '${name}' not found`);
  job.enabled = enabled;
  writeJob(job);
}

/** Validate a partial job config, returning a list of human-readable errors. */
export function validateJob(config: Partial<JobConfig>): string[] {
  const errors: string[] = [];

  if (!config.name || typeof config.name !== 'string') {
    errors.push('name is required');
  }
  const hasSchedule = Boolean(config.schedule && typeof config.schedule === 'string');
  const hasTrigger = config.trigger !== undefined;
  if (!hasSchedule && !hasTrigger) {
    errors.push('schedule (cron expression) or trigger is required');
  }
  if (config.schedule !== undefined) {
    if (typeof config.schedule !== 'string') {
      errors.push('schedule must be a cron expression string');
    } else {
      // Validate cron expression is parseable
      try {
        new Cron(config.schedule);
      } catch {
        errors.push(`invalid cron expression: "${config.schedule}"`);
      }
    }
  }
  if (config.trigger !== undefined) {
    errors.push(...validateTrigger(config.trigger));
  }
  const hasAgent = Boolean(config.agent && typeof config.agent === 'string');
  const hasWorkflow = Boolean(config.workflow && typeof config.workflow === 'string');
  if (!hasAgent && !hasWorkflow) {
    errors.push('exactly one of agent or workflow is required');
  } else if (hasAgent && hasWorkflow) {
    errors.push('exactly one of agent or workflow must be set (not both)');
  }
  if (hasAgent && config.agent && !ALL_AGENT_IDS.includes(config.agent as AgentId)) {
    errors.push(`agent must be one of: ${ALL_AGENT_IDS.join(', ')}`);
  }
  if (hasWorkflow && config.workflow) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(config.workflow)) {
      errors.push('workflow must be a lowercase alphanumeric name (hyphens and underscores allowed, e.g. autodev)');
    }
  }
  if (config.mode && !['plan', 'edit', 'auto', 'skip', 'full'].includes(config.mode)) {
    errors.push("mode must be plan, edit, auto, or skip ('full' accepted as alias for skip)");
  }
  if (config.effort && !['low', 'medium', 'high', 'xhigh', 'max', 'auto'].includes(config.effort)) {
    errors.push('effort must be low, medium, high, xhigh, max, or auto');
  }
  if (!config.prompt || typeof config.prompt !== 'string') {
    errors.push('prompt is required');
  }
  if (config.timeout && !parseTimeout(config.timeout)) {
    errors.push('timeout must be like 10m, 2h, 3d, 1w (max 1w)');
  }
  if (config.endAt !== undefined) {
    if (typeof config.endAt !== 'string' || !isParseableDate(config.endAt)) {
      errors.push('endAt must be a parseable ISO 8601 / RFC3339 timestamp (e.g., 2026-12-31T23:59:00Z)');
    }
  }
  if (config.device !== undefined) {
    if (typeof config.device !== 'string' || config.device.trim() === '') {
      errors.push('device must be a non-empty device name (as shown by `agents devices`, e.g. yosemite-s0)');
    }
  }

  return errors;
}

/** Validate a job trigger block, returning a list of human-readable errors. */
export function validateTrigger(trigger: unknown): string[] {
  const errors: string[] = [];
  if (!trigger || typeof trigger !== 'object') {
    return ['trigger must be an object'];
  }
  const t = trigger as Partial<JobTrigger>;
  if (t.type !== 'github_event') {
    errors.push("trigger.type must be 'github_event'");
  }
  if (!t.event || !GITHUB_TRIGGER_EVENTS.includes(t.event as GithubTriggerEvent)) {
    errors.push(`trigger.event must be one of: ${GITHUB_TRIGGER_EVENTS.join(', ')}`);
  }
  if (t.repo !== undefined && (typeof t.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(t.repo))) {
    errors.push('trigger.repo must be in owner/name form');
  }
  if (t.branch !== undefined && typeof t.branch !== 'string') {
    errors.push('trigger.branch must be a string');
  }
  return errors;
}

function isParseableDate(value: string): boolean {
  if (!value.trim()) return false;
  const ts = Date.parse(value);
  return Number.isFinite(ts);
}

/** True when a job's endAt has already elapsed. False when endAt is unset or in the future. */
export function isPastEndAt(config: Pick<JobConfig, 'endAt'>, now: Date = new Date()): boolean {
  if (!config.endAt) return false;
  const end = Date.parse(config.endAt);
  if (!Number.isFinite(end)) return false;
  return now.getTime() >= end;
}

/** Expand built-in and user-defined template variables in a job's prompt string. */
export function resolveJobPrompt(config: JobConfig): string {
  const now = new Date();
  const tz = config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Compute date/day/time in the job's configured timezone
  // Use Intl.DateTimeFormat to get the weekday name directly in the target timezone
  const localDayName = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now);
  const localDay = days.includes(localDayName) ? localDayName : days[now.getDay()];
  const localDate = now.toLocaleDateString('en-CA', { timeZone: tz }); // en-CA gives YYYY-MM-DD
  const localTime = now.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false }); // HH:MM:SS

  let prompt = config.prompt;

  // Built-in variables (timezone-aware)
  prompt = prompt.replace(/\{day\}/g, localDay);
  prompt = prompt.replace(/\{date\}/g, localDate);
  prompt = prompt.replace(/\{time\}/g, localTime);
  prompt = prompt.replace(/\{job_name\}/g, config.name);

  // User-defined variables
  if (config.variables) {
    for (const [key, value] of Object.entries(config.variables)) {
      prompt = prompt.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
  }

  // Last report (special handling)
  const latestRun = getLatestRun(config.name);
  if (latestRun) {
    const reportPath = path.join(getRunsDir(), config.name, latestRun.runId, 'report.md');
    if (fs.existsSync(reportPath)) {
      const report = fs.readFileSync(reportPath, 'utf-8');
      prompt = prompt.replace(/\{last_report\}/g, report);
    } else {
      prompt = prompt.replace(/\{last_report\}/g, '(no previous report)');
    }
  } else {
    prompt = prompt.replace(/\{last_report\}/g, '(no previous report)');
  }

  return prompt;
}

/** Parse a human-readable timeout string (e.g. "10m", "2h", "1h30m", "3d", "1w") into milliseconds.
 *  Accepts combinations of w (weeks), d (days), h (hours), m (minutes).
 *  Returns null if the string is empty, matches nothing, totals zero, or exceeds 1 week.
 */
export function parseTimeout(timeout: string): number | null {
  const match = timeout.match(/^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!match) return null;

  const weeks = parseInt(match[1] || '0', 10);
  const days = parseInt(match[2] || '0', 10);
  const hours = parseInt(match[3] || '0', 10);
  const minutes = parseInt(match[4] || '0', 10);

  const ms = ((weeks * 7 + days) * 24 * 60 + hours * 60 + minutes) * 60 * 1000;
  if (ms <= 0) return null;

  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000; // 604800000
  if (ms > ONE_WEEK_MS) return null;

  return ms;
}

/** List all run metadata entries for a job, sorted chronologically. */
export function listRuns(jobName: string): RunMeta[] {
  const runsDir = getRunsDir();
  const jobRunsDir = path.join(runsDir, jobName);
  if (!fs.existsSync(jobRunsDir)) return [];

  const entries = fs.readdirSync(jobRunsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const runs: RunMeta[] = [];
  for (const runId of entries) {
    const meta = readRunMeta(jobName, runId);
    if (meta) runs.push(meta);
  }
  return runs;
}

/** Get the most recent run for a job, or null if never run. */
export function getLatestRun(jobName: string): RunMeta | null {
  const runs = listRuns(jobName);
  return runs.length > 0 ? runs[runs.length - 1] : null;
}

/** Persist run metadata to its run directory as meta.json. */
export function writeRunMeta(meta: RunMeta): void {
  ensureAgentsDir();
  const runDir = path.join(getRunsDir(), meta.jobName, meta.runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

/** Read run metadata from disk. Returns null if missing or corrupt. */
export function readRunMeta(jobName: string, runId: string): RunMeta | null {
  const metaPath = path.join(getRunsDir(), jobName, runId, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as RunMeta;
  } catch {
    return null;
  }
}

/** Get the filesystem path for a specific run's directory. */
export function getRunDir(jobName: string, runId: string): string {
  return path.join(getRunsDir(), jobName, runId);
}

/** Discover routine YAML files in a repository's routines/ directory. */
export function discoverJobsFromRepo(repoPath: string): Array<{ name: string; path: string }> {
  const jobsPath = path.join(repoPath, 'routines');
  if (!fs.existsSync(jobsPath)) return [];

  return fs.readdirSync(jobsPath)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => ({
      name: f.replace(/\.ya?ml$/, ''),
      path: path.join(jobsPath, f),
    }));
}

/** Check whether a job with the given name exists on disk. */
export function jobExists(name: string): boolean {
  return readJob(name) !== null;
}

/** Get the filesystem path of a job's YAML config file, or null if not found. */
export function getJobPath(name: string): string | null {
  const jobsDir = getRoutinesDir();
  for (const ext of ['.yml', '.yaml']) {
    const filePath = safeJoin(jobsDir, name + ext);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

/**
 * Parse an "at" time string into a one-shot cron expression.
 * Supports formats like:
 * - "9:00" or "09:00" - today at 9:00 AM (or tomorrow if past)
 * - "14:30" - today at 2:30 PM
 * - "2026-02-24 09:00" - specific date and time
 * Returns null if invalid format.
 */
export function parseAtTime(atTime: string): { schedule: string; runOnce: boolean } | null {
  // Try parsing as "HH:MM" format
  const timeMatch = atTime.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1], 10);
    const minute = parseInt(timeMatch[2], 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

    const now = new Date();
    let targetDate = new Date();
    targetDate.setHours(hour, minute, 0, 0);

    // If the time has already passed today, schedule for tomorrow
    if (targetDate <= now) {
      targetDate.setDate(targetDate.getDate() + 1);
    }

    const day = targetDate.getDate();
    const month = targetDate.getMonth() + 1;
    // Cron format: minute hour day month *
    return { schedule: `${minute} ${hour} ${day} ${month} *`, runOnce: true };
  }

  // Try parsing as "YYYY-MM-DD HH:MM" format
  const dateTimeMatch = atTime.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (dateTimeMatch) {
    const year = parseInt(dateTimeMatch[1], 10);
    const month = parseInt(dateTimeMatch[2], 10);
    const day = parseInt(dateTimeMatch[3], 10);
    const hour = parseInt(dateTimeMatch[4], 10);
    const minute = parseInt(dateTimeMatch[5], 10);

    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

    // Note: croner doesn't support year, so we just use month/day
    // The job will fire on that date each year unless removed
    return { schedule: `${minute} ${hour} ${day} ${month} *`, runOnce: true };
  }

  return null;
}

/** Check if an installed job's normalized YAML matches the source file. */
export function jobContentMatches(name: string, sourcePath: string): boolean {
  const existing = readJob(name);
  if (!existing) return false;

  try {
    const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
    const sourceJob = yaml.parse(sourceContent);
    if (!sourceJob) return false;

    const existingNormalized = yaml.stringify(existing);
    const fullSource = { ...JOB_DEFAULTS, ...sourceJob, name: sourceJob.name || name };
    const sourceNormalized = yaml.stringify(fullSource);
    return existingNormalized === sourceNormalized;
  } catch {
    return false;
  }
}

/** Install a job by reading and validating a YAML source file. */
export function installJobFromSource(sourcePath: string, name: string): { success: boolean; error?: string } {
  try {
    const content = fs.readFileSync(sourcePath, 'utf-8');
    const parsed = yaml.parse(content);
    if (!parsed) return { success: false, error: 'Invalid YAML' };

    const config: JobConfig = {
      ...JOB_DEFAULTS,
      ...parsed,
      name: parsed.name || name,
    } as JobConfig;

    const errors = validateJob(config);
    if (errors.length > 0) {
      return { success: false, error: errors.join(', ') };
    }

    writeJob(config);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** List all job names that have run directories. */
export function listJobsWithRuns(): string[] {
  const runsDir = getRunsDir();
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/** Count total runs across all jobs. */
export function countAllRuns(): number {
  let total = 0;
  for (const jobName of listJobsWithRuns()) {
    total += listRuns(jobName).length;
  }
  return total;
}

/** Preview runs that would be pruned (keeping only the most recent `keep` per job). */
export function previewRunsPrune(keep: number): Array<{ jobName: string; runId: string; startedAt: string }> {
  const toPrune: Array<{ jobName: string; runId: string; startedAt: string }> = [];
  for (const jobName of listJobsWithRuns()) {
    const runs = listRuns(jobName);
    if (runs.length > keep) {
      const toRemove = runs.slice(0, runs.length - keep);
      for (const run of toRemove) {
        toPrune.push({ jobName, runId: run.runId, startedAt: run.startedAt });
      }
    }
  }
  return toPrune;
}

/** Delete old runs, keeping only the most recent `keep` per job. Returns bytes freed and run count. */
export function pruneRuns(keep: number): { deleted: number; bytesFreed: number } {
  let deleted = 0;
  let bytesFreed = 0;

  for (const jobName of listJobsWithRuns()) {
    const runs = listRuns(jobName);
    if (runs.length <= keep) continue;

    const toRemove = runs.slice(0, runs.length - keep);
    for (const run of toRemove) {
      const runDir = getRunDir(jobName, run.runId);
      bytesFreed += getDirSize(runDir);
      fs.rmSync(runDir, { recursive: true, force: true });
      deleted++;
    }
  }

  return { deleted, bytesFreed };
}

function getDirSize(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let size = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      size += getDirSize(fullPath);
    } else {
      try {
        size += fs.statSync(fullPath).size;
      } catch { /* ignore */ }
    }
  }
  return size;
}
