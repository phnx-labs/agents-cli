// VS Code integration for unified task management.
// Aggregates Linear (linear-cli) and GitHub (gh). The former
// `agents tickets` command is gone (RUSH-2932).

import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { TaskSource, TaskSourceSettings } from '../core/settings';
import {
  CycleInfo,
  UnifiedTask,
  githubToUnifiedTask,
  groupTasksBySource,
  linearToUnifiedTask,
} from '../core/tasks';

const execFileAsync = promisify(execFile);

export interface TaskFetchResult {
  tasks: UnifiedTask[];
  cycleInfo: CycleInfo | null;
}

interface TicketsListResult {
  tickets: UnifiedTask[];
  cycleInfo: CycleInfo | null;
  sources: {
    linear: { available: boolean; error?: string };
    github: { available: boolean; error?: string };
  };
}

function hostPath(): string {
  const dirs = [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.agents', 'shims'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
  return [...dirs, process.env.PATH ?? ''].join(':');
}

async function runCli(bin: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync(bin, args, {
    cwd,
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PATH: hostPath() },
  });
  return stdout;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function readLinear(cwd?: string): Promise<{ tickets: UnifiedTask[]; cycleInfo: CycleInfo | null }> {
  const stdout = await runCli('linear', ['tasks', '--json'], cwd);
  const data = JSON.parse(stdout) as {
    cycle?: { name?: string; startsAt?: string; endsAt?: string };
    issues?: Parameters<typeof linearToUnifiedTask>[0][];
  };
  const cycle = data.cycle;
  const cycleInfo = cycle?.startsAt && cycle?.endsAt
    ? { name: String(cycle.name ?? ''), startsAt: String(cycle.startsAt), endsAt: String(cycle.endsAt) }
    : null;
  const tickets = (Array.isArray(data.issues) ? data.issues : []).map((issue) => linearToUnifiedTask({
    ...issue,
    id: issue.identifier,
    identifier: issue.identifier,
  }));
  return { tickets, cycleInfo };
}

async function readGithub(cwd?: string, assignedOnly = false): Promise<UnifiedTask[]> {
  const repo = (await runCli('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd)).trim();
  if (!repo) throw new Error('No GitHub repository resolved for this workspace.');
  const args = [
    'issue', 'list', '--repo', repo, '--state', 'open', '--limit', '50',
    '--json', 'number,title,state,labels,assignees,url,body,createdAt',
  ];
  if (assignedOnly) args.push('--assignee', '@me');
  const stdout = await runCli('gh', args, cwd);
  const issues = JSON.parse(stdout) as Array<{
    id?: number;
    number: number;
    title: string;
    body?: string;
    state: string;
    url?: string;
    html_url?: string;
    labels?: { name: string }[];
    assignees?: { login: string }[];
    createdAt?: string;
  }>;
  return issues.map((issue) => githubToUnifiedTask({
    id: issue.id ?? issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    html_url: issue.html_url ?? issue.url ?? '',
    labels: issue.labels,
    assignee: issue.assignees?.[0] ? { login: issue.assignees[0].login } : undefined,
    createdAt: issue.createdAt,
  }, repo));
}

async function listTickets(enabled: TaskSourceSettings, cwd?: string): Promise<TicketsListResult> {
  const result: TicketsListResult = {
    tickets: [],
    cycleInfo: null,
    sources: {
      linear: { available: false },
      github: { available: false },
    },
  };

  const [linear, github] = await Promise.all([
    enabled.linear
      ? readLinear(cwd).then((value) => ({ ok: true as const, value })).catch((error) => ({ ok: false as const, error }))
      : Promise.resolve(null),
    enabled.github
      ? readGithub(cwd, enabled.githubAssignedOnly).then((value) => ({ ok: true as const, value })).catch((error) => ({ ok: false as const, error }))
      : Promise.resolve(null),
  ]);

  if (linear?.ok) {
    result.sources.linear.available = true;
    result.tickets.push(...linear.value.tickets);
    result.cycleInfo = linear.value.cycleInfo;
  } else if (linear) {
    result.sources.linear.error = errorMessage(linear.error);
  }

  if (github?.ok) {
    result.sources.github.available = true;
    result.tickets.push(...github.value);
  } else if (github) {
    result.sources.github.error = errorMessage(github.error);
  }

  return result;
}

export async function detectAvailableSources(context: vscode.ExtensionContext): Promise<{
  linear: boolean;
  github: boolean;
}> {
  void context;
  const result = await listTickets({ linear: true, github: true, githubAssignedOnly: false });
  return { linear: result.sources.linear.available, github: result.sources.github.available };
}

export async function fetchAllTasks(
  context: vscode.ExtensionContext,
  enabledSources: TaskSourceSettings
): Promise<TaskFetchResult> {
  void context;
  const result = await listTickets(enabledSources, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  return { tasks: result.tickets, cycleInfo: result.cycleInfo };
}

export async function fetchTasksGrouped(
  context: vscode.ExtensionContext,
  enabledSources: TaskSourceSettings
): Promise<Map<TaskSource, UnifiedTask[]>> {
  const { tasks } = await fetchAllTasks(context, enabledSources);
  return groupTasksBySource(tasks);
}
