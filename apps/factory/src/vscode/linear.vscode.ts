import * as vscode from 'vscode';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { UnifiedTask, CycleInfo, linearToUnifiedTask, extractRepoNameFromLabels } from '../core/tasks';
import type { LinearProjectLite } from '../core/linearProjects';
import { getSettings, resolveGithubOwner } from './settings.vscode';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const LINEAR_CONFIG = path.join(
  process.env.HOME || '',
  '.linear-cli/config.json'
);

let cachedLinearPath: string | null = null;

async function findLinearCli(): Promise<string | null> {
  if (cachedLinearPath !== null) return cachedLinearPath || null;
  try {
    const { stdout } = await execAsync('which linear');
    cachedLinearPath = stdout.trim();
    return cachedLinearPath || null;
  } catch {
    cachedLinearPath = '';
    return null;
  }
}

export async function isLinearAvailable(_context: vscode.ExtensionContext): Promise<boolean> {
  try {
    const linearPath = await findLinearCli();
    if (!linearPath) return false;
    await execFileAsync(linearPath, ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export interface LinearFetchResult {
  tasks: UnifiedTask[];
  cycleInfo: CycleInfo | null;
}

export async function fetchLinearTasks(context: vscode.ExtensionContext): Promise<LinearFetchResult> {
  if (!(await isLinearAvailable(context))) return { tasks: [], cycleInfo: null };

  try {
    const linearPath = await findLinearCli();
    if (!linearPath) return { tasks: [], cycleInfo: null };
    const { stdout } = await execFileAsync(linearPath, ['tasks', '--json'], {
      timeout: 15000,
    });

    const data = JSON.parse(stdout);
    const issues: any[] = data.issues || [];
    const cycle = data.cycle || null;

    const cycleInfo: CycleInfo | null = cycle && cycle.startsAt && cycle.endsAt
      ? { name: cycle.name, startsAt: cycle.startsAt, endsAt: cycle.endsAt }
      : null;

    // Resolve owner once so we can render "owner/repo" chips on each card.
    // Falls through to null if no owner is configured — card just won't show a repo chip.
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const owner = await resolveGithubOwner(workspacePath, getSettings(context));

    const tasks = issues.map(issue => {
      const labels: string[] = (issue.labels?.nodes || []).map((n: any) => n.name);
      const repoName = extractRepoNameFromLabels(labels);
      const repo = repoName && owner ? `${owner}/${repoName}` : null;
      return linearToUnifiedTask({
        id: issue.identifier,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        state: issue.state,
        priority: issue.priority,
        url: issue.url || `https://linear.app/issue/${issue.identifier}`,
        labels: issue.labels,
        assignee: issue.assignee,
        project: issue.project,
        dueDate: issue.dueDate,
        createdAt: issue.createdAt,
        comments: issue.comments,
      }, repo);
    });

    return { tasks, cycleInfo };
  } catch (err) {
    console.error('[LINEAR] Error fetching tasks:', err);
    return { tasks: [], cycleInfo: null };
  }
}

/**
 * Fetch the workspace's Linear projects via `linear projects --json`. Returns a
 * lightweight {id, name}[] to populate the add-project Linear dropdown. Degrades
 * to [] when the CLI is missing/unavailable — the UI shows "unavailable" and the
 * feature still works history-only.
 */
export async function fetchLinearProjects(context: vscode.ExtensionContext): Promise<LinearProjectLite[]> {
  if (!(await isLinearAvailable(context))) return [];
  try {
    const linearPath = await findLinearCli();
    if (!linearPath) return [];
    const { stdout } = await execFileAsync(linearPath, ['projects', '--json'], { timeout: 15000 });
    const parsed = JSON.parse(stdout);
    // `linear projects --json` returns a bare array; tolerate a {projects:[...]} wrapper too.
    const rows: any[] = Array.isArray(parsed) ? parsed : (parsed?.projects ?? []);
    return rows
      .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
      .map((p) => ({ id: p.id, name: p.name }));
  } catch (err) {
    console.error('[LINEAR] Error fetching projects:', err);
    return [];
  }
}

export async function saveLinearApiKey(key: string): Promise<void> {
  let config: Record<string, any> = {};
  try {
    const raw = await fs.promises.readFile(LINEAR_CONFIG, 'utf-8');
    config = JSON.parse(raw);
  } catch {
    // No existing config
  }
  config.apiKey = key;
  await fs.promises.mkdir(path.dirname(LINEAR_CONFIG), { recursive: true });
  await fs.promises.writeFile(LINEAR_CONFIG, JSON.stringify(config, null, 2));
}

export function clearLinearCache(): void {
  // No cache to clear with CLI approach
}
