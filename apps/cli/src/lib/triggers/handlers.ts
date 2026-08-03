/**
 * Webhook handler config layer.
 *
 * Handlers are one-off triggers stored in `~/.agents/webhooks/*.yml` (plus
 * project/system layers). They complement routine triggers: a matching webhook
 * can run an agent, workflow, shell command, or delegate to a routine.
 */

import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { emit } from '../events.js';
import { machineId, normalizeHost } from '../machine-id.js';
import { safeJoin } from '../paths.js';
import type { JobConfig, RunMeta, WebhookContext } from '../routines.js';
import {
  assertShellSubstitutionSupported,
  readJob,
  substituteWebhookCommand,
  substituteWebhookPrompt,
} from '../routines.js';
import { ensureAgentsDir, getProjectWebhooksDir, getSystemWebhooksDir, getWebhooksDir } from '../state.js';
import type { AgentId } from '../types.js';
import type { IncomingWebhook, WebhookSource } from './webhook.js';

export interface WebhookHandler {
  name: string;
  enabled?: boolean;
  devices?: string[];
  source: WebhookSource;
  event?: string;
  action?: string;
  stateTo?: string;
  stateFrom?: string;
  teamKey?: string;
  label?: string;
  repo?: string;
  branch?: string;
  run?: {
    agent?: AgentId;
    workflow?: string;
    command?: string;
    prompt?: string;
  };
  routine?: string;
}

export interface FiredHandler {
  handlerName: string;
  runId?: string;
  exitCode?: number;
  output?: string;
}

const HANDLER_DEFAULTS: Partial<WebhookHandler> = {
  enabled: true,
};

/** Read `repository.full_name` (`owner/name`) from a webhook payload, if present. */
function payloadRepo(payload: Record<string, unknown>): string | null {
  const repo = payload?.repository as { full_name?: unknown } | undefined;
  const fullName = repo?.full_name;
  return typeof fullName === 'string' && fullName.length > 0 ? fullName : null;
}

/** Strip a `refs/heads/` (or `refs/tags/`) prefix to the short branch/tag name. */
function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, '');
}

/** Extract candidate branches a webhook payload references. */
function payloadBranches(event: string, payload: Record<string, unknown>): string[] {
  const branches = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.length > 0) branches.add(shortRef(v));
  };

  switch (event) {
    case 'push':
      add(payload.ref);
      break;
    case 'pull_request': {
      const pr = payload.pull_request as { base?: { ref?: unknown }; head?: { ref?: unknown } } | undefined;
      add(pr?.base?.ref);
      add(pr?.head?.ref);
      break;
    }
    case 'workflow_run': {
      const run = payload.workflow_run as { head_branch?: unknown } | undefined;
      add(run?.head_branch);
      break;
    }
    default:
      break;
  }
  return [...branches];
}

function linearAction(payload: Record<string, unknown>): string | null {
  return typeof payload.action === 'string' ? payload.action : null;
}

function linearTeamKey(payload: Record<string, unknown>): string | null {
  const data = payload.data as Record<string, unknown> | undefined;
  const identifier = data?.identifier;
  if (typeof identifier === 'string') {
    const match = /^([A-Z][A-Z0-9]*)-\d+$/.exec(identifier);
    if (match) return match[1];
  }
  const team = data?.team as { key?: unknown } | undefined;
  return typeof team?.key === 'string' ? team.key : null;
}

function linearLabels(payload: Record<string, unknown>): string[] {
  const data = payload.data as Record<string, unknown> | undefined;
  const labels = Array.isArray(data?.labels) ? (data?.labels as unknown[]) : [];
  return labels
    .map((n) => (n as { name?: unknown }).name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
}

function githubAction(payload: Record<string, unknown>): string | null {
  return typeof payload.action === 'string' ? payload.action : null;
}

function githubLabels(payload: Record<string, unknown>): string[] {
  const names = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0) names.add(value);
  };

  const deliveryLabel = payload.label as { name?: unknown } | undefined;
  add(deliveryLabel?.name);

  const pr = payload.pull_request as { labels?: unknown } | undefined;
  const prLabels = Array.isArray(pr?.labels) ? pr.labels : [];
  for (const label of prLabels) {
    add((label as { name?: unknown }).name);
  }

  const issue = payload.issue as { labels?: unknown } | undefined;
  const issueLabels = Array.isArray(issue?.labels) ? issue.labels : [];
  for (const label of issueLabels) {
    add((label as { name?: unknown }).name);
  }

  return [...names];
}

function readHandlerFile(filePath: string): WebhookHandler | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      ...HANDLER_DEFAULTS,
      ...parsed,
      name: parsed.name || path.basename(filePath).replace(/\.ya?ml$/, ''),
    } as WebhookHandler;
  } catch {
    return null;
  }
}

function handlerRunsOnThisDevice(handler: Pick<WebhookHandler, 'devices'>): boolean {
  if (!handler.devices || handler.devices.length === 0) return true;
  const self = machineId();
  return handler.devices.some((d) => normalizeHost(d) === self);
}

/**
 * List all webhook handlers, scanning project > user > system webhook dirs.
 * Higher layers shadow lower ones of the same name (first-seen wins).
 */
export function listHandlers(cwd?: string): WebhookHandler[] {
  ensureAgentsDir();
  const seen = new Set<string>();
  const handlers: WebhookHandler[] = [];

  const dirs: Array<{ scope: 'project' | 'user' | 'system'; path: string }> = [];
  if (cwd) {
    const projectDir = getProjectWebhooksDir(cwd);
    if (projectDir) dirs.push({ scope: 'project', path: projectDir });
  }
  dirs.push({ scope: 'user', path: getWebhooksDir() });
  dirs.push({ scope: 'system', path: getSystemWebhooksDir() });

  for (const { path: dir } of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    for (const file of files) {
      const handler = readHandlerFile(safeJoin(dir, file));
      if (!handler) continue;
      if (seen.has(handler.name)) continue;
      seen.add(handler.name);
      handlers.push(handler);
    }
  }
  return handlers;
}

/** Pure matcher: does this handler match the incoming webhook? */
export function handlerMatchesWebhook(handler: WebhookHandler, webhook: IncomingWebhook): boolean {
  if (handler.enabled === false) return false;
  if (handler.source !== webhook.source) return false;
  if (handler.event && handler.event !== webhook.event) return false;
  if (!handlerRunsOnThisDevice(handler)) return false;

  if (handler.action) {
    const action = webhook.source === 'github' ? githubAction(webhook.payload) : linearAction(webhook.payload);
    if (action !== handler.action) return false;
  }

  if (webhook.source === 'linear') {
    if (handler.teamKey && linearTeamKey(webhook.payload) !== handler.teamKey) return false;
    if (handler.label) {
      const expected = handler.label.toLowerCase();
      if (!linearLabels(webhook.payload).some((name) => name.toLowerCase() === expected)) return false;
    }
    if (handler.stateTo) {
      const data = webhook.payload.data as Record<string, unknown> | undefined;
      const current = (data?.state as Record<string, unknown> | undefined)?.name;
      if (current !== handler.stateTo) return false;
    }
    if (handler.stateFrom) {
      const updatedFrom = webhook.payload.updatedFrom as Record<string, unknown> | undefined;
      const previous = (updatedFrom?.state as Record<string, unknown> | undefined)?.name;
      if (previous !== handler.stateFrom) return false;
    }
    return true;
  }

  if (handler.repo) {
    const repo = payloadRepo(webhook.payload);
    if (!repo || repo.toLowerCase() !== handler.repo.toLowerCase()) return false;
  }
  if (handler.branch) {
    const branches = payloadBranches(webhook.event, webhook.payload);
    if (!branches.some((b) => b === handler.branch)) return false;
  }
  if (handler.label) {
    const expected = handler.label.toLowerCase();
    if (!githubLabels(webhook.payload).some((name) => name.toLowerCase() === expected)) return false;
  }
  return true;
}

/**
 * Build the variable-substitution context for a webhook. Linear events expose
 * `issue` and `updatedFrom`; GitHub events expose `repository`, `pull_request`,
 * and `issue`.
 */
export function buildWebhookContext(webhook: IncomingWebhook): WebhookContext {
  const action = webhook.source === 'github'
    ? githubAction(webhook.payload) ?? undefined
    : linearAction(webhook.payload) ?? undefined;
  if (webhook.source === 'linear') {
    return {
      source: webhook.source,
      event: webhook.event,
      action,
      issue: webhook.payload.data,
      updatedFrom: webhook.payload.updatedFrom,
    };
  }
  return {
    source: webhook.source,
    event: webhook.event,
    action,
    repository: webhook.payload.repository,
    pull_request: webhook.payload.pull_request,
    issue: webhook.payload.issue,
  };
}

export interface ExecuteHandlerOptions {
  dispatchAgent?: (config: JobConfig) => Promise<RunMeta>;
  dispatchWorkflow?: (config: JobConfig) => Promise<RunMeta>;
  execCommand?: (command: string) => Promise<{ exitCode: number; output: string }>;
  dispatchRoutine?: (config: JobConfig) => Promise<RunMeta>;
}

function defaultExecCommand(command: string): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    exec(command, (error, stdout, stderr) => {
      const output = stdout + stderr;
      if (error) {
        resolve({ exitCode: typeof error.code === 'number' ? error.code : 1, output });
      } else {
        resolve({ exitCode: 0, output });
      }
    });
  });
}

function dispatchDefault(config: JobConfig): Promise<RunMeta> {
  // Import lazily so the runner module (heavy) is only loaded when a handler
  // actually needs to spawn. Tests inject dispatch functions, so this path is
  // not exercised in unit tests.
  return import('../runner.js').then((m) => m.executeJobDetached(config));
}

/**
 * Execute a handler's action. Runs the configured agent/workflow/command or
 * delegates to a routine, substituting `{{...}}` placeholders from the webhook
 * context.
 */
export async function executeHandler(
  handler: WebhookHandler,
  webhook: IncomingWebhook,
  opts: ExecuteHandlerOptions = {},
): Promise<FiredHandler> {
  const context = buildWebhookContext(webhook);
  const base: FiredHandler = { handlerName: handler.name };

  emit('webhook.handler.start', {
    source: webhook.source,
    event: webhook.event,
    handlerName: handler.name,
  });

  try {
    const result = await executeHandlerAction(handler, webhook, context, opts);
    emit('webhook.handler.end', {
      source: webhook.source,
      event: webhook.event,
      handlerName: handler.name,
      status: 'success',
      ...result,
    });
    return { ...base, ...result };
  } catch (err) {
    const error = (err as Error).message;
    emit('webhook.handler.end', {
      source: webhook.source,
      event: webhook.event,
      handlerName: handler.name,
      status: 'error',
      error,
    });
    throw err;
  }
}

async function executeHandlerAction(
  handler: WebhookHandler,
  webhook: IncomingWebhook,
  context: WebhookContext,
  opts: ExecuteHandlerOptions,
): Promise<Omit<FiredHandler, 'handlerName'>> {
  const substitutedPrompt = handler.run?.prompt ? substituteWebhookPrompt(handler.run.prompt, context) : '';

  if (handler.run?.agent || handler.run?.workflow) {
    const config: JobConfig = {
      name: handler.name,
      mode: 'auto',
      effort: 'auto',
      timeout: '10m',
      enabled: true,
      prompt: substitutedPrompt,
      ...(handler.run.agent ? { agent: handler.run.agent } : { workflow: handler.run.workflow! }),
      ...(handler.devices ? { devices: handler.devices } : {}),
    };
    const dispatch = handler.run.agent
      ? (opts.dispatchAgent ?? dispatchDefault)
      : (opts.dispatchWorkflow ?? dispatchDefault);
    const meta = await dispatch(config);
    return { runId: meta.runId };
  }

  if (handler.run?.command) {
    assertShellSubstitutionSupported(handler.run.command);
    const command = substituteWebhookCommand(handler.run.command, context);
    const exec = opts.execCommand ?? defaultExecCommand;
    const { exitCode, output } = await exec(command);
    return { exitCode, output };
  }

  if (handler.routine) {
    const routine = readJob(handler.routine);
    if (!routine) throw new Error(`routine '${handler.routine}' not found`);
    const config: JobConfig = {
      ...routine,
      prompt: substituteWebhookPrompt(routine.prompt, context),
      ...(handler.devices ? { devices: handler.devices } : {}),
    };
    const dispatch = opts.dispatchRoutine ?? dispatchDefault;
    const meta = await dispatch(config);
    return { runId: meta.runId };
  }

  throw new Error(`handler '${handler.name}' has no run or routine action`);
}
